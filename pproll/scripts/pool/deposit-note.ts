// Ring seed and budget viewing secret arrive on stdin. They are not printed or written.

import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { join as pathJoin } from "node:path";
import { Connection, Keypair, PublicKey, type AccountMeta } from "@solana/web3.js";
import type { Bytes32 } from "../../../pescrow/sdk/node_modules/@heliuslabs/spr/dist/keypair/bytes.js";
import type { Address } from "../../../pescrow/sdk/node_modules/@heliuslabs/spr/dist/interface/types.js";
import {
  LocalKeys,
  ShieldedAddress,
  ShieldedKeypair,
  SigningKey,
  Wallet,
  createSprClient,
  syncWallet,
} from "../../../pescrow/sdk/node_modules/@heliuslabs/spr/dist/index.js";
import { SignedTeePolicy } from "../../../pescrow/sdk/node_modules/@heliuslabs/spr/dist/client/index.js";
import { prepareTransfer } from "../../../pescrow/sdk/node_modules/@heliuslabs/spr/dist/client/prover/assembly.js";
import { proveThroughAuthority } from "../../../pescrow/sdk/node_modules/@heliuslabs/spr/dist/client/prover/indexed.js";
import { compressProof } from "../../../pescrow/sdk/node_modules/@heliuslabs/spr/dist/client/prover/proof.js";
import { encodeTransactInstructionData } from "../../../pescrow/sdk/node_modules/@heliuslabs/spr/dist/interface/index.js";
import { initializePoseidon } from "../../../pescrow/sdk/node_modules/@heliuslabs/spr/dist/hasher/index.js";
import { ViewingKey, randomBlinding } from "../../../pescrow/sdk/node_modules/@heliuslabs/spr/dist/keypair/index.js";
import {
  ProgramOwner,
  bindProgramTransaction,
  toProgramWalletUtxo,
  transactCpiAccounts,
} from "../../../pescrow/sdk/node_modules/@heliuslabs/spr/dist/program/index.js";
import type { ProgramTransaction, ProgramTransactionKeys } from "../../../pescrow/sdk/node_modules/@heliuslabs/spr/dist/program/program-transaction.js";
import type { WalletUtxo } from "../../../pescrow/sdk/node_modules/@heliuslabs/spr/dist/transaction/wallet/state.js";
import type { TransactInstructionData } from "../../../pescrow/sdk/node_modules/@heliuslabs/spr/dist/interface/types.js";
import { heliusRpcUrl } from "../../../src/lib/helius-rpc.ts";
import {
  DEPOSIT_COMPUTE_UNIT_LIMIT,
  DEPOSIT_IX,
  MISSING_BUDGET_VIEWING_KEY,
  NOTE_NOT_IN_BALANCE,
  ROOT_MOVED,
  alignDepositTreeContext,
  vaultDepositRefusal,
  type PreparedDeposit,
} from "../../../src/lib/budget-deposit.ts";
import init, { DepositProver, depositTransaction } from "../../target/zk/pproll/wasm/node.mjs";

const PROGRAM_ID = "5e6tZK4jSgHWUDW64PqRQwJBgN9VpgFEpcYiw5N9Lux6";
const RING1_TREE = "777pvSGe5LaBd9nCczvE2FXEauiwtfGJ5XRpjKyniGor";
const POOL_ID = "ring1GaLCuJnkUMVkX2JeZLTTX17wKsV4fZmPVzXANW";
const ESCROW_NOTE = "xUiK4RZz4JerbRzZjHVaBgaQM46A45eYhZ2uBMggNzY";
const POOL_SEED = "user-pool";
const SOLANA_OWNER_TAG = 0x53;
const TREE_ID = 0;
const FIELD_BYTES = 32;
const PROOF_A = 32;
const PROOF_B = 64;
const PROOF_C = 32;
const ROLE_WRITABLE = 1;
const ROLE_READONLY_SIGNER = 2;
const ROLE_WRITABLE_SIGNER = 3;
const HEX_32 = /^[0-9a-f]{64}$/i;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const ESCROW_NOTE_BYTES = new PublicKey(ESCROW_NOTE).toBytes();
const HERE = fileURLToPath(new URL(".", import.meta.url));
const programKey = new PublicKey(PROGRAM_ID);

type DepositJob = {
  readonly owner: string;
  readonly vault: string;
  readonly note: string;
  readonly seed: string;
  readonly viewingSecret: string;
  readonly ownerHash: string;
};

