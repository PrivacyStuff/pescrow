import { createRequire } from "node:module";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
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
import {
  bindProgramTransaction,
  toProgramWalletUtxo,
  transactCpiAccounts,
} from "@heliuslabs/spr/program";
import initWasm, { lockTransaction, LockProver } from "../../target/zk/pescrow/wasm/pescrow.js";
import { devnetRpcUrl } from "./rpc-url.ts";
import { RING1_NOTE_HASHES, RING1_TREE } from "./notes.ts";

const PROGRAM_ID = "7c3yarLtR2eUebLqYcms7GViXZ5SpQVWmmiqJTp3QtYG";
const ESCROW_ID = process.env.ESCROW_ID ?? "FN4yqDixHBi84WUZBqTg2rm6m1Rrvvm46Pum55nU99KF";
const NOTE_HASHES =
  process.env.NOTE_A !== undefined && process.env.NOTE_B !== undefined
    ? ([process.env.NOTE_A, process.env.NOTE_B] as const)
    : RING1_NOTE_HASHES;
const LOCK_SEED = "escrow-lock";
const SOLANA_OWNER_TAG = 0x53;
const FUND_SIDE = 3;
const LOCK_HEADER = 65;
const CIRCUIT_PROOF_LEN = 128;
const COMPUTE_UNIT_LIMIT = 1_400_000;
const TREE_ID = 0;
const ACCOUNT_LEN = 160;

const require = createRequire(import.meta.url);
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
  equals(other: Web3PublicKey): boolean;
}

interface Web3Keypair {
  publicKey: Web3PublicKey;
}

interface Web3Module {
  Connection: new (url: string, commitment: string) => {
    getAccountInfo(key: Web3PublicKey): Promise<{ data: Buffer } | null>;
    getLatestBlockhash(commitment: string): Promise<{
      blockhash: string;
      lastValidBlockHeight: number;
    }>;
    sendRawTransaction(raw: Buffer, opts: { skipPreflight: boolean }): Promise<string>;
    simulateTransaction(tx: Web3Transaction): Promise<{
      value: { err: unknown; logs: string[] | null };
    }>;
    confirmTransaction(
      signature: string,
      commitment: string,
    ): Promise<{ value: { err: unknown } }>;
  };
  PublicKey: {
    new (value: string | Uint8Array): Web3PublicKey;
    findProgramAddressSync(seeds: Buffer[], program: Web3PublicKey): [Web3PublicKey, number];
  };
  Keypair: { fromSeed(seed: Uint8Array): Web3Keypair & { secretKey: Uint8Array } };
  Transaction: new () => Web3Transaction;
  TransactionInstruction: new (args: {
    programId: Web3PublicKey;
    keys: { pubkey: Web3PublicKey; isSigner: boolean; isWritable: boolean }[];
    data: Buffer;
  }) => unknown;
  ComputeBudgetProgram: { setComputeUnitLimit(args: { units: number }): unknown };
  SYSVAR_CLOCK_PUBKEY: Web3PublicKey;
}

