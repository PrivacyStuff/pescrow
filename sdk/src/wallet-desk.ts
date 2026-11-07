import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { AccountRole, address, getBase58Decoder } from "@solana/kit";
import {
  LocalKeys,
  SHIELDED_POOL_PROGRAM_ID,
  ShieldedKeypair,
  SigningKey,
  SOL_MINT,
  Wallet,
  buildDepositTransaction,
  buildSplitTransaction,
  buildTransferTransaction,
  createSprClient,
  syncWallet,
  type Bytes31,
  type Bytes32,
} from "@heliuslabs/spr";
import { SignedTeePolicy } from "@heliuslabs/spr/client";
import { NullifierKey, ShieldedAddress, ViewingKey, randomBlinding } from "@heliuslabs/spr/keypair";
import { encodeTransactInstructionData } from "@heliuslabs/spr/interface";
import { bindProgramTransaction, toProgramWalletUtxo, transactCpiAccounts } from "@heliuslabs/spr/program";
import {
  createKeyPairSignerFromPrivateKeyBytes,
  getSignatureFromTransaction,
  sendTransactionWithoutConfirmingFactory,
  signTransactionWithSigners,
} from "@solana/kit";
import initWasm, { LockProver, SwapProver, lockTransaction, swapTransaction } from "../../target/zk/pescrow/wasm/pescrow.js";
import { chunkRefusal, planChunk } from "./chunk-plan.ts";
import { readTerms } from "./escrow-terms.ts";
import { foldSolNotes } from "./fold-notes.ts";
import { devnetRpcUrl } from "./rpc-url.ts";
import { RING1_TREE } from "./notes.ts";

const PROGRAM_ID = "7c3yarLtR2eUebLqYcms7GViXZ5SpQVWmmiqJTp3QtYG";
const ACCOUNT_LEN = 160;
const LOCK_SEED = "escrow-lock";
const SOLANA_OWNER_TAG = 0x53;
const FUND_SIDE = 3;
const RELEASE = 4;
const TREE_ID = 0;
const COMPUTE_UNIT_LIMIT = 1_400_000;
const LOCK_HEADER = 65;
const RELEASE_HEADER = 32;
const CIRCUIT_PROOF_LEN = 128;
const SPLIT_MIN_PARTS = 2;
const SPLIT_MAX_PARTS = 8;
const RESERVE_TTL_MS = 180_000n;
const CHUNK_SYNC_ATTEMPTS = 8;

const require = createRequire("/tmp/pescrow-web3/package.json");
const web3 = require("@solana/web3.js") as Web3Module;

interface AccountMeta {
  readonly address: string;
  readonly role: number;
}

interface Web3PublicKey {
  toBase58(): string;
  toBuffer(): Buffer;
  equals(other: Web3PublicKey): boolean;
}

interface Web3Keypair {
  publicKey: Web3PublicKey;
  secretKey: Uint8Array;
}

interface Web3Transaction {
  add(...items: unknown[]): Web3Transaction;
  recentBlockhash: string;
  feePayer: Web3PublicKey;
  partialSign(...signers: Web3Keypair[]): void;
  sign(...signers: Web3Keypair[]): void;
  serialize(options?: { requireAllSignatures?: boolean; verifySignatures?: boolean }): Buffer;
}

interface LookupTable {
  state: { addresses: Web3PublicKey[] };
}

interface Versioned {
  sign(signers: Web3Keypair[]): void;
  serialize(): Buffer;
}

