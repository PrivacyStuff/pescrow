// Payroll viewing secrets and the payee ring seed arrive on stdin. They are not printed.

import { readFileSync } from "node:fs";
import { join as pathJoin } from "node:path";
import { fileURLToPath } from "node:url";
import { Connection, PublicKey, type AccountMeta } from "@solana/web3.js";
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
import { encodeTransactInstructionData } from "../../../pescrow/sdk/node_modules/@heliuslabs/spr/dist/interface/index.js";
import { initializePoseidon, poseidon } from "../../../pescrow/sdk/node_modules/@heliuslabs/spr/dist/hasher/index.js";
import { ViewingKey, randomBlinding } from "../../../pescrow/sdk/node_modules/@heliuslabs/spr/dist/keypair/index.js";
import {
  ProgramOwner,
  bindProgramTransaction,
  toProgramWalletUtxo,
  transactCpiAccounts,
} from "../../../pescrow/sdk/node_modules/@heliuslabs/spr/dist/program/index.js";
import { ShieldedPda } from "../../../pescrow/sdk/node_modules/@heliuslabs/spr/dist/program/shielded-pda.js";
import type { ProgramTransaction, ProgramTransactionKeys } from "../../../pescrow/sdk/node_modules/@heliuslabs/spr/dist/program/program-transaction.js";
import type { WalletUtxo } from "../../../pescrow/sdk/node_modules/@heliuslabs/spr/dist/transaction/wallet/state.js";
import type { TransactInstructionData } from "../../../pescrow/sdk/node_modules/@heliuslabs/spr/dist/interface/types.js";
import { heliusRpcUrl } from "../../../src/lib/helius-rpc.ts";
import { MISSING_BUDGET_VIEWING_KEY, type PreparedDeposit } from "../../../src/lib/budget-deposit.ts";
import { IX_INITIATE, IX_PAY, PPROLL_PROGRAM_ID } from "../../../src/lib/payroll-account.ts";
import {
  BUDGET_NOTE_TOO_SMALL,
  KEEPS_NOTE,
  MILESTONE_NOT_DUE,
  MISSING_PAYROLL_KEY,
  NOT_READY_TO_CRANK,
  NOT_READY_TO_FUND,
  PAYROLL_NOTE_MISSING,
  PUT_NOTE_IN_BUDGET,
  WRONG_SHIELDED_OWNER,
  payBuildFailure,
} from "../../../src/lib/payroll-roll.ts";
import { be32, limbs } from "./commitment.ts";
import init, { InitiateProver, PayProver, initiateTransaction, payTransaction } from "../../target/zk/pproll/wasm/node.mjs";

const RING1_TREE = "777pvSGe5LaBd9nCczvE2FXEauiwtfGJ5XRpjKyniGor";
const POOL_ID = "ring1GaLCuJnkUMVkX2JeZLTTX17wKsV4fZmPVzXANW";
const ESCROW_NOTE = "xUiK4RZz4JerbRzZjHVaBgaQM46A45eYhZ2uBMggNzY";
const POOL_SEED = "user-pool";
const NOTE_SEED = "payroll";
const SOLANA_OWNER_TAG = 0x53;
const TREE_ID = 0;
const FIELD_BYTES = 32;
const PROOF_A = 32;
const PROOF_B = 64;
const PROOF_C = 32;
const COMPUTE_UNIT_LIMIT = 1_400_000;
const PAYROLL_LEN = 264;
const VAULT_LEN = 112;
const PAYROLL_TAG = 5;
const VAULT_TAG = 4;
const LIVE_NOTE = 1;
const STATUS_PROPOSED = 1;
const STATUS_ACTIVE = 2;
const CLOCK_UNIX_OFFSET = 32;
const PAY_OFF_STATUS = 1;
const PAY_OFF_FROZEN = 4;
const PAY_OFF_START = 8;
const PAY_OFF_PERIOD = 24;
const PAY_OFF_EMPLOYER = 32;
const PAY_OFF_PAYEE = 64;
const PAY_OFF_PAYEE_HASH = 96;
const PAY_OFF_NOTE_HASH = 128;
const PAY_OFF_INSTALLMENT = 160;
const PAY_OFF_BUDGET = 192;
const PAY_OFF_NEXT = 260;
const VAULT_OFF_LIVE = 1;
const VAULT_OFF_OWNER = 8;
const VAULT_OFF_HASH = 40;
const ROLE_WRITABLE = 1;
const ROLE_READONLY_SIGNER = 2;
const ROLE_WRITABLE_SIGNER = 3;
const HEX_32 = /^[0-9a-f]{64}$/i;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const AMOUNT = /^\d{1,20}$/;
const U64_MAX = (BigInt(1) << BigInt(64)) - BigInt(1);
const CLOCK = new PublicKey("SysvarC1ock11111111111111111111111111111111");
const ESCROW_NOTE_BYTES = new PublicKey(ESCROW_NOTE).toBytes();
const HERE = fileURLToPath(new URL(".", import.meta.url));
const programKey = new PublicKey(PPROLL_PROGRAM_ID);

