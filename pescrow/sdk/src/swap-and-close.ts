import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AccountRole, address, getBase58Decoder } from "@solana/kit";
import {
  LocalKeys,
  SHIELDED_POOL_PROGRAM_ID,
  ShieldedKeypair,
  SigningKey,
  Wallet,
  createSprClient,
  syncWallet,
  type Bytes31,
  type Bytes32,
} from "@heliuslabs/spr";
import { SignedTeePolicy } from "@heliuslabs/spr/client";
import { NullifierKey, ShieldedAddress, ViewingKey, randomBlinding } from "@heliuslabs/spr/keypair";
import { encodeTransactInstructionData } from "@heliuslabs/spr/interface";
import { bindProgramTransaction, toProgramWalletUtxo, transactCpiAccounts } from "@heliuslabs/spr/program";
import initWasm, { SwapProver, swapTransaction } from "../../target/zk/pescrow/wasm/pescrow.js";
import { devnetRpcUrl } from "./rpc-url.ts";
import { RING1_TREE } from "./notes.ts";

const PROGRAM_ID = "7c3yarLtR2eUebLqYcms7GViXZ5SpQVWmmiqJTp3QtYG";
const ESCROW_ID = process.env.ESCROW_ID ?? "FN4yqDixHBi84WUZBqTg2rm6m1Rrvvm46Pum55nU99KF";
const LOCK_SEED = "escrow-lock";
const RELEASE = 4;
const CLOSE = 6;
const PROPOSED = 1;
const EXCHANGED = 3;
const RELEASE_HEADER = 32;
const CIRCUIT_PROOF_LEN = 128;
const COMPUTE_UNIT_LIMIT = 1_400_000;
const TREE_ID = 0;
const ACCOUNT_LEN = 160;
const COMMIT_A = 96;
const COMMIT_B = 128;

const require = createRequire("/tmp/pescrow-web3/package.json");
const web3 = require("@solana/web3.js") as Web3Module;

interface WalletFile {
  readonly funding_secret_hex: string;
}

interface AccountMeta {
  readonly address: string;
  readonly role: number;
}

interface Web3PublicKey {
  toBase58(): string;
  toBuffer(): Buffer;
}

interface Web3Keypair {
  publicKey: Web3PublicKey;
  secretKey: Uint8Array;
}

interface Web3Module {
  Connection: new (url: string, commitment: string) => {
    getAccountInfo(key: Web3PublicKey): Promise<{ data: Buffer; lamports: number } | null>;
    getBalance(key: Web3PublicKey): Promise<number>;
    getSlot(commitment: string): Promise<number>;
    getAddressLookupTable(key: Web3PublicKey): Promise<{ value: LookupTable | null }>;
    getLatestBlockhash(commitment: string): Promise<{ blockhash: string }>;
    sendRawTransaction(raw: Buffer, opts: { skipPreflight: boolean }): Promise<string>;
    simulateTransaction(tx: Web3Transaction | Versioned): Promise<{
      value: { err: unknown; logs: string[] | null };
    }>;
    confirmTransaction(signature: string, commitment: string): Promise<{ value: { err: unknown } }>;
  };
  PublicKey: {
    new (value: string | Uint8Array): Web3PublicKey;
    findProgramAddressSync(seeds: Buffer[], program: Web3PublicKey): [Web3PublicKey, number];
  };
  Keypair: { fromSeed(seed: Uint8Array): Web3Keypair };
  Transaction: new () => Web3Transaction;
  TransactionInstruction: new (args: {
    programId: Web3PublicKey;
    keys: { pubkey: Web3PublicKey; isSigner: boolean; isWritable: boolean }[];
    data: Buffer;
  }) => Web3Instruction;
  ComputeBudgetProgram: { setComputeUnitLimit(args: { units: number }): Web3Instruction };
  SYSVAR_CLOCK_PUBKEY: Web3PublicKey;
  AddressLookupTableProgram: {
    createLookupTable(args: {
      authority: Web3PublicKey;
      payer: Web3PublicKey;
      recentSlot: number;
    }): [Web3Instruction, Web3PublicKey];
    extendLookupTable(args: {
      lookupTable: Web3PublicKey;
      authority: Web3PublicKey;
      payer: Web3PublicKey;
      addresses: Web3PublicKey[];
    }): Web3Instruction;
    deactivateLookupTable(args: { lookupTable: Web3PublicKey; authority: Web3PublicKey }): Web3Instruction;
    closeLookupTable(args: {
      lookupTable: Web3PublicKey;
      authority: Web3PublicKey;
      recipient: Web3PublicKey;
    }): Web3Instruction;
  };
  TransactionMessage: new (args: {
    payerKey: Web3PublicKey;
    recentBlockhash: string;
    instructions: Web3Instruction[];
  }) => { compileToV0Message(tables: LookupTable[]): VersionedMessage };
  VersionedTransaction: new (message: VersionedMessage) => Versioned;
}