export async function prepareBudgetDeposit(value: unknown): Promise<PreparedDeposit> {
  const job = readJob(value);
  const owner = new PublicKey(job.owner);
  const vault = new PublicKey(job.vault);
  const seed = Buffer.from(job.seed, "hex");
  const secret = Buffer.from(job.viewingSecret, "hex");
  let secretCopy = new Uint8Array(0);
  let viewing: ViewingKey | null = null;
  let shielded: ShieldedKeypair | null = null;
  let keys: LocalKeys | null = null;
  try {
    if (seed.length !== FIELD_BYTES || secret.length !== FIELD_BYTES) {
      throw new Error("The budget deposit could not be prepared.");
    }
    const connection = new Connection(heliusRpcUrl(), "confirmed");
    const info = await connection.getAccountInfo(vault, "confirmed");
    const refusal = vaultDepositRefusal(info?.data ?? new Uint8Array(), owner.toBytes(), job.ownerHash);
    if (refusal !== null) throw new Error(refusal);
    secretCopy = Uint8Array.from(secret);
    viewing = ViewingKey.fromBytes(bytes32(secretCopy));
    await initializePoseidon();
    await init({ threads: 1 });
    const destination = pdaAddress(poolPda(owner), viewing);
    if (Buffer.from(destination.ownerHash()).toString("hex") !== job.ownerHash) {
      throw new Error(MISSING_BUDGET_VIEWING_KEY);
    }
    const seedCopy = Uint8Array.from(seed);
    const ring = Keypair.fromSeed(seedCopy).publicKey;
    shielded = ShieldedKeypair.fromKeypair(SigningKey.fromEd25519Bytes(bytes32(seedCopy)));
    seedCopy.fill(0);
    const client = await createSprClient({
      solanaRpcUrl: heliusRpcUrl(),
      proverTee: SignedTeePolicy.forNetwork("devnet"),
    });
    keys = LocalKeys.fromKeypair(shielded, client.proofService);
    const wallet = new Wallet({ identity: shielded.shieldedAddress() });
    await syncWallet({ client, wallet, keys });
    const note = findNote(wallet, job.note);
    const build = bindProgramTransaction(depositTransaction, { assets: wallet.registry });
    const built = await build(
      {
        private: {
          txContext: { blindingSeed: randomBlinding(), outputTreeId: TREE_ID },
          note: [toProgramWalletUtxo(note, { nullifierPublicKey: shielded.nullifierPublicKey(), treeId: TREE_ID, assets: wallet.registry })],
          pool: pdaOwner(poolPda(owner)),
        },
        public: { hash: destination.ownerHash() },
      },
      destination.toBytes(),
      ring.toBase58(),
    );
    const prover = depositProver();
    try {
      const proved = await proveMove(connection, keys, viewing, built, prover);
      const tail = await tailAccounts(owner, ring, proved.proved);
      const data = proved.instruction;
      return {
        computeUnitLimit: DEPOSIT_COMPUTE_UNIT_LIMIT,
        programId: PROGRAM_ID,
        dataHex: data.toString("hex"),
        keys: vaultAccounts(vault, owner, tail).map(metaJson),
        lookupAddresses: unique(tail.map((key) => key.pubkey.toBase58())),
      };
    } finally {
      prover.free();
    }
  } finally {
    seed.fill(0);
    secret.fill(0);
    secretCopy.fill(0);
    keys?.destroy();
    shielded?.destroy();
    viewing?.destroy();
  }
}

function readJob(value: unknown): DepositJob {
  if (typeof value !== "object" || value === null) throw new Error("The budget deposit could not be prepared.");
  const record = value as Record<string, unknown>;
  if (!pubkey(record.owner) || !pubkey(record.vault) || !pubkey(record.note)) {
    throw new Error("The budget deposit could not be prepared.");
  }
  if (!hex32(record.seed) || !hex32(record.viewingSecret) || !hex32(record.ownerHash)) {
    throw new Error("The budget deposit could not be prepared.");
  }
  return {
    owner: record.owner,
    vault: record.vault,
    note: record.note,
    seed: record.seed.toLowerCase(),
    viewingSecret: record.viewingSecret.toLowerCase(),
    ownerHash: record.ownerHash.toLowerCase(),
  };
}

function findNote(wallet: Wallet, hash: string): WalletUtxo {
  const note = wallet
    .utxos()
    .filter((utxo) => utxo.outputContext.tree === asAddress(RING1_TREE) && !utxo.spent)
    .find((utxo) => noteHash(utxo) === hash && utxo.utxo.amount > BigInt(0) && !isEscrowNote(utxo));
  if (note === undefined) throw new Error(NOTE_NOT_IN_BALANCE);
  return note;
}