interface Web3Transaction {
  add(...items: unknown[]): Web3Transaction;
  recentBlockhash: string;
  feePayer: Web3PublicKey;
  sign(...signers: Web3Keypair[]): void;
  serialize(): Buffer;
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

function escrowViewingKey(): ViewingKey {
  const path = join(homedir(), ".config/zolana/escrow-pda.json");
  try {
    const saved = JSON.parse(readFileSync(path, "utf8")) as { viewing_secret_hex?: string };
    const secret = saved.viewing_secret_hex;
    if (secret === undefined || secret.length !== 64) throw new Error("escrow viewing key file is unreadable");
    return ViewingKey.fromBytes(Uint8Array.from(Buffer.from(secret, "hex")) as unknown as Bytes32);
  } catch (error) {
    if (error instanceof Error && error.message === "escrow viewing key file is unreadable") throw error;
    const created = ViewingKey.generate();
    writeFileSync(path, `${JSON.stringify({ viewing_secret_hex: Buffer.from(created.secretBytes()).toString("hex") })}\n`, {
      mode: 0o600,
    });
    chmodSync(path, 0o600);
    return created;
  }
}

function loadSeed(name: string): Uint8Array {
  const file = JSON.parse(
    readFileSync(join(homedir(), ".config/zolana", name), "utf8"),
  ) as WalletFile;
  const seed = Uint8Array.from(Buffer.from(file.funding_secret_hex, "hex"));
  if (seed.byteLength !== 32) throw new Error(`${name} funding seed is ${seed.byteLength} bytes`);
  return seed;
}

function u64(bytes: Uint8Array, offset: number): bigint {
  let value = 0n;
  for (let i = 0; i < 8; i += 1) {
    value += BigInt(bytes[offset + i] ?? 0) << BigInt(8 * i);
  }
  return value;
}

function metaToKey(meta: AccountMeta): { pubkey: Web3PublicKey; isSigner: boolean; isWritable: boolean } {
  return {
    pubkey: new web3.PublicKey(meta.address),
    isSigner: meta.role === AccountRole.READONLY_SIGNER || meta.role === AccountRole.WRITABLE_SIGNER,
    isWritable: meta.role === AccountRole.WRITABLE || meta.role === AccountRole.WRITABLE_SIGNER,
  };
}

const apiKey = heliusApiKey();
const rpcUrl = devnetRpcUrl(apiKey);
const connection = new web3.Connection(rpcUrl, "confirmed");
const programKey = new web3.PublicKey(PROGRAM_ID);
const escrowKey = new web3.PublicKey(ESCROW_ID);
const [lockPda, lockBump] = web3.PublicKey.findProgramAddressSync(
  [Buffer.from(LOCK_SEED), escrowKey.toBuffer()],
  programKey,
);

const wasmBytes = readFileSync(join(import.meta.dirname, "../../target/zk/pescrow/wasm/pescrow_bg.wasm"));
await initWasm({ module_or_path: wasmBytes });
const provingKey = readFileSync(join(import.meta.dirname, "../../target/zk/pescrow/lock.pk"));
const keyHashHex = readFileSync(
  join(import.meta.dirname, "../../target/zk/pescrow/lock.pk.sha256"),
  "utf8",
).slice(0, 64);
const prover = LockProver.fromKey(provingKey, Buffer.from(keyHashHex, "hex"));
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
const sides = [
  { file: "party-a.json", side: 0, hash: NOTE_HASHES[0], sealAt: 4, commitAt: 96 },
  { file: "party-b.json", side: 1, hash: NOTE_HASHES[1], sealAt: 5, commitAt: 128 },
] as const;

const lockSide = process.env.LOCK_SIDE;
for (const side of sides) {
  if (lockSide === "a" && side.side !== 0) continue;
  if (lockSide === "b" && side.side !== 1) continue;
  const account = await connection.getAccountInfo(escrowKey);
  if (account === null || account.data.length !== ACCOUNT_LEN) {
    throw new Error("escrow account is missing");
  }
  const data = new Uint8Array(account.data);
  if (data[88] !== lockBump) throw new Error(`escrow bump ${data[88]} is not the PDA bump ${lockBump}`);
  if (side.side === 0 && data[2] !== 1) throw new Error("party A has not approved");
  if (side.side === 1 && (data[3] !== 1 || data[4] !== 1)) {
    throw new Error("party B can lock only after A is sealed and B has approved");
  }
  if (data[side.sealAt] !== 0) {
    console.log(`${side.file} already sealed`);
    continue;
  }
  const seed = loadSeed(side.file);
  const payer = web3.Keypair.fromSeed(seed);
  const shielded = ShieldedKeypair.fromKeypair(SigningKey.fromEd25519Bytes(seed as Bytes32));
  seed.fill(0);
  const keys = LocalKeys.fromKeypair(shielded, client.proofService);
  try {
    const wallet = new Wallet({ identity: shielded.shieldedAddress() });
    await syncWallet({ client, wallet, keys });
    const buildLock = bindProgramTransaction(lockTransaction, { assets: wallet.registry });
    const note = wallet.utxos().find((utxo) => {
      return getBase58Decoder().decode(utxo.outputContext.hash) === side.hash && !utxo.spent;
    });
    if (note === undefined) throw new Error(`${side.file} has no unspent note ${side.hash}`);
    const programNote = toProgramWalletUtxo(note, {
      nullifierPublicKey: shielded.nullifierPublicKey(),
      treeId: TREE_ID,
      assets: wallet.registry,
    });
    const blindingSeed = randomBlinding();
    const lockInputs = {
      private: {
        txContext: { blindingSeed, outputTreeId: TREE_ID },
        note: [programNote],
        pda: {
          tag: SOLANA_OWNER_TAG,
          key: lockPda.toBuffer(),
          nullifierPk: pdaNullifier.publicKey(),
        },
      },
      public: {
        escrow0: u64(escrowKey.toBuffer(), 0),
        escrow1: u64(escrowKey.toBuffer(), 8),
        escrow2: u64(escrowKey.toBuffer(), 16),
        escrow3: u64(escrowKey.toBuffer(), 24),
        startAt: u64(data, 8),
        side: BigInt(side.side),
        aApproved: BigInt(data[2] ?? 0),
        bApproved: BigInt(data[3] ?? 0),
      },
    };
    let built;
    try {
      // The wasm Lock tuple and the SDK note are the same JSON shape.
      built = await buildLock(lockInputs as never, pdaAddress.toBytes(), payer.publicKey.toBase58());
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : JSON.stringify(cause);
      console.error(`wasm lock failed: ${message}`);
      throw cause instanceof Error ? cause : new Error(message);
    }
    if (process.env.LOCK_BUILD_ONLY === "1") {
      console.log(`${side.file} circuit transaction built`);
      continue;
    }
    const outputHash = built.transaction.outputHashes[0];
    if (outputHash === undefined || outputHash.byteLength !== 32) {
      throw new Error("lock produced no output hash");
    }
    const proofInputs = built.transaction.encryptWithKeys(pdaViewing);
    const proved = await client.proveTransact(proofInputs, keys);
    const circuit = prover.prove(built.proofInputs).compressedProof;
    if (circuit.a.byteLength !== 32 || circuit.b.byteLength !== 64 || circuit.c.byteLength !== 32) {
      throw new Error("circuit proof is not 128 bytes");
    }
    const transact = encodeTransactInstructionData(proved);
    const instruction = Buffer.concat([
      Buffer.from([FUND_SIDE]),
      escrowKey.toBuffer(),
      Buffer.from([side.side]),
      Buffer.from(outputHash),
      Buffer.from(circuit.a),
      Buffer.from(circuit.b),
      Buffer.from(circuit.c),
      Buffer.from(transact),
    ]);
    if (instruction.length < 1 + LOCK_HEADER + CIRCUIT_PROOF_LEN) {
      throw new Error("lock instruction is shorter than its header");
    }
    const tail = await transactCpiAccounts({
      payer: address(payer.publicKey.toBase58()),
      inputTree: RING1_TREE,
      outputTree: RING1_TREE,
      ownerSigners: [address(payer.publicKey.toBase58())],
      signerPdas: [],
      data: proved,
    });
    const pool = tail[2];
    if (pool === undefined || pool.address !== SHIELDED_POOL_PROGRAM_ID) {
      throw new Error("pool account is not at tail index 2");
    }
    const keysForIx = (tail as readonly AccountMeta[]).map(metaToKey);
    const tx = new web3.Transaction()
      .add(web3.ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNIT_LIMIT }))
      .add(
        new web3.TransactionInstruction({
          programId: programKey,
          keys: [
            { pubkey: escrowKey, isSigner: false, isWritable: true },
            { pubkey: payer.publicKey, isSigner: true, isWritable: true },
            { pubkey: web3.SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
            ...keysForIx,
          ],
          data: instruction,
        }),
      );
    const blockhash = await connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash.blockhash;
    tx.feePayer = payer.publicKey;
    tx.sign(payer);
    const simulation = await connection.simulateTransaction(tx);
    if (simulation.value.err) {
      const logs = (simulation.value.logs ?? []).join("\n");
      throw new Error(`simulation failed: ${JSON.stringify(simulation.value.err)}\n${logs}`);
    }
    const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    const confirmed = await connection.confirmTransaction(signature, "confirmed");
    if (confirmed.value.err) throw new Error(`lock ${signature} failed: ${JSON.stringify(confirmed.value.err)}`);
    const after = await connection.getAccountInfo(escrowKey);
    if (after === null) throw new Error("escrow disappeared after the lock");
    const sealed = after.data[side.sealAt] === 1;
    const stored = Buffer.from(after.data.subarray(side.commitAt, side.commitAt + 32));
    if (!sealed || !stored.equals(Buffer.from(outputHash))) {
      throw new Error(`${side.file} landed ${signature} but the seal or commitment does not match`);
    }
    console.log(
      `${side.file} locked signature=${signature} commitment=${getBase58Decoder().decode(outputHash)} pda=${lockPda.toBase58()}`,
    );
  } finally {
    keys.destroy();
  }
}

pdaNullifier.destroy();
pdaViewing.destroy();
process.exit(0);