interface Web3Instruction {
  programId: Web3PublicKey;
  keys: { pubkey: Web3PublicKey; isSigner: boolean; isWritable: boolean }[];
}

interface LookupTable {
  state: { addresses: Web3PublicKey[] };
}

interface VersionedMessage {
  serialize(): Buffer;
}

interface Versioned {
  sign(signers: Web3Keypair[]): void;
  serialize(): Buffer;
}

interface Web3Transaction {
  add(...items: unknown[]): Web3Transaction;
  recentBlockhash: string;
  feePayer: Web3PublicKey;
  sign(...signers: Web3Keypair[]): void;
  serialize(): Buffer;
}

interface Party {
  readonly shielded: ShieldedKeypair;
  readonly signer: Web3Keypair;
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

function scrub(value: unknown): string {
  return String(value).replace(/api-key=[^&\s"]+/g, "api-key=REDACTED");
}

function loadParty(name: string): Party {
  const file = JSON.parse(readFileSync(join(homedir(), ".config/zolana", name), "utf8")) as WalletFile;
  const seed = Uint8Array.from(Buffer.from(file.funding_secret_hex, "hex"));
  if (seed.byteLength !== 32) throw new Error(`${name} funding seed is ${seed.byteLength} bytes`);
  const signer = web3.Keypair.fromSeed(seed);
  const shielded = ShieldedKeypair.fromKeypair(SigningKey.fromEd25519Bytes(seed as Bytes32));
  seed.fill(0);
  return { shielded, signer };
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
  for (let i = 0; i < 8; i += 1) value += BigInt(bytes[offset + i] ?? 0) << BigInt(8 * i);
  return value;
}

function uniqueAddresses(instructions: readonly Web3Instruction[]): Web3PublicKey[] {
  const found = new Map<string, Web3PublicKey>();
  for (const instruction of instructions) {
    found.set(instruction.programId.toBase58(), instruction.programId);
    for (const key of instruction.keys) found.set(key.pubkey.toBase58(), key.pubkey);
  }
  return [...found.values()];
}

async function sendLegacy(instructions: readonly Web3Instruction[], signer: Web3Keypair): Promise<string> {
  const tx = new web3.Transaction();
  for (const instruction of instructions) tx.add(instruction);
  const hash = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = hash.blockhash;
  tx.feePayer = signer.publicKey;
  tx.sign(signer);
  const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  const confirmed = await connection.confirmTransaction(signature, "confirmed");
  if (confirmed.value.err) throw new Error(`${signature} failed: ${JSON.stringify(confirmed.value.err)}`);
  return signature;
}

async function waitForLookupTable(tableKey: Web3PublicKey, createdSlot: number): Promise<LookupTable> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const slot = await connection.getSlot("confirmed");
    const fetched = await connection.getAddressLookupTable(tableKey);
    if (fetched.value !== null && slot > createdSlot) return fetched.value;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("lookup table was not active");
}

async function sendVersioned(
  instructions: readonly Web3Instruction[],
  tables: readonly LookupTable[],
  signer: Web3Keypair,
): Promise<string> {
  const hash = await connection.getLatestBlockhash("confirmed");
  const message = new web3.TransactionMessage({
    payerKey: signer.publicKey,
    recentBlockhash: hash.blockhash,
    instructions: [...instructions],
  }).compileToV0Message([...tables]);
  const tx = new web3.VersionedTransaction(message);
  tx.sign([signer]);
  const simulation = await connection.simulateTransaction(tx);
  if (simulation.value.err) {
    throw new Error(
      `simulation failed: ${JSON.stringify(simulation.value.err)}\n${(simulation.value.logs ?? []).join("\n")}`,
    );
  }
  const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  const confirmed = await connection.confirmTransaction(signature, "confirmed");
  if (confirmed.value.err) throw new Error(`${signature} failed: ${JSON.stringify(confirmed.value.err)}`);
  return signature;
}

async function closeLookupTable(tableKey: Web3PublicKey, signer: Web3Keypair): Promise<string> {
  await sendLegacy(
    [web3.AddressLookupTableProgram.deactivateLookupTable({ lookupTable: tableKey, authority: signer.publicKey })],
    signer,
  );
  for (let attempt = 0; attempt < 180; attempt += 1) {
    try {
      return await sendLegacy(
        [
          web3.AddressLookupTableProgram.closeLookupTable({
            lookupTable: tableKey,
            authority: signer.publicKey,
            recipient: signer.publicKey,
          }),
        ],
        signer,
      );
    } catch (error) {
      const message = scrub(error);
      if (!/deactivat/i.test(message)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  throw new Error("lookup table did not finish deactivating");
}

function metaToKey(meta: AccountMeta): { pubkey: Web3PublicKey; isSigner: boolean; isWritable: boolean } {
  return {
    pubkey: new web3.PublicKey(meta.address),
    isSigner: meta.role === AccountRole.READONLY_SIGNER || meta.role === AccountRole.WRITABLE_SIGNER,
    isWritable: meta.role === AccountRole.WRITABLE || meta.role === AccountRole.WRITABLE_SIGNER,
  };
}

const apiKey = heliusApiKey();
const connection = new web3.Connection(devnetRpcUrl(apiKey), "confirmed");
const programKey = new web3.PublicKey(PROGRAM_ID);
const escrowKey = new web3.PublicKey(ESCROW_ID);
const [lockPda, lockBump] = web3.PublicKey.findProgramAddressSync(
  [Buffer.from(LOCK_SEED), escrowKey.toBuffer()],
  programKey,
);
const account = await connection.getAccountInfo(escrowKey);
if (account === null || account.data.length !== ACCOUNT_LEN) throw new Error("escrow account is missing");
const data = new Uint8Array(account.data);
if (data[1] !== PROPOSED) throw new Error(`escrow status ${data[1]} is not Proposed`);
if (data[4] !== 1 || data[5] !== 1) throw new Error("both notes must be locked before the swap");
if (data[88] !== lockBump) throw new Error(`escrow bump ${data[88]} is not the PDA bump ${lockBump}`);

const wasmBytes = readFileSync(join(import.meta.dirname, "../../target/zk/pescrow/wasm/pescrow_bg.wasm"));
await initWasm({ module_or_path: wasmBytes });
const provingKey = readFileSync(join(import.meta.dirname, "../../target/zk/pescrow/swap.pk"));
const keyHashHex = readFileSync(join(import.meta.dirname, "../../target/zk/pescrow/swap.pk.sha256"), "utf8").slice(0, 64);
const prover = SwapProver.fromKey(provingKey, Buffer.from(keyHashHex, "hex"));

const client = await createSprClient({
  solanaRpcUrl: devnetRpcUrl(apiKey),
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
const partyA = loadParty("party-a.json");
const partyB = loadParty("party-b.json");
const keys = LocalKeys.fromKeys(
  { address: pdaAddress, viewingKeys: [pdaViewing], nullifierKey: pdaNullifier },
  client.proofService,
);

try {
  const wallet = new Wallet({ identity: pdaAddress });
  await syncWallet({ client, wallet, keys });
  const wanted = [Buffer.from(data.subarray(COMMIT_A, COMMIT_A + 32)), Buffer.from(data.subarray(COMMIT_B, COMMIT_B + 32))];
  const notes = wanted.map((commitment, index) => {
    const note = wallet.utxos().find((utxo) => {
      return Buffer.from(utxo.outputContext.hash).equals(commitment) && !utxo.spent;
    });
    if (note === undefined) throw new Error(`locked note ${index} is not in the escrow wallet`);
    return toProgramWalletUtxo(note, {
      nullifierPublicKey: pdaNullifier.publicKey(),
      treeId: TREE_ID,
      assets: wallet.registry,
    });
  });
  const noteA = notes[0];
  const noteB = notes[1];
  if (noteA === undefined || noteB === undefined) throw new Error("swap is missing a note");
  const buildSwap = bindProgramTransaction(swapTransaction, { assets: wallet.registry });
  const swapInputs = {
    private: {
      txContext: { blindingSeed: randomBlinding(), outputTreeId: TREE_ID },
      noteA: [noteA],
      noteB: [noteB],
      toA: partyA.shielded.shieldedAddress().toBytes(),
      toB: partyB.shielded.shieldedAddress().toBytes(),
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
  };
  let built;
  try {
    // The wasm Swap tuple and the SDK note are the same JSON shape.
    built = await buildSwap(swapInputs as never, pdaAddress.toBytes(), partyA.signer.publicKey.toBase58());
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : JSON.stringify(cause);
    throw new Error(`wasm swap failed: ${message}`);
  }
  const proofInputs = built.transaction.encryptWithKeys(pdaViewing);
  const proved = await client.proveTransact(proofInputs, keys);
  const circuit = prover.prove(built.proofInputs).compressedProof;
  if (circuit.a.byteLength !== 32 || circuit.b.byteLength !== 64 || circuit.c.byteLength !== 32) {
    throw new Error("circuit proof is not 128 bytes");
  }
  const transact = encodeTransactInstructionData(proved);
  const instruction = Buffer.concat([
    Buffer.from([RELEASE]),
    escrowKey.toBuffer(),
    Buffer.from(circuit.a),
    Buffer.from(circuit.b),
    Buffer.from(circuit.c),
    Buffer.from(transact),
  ]);
  if (instruction.length < 1 + RELEASE_HEADER + CIRCUIT_PROOF_LEN) {
    throw new Error("swap instruction is shorter than its header");
  }
  const tail = await transactCpiAccounts({
    payer: address(partyA.signer.publicKey.toBase58()),
    inputTree: RING1_TREE,
    outputTree: RING1_TREE,
    ownerSigners: [],
    signerPdas: [address(lockPda.toBase58())],
    data: proved,
  });
  const pool = tail[2];
  if (pool === undefined || pool.address !== SHIELDED_POOL_PROGRAM_ID) {
    throw new Error("pool account is not at tail index 2");
  }
  const swapInstructions = [
    web3.ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNIT_LIMIT }),
    new web3.TransactionInstruction({
      programId: programKey,
      keys: [
        { pubkey: escrowKey, isSigner: false, isWritable: true },
        { pubkey: partyA.signer.publicKey, isSigner: true, isWritable: true },
        { pubkey: web3.SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
        ...(tail as readonly AccountMeta[]).map(metaToKey),
      ],
      data: instruction,
    }),
  ];
  const lookupAddresses = uniqueAddresses(swapInstructions);
  const recentSlot = await connection.getSlot("confirmed");
  const [createTable, tableKey] = web3.AddressLookupTableProgram.createLookupTable({
    authority: partyA.signer.publicKey,
    payer: partyA.signer.publicKey,
    recentSlot,
  });
  const extendTable = web3.AddressLookupTableProgram.extendLookupTable({
    lookupTable: tableKey,
    authority: partyA.signer.publicKey,
    payer: partyA.signer.publicKey,
    addresses: lookupAddresses,
  });
  await sendLegacy([createTable, extendTable], partyA.signer);
  const table = await waitForLookupTable(tableKey, recentSlot);
  const swapSignature = await sendVersioned(swapInstructions, [table], partyA.signer);
  const exchanged = await connection.getAccountInfo(escrowKey);
  if (exchanged === null || exchanged.data[1] !== EXCHANGED) {
    throw new Error(`swap ${swapSignature} landed without status Exchanged`);
  }
  const outputs = built.transaction.outputHashes.map((hash) => getBase58Decoder().decode(hash));
  console.log(`swap signature=${swapSignature} toA=${outputs[0] ?? ""} toB=${outputs[1] ?? ""}`);

  const rentBefore = await connection.getBalance(partyA.signer.publicKey);
  const closeSignature = await sendLegacy(
    [
      new web3.TransactionInstruction({
        programId: programKey,
        keys: [
          { pubkey: escrowKey, isSigner: false, isWritable: true },
          { pubkey: partyA.signer.publicKey, isSigner: true, isWritable: true },
        ],
        data: Buffer.from([CLOSE]),
      }),
    ],
    partyA.signer,
  );
  const gone = await connection.getAccountInfo(escrowKey);
  if (gone !== null) throw new Error(`close ${closeSignature} left the escrow account`);
  const tableSignature = await closeLookupTable(tableKey, partyA.signer);
  const rentAfter = await connection.getBalance(partyA.signer.publicKey);
  console.log(
    `close signature=${closeSignature} lookup=${tableSignature} rent_lamports=${rentAfter - rentBefore} payer=${partyA.signer.publicKey.toBase58()}`,
  );
} catch (error) {
  console.error(scrub(error));
  process.exitCode = 1;
} finally {
  keys.destroy();
  pdaNullifier.destroy();
  pdaViewing.destroy();
}
process.exit(process.exitCode ?? 0);