async function proveMove(
  connection: Connection,
  keys: LocalKeys,
  viewing: ProgramTransactionKeys,
  built: ProgramTransaction,
  prover: DepositProver,
): Promise<{ proved: TransactInstructionData; instruction: Buffer }> {
  const prepared = prepareTransfer(built.transaction.encryptWithKeys(viewing), { kind: "confidential" });
  const circuit = prover.prove(built.proofInputs).compressedProof;
  if (circuit.a.byteLength !== PROOF_A || circuit.b.byteLength !== PROOF_B || circuit.c.byteLength !== PROOF_C) {
    throw new Error("circuit proof is not 128 bytes");
  }
  const circuitProof = Buffer.concat([Buffer.from(circuit.a), Buffer.from(circuit.b), Buffer.from(circuit.c)]);
  let moved: Error = new Error(ROOT_MOVED);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const slot = await connection.getSlot("confirmed");
    const { proof, trees } = await proveThroughAuthority(keys, { ...prepared.inputs, minContextSlot: BigInt(slot) });
    const complete = prepared.finish(trees);
    const proved = complete.withProof(compressProof(proof).toTransactProof());
    const encoded = Buffer.concat([Buffer.from([DEPOSIT_IX]), circuitProof, Buffer.from(encodeTransactInstructionData(proved))]);
    const info = await connection.getAccountInfo(new PublicKey(RING1_TREE), "confirmed");
    try {
      const instruction = alignDepositTreeContext(encoded, info?.data ?? new Uint8Array(), {
        utxoRoot: new Uint8Array(complete.roots.stateRoot),
        nullifierRoot: new Uint8Array(complete.roots.nullifierRoot),
      });
      return { proved, instruction: Buffer.from(instruction) };
    } catch (error) {
      moved = error instanceof Error ? error : new Error(ROOT_MOVED);
      if (moved.message !== ROOT_MOVED || attempt === 1) throw moved;
    }
  }
  throw moved;
}

/** The spent note belongs to the ring key, not the wallet. The pool only accepts a spend its owner signs. */
async function tailAccounts(payer: PublicKey, ring: PublicKey, proved: TransactInstructionData): Promise<AccountMeta[]> {
  const tail = await transactCpiAccounts({
    payer: asAddress(payer.toBase58()),
    inputTree: asAddress(RING1_TREE),
    outputTree: asAddress(RING1_TREE),
    ownerSigners: [asAddress(ring.toBase58())],
    signerPdas: [],
    data: proved,
  });
  const pool = tail[2];
  if (pool?.address !== POOL_ID) throw new Error("pool account is not at tail index 2");
  return tail.map(metaToKey);
}

function depositProver(): DepositProver {
  const zkDir = pathJoin(HERE, "../../target/zk/pproll");
  const provingKey = readFileSync(pathJoin(zkDir, "deposit.pk"));
  const keyHashHex = readFileSync(pathJoin(zkDir, "deposit.pk.sha256"), "utf8").slice(0, FIELD_BYTES * 2);
  return DepositProver.fromKey(provingKey, Buffer.from(keyHashHex, "hex"));
}

function vaultAccounts(vault: PublicKey, owner: PublicKey, tail: AccountMeta[]): AccountMeta[] {
  return [
    { pubkey: vault, isSigner: false, isWritable: true },
    { pubkey: owner, isSigner: true, isWritable: true },
    ...tail,
  ];
}

function poolPda(owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from(POOL_SEED), owner.toBuffer()], programKey)[0];
}

function pdaAddress(pda: PublicKey, viewing: ViewingKey): ShieldedAddress {
  const key = ProgramOwner.nullifierKey();
  try {
    return ShieldedAddress.forPda({
      pda: bytes32(pda.toBytes()),
      nullifierPublicKey: bytes32(key.publicKey()),
      viewingPublicKey: viewing.publicKey(),
    });
  } finally {
    key.destroy();
  }
}

function pdaOwner(pda: PublicKey): { tag: number; key: Uint8Array; nullifierPk: Bytes32 } {
  const key = ProgramOwner.nullifierKey();
  try {
    return { tag: SOLANA_OWNER_TAG, key: pda.toBuffer(), nullifierPk: bytes32(key.publicKey()) };
  } finally {
    key.destroy();
  }
}

function noteHash(utxo: WalletUtxo): string {
  return new PublicKey(utxo.outputContext.hash).toBase58();
}

function isEscrowNote(utxo: WalletUtxo): boolean {
  return Buffer.from(utxo.outputContext.hash).equals(Buffer.from(ESCROW_NOTE_BYTES));
}

function metaToKey(meta: { address: string; role: number }): AccountMeta {
  return {
    pubkey: new PublicKey(meta.address),
    isSigner: meta.role === ROLE_READONLY_SIGNER || meta.role === ROLE_WRITABLE_SIGNER,
    isWritable: meta.role === ROLE_WRITABLE || meta.role === ROLE_WRITABLE_SIGNER,
  };
}

function metaJson(meta: AccountMeta): PreparedDeposit["keys"][number] {
  return { pubkey: meta.pubkey.toBase58(), isSigner: meta.isSigner, isWritable: meta.isWritable };
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function asAddress(value: string): Address {
  return new PublicKey(value).toBase58() as Address;
}

function bytes32(value: Uint8Array): Bytes32 {
  if (value.byteLength !== FIELD_BYTES) throw new Error("expected 32 bytes");
  return value as Bytes32;
}

function pubkey(value: unknown): value is string {
  return typeof value === "string" && BASE58.test(value);
}

function hex32(value: unknown): value is string {
  return typeof value === "string" && HEX_32.test(value);
}