interface Web3Module {
  Connection: new (url: string, commitment: string) => {
    getBalance(key: Web3PublicKey): Promise<number>;
    getAccountInfo(key: Web3PublicKey): Promise<{ data: Buffer } | null>;
    getSlot(commitment: string): Promise<number>;
    getAddressLookupTable(key: Web3PublicKey): Promise<{ value: LookupTable | null }>;
    getLatestBlockhash(commitment: string): Promise<{ blockhash: string }>;
    sendRawTransaction(raw: Buffer, opts: { skipPreflight: boolean }): Promise<string>;
    simulateTransaction(
      tx: Web3Transaction,
      config: { sigVerify: boolean; replaceRecentBlockhash: boolean },
    ): Promise<{ value: { err: unknown; logs: string[] | null } }>;
    confirmTransaction(signature: string, commitment: string): Promise<{ value: { err: unknown } }>;
  };
  PublicKey: {
    new (value: string | Uint8Array): Web3PublicKey;
    findProgramAddressSync(seeds: Buffer[], program: Web3PublicKey): [Web3PublicKey, number];
  };
  Keypair: { fromSeed(seed: Uint8Array): Web3Keypair };
  SystemProgram: {
    transfer(args: { fromPubkey: Web3PublicKey; toPubkey: Web3PublicKey; lamports: number }): unknown;
  };
  Transaction: new () => Web3Transaction;
  TransactionInstruction: new (args: {
    programId: Web3PublicKey;
    keys: { pubkey: Web3PublicKey; isSigner: boolean; isWritable: boolean }[];
    data: Buffer;
  }) => { programId: Web3PublicKey; keys: { pubkey: Web3PublicKey }[] };
  ComputeBudgetProgram: { setComputeUnitLimit(args: { units: number }): unknown };
  SYSVAR_CLOCK_PUBKEY: Web3PublicKey;
  AddressLookupTableProgram: {
    createLookupTable(args: {
      authority: Web3PublicKey;
      payer: Web3PublicKey;
      recentSlot: number;
    }): [unknown, Web3PublicKey];
    extendLookupTable(args: {
      lookupTable: Web3PublicKey;
      authority: Web3PublicKey;
      payer: Web3PublicKey;
      addresses: Web3PublicKey[];
    }): unknown;
    deactivateLookupTable(args: { lookupTable: Web3PublicKey; authority: Web3PublicKey }): unknown;
    closeLookupTable(args: {
      lookupTable: Web3PublicKey;
      authority: Web3PublicKey;
      recipient: Web3PublicKey;
    }): unknown;
  };
  TransactionMessage: new (args: {
    payerKey: Web3PublicKey;
    recentBlockhash: string;
    instructions: unknown[];
  }) => { compileToV0Message(tables: LookupTable[]): unknown };
  VersionedTransaction: new (message: unknown) => Versioned;
}

interface Job {
  readonly cmd?: string;
  readonly seedHex?: string;
  readonly wallet?: string;
  readonly lamports?: string;
  readonly escrow?: string;
  readonly note?: string;
  readonly toAHex?: string;
  readonly toBHex?: string;
}