type Client = Awaited<ReturnType<typeof createSprClient>>;
type CircuitProver = { prove(proofInputs: Uint8Array): { compressedProof: { a: Uint8Array; b: Uint8Array; c: Uint8Array } }; free(): void };

type InitiateJob = {
  readonly owner: string;
  readonly payroll: string;
  readonly vault: string;
  readonly viewingSecret: string;
  readonly budgetViewingSecret: string;
  readonly budgetAmount: string;
  readonly budgetBlinding: string;
};

type PayJob = {
  readonly owner: string;
  readonly payroll: string;
  readonly seed: string;
  readonly viewingSecret: string;
  readonly installmentAmount: string;
  readonly installmentBlinding: string;
};

/**
 * Unsigned initiate. Circuit inputs match `initiatePayroll` in `lib.ts`:
 * the budget note moves onto the payroll PDA and the pool keeps the change.
 */
export async function prepareInitiate(value: unknown): Promise<PreparedDeposit> {
  const job = readInitiate(value);
  const employer = new PublicKey(job.owner);
  const payroll = new PublicKey(job.payroll);
  const vault = new PublicKey(job.vault);
  const budget = parseAmount(job.budgetAmount, NOT_READY_TO_FUND);
  const secret = Buffer.from(job.viewingSecret, "hex");
  const budgetSecret = Buffer.from(job.budgetViewingSecret, "hex");
  const blind = Buffer.from(job.budgetBlinding, "hex");
  let secretCopy = new Uint8Array(0);
  let budgetCopy = new Uint8Array(0);
  let poolViewing: ViewingKey | null = null;
  let payrollViewing: ViewingKey | null = null;
  let keys: LocalKeys | null = null;
  let identity: ShieldedPda | null = null;
  try {
    const connection = new Connection(heliusRpcUrl(), "confirmed");
    const payrollInfo = await ownedAccount(connection, payroll, PAYROLL_LEN, NOT_READY_TO_FUND);
    const vaultInfo = await ownedAccount(connection, vault, VAULT_LEN, NOT_READY_TO_FUND);
    if (payrollInfo[0] !== PAYROLL_TAG || vaultInfo[0] !== VAULT_TAG) throw new Error(NOT_READY_TO_FUND);
    if (!pubkeyAt(payrollInfo, PAY_OFF_EMPLOYER).equals(employer)) throw new Error(NOT_READY_TO_FUND);
    if (!pubkeyAt(vaultInfo, VAULT_OFF_OWNER).equals(employer)) throw new Error(NOT_READY_TO_FUND);
    if (payrollInfo[PAY_OFF_FROZEN] !== 1 || payrollInfo[PAY_OFF_STATUS] !== STATUS_PROPOSED) throw new Error(NOT_READY_TO_FUND);
    if (isZero(payrollInfo.subarray(PAY_OFF_PAYEE_HASH, PAY_OFF_PAYEE_HASH + FIELD_BYTES))) throw new Error(NOT_READY_TO_FUND);
    if (vaultInfo[VAULT_OFF_LIVE] !== LIVE_NOTE) throw new Error(PUT_NOTE_IN_BUDGET);
    secretCopy = Uint8Array.from(secret);
    budgetCopy = Uint8Array.from(budgetSecret);
    payrollViewing = ViewingKey.fromBytes(bytes32(secretCopy));
    poolViewing = ViewingKey.fromBytes(bytes32(budgetCopy));
    await initializePoseidon();
    const payrollNote = notePda(payroll);
    const pool = poolPda(employer);
    const destination = pdaAddress(payrollNote, payrollViewing);
    const poolAddress = pdaAddress(pool, poolViewing);
    if (!same32(payrollInfo, PAY_OFF_NOTE_HASH, destination.ownerHash())) throw new Error(MISSING_PAYROLL_KEY);
    if (!same32(vaultInfo, VAULT_OFF_HASH, poolAddress.ownerHash())) throw new Error(MISSING_BUDGET_VIEWING_KEY);
    const committed = await commitment(budget, blind);
    if (!same32(payrollInfo, PAY_OFF_BUDGET, committed)) throw new Error(MISSING_PAYROLL_KEY);
    await init({ threads: 1 });
    const client = await spr();
    const pda = await pdaWallet(client, pool, poolViewing);
    keys = pda.keys;
    identity = pda.identity;
    const note = pickNote(liveNotes(pda.wallet), budget, BUDGET_NOTE_TOO_SMALL);
    const [blind0, blind1, blind2, blind3] = limbs(blind);
    const build = bindProgramTransaction(initiateTransaction, { assets: pda.wallet.registry });
    const built = await build(
      {
        private: {
          txContext: { blindingSeed: randomBlinding(), outputTreeId: TREE_ID },
          note: [asProgram(note, ProgramOwner.nullifierPublicKey(), pda.wallet.registry)],
          amount: budget,
          blind0,
          blind1,
          blind2,
          blind3,
          payroll: pdaOwner(payrollNote),
          poolAddress: poolAddress.toBytes(),
        },
        public: { budget: committed, note: destination.ownerHash(), keepsNote: BigInt(KEEPS_NOTE) },
      } as unknown as Parameters<typeof initiateTransaction>[0],
      destination.toBytes(),
      employer.toBase58(),
    );
    const proved = await proveMove(client, pda.keys, payrollViewing, built, proverFor("initiate", InitiateProver));
    const tail = await tailAccounts(employer, [], [pool], proved.proved);
    return prepared(Buffer.concat([Buffer.from([IX_INITIATE, KEEPS_NOTE]), proved.data]), initiateAccounts(payroll, vault, employer, tail), tail);
  } finally {
    secret.fill(0);
    budgetSecret.fill(0);
    blind.fill(0);
    secretCopy.fill(0);
    budgetCopy.fill(0);
    keys?.destroy();
    identity?.destroy();
    poolViewing?.destroy();
    payrollViewing?.destroy();
  }
}

/**
 * Unsigned pay. Circuit inputs match `payPayroll` in `lib.ts`:
 * one installment leaves the payroll note for the payee's shielded owner.
 */
export async function preparePay(value: unknown): Promise<PreparedDeposit> {
  const job = readPay(value);
  const payee = new PublicKey(job.owner);
  const payroll = new PublicKey(job.payroll);
  const installment = parseAmount(job.installmentAmount, NOT_READY_TO_CRANK);
  const seed = Buffer.from(job.seed, "hex");
  const secret = Buffer.from(job.viewingSecret, "hex");
  const blind = Buffer.from(job.installmentBlinding, "hex");
  let seedCopy = new Uint8Array(0);
  let secretCopy = new Uint8Array(0);
  let payrollViewing: ViewingKey | null = null;
  let shielded: ShieldedKeypair | null = null;
  let personKeys: LocalKeys | null = null;
  let pdaKeys: LocalKeys | null = null;
  let identity: ShieldedPda | null = null;
  try {
    const connection = new Connection(heliusRpcUrl(), "confirmed");
    const payrollInfo = await ownedAccount(connection, payroll, PAYROLL_LEN, NOT_READY_TO_CRANK);
    if (payrollInfo[0] !== PAYROLL_TAG) throw new Error(NOT_READY_TO_CRANK);
    if (!pubkeyAt(payrollInfo, PAY_OFF_PAYEE).equals(payee)) throw new Error(NOT_READY_TO_CRANK);
    if (payrollInfo[PAY_OFF_STATUS] !== STATUS_ACTIVE) throw new Error(NOT_READY_TO_CRANK);
    if (isZero(payrollInfo.subarray(PAY_OFF_PAYEE_HASH, PAY_OFF_PAYEE_HASH + FIELD_BYTES))) throw new Error(NOT_READY_TO_CRANK);
    const next = payrollInfo.readUInt32LE(PAY_OFF_NEXT);
    const due = claimDue(payrollInfo.readBigInt64LE(PAY_OFF_START), payrollInfo.readBigInt64LE(PAY_OFF_PERIOD), next);
    const now = await clockNow(connection);
    if (now < due) throw new Error(MILESTONE_NOT_DUE);
    secretCopy = Uint8Array.from(secret);
    seedCopy = Uint8Array.from(seed);
    payrollViewing = ViewingKey.fromBytes(bytes32(secretCopy));
    await initializePoseidon();
    const payrollNote = notePda(payroll);
    const payrollAddress = pdaAddress(payrollNote, payrollViewing);
    if (!same32(payrollInfo, PAY_OFF_NOTE_HASH, payrollAddress.ownerHash())) throw new Error(MISSING_PAYROLL_KEY);
    const committed = await commitment(installment, blind);
    if (!same32(payrollInfo, PAY_OFF_INSTALLMENT, committed)) throw new Error(MISSING_PAYROLL_KEY);
    await init({ threads: 1 });
    const client = await spr();
    shielded = ShieldedKeypair.fromKeypair(SigningKey.fromEd25519Bytes(bytes32(seedCopy)));
    seedCopy.fill(0);
    if (!same32(payrollInfo, PAY_OFF_PAYEE_HASH, shielded.ownerHash())) throw new Error(WRONG_SHIELDED_OWNER);
    personKeys = LocalKeys.fromKeypair(shielded, client.proofService);
    const pda = await pdaWallet(client, payrollNote, payrollViewing);
    pdaKeys = pda.keys;
    identity = pda.identity;
    const source = pickNote(liveNotes(pda.wallet), BigInt(0), PAYROLL_NOTE_MISSING);
    const [blind0, blind1, blind2, blind3] = limbs(blind);
    const pay = labelledBuild(payTransaction);
    const build = bindProgramTransaction(pay.build, { assets: pda.wallet.registry });
    const built = await build(
      {
        private: {
          txContext: { blindingSeed: randomBlinding(), outputTreeId: TREE_ID },
          note: [asProgram(source, ProgramOwner.nullifierPublicKey(), pda.wallet.registry)],
          amount: installment,
          blind0,
          blind1,
          blind2,
          blind3,
          payee: payeeOwner(shielded),
          payrollAddress: payrollAddress.toBytes(),
        },
        public: {
          index: BigInt(next),
          due,
          installment: committed,
          payee: shielded.ownerHash(),
        },
      } as unknown as Parameters<typeof payTransaction>[0],
      shielded.shieldedAddress().toBytes(),
      payee.toBase58(),
    ).catch((error: unknown) => {
      const label = pay.label();
      throw label === null ? error : new Error(payBuildFailure(label));
    });
    const proved = await proveMove(client, pda.keys, shielded, built, proverFor("pay", PayProver));
    const tail = await tailAccounts(payee, [], [payrollNote], proved.proved);
    return prepared(Buffer.concat([Buffer.from([IX_PAY]), proved.data]), payAccounts(payroll, payee, tail), tail);
  } finally {
    seed.fill(0);
    secret.fill(0);
    blind.fill(0);
    seedCopy.fill(0);
    secretCopy.fill(0);
    pdaKeys?.destroy();
    identity?.destroy();
    personKeys?.destroy();
    shielded?.destroy();
    payrollViewing?.destroy();
  }
}