function scrub(value: unknown): string {
  return String(value).replace(/api-key=[^&\s"]+/g, "api-key=REDACTED");
}

function heliusApiKey(): string {
  const fromEnv = process.env.HELIUS_API_KEY;
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  const text = readFileSync(join(homedir(), ".config/solana/cli/config.yml"), "utf8");
  const match = text.match(/api-key=([0-9a-f-]+)/i);
  const key = match?.[1];
  if (key === undefined) throw new Error("Helius key is not in the Solana CLI config");
  return key;
}

function readSeed(job: Job): Uint8Array {
  const seed = Uint8Array.from(Buffer.from(job.seedHex ?? "", "hex"));
  if (seed.byteLength !== 32) throw new Error("ring key is not 32 bytes");
  return seed;
}

function escrowViewingKey(): ViewingKey {
  const saved = JSON.parse(readFileSync(join(homedir(), ".config/zolana/escrow-pda.json"), "utf8")) as {
    viewing_secret_hex?: string;
  };
  const secret = saved.viewing_secret_hex;
  if (secret === undefined || secret.length !== 64) throw new Error("escrow viewing key file is unreadable");
  return ViewingKey.fromBytes(Uint8Array.from(Buffer.from(secret, "hex")) as unknown as Bytes32);
}

function u64(bytes: Uint8Array, offset: number): bigint {
  let value = 0n;
  for (let index = 0; index < 8; index += 1) value += BigInt(bytes[offset + index] ?? 0) << BigInt(8 * index);
  return value;
}

function metaToKey(meta: AccountMeta): { pubkey: Web3PublicKey; isSigner: boolean; isWritable: boolean } {
  return {
    pubkey: new web3.PublicKey(meta.address),
    isSigner: meta.role === AccountRole.READONLY_SIGNER || meta.role === AccountRole.WRITABLE_SIGNER,
    isWritable: meta.role === AccountRole.WRITABLE || meta.role === AccountRole.WRITABLE_SIGNER,
  };
}

async function confirmSignature(rpcUrl: string, signature: string): Promise<void> {
  const client = await createSprClient({ solanaRpcUrl: rpcUrl });
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const status = await client.solanaRpc.getSignatureStatuses([signature as never]).send();
    const row = status.value[0];
    if (row?.err) throw new Error(`transaction ${signature} failed`);
    if (row?.confirmationStatus === "confirmed" || row?.confirmationStatus === "finalized") return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`transaction ${signature} was not confirmed`);
}

async function notes(rpcUrl: string, seed: Uint8Array): Promise<unknown> {
  const ring = web3.Keypair.fromSeed(seed);
  const shielded = ShieldedKeypair.fromKeypair(SigningKey.fromEd25519Bytes(seed as Bytes32));
  const connection = new web3.Connection(rpcUrl, "confirmed");
  const sol = await connection.getBalance(ring.publicKey);
  const client = await createSprClient({ solanaRpcUrl: rpcUrl });
  const keys = LocalKeys.fromKeypair(shielded, client.proofService);
  try {
    const wallet = new Wallet({ identity: shielded.shieldedAddress() });
    await syncWallet({ client, wallet, keys });
    const rows = wallet
      .utxos()
      .filter((utxo) => utxo.outputContext.tree === RING1_TREE && !utxo.spent)
      .map((utxo) => ({
        hash: getBase58Decoder().decode(utxo.outputContext.hash),
        lamports: utxo.utxo.amount.toString(),
        leaf: utxo.outputContext.leafIndex.toString(),
      }));
    return {
      ring: ring.publicKey.toBase58(),
      shieldedAddressHex: Buffer.from(shielded.shieldedAddress().toBytes()).toString("hex"),
      sol: String(sol),
      notes: rows,
    };
  } finally {
    keys.destroy();
  }
}

async function shield(rpcUrl: string, seed: Uint8Array, lamports: bigint): Promise<unknown> {
  if (lamports < 1n || lamports > 1_000_000_000n) throw new Error("amount must be between 1 lamport and 1 SOL");
  const shielded = ShieldedKeypair.fromKeypair(SigningKey.fromEd25519Bytes(seed as Bytes32));
  const signer = await createKeyPairSignerFromPrivateKeyBytes(seed);
  const client = await createSprClient({ solanaRpcUrl: rpcUrl });
  const transaction = await buildDepositTransaction({
    client,
    feePayer: signer.address,
    recipient: shielded.shieldedAddress(),
    amount: lamports,
    tree: RING1_TREE,
  });
  const signed = await signTransactionWithSigners([signer], transaction);
  const send = sendTransactionWithoutConfirmingFactory({ rpc: client.solanaRpc });
  await send(signed, { commitment: "confirmed" });
  const signature = getSignatureFromTransaction(signed);
  await confirmSignature(rpcUrl, signature);
  const merged = await foldSolNotes({ rpcUrl, seed });
  return merged === null ? { signature } : { signature, merged };
}

type SprClient = Awaited<ReturnType<typeof createSprClient>>;
type NoteWallet = InstanceType<typeof Wallet>;
type NoteKeys = ReturnType<typeof LocalKeys.fromKeypair>;

function hashOf(utxo: { outputContext: { hash: Parameters<ReturnType<typeof getBase58Decoder>["decode"]>[0] } }): string {
  return getBase58Decoder().decode(utxo.outputContext.hash);
}

function equalSplitParts(noteLamports: bigint, chunkLamports: bigint): number | null {
  if (chunkLamports <= 0n || noteLamports % chunkLamports !== 0n) return null;
  const parts = noteLamports / chunkLamports;
  if (parts < BigInt(SPLIT_MIN_PARTS) || parts > BigInt(SPLIT_MAX_PARTS)) return null;
  return Number(parts);
}

async function sendPrivate(
  rpcUrl: string,
  client: SprClient,
  signer: Awaited<ReturnType<typeof createKeyPairSignerFromPrivateKeyBytes>>,
  transaction: Parameters<typeof signTransactionWithSigners>[1],
): Promise<string> {
  const signed = await signTransactionWithSigners([signer], transaction);
  const send = sendTransactionWithoutConfirmingFactory({ rpc: client.solanaRpc });
  await send(signed, { commitment: "confirmed" });
  const signature = getSignatureFromTransaction(signed);
  await confirmSignature(rpcUrl, signature);
  return signature;
}

// buildSplitTransaction only emits 2–8 equal notes and can name the input.
// A typed amount that is not one of those equal parts is a transfer of that
// amount back to the same shielded address. Other notes are reserved so the
// selected note is the input and the change output is the remainder.
async function carveChunk(input: {
  rpcUrl: string;
  seed: Uint8Array;
  client: SprClient;
  wallet: NoteWallet;
  keys: NoteKeys;
  noteHash: string;
  chunkLamports: bigint;
  recipient: ReturnType<ShieldedKeypair["shieldedAddress"]>;
}): Promise<{ hash: string; signature: string }> {
  const signer = await createKeyPairSignerFromPrivateKeyBytes(input.seed);
  const note = input.wallet.utxos().find((utxo) => hashOf(utxo) === input.noteHash && !utxo.spent);
  if (note === undefined) throw new Error("that note is not in this wallet");
  if (note.utxo.asset !== SOL_MINT) throw new Error("only a SOL note can be chunked");
  const before = new Set(input.wallet.utxos().filter((utxo) => !utxo.spent).map((utxo) => hashOf(utxo)));
  const parts = equalSplitParts(note.utxo.amount, input.chunkLamports);
  let signature: string;
  if (parts !== null) {
    const transaction = await buildSplitTransaction({
      client: input.client,
      wallet: input.wallet,
      keys: input.keys,
      feePayer: signer.address,
      input: note.outputContext.hash,
      parts,
    });
    signature = await sendPrivate(input.rpcUrl, input.client, signer, transaction);
  } else {
    const held = input.wallet.utxos().filter((utxo) => {
      return !utxo.spent && utxo.utxo.amount > 0n && utxo.utxo.asset === SOL_MINT && hashOf(utxo) !== input.noteHash;
    });
    const reservation = held.length === 0
      ? null
      : input.wallet._reserveUtxos({
          utxoHashes: held.map((utxo) => utxo.outputContext.hash),
          nowMs: BigInt(Date.now()),
          ttlMs: RESERVE_TTL_MS,
        });
    try {
      const transaction = await buildTransferTransaction({
        client: input.client,
        wallet: input.wallet,
        keys: input.keys,
        feePayer: signer.address,
        recipient: input.recipient,
        amount: input.chunkLamports,
      });
      signature = await sendPrivate(input.rpcUrl, input.client, signer, transaction);
    } finally {
      if (reservation !== null) input.wallet._releaseReservation(reservation.id);
    }
  }
  for (let attempt = 0; attempt < CHUNK_SYNC_ATTEMPTS; attempt += 1) {
    await syncWallet({ client: input.client, wallet: input.wallet, keys: input.keys });
    const created = input.wallet.utxos().find((utxo) => {
      return !utxo.spent && utxo.utxo.amount === input.chunkLamports && !before.has(hashOf(utxo));
    });
    if (created !== undefined) return { hash: hashOf(created), signature };
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("the chunk note did not appear after the split");
}

async function lock(rpcUrl: string, seed: Uint8Array, wallet: string, escrowAddress: string, noteHash: string, lamportsText: string): Promise<unknown> {
  const connection = new web3.Connection(rpcUrl, "confirmed");
  const program = new web3.PublicKey(PROGRAM_ID);
  const escrowKey = new web3.PublicKey(escrowAddress);
  const party = new web3.PublicKey(wallet);
  const ring = web3.Keypair.fromSeed(seed);
  const account = await connection.getAccountInfo(escrowKey);
  if (account === null || account.data.length !== ACCOUNT_LEN) throw new Error("escrow account is missing");
  const data = new Uint8Array(account.data);
  if (data[2] !== 1 || data[3] !== 1) throw new Error("both wallets have to approve before a note can lock");
  const partyA = new web3.PublicKey(data.subarray(24, 56)).toBase58();
  const partyB = new web3.PublicKey(data.subarray(56, 88)).toBase58();
  const side = party.toBase58() === partyA ? 0 : party.toBase58() === partyB ? 1 : -1;
  if (side < 0) throw new Error("this wallet is not a party to the escrow");
  if (data[side === 0 ? 4 : 5] === 1) throw new Error("this side is already locked");
  const [lockPda, lockBump] = web3.PublicKey.findProgramAddressSync([Buffer.from(LOCK_SEED), escrowKey.toBuffer()], program);
  if (data[88] !== lockBump) throw new Error("escrow bump does not match the lock PDA");

  const wasmBytes = readFileSync(join(import.meta.dirname, "../../target/zk/pescrow/wasm/pescrow_bg.wasm"));
  await initWasm({ module_or_path: wasmBytes });
  const provingKey = readFileSync(join(import.meta.dirname, "../../target/zk/pescrow/lock.pk"));
  const keyHashHex = readFileSync(join(import.meta.dirname, "../../target/zk/pescrow/lock.pk.sha256"), "utf8").slice(0, 64);
  const prover = LockProver.fromKey(provingKey, Buffer.from(keyHashHex, "hex"));
  const client = await createSprClient({
    solanaRpcUrl: rpcUrl,
    proverTee: SignedTeePolicy.forNetwork("devnet"),
    proofDataSource: "client",
  });
  const shielded = ShieldedKeypair.fromKeypair(SigningKey.fromEd25519Bytes(seed as Bytes32));
  const keys = LocalKeys.fromKeypair(shielded, client.proofService);
  const pdaViewing = escrowViewingKey();
  const pdaNullifier = NullifierKey.fromSecret(new Uint8Array(31) as Bytes31);
  try {
    const pdaAddress = ShieldedAddress.forPda({
      pda: address(lockPda.toBase58()),
      nullifierPublicKey: pdaNullifier.publicKey(),
      viewingPublicKey: pdaViewing.publicKey(),
    });
    const walletState = new Wallet({ identity: shielded.shieldedAddress() });
    await syncWallet({ client, wallet: walletState, keys });
    const note = walletState.utxos().find((utxo) => {
      return getBase58Decoder().decode(utxo.outputContext.hash) === noteHash && !utxo.spent;
    });
    if (note === undefined) throw new Error("that note is not in this wallet");
    const typed = BigInt(lamportsText);
    const stored = readTerms()[escrowAddress];
    const agreed = stored === undefined ? null : BigInt(side === 0 ? stored.lockLamports : stored.receiveLamports);
    const plan = planChunk({ noteLamports: note.utxo.amount, typedLamports: typed, agreedLamports: agreed });
    if (!plan.ok) throw new Error(chunkRefusal(plan.reason));
    let spend = note;
    let splitSignature: string | null = null;
    if (plan.split) {
      const carved = await carveChunk({
        rpcUrl,
        seed,
        client,
        wallet: walletState,
        keys,
        noteHash,
        chunkLamports: plan.lamports,
        recipient: shielded.shieldedAddress(),
      });
      splitSignature = carved.signature;
      const chunk = walletState.utxos().find((utxo) => hashOf(utxo) === carved.hash && !utxo.spent);
      if (chunk === undefined || chunk.utxo.amount !== plan.lamports) throw new Error("the chunk note does not match the agreed amount");
      spend = chunk;
    }
    const buildLock = bindProgramTransaction(lockTransaction, { assets: walletState.registry });
    const built = await buildLock(
      {
        private: {
          txContext: { blindingSeed: randomBlinding(), outputTreeId: TREE_ID },
          note: [
            toProgramWalletUtxo(spend, {
              nullifierPublicKey: shielded.nullifierPublicKey(),
              treeId: TREE_ID,
              assets: walletState.registry,
            }),
          ],
          pda: { tag: SOLANA_OWNER_TAG, key: lockPda.toBuffer(), nullifierPk: pdaNullifier.publicKey() },
        },
        public: {
          escrow0: u64(escrowKey.toBuffer(), 0),
          escrow1: u64(escrowKey.toBuffer(), 8),
          escrow2: u64(escrowKey.toBuffer(), 16),
          escrow3: u64(escrowKey.toBuffer(), 24),
          startAt: u64(data, 8),
          side: BigInt(side),
          aApproved: BigInt(data[2] ?? 0),
          bApproved: BigInt(data[3] ?? 0),
        },
      } as never,
      pdaAddress.toBytes(),
      ring.publicKey.toBase58(),
    );
    const outputHash = built.transaction.outputHashes[0];
    if (outputHash === undefined || outputHash.byteLength !== 32) throw new Error("lock produced no output hash");
    const proved = await client.proveTransact(built.transaction.encryptWithKeys(pdaViewing), keys);
    const circuit = prover.prove(built.proofInputs).compressedProof;
    const transact = encodeTransactInstructionData(proved);
    const instruction = Buffer.concat([
      Buffer.from([FUND_SIDE]),
      escrowKey.toBuffer(),
      Buffer.from([side]),
      Buffer.from(outputHash),
      Buffer.from(circuit.a),
      Buffer.from(circuit.b),
      Buffer.from(circuit.c),
      Buffer.from(transact),
    ]);
    if (instruction.length < 1 + LOCK_HEADER + CIRCUIT_PROOF_LEN) throw new Error("lock instruction is short");
    const tail = await transactCpiAccounts({
      payer: address(party.toBase58()),
      inputTree: RING1_TREE,
      outputTree: RING1_TREE,
      ownerSigners: [address(ring.publicKey.toBase58())],
      signerPdas: [],
      data: proved,
    });
    const tx = new web3.Transaction()
      .add(web3.ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNIT_LIMIT }))
      .add(
        new web3.TransactionInstruction({
          programId: program,
          keys: [
            { pubkey: escrowKey, isSigner: false, isWritable: true },
            { pubkey: party, isSigner: true, isWritable: true },
            { pubkey: web3.SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
            ...(tail as readonly AccountMeta[]).map(metaToKey),
          ],
          data: instruction,
        }),
      );
    const block = await connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = block.blockhash;
    tx.feePayer = party;
    tx.partialSign(ring);
    const simulation = await connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
    if (simulation.value.err) {
      throw new Error(`simulation failed: ${JSON.stringify(simulation.value.err)}\n${(simulation.value.logs ?? []).join("\n")}`);
    }
    return {
      tx: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"),
      commitment: getBase58Decoder().decode(outputHash),
      split: splitSignature,
    };
  } finally {
    keys.destroy();
    pdaNullifier.destroy();
    pdaViewing.destroy();
  }
}

function uniqueAddresses(instructions: readonly { programId: Web3PublicKey; keys: { pubkey: Web3PublicKey }[] }[]): Web3PublicKey[] {
  const found = new Map<string, Web3PublicKey>();
  for (const instruction of instructions) {
    found.set(instruction.programId.toBase58(), instruction.programId);
    for (const key of instruction.keys) found.set(key.pubkey.toBase58(), key.pubkey);
  }
  return [...found.values()];
}

async function swap(rpcUrl: string, seed: Uint8Array, escrowAddress: string, toAHex: string, toBHex: string): Promise<unknown> {
  const connection = new web3.Connection(rpcUrl, "confirmed");
  const program = new web3.PublicKey(PROGRAM_ID);
  const escrowKey = new web3.PublicKey(escrowAddress);
  const ring = web3.Keypair.fromSeed(seed);
  const account = await connection.getAccountInfo(escrowKey);
  if (account === null || account.data.length !== ACCOUNT_LEN) throw new Error("escrow account is missing");
  const data = new Uint8Array(account.data);
  if (data[4] !== 1 || data[5] !== 1) throw new Error("both notes have to be locked before the swap");
  const [lockPda, lockBump] = web3.PublicKey.findProgramAddressSync([Buffer.from(LOCK_SEED), escrowKey.toBuffer()], program);
  if (data[88] !== lockBump) throw new Error("escrow bump does not match the lock PDA");
  const wasmBytes = readFileSync(join(import.meta.dirname, "../../target/zk/pescrow/wasm/pescrow_bg.wasm"));
  await initWasm({ module_or_path: wasmBytes });
  const provingKey = readFileSync(join(import.meta.dirname, "../../target/zk/pescrow/swap.pk"));
  const keyHashHex = readFileSync(join(import.meta.dirname, "../../target/zk/pescrow/swap.pk.sha256"), "utf8").slice(0, 64);
  const prover = SwapProver.fromKey(provingKey, Buffer.from(keyHashHex, "hex"));
  const client = await createSprClient({
    solanaRpcUrl: rpcUrl,
    proverTee: SignedTeePolicy.forNetwork("devnet"),
    proofDataSource: "client",
  });
  const pdaViewing = escrowViewingKey();
  const pdaNullifier = NullifierKey.fromSecret(new Uint8Array(31) as Bytes31);
  const pdaAddress = ShieldedAddress.forPda({
    pda: address(lockPda.toBase58()),
    nullifierPublicKey: pdaNullifier.publicKey(),
    viewingPublicKey: pdaViewing.publicKey(),
  });
  const keys = LocalKeys.fromKeys(
    { address: pdaAddress, viewingKeys: [pdaViewing], nullifierKey: pdaNullifier },
    client.proofService,
  );
  try {
    const walletState = new Wallet({ identity: pdaAddress });
    await syncWallet({ client, wallet: walletState, keys });
    const wanted = [Buffer.from(data.subarray(96, 128)), Buffer.from(data.subarray(128, 160))];
    const notes = wanted.map((commitment, index) => {
      const note = walletState.utxos().find((utxo) => Buffer.from(utxo.outputContext.hash).equals(commitment) && !utxo.spent);
      if (note === undefined) throw new Error(`locked note ${index} is not in the escrow`);
      return toProgramWalletUtxo(note, {
        nullifierPublicKey: pdaNullifier.publicKey(),
        treeId: TREE_ID,
        assets: walletState.registry,
      });
    });
    const noteA = notes[0];
    const noteB = notes[1];
    if (noteA === undefined || noteB === undefined) throw new Error("swap is missing a note");
    const buildSwap = bindProgramTransaction(swapTransaction, { assets: walletState.registry });
    const built = await buildSwap(
      {
        private: {
          txContext: { blindingSeed: randomBlinding(), outputTreeId: TREE_ID },
          noteA: [noteA],
          noteB: [noteB],
          toA: ShieldedAddress.fromBytes(Buffer.from(toAHex, "hex")).toBytes(),
          toB: ShieldedAddress.fromBytes(Buffer.from(toBHex, "hex")).toBytes(),
        },
        public: {
          escrow0: u64(escrowKey.toBuffer(), 0),
          escrow1: u64(escrowKey.toBuffer(), 8),
          escrow2: u64(escrowKey.toBuffer(), 16),
          escrow3: u64(escrowKey.toBuffer(), 24),
          startAt: u64(data, 8),
          aSealed: BigInt(data[4] ?? 0),
          bSealed: BigInt(data[5] ?? 0),
        },
      } as never,
      pdaAddress.toBytes(),
      ring.publicKey.toBase58(),
    );
    const proved = await client.proveTransact(built.transaction.encryptWithKeys(pdaViewing), keys);
    const circuit = prover.prove(built.proofInputs).compressedProof;
    const transact = encodeTransactInstructionData(proved);
    const instruction = Buffer.concat([
      Buffer.from([RELEASE]),
      escrowKey.toBuffer(),
      Buffer.from(circuit.a),
      Buffer.from(circuit.b),
      Buffer.from(circuit.c),
      Buffer.from(transact),
    ]);
    if (instruction.length < 1 + RELEASE_HEADER + CIRCUIT_PROOF_LEN) throw new Error("swap instruction is short");
    const tail = await transactCpiAccounts({
      payer: address(ring.publicKey.toBase58()),
      inputTree: RING1_TREE,
      outputTree: RING1_TREE,
      ownerSigners: [],
      signerPdas: [address(lockPda.toBase58())],
      data: proved,
    });
    const swapInstruction = new web3.TransactionInstruction({
      programId: program,
      keys: [
        { pubkey: escrowKey, isSigner: false, isWritable: true },
        { pubkey: ring.publicKey, isSigner: true, isWritable: true },
        { pubkey: web3.SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
        ...(tail as readonly AccountMeta[]).map(metaToKey),
      ],
      data: instruction,
    });
    const budget = web3.ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNIT_LIMIT });
    const recentSlot = await connection.getSlot("confirmed");
    const [createTable, tableKey] = web3.AddressLookupTableProgram.createLookupTable({
      authority: ring.publicKey,
      payer: ring.publicKey,
      recentSlot,
    });
    const extendTable = web3.AddressLookupTableProgram.extendLookupTable({
      lookupTable: tableKey,
      authority: ring.publicKey,
      payer: ring.publicKey,
      addresses: uniqueAddresses([swapInstruction]),
    });
    const setup = new web3.Transaction().add(createTable).add(extendTable);
    const setupHash = await connection.getLatestBlockhash("confirmed");
    setup.recentBlockhash = setupHash.blockhash;
    setup.feePayer = ring.publicKey;
    setup.sign(ring);
    const setupSignature = await connection.sendRawTransaction(setup.serialize(), { skipPreflight: false });
    const setupConfirmed = await connection.confirmTransaction(setupSignature, "confirmed");
    if (setupConfirmed.value.err) throw new Error(`lookup table ${setupSignature} failed`);
    let table: LookupTable | null = null;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const slot = await connection.getSlot("confirmed");
      const fetched = await connection.getAddressLookupTable(tableKey);
      if (fetched.value !== null && slot > recentSlot) {
        table = fetched.value;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (table === null) throw new Error("lookup table was not active");
    const hash = await connection.getLatestBlockhash("confirmed");
    const message = new web3.TransactionMessage({
      payerKey: ring.publicKey,
      recentBlockhash: hash.blockhash,
      instructions: [budget, swapInstruction],
    }).compileToV0Message([table]);
    const tx = new web3.VersionedTransaction(message);
    tx.sign([ring]);
    const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    const confirmed = await connection.confirmTransaction(signature, "confirmed");
    if (confirmed.value.err) throw new Error(`swap ${signature} failed`);
    await connection.sendRawTransaction(
      await signedLegacy(connection, [
        web3.AddressLookupTableProgram.deactivateLookupTable({ lookupTable: tableKey, authority: ring.publicKey }),
      ], ring),
      { skipPreflight: false },
    );
    return { signature };
  } finally {
    keys.destroy();
    pdaNullifier.destroy();
    pdaViewing.destroy();
  }
}

async function signedLegacy(
  connection: InstanceType<typeof web3.Connection>,
  instructions: unknown[],
  signer: Web3Keypair,
): Promise<Buffer> {
  const tx = new web3.Transaction();
  for (const instruction of instructions) tx.add(instruction);
  const hash = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = hash.blockhash;
  tx.feePayer = signer.publicKey;
  tx.sign(signer);
  return tx.serialize();
}

async function returnSol(rpcUrl: string, seed: Uint8Array, wallet: string): Promise<unknown> {
  const connection = new web3.Connection(rpcUrl, "confirmed");
  const ring = web3.Keypair.fromSeed(seed);
  const balance = await connection.getBalance(ring.publicKey);
  const fee = 5000;
  if (balance <= fee) return { lamports: "0" };
  const tx = new web3.Transaction().add(
    web3.SystemProgram.transfer({
      fromPubkey: ring.publicKey,
      toPubkey: new web3.PublicKey(wallet),
      lamports: balance - fee,
    }),
  );
  const hash = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = hash.blockhash;
  tx.feePayer = ring.publicKey;
  tx.sign(ring);
  const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  const confirmed = await connection.confirmTransaction(signature, "confirmed");
  if (confirmed.value.err) throw new Error(`return ${signature} failed`);
  return { signature, lamports: String(balance - fee) };
}

async function main(): Promise<void> {
  const raw = await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on("error", reject);
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
  const job = JSON.parse(raw) as Job;
  const seed = readSeed(job);
  const rpcUrl = devnetRpcUrl(heliusApiKey());
  try {
    let result: unknown;
    if (job.cmd === "notes") result = await notes(rpcUrl, seed);
    else if (job.cmd === "shield") result = await shield(rpcUrl, seed, BigInt(job.lamports ?? "0"));
    else if (job.cmd === "lock" && job.wallet && job.escrow && job.note && job.lamports) {
      result = await lock(rpcUrl, seed, job.wallet, job.escrow, job.note, job.lamports);
    } else if (job.cmd === "swap" && job.escrow && job.toAHex && job.toBHex) {
      result = await swap(rpcUrl, seed, job.escrow, job.toAHex, job.toBHex);
    } else if (job.cmd === "return" && job.wallet) result = await returnSol(rpcUrl, seed, job.wallet);
    else throw new Error("unknown wallet desk command");
    process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
  } finally {
    seed.fill(0);
  }
}

main()
  .catch((error: unknown) => {
    process.stdout.write(`${JSON.stringify({ ok: false, error: scrub(error) })}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    setTimeout(() => process.exit(process.exitCode ?? 0), 20);
  });