function readInitiate(value: unknown): InitiateJob {
  const record = recordOf(value);
  if (!pubkey(record.owner) || !pubkey(record.payroll) || !pubkey(record.vault)) throw new Error(NOT_READY_TO_FUND);
  if (!hex32(record.viewingSecret) || !hex32(record.budgetViewingSecret) || !hex32(record.budgetBlinding)) {
    throw new Error(MISSING_PAYROLL_KEY);
  }
  if (!amountText(record.budgetAmount)) throw new Error(NOT_READY_TO_FUND);
  return {
    owner: record.owner,
    payroll: record.payroll,
    vault: record.vault,
    viewingSecret: record.viewingSecret.toLowerCase(),
    budgetViewingSecret: record.budgetViewingSecret.toLowerCase(),
    budgetAmount: record.budgetAmount,
    budgetBlinding: record.budgetBlinding.toLowerCase(),
  };
}

function readPay(value: unknown): PayJob {
  const record = recordOf(value);
  if (!pubkey(record.owner) || !pubkey(record.payroll)) throw new Error(NOT_READY_TO_CRANK);
  if (!hex32(record.seed) || !hex32(record.viewingSecret) || !hex32(record.installmentBlinding)) {
    throw new Error(MISSING_PAYROLL_KEY);
  }
  if (!amountText(record.installmentAmount)) throw new Error(NOT_READY_TO_CRANK);
  return {
    owner: record.owner,
    payroll: record.payroll,
    seed: record.seed.toLowerCase(),
    viewingSecret: record.viewingSecret.toLowerCase(),
    installmentAmount: record.installmentAmount,
    installmentBlinding: record.installmentBlinding.toLowerCase(),
  };
}

function recordOf(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) throw new Error(NOT_READY_TO_FUND);
  return value as Record<string, unknown>;
}

async function ownedAccount(connection: Connection, key: PublicKey, length: number, failure: string): Promise<Buffer> {
  const info = await connection.getAccountInfo(key, "confirmed");
  if (info === null || !info.owner.equals(programKey) || info.data.length !== length) throw new Error(failure);
  return info.data;
}

async function clockNow(connection: Connection): Promise<bigint> {
  const info = await connection.getAccountInfo(CLOCK, "confirmed");
  if (info === null) throw new Error(NOT_READY_TO_CRANK);
  return info.data.readBigInt64LE(CLOCK_UNIX_OFFSET);
}

function claimDue(startAt: bigint, periodSecs: bigint, index: number): bigint {
  return startAt + (BigInt(index) + BigInt(1)) * periodSecs;
}

async function spr(): Promise<Client> {
  return createSprClient({
    solanaRpcUrl: heliusRpcUrl(),
    proverTee: SignedTeePolicy.forNetwork("devnet"),
  });
}

async function pdaWallet(
  client: Client,
  pda: PublicKey,
  viewing: ViewingKey,
): Promise<{ identity: ShieldedPda; keys: LocalKeys; wallet: Wallet }> {
  const identity = ShieldedPda.withViewingKey(bytes32(pda.toBytes()), ProgramOwner.nullifierKey(), viewing.clone());
  const keys = LocalKeys.fromKeys(
    {
      address: identity.shieldedAddress(),
      viewingKeys: [identity.viewingKey()],
      nullifierKey: ProgramOwner.nullifierKey(),
    },
    client.proofService,
  );
  const wallet = new Wallet({ identity: identity.shieldedAddress() });
  await syncWallet({ client, wallet, keys });
  return { identity, keys, wallet };
}

function liveNotes(wallet: Wallet): WalletUtxo[] {
  return wallet
    .utxos()
    .filter((utxo) => utxo.outputContext.tree === asAddress(RING1_TREE) && !utxo.spent)
    .filter((utxo) => !Buffer.from(utxo.outputContext.hash).equals(Buffer.from(ESCROW_NOTE_BYTES)));
}

function pickNote(notes: readonly WalletUtxo[], minimum: bigint, failure: string): WalletUtxo {
  const fits = notes
    .filter((note) => note.utxo.amount > minimum)
    .sort((left, right) => (left.utxo.amount < right.utxo.amount ? -1 : 1));
  const note = fits[0];
  if (note === undefined) throw new Error(failure);
  return note;
}

/** The SDK keeps only TRANSACTION_PROGRAM_BUILD. The circuit assertion label is kept here for mapping, not printed. */
function labelledBuild<A extends unknown[], R>(build: (...args: A) => R): { build: (...args: A) => R; label: () => string | null } {
  let label: string | null = null;
  return {
    build: (...args: A): R => {
      try {
        return build(...args);
      } catch (error) {
        label = error instanceof Error ? error.message : String(error);
        throw error;
      }
    },
    label: () => label,
  };
}

function asProgram(note: WalletUtxo, nullifierPk: Bytes32, registry: Wallet["registry"]): ReturnType<typeof toProgramWalletUtxo> {
  return toProgramWalletUtxo(note, { nullifierPublicKey: nullifierPk, treeId: TREE_ID, assets: registry });
}

async function proveMove(
  client: Client,
  keys: LocalKeys,
  viewing: ProgramTransactionKeys,
  built: ProgramTransaction,
  prover: CircuitProver,
): Promise<{ proved: TransactInstructionData; data: Buffer }> {
  try {
    const proved = await client.proveTransact(built.transaction.encryptWithKeys(viewing), keys);
    const circuit = prover.prove(built.proofInputs).compressedProof;
    if (circuit.a.byteLength !== PROOF_A || circuit.b.byteLength !== PROOF_B || circuit.c.byteLength !== PROOF_C) {
      throw new Error("circuit proof is not 128 bytes");
    }
    return {
      proved,
      data: Buffer.concat([
        Buffer.from(circuit.a),
        Buffer.from(circuit.b),
        Buffer.from(circuit.c),
        Buffer.from(encodeTransactInstructionData(proved)),
      ]),
    };
  } finally {
    prover.free();
  }
}

function proverFor(name: "initiate" | "pay", ctor: { fromKey(provingKey: Uint8Array, expectedSha256: Uint8Array): CircuitProver }): CircuitProver {
  const zkDir = pathJoin(HERE, "../../target/zk/pproll");
  const provingKey = readFileSync(pathJoin(zkDir, `${name}.pk`));
  const keyHashHex = readFileSync(pathJoin(zkDir, `${name}.pk.sha256`), "utf8").slice(0, FIELD_BYTES * 2);
  return ctor.fromKey(provingKey, Buffer.from(keyHashHex, "hex"));
}

async function tailAccounts(payer: PublicKey, ownerSigners: PublicKey[], signerPdas: PublicKey[], proved: TransactInstructionData): Promise<AccountMeta[]> {
  const tail = await transactCpiAccounts({
    payer: asAddress(payer.toBase58()),
    inputTree: asAddress(RING1_TREE),
    outputTree: asAddress(RING1_TREE),
    ownerSigners: ownerSigners.map((key) => asAddress(key.toBase58())),
    signerPdas: signerPdas.map((key) => asAddress(key.toBase58())),
    data: proved,
  });
  const pool = tail[2];
  if (pool?.address !== POOL_ID) throw new Error("pool account is not at tail index 2");
  return tail.map(metaToKey);
}

function initiateAccounts(payroll: PublicKey, vault: PublicKey, employer: PublicKey, tail: AccountMeta[]): AccountMeta[] {
  return [
    { pubkey: payroll, isSigner: false, isWritable: true },
    { pubkey: vault, isSigner: false, isWritable: true },
    { pubkey: employer, isSigner: true, isWritable: true },
    ...tail,
  ];
}

function payAccounts(payroll: PublicKey, payee: PublicKey, tail: AccountMeta[]): AccountMeta[] {
  return [
    { pubkey: payroll, isSigner: false, isWritable: true },
    { pubkey: payee, isSigner: true, isWritable: true },
    { pubkey: CLOCK, isSigner: false, isWritable: false },
    ...tail,
  ];
}

function prepared(data: Buffer, keys: AccountMeta[], tail: AccountMeta[]): PreparedDeposit {
  return {
    computeUnitLimit: COMPUTE_UNIT_LIMIT,
    programId: PPROLL_PROGRAM_ID,
    dataHex: data.toString("hex"),
    keys: keys.map(metaJson),
    lookupAddresses: [...new Set(tail.map((key) => key.pubkey.toBase58()))],
  };
}

async function commitment(amount: bigint, blinding: Uint8Array): Promise<Uint8Array> {
  await initializePoseidon();
  return poseidon([be32(amount), blinding]);
}

function poolPda(owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from(POOL_SEED), owner.toBuffer()], programKey)[0];
}

function notePda(payroll: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from(NOTE_SEED), payroll.toBuffer()], programKey)[0];
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

/**
 * The payroll commits `shielded.ownerHash()`, which hashes the ring signing key.
 * The browser ring seed is not the wallet secret, so the wallet key would miss that hash.
 */
export function payeeOwner(shielded: ShieldedKeypair): { tag: number; key: Uint8Array; nullifierPk: Bytes32 } {
  return { tag: SOLANA_OWNER_TAG, key: shielded.signingPublicKey().ed25519(), nullifierPk: shielded.nullifierPublicKey() };
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

function pubkeyAt(data: Buffer, offset: number): PublicKey {
  return new PublicKey(data.subarray(offset, offset + FIELD_BYTES));
}

function same32(data: Buffer, offset: number, bytes: Uint8Array): boolean {
  return bytes.byteLength === FIELD_BYTES && data.subarray(offset, offset + FIELD_BYTES).equals(Buffer.from(bytes));
}

function isZero(bytes: Uint8Array): boolean {
  return bytes.every((byte) => byte === 0);
}

function parseAmount(value: string, failure: string): bigint {
  const amount = BigInt(value);
  if (amount <= BigInt(0) || amount > U64_MAX) throw new Error(failure);
  return amount;
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

function amountText(value: unknown): value is string {
  return typeof value === "string" && AMOUNT.test(value) && value !== "0";
}
