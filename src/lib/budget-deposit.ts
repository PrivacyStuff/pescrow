import {
  AddressLookupTableAccount,
  AddressLookupTableProgram,
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type Connection,
} from "@solana/web3.js";
import { chooseLookupSlot, recentSlotFromCreateInstruction } from "../../pescrow/sdk/src/lookup-slot.ts";
import { formatAsset, short } from "../components/dashboard/format.ts";
import { encodeBase58 } from "./escrow-account.ts";
import { stripProverStderr } from "./prover-stderr.ts";
import { type TokenMetadata } from "./token-metadata.ts";
import { PPROLL_PROGRAM_ID } from "./payroll-account.ts";

export const MISSING_BUDGET_VIEWING_KEY = "This browser does not have the budget viewing key.";
export const FUNDED_BUDGET_KEY_MISSING = "The viewing key for that funded budget is not in this browser.";
export const BUDGET_ALREADY_HOLDS_NOTE = "The budget already holds a note.";
export const NOTE_NOT_IN_BALANCE = "That note is not in the private balance.";
export const VAULT_NOT_FOUND = "The budget account is not a vault.";
export const VAULT_WRONG_OWNER = "The budget belongs to another wallet.";
export const DEPOSIT_IX = 7;
/** Compressed Groth16 proof ahead of the shielded-pool payload: 32-byte A, 64-byte B, 32-byte C. */
export const CIRCUIT_PROOF_LEN = 128;
/** `InstructionTag::Transact`. The program prepends this byte when it CPIs the payload. */
export const POOL_TRANSACT_TAG = 16;
export const DEPOSIT_ACCOUNTS_CHANGED = "The budget deposit accounts changed while the address table activated. Retry.";
export const ROOT_MOVED = "The shielded pool root moved while the deposit was proved. Retry.";
/** Shielded-pool tree account. The proof commits to root bytes; the instruction names their history slots. */
export const TREE_ACCOUNT_LEN = 40_080;
export const TREE_ACCOUNT_TAG = 1;
export const UTXO_ROOT_HISTORY_OFFSET = 1_152;
export const UTXO_ROOT_HISTORY_CAPACITY = 500;
export const NULLIFIER_ROOT_HISTORY_OFFSET = 17_232;
export const NULLIFIER_ROOT_HISTORY_CAPACITY = 100;
export const RING_KEY_NOT_SIGNER = "The budget deposit does not ask the private balance key to sign. Retry.";
const RING_SEED_LEN = 32;
export const DEPOSIT_COMPUTE_UNIT_LIMIT = 1_400_000;
export const LOOKUP_ADDRESS_LIMIT = 20;
export const LOOKUP_SLOT_ATTEMPTS = 4;
export const LOOKUP_WAIT_ATTEMPTS = 40;
export const LOOKUP_WAIT_MS = 500;
export const DEPOSIT_SIM_ATTEMPTS = 3;
const SIMULATION_MESSAGE_LIMIT = 500;
const POOL_OCCUPIED_LOG = /custom program error: 0x81\b/i;

const VAULT_LEN = 112;
const VAULT_TAG = 4;
const VAULT_LIVE_EMPTY = 0;
const VAULT_OFF_LIVE = 1;
const VAULT_OFF_OWNER = 8;
const VAULT_OFF_HASH = 40;
const HASH_LEN = 32;
const VIEWING_SECRET = /^[0-9a-f]{64}$/i;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const DATA_HEX = /^[0-9a-f]+$/i;
const MAX_DATA_HEX = 200_000;
const ACTIVE_FOREVER = BigInt("18446744073709551615");

export type DepositAccountMeta = {
  readonly pubkey: string;
  readonly isSigner: boolean;
  readonly isWritable: boolean;
};

export type PreparedDeposit = {
  readonly computeUnitLimit: number;
  readonly programId: string;
  readonly dataHex: string;
  readonly keys: readonly DepositAccountMeta[];
  readonly lookupAddresses: readonly string[];
};

export type LookupReader = {
  getSlot(commitment: "processed" | "confirmed"): Promise<number>;
  getLatestBlockhashAndContext(commitment: "processed"): Promise<{
    context: { slot: number };
    value: { blockhash: string };
  }>;
  getLatestBlockhash(commitment: "confirmed"): Promise<{ blockhash: string }>;
  simulateTransaction(
    transaction: VersionedTransaction,
    config: {
      sigVerify: false;
      replaceRecentBlockhash: true;
      commitment?: "confirmed";
      minContextSlot?: number;
    },
  ): Promise<{ context: { slot: number }; value: { err: unknown; logs: string[] | null } }>;
  getAddressLookupTable(key: PublicKey): Promise<{
    context?: { slot: number };
    value: AddressLookupTableAccount | null;
  }>;
};

export type LookupPlan = {
  readonly tx: Transaction;
  readonly lookup: PublicKey;
  readonly recentSlot: number;
};

export function scrubPayrollError(text: string): string {
  return stripProverStderr(text).replace(/api-key=[^&\s"]+/g, "api-key=REDACTED").replace(/[0-9a-fA-F]{64,}/g, "[redacted]");
}

export function viewingKeyBelongsTo(vault: string): string {
  return `The viewing key in this browser belongs to ${vault}.`;
}

/** The fee payer signature, once the wallet has signed. An unsigned transaction has none. */
export function feePayerSignature(tx: VersionedTransaction | Transaction): string | null {
  const raw = tx instanceof VersionedTransaction ? tx.signatures[0] : tx.signature;
  if (raw === undefined || raw === null || raw.byteLength !== 64) return null;
  for (const byte of raw) {
    if (byte !== 0) return encodeBase58(raw);
  }
  return null;
}

/** A signed deposit that the network rejects still names its signature. Secrets stay out of the text. */
export function signedDepositFailure(signature: string | null, error: unknown): Error {
  const raw = error instanceof Error && error.message.length > 0 ? error.message : "The budget deposit failed.";
  const scrubbed = scrubPayrollError(raw);
  if (signature === null || scrubbed.includes(signature)) return new Error(scrubbed);
  return new Error(`transaction ${signature} failed. ${scrubbed}`);
}

export function budgetDepositRefusal(input: { readonly viewingSecretHex: string | null; readonly funded: boolean }): string | null {
  if (input.funded) return BUDGET_ALREADY_HOLDS_NOTE;
  if (input.viewingSecretHex === null || !VIEWING_SECRET.test(input.viewingSecretHex)) return MISSING_BUDGET_VIEWING_KEY;
  return null;
}

export type BudgetNote = {
  readonly hash: string;
  readonly amount: string;
  readonly mint: string;
};

export function budgetDepositNotes<T extends BudgetNote>(notes: readonly T[]): T[] {
  return notes.filter((note) => note.amount !== "0");
}

export function selectedBudgetNote(notes: readonly BudgetNote[], chosen: string, preferred: string): string {
  if (notes.some((note) => note.hash === chosen)) return chosen;
  return notes.find((note) => note.hash === preferred)?.hash ?? notes[0]?.hash ?? "";
}

export function budgetNoteLabel(note: BudgetNote, decimals: number | undefined, metadata: TokenMetadata | null | undefined): string {
  return `${formatAsset(note.amount, note.mint, decimals, metadata)} · ${short(note.hash)}`;
}

export type BudgetVaultListing = {
  readonly address: string;
  readonly funded: boolean;
};

export type BudgetKeyChoice = {
  readonly viewingSecretHex: string;
  readonly ownerHashHex: string;
  readonly vault: string | null;
};

export type BudgetAction =
  | {
      readonly action: "deposit";
      readonly vault: string;
      readonly viewingSecretHex: string;
      readonly ownerHashHex: string;
    }
  | { readonly action: "open" }
  | { readonly action: "refuse"; readonly message: string };

/**
 * Deposit only into the vault named by the viewing key.
 * A key stored for a different vault is refused, and the message names that vault.
 * Every listed vault empty and no key for them: another vault may be opened.
 * A funded vault whose key is absent: do not open a second vault.
 */
export function chooseBudgetAction(vaults: readonly BudgetVaultListing[], key: BudgetKeyChoice | null): BudgetAction {
  const usable = usableBudgetKey(key);
  if (usable !== null) {
    const target = depositTarget(vaults, usable);
    if (target !== null && "mismatch" in target) return { action: "refuse", message: viewingKeyBelongsTo(target.mismatch) };
    if (target !== null && target.funded) return { action: "refuse", message: BUDGET_ALREADY_HOLDS_NOTE };
    if (target !== null) {
      return {
        action: "deposit",
        vault: target.address,
        viewingSecretHex: usable.viewingSecretHex,
        ownerHashHex: usable.ownerHashHex,
      };
    }
  }
  if (vaults.some((vault) => vault.funded)) return { action: "refuse", message: FUNDED_BUDGET_KEY_MISSING };
  return { action: "open" };
}

export function parseBudgetKeyRecord(value: unknown): BudgetKeyChoice | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.viewingSecretHex !== "string" || !VIEWING_SECRET.test(row.viewingSecretHex)) return null;
  if (typeof row.ownerHashHex !== "string" || !VIEWING_SECRET.test(row.ownerHashHex)) return null;
  if (row.vault === undefined || row.vault === null) {
    return { viewingSecretHex: row.viewingSecretHex.toLowerCase(), ownerHashHex: row.ownerHashHex.toLowerCase(), vault: null };
  }
  if (typeof row.vault !== "string" || !BASE58.test(row.vault)) return null;
  return { viewingSecretHex: row.viewingSecretHex.toLowerCase(), ownerHashHex: row.ownerHashHex.toLowerCase(), vault: row.vault };
}

function usableBudgetKey(key: BudgetKeyChoice | null): BudgetKeyChoice | null {
  if (key === null || !VIEWING_SECRET.test(key.viewingSecretHex) || !VIEWING_SECRET.test(key.ownerHashHex)) return null;
  if (key.vault !== null && !BASE58.test(key.vault)) return null;
  return {
    viewingSecretHex: key.viewingSecretHex.toLowerCase(),
    ownerHashHex: key.ownerHashHex.toLowerCase(),
    vault: key.vault,
  };
}

function depositTarget(
  vaults: readonly BudgetVaultListing[],
  key: BudgetKeyChoice,
): BudgetVaultListing | { readonly mismatch: string } | null {
  if (key.vault !== null) {
    const listed = vaults.find((vault) => vault.address === key.vault);
    if (listed !== undefined) return listed;
    return { mismatch: key.vault };
  }
  if (vaults.length === 1) return vaults[0] ?? null;
  return null;
}

export function vaultDepositRefusal(data: Uint8Array, owner: Uint8Array, ownerHashHex: string): string | null {
  if (data.length !== VAULT_LEN || data[0] !== VAULT_TAG) return VAULT_NOT_FOUND;
  if (owner.length !== HASH_LEN || !equalAt(data, VAULT_OFF_OWNER, owner)) return VAULT_WRONG_OWNER;
  if (data[VAULT_OFF_LIVE] !== VAULT_LIVE_EMPTY) return BUDGET_ALREADY_HOLDS_NOTE;
  if (!VIEWING_SECRET.test(ownerHashHex) || readHex(data, VAULT_OFF_HASH, HASH_LEN) !== ownerHashHex.toLowerCase()) {
    return MISSING_BUDGET_VIEWING_KEY;
  }
  return null;
}

export function parsePreparedDeposit(value: unknown): PreparedDeposit | null {
  return parsePreparedVaultMove(value, DEPOSIT_IX);
}

/** Deposit is instruction 7. Withdraw is instruction 9. The unsigned transaction shape is the same. */
export function parsePreparedVaultMove(value: unknown, instruction: number): PreparedDeposit | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record.computeUnitLimit !== DEPOSIT_COMPUTE_UNIT_LIMIT) return null;
  if (record.programId !== PPROLL_PROGRAM_ID) return null;
  if (!vaultMoveData(record.dataHex, instruction)) return null;
  if (!Array.isArray(record.keys) || record.keys.length < 2 || record.keys.length > 64) return null;
  const keys: DepositAccountMeta[] = [];
  for (const entry of record.keys) {
    const meta = parseMeta(entry);
    if (meta === null) return null;
    keys.push(meta);
  }
  if (!Array.isArray(record.lookupAddresses) || record.lookupAddresses.length === 0 || record.lookupAddresses.length > LOOKUP_ADDRESS_LIMIT) {
    return null;
  }
  const lookupAddresses: string[] = [];
  for (const entry of record.lookupAddresses) {
    if (typeof entry !== "string" || !BASE58.test(entry)) return null;
    lookupAddresses.push(entry);
  }
  return {
    computeUnitLimit: DEPOSIT_COMPUTE_UNIT_LIMIT,
    programId: PPROLL_PROGRAM_ID,
    dataHex: (record.dataHex as string).toLowerCase(),
    keys,
    lookupAddresses,
  };
}

export type DepositTransactFields = {
  /** Byte the program prepends. The TEE hashes this byte in front of `prefix`. */
  readonly cpiTag: number;
  /** Instruction bytes through `messages`. The ciphertext sits in here. Tree-context indexes do not. */
  readonly prefix: Uint8Array;
  /** First output's ciphertext scheme byte, inside `prefix`. */
  readonly scheme: number;
  readonly utxoRootIndex: number;
  readonly nullifierRootIndex: number;
};

/**
 * The pool hashes `POOL_TRANSACT_TAG` plus `prefix`, then loads roots from the
 * tree account at the context indexes. Those indexes are not part of `prefix`.
 * Returns null when the bytes are not a deposit of one confidential output.
 */
export function readDepositTransact(data: Uint8Array): DepositTransactFields | null {
  if (data.length < 1 + CIRCUIT_PROOF_LEN || data[0] !== DEPOSIT_IX) return null;
  const transact = data.subarray(1 + CIRCUIT_PROOF_LEN);
  const cursor = { offset: 0 };
  if (!skip(transact, cursor, 8 + 33 + 16)) return null;
  const transfers = take(transact, cursor);
  if (transfers === null) return null;
  for (let index = 0; index < transfers; index += 1) {
    const kind = take(transact, cursor);
    if (kind === null || kind > 3) return null;
    if (!skip(transact, cursor, kind >= 2 ? 9 : 8)) return null;
  }
  if (!skipOption(transact, cursor, HASH_LEN) || !skipOption(transact, cursor, HASH_LEN)) return null;
  const outputs = take(transact, cursor);
  if (outputs === null || outputs < 1) return null;
  let scheme: number | null = null;
  for (let index = 0; index < outputs; index += 1) {
    if (!skip(transact, cursor, HASH_LEN)) return null;
    const tag = take(transact, cursor);
    if (tag === 0) {
      if (!skip(transact, cursor, HASH_LEN)) return null;
    } else if (tag === 1) {
      if (take(transact, cursor) === null) return null;
    } else {
      return null;
    }
    const present = take(transact, cursor);
    if (present === 1) {
      const length = u16(transact, cursor);
      if (length === null || !fits(transact, cursor.offset, length)) return null;
      if (index === 0) {
        if (length < 6) return null;
        scheme = transact[cursor.offset + 5] ?? null;
      }
      cursor.offset += length;
    } else if (present !== 0) {
      return null;
    }
  }
  const messages = take(transact, cursor);
  if (messages === null) return null;
  for (let index = 0; index < messages; index += 1) {
    if (!skip(transact, cursor, HASH_LEN)) return null;
    const length = u16(transact, cursor);
    if (length === null || !skip(transact, cursor, length)) return null;
  }
  if (scheme === null) return null;
  const prefix = transact.subarray(0, cursor.offset);
  if (!skip(transact, cursor, HASH_LEN)) return null;
  const circuit = u16(transact, cursor);
  if (circuit !== 0 || !skip(transact, cursor, 3)) return null;
  if (!skip(transact, cursor, 32 + 128 + 32)) return null;
  const inputs = take(transact, cursor);
  if (inputs === null) return null;
  for (let index = 0; index < inputs; index += 1) {
    if (!skip(transact, cursor, HASH_LEN + 1)) return null;
  }
  const contexts = take(transact, cursor);
  if (contexts !== 1) return null;
  const utxoRootIndex = u16(transact, cursor);
  const nullifierRootIndex = u16(transact, cursor);
  if (utxoRootIndex === null || nullifierRootIndex === null || cursor.offset !== transact.length) return null;
  return { cpiTag: POOL_TRANSACT_TAG, prefix, scheme, utxoRootIndex, nullifierRootIndex };
}

export type ProvedRoots = {
  readonly utxoRoot: Uint8Array;
  readonly nullifierRoot: Uint8Array;
};

/**
 * The pool loads roots from the tree at the context indexes. Those indexes sit
 * after the CPI prefix, so changing them does not change the external-data hash.
 * Point them at the history slots that still hold the roots the proof used.
 */
export function alignDepositTreeContext(data: Uint8Array, tree: Uint8Array, expected: ProvedRoots): Uint8Array {
  const fields = readDepositTransact(data);
  if (fields === null || tree.length !== TREE_ACCOUNT_LEN || tree[0] !== TREE_ACCOUNT_TAG) {
    throw new Error("The budget deposit could not be prepared.");
  }
  const utxoIndex = rootSlot(tree, UTXO_ROOT_HISTORY_OFFSET, UTXO_ROOT_HISTORY_CAPACITY, expected.utxoRoot, fields.utxoRootIndex);
  const nullifierIndex = rootSlot(
    tree,
    NULLIFIER_ROOT_HISTORY_OFFSET,
    NULLIFIER_ROOT_HISTORY_CAPACITY,
    expected.nullifierRoot,
    fields.nullifierRootIndex,
  );
  if (utxoIndex === null || nullifierIndex === null) throw new Error(ROOT_MOVED);
  if (utxoIndex === fields.utxoRootIndex && nullifierIndex === fields.nullifierRootIndex) return data;
  const out = new Uint8Array(data);
  writeU16(out, out.length - 4, utxoIndex);
  writeU16(out, out.length - 2, nullifierIndex);
  const checked = readDepositTransact(out);
  if (
    checked === null ||
    checked.utxoRootIndex !== utxoIndex ||
    checked.nullifierRootIndex !== nullifierIndex ||
    checked.prefix.length !== fields.prefix.length ||
    !equalAt(checked.prefix, 0, fields.prefix)
  ) {
    throw new Error("The budget deposit could not be prepared.");
  }
  return out;
}

/** Sign the proof made after the address table activates. Its accounts must still be the ones in the table. */
export function useFreshBudgetDeposit(opened: PreparedDeposit, proved: PreparedDeposit): PreparedDeposit {
  if (!sameAccounts(opened, proved)) throw new Error(DEPOSIT_ACCOUNTS_CHANGED);
  return proved;
}

export function lookupReader(connection: Connection): LookupReader {
  return {
    getSlot: (commitment) => connection.getSlot(commitment),
    getLatestBlockhashAndContext: (commitment) => connection.getLatestBlockhashAndContext(commitment),
    getLatestBlockhash: (commitment) => connection.getLatestBlockhash(commitment),
    simulateTransaction: (transaction, config) => connection.simulateTransaction(transaction, config),
    getAddressLookupTable: (key) => connection.getAddressLookupTable(key),
  };
}

export async function lookupTableTransaction(
  connection: LookupReader,
  payer: PublicKey,
  addresses: readonly PublicKey[],
): Promise<LookupPlan> {
  const unique = uniquePubkeys(addresses);
  if (unique.length === 0 || unique.length > LOOKUP_ADDRESS_LIMIT) {
    throw new Error("The budget deposit could not be prepared.");
  }
  let simulationSlot: number | null = null;
  let previousRejected = false;
  for (let attempt = 0; attempt < LOOKUP_SLOT_ATTEMPTS; attempt += 1) {
    const [processed, block] = await Promise.all([
      connection.getSlot("processed"),
      connection.getLatestBlockhashAndContext("processed"),
    ]);
    const recentSlot = chooseLookupSlot({
      processed,
      blockhashSlot: block.context.slot,
      simulationSlot,
      previousRejected,
    });
    const [createTable, lookup] = AddressLookupTableProgram.createLookupTable({
      authority: payer,
      payer,
      recentSlot,
    });
    const written = recentSlotFromCreateInstruction(createTable.data);
    if (written !== BigInt(recentSlot)) throw new Error("The address table slot was not written into the instruction.");
    const extendTable = AddressLookupTableProgram.extendLookupTable({
      lookupTable: lookup,
      authority: payer,
      payer,
      addresses: unique,
    });
    const probe = new TransactionMessage({
      payerKey: payer,
      recentBlockhash: block.value.blockhash,
      instructions: [createTable, extendTable],
    }).compileToV0Message();
    const simulation = await connection.simulateTransaction(new VersionedTransaction(probe), {
      sigVerify: false,
      replaceRecentBlockhash: true,
    });
    simulationSlot = simulation.context.slot;
    const logs = (simulation.value.logs ?? []).join("\n");
    if (simulation.value.err && logs.includes("not a recent slot")) {
      previousRejected = true;
      if (attempt + 1 < LOOKUP_SLOT_ATTEMPTS) continue;
      throw new Error("The devnet RPC is too far behind to open a lookup table. Retry.");
    }
    if (simulation.value.err) throw new Error("The address table did not simulate.");
    const fresh = await connection.getLatestBlockhash("confirmed");
    const tx = new Transaction().add(createTable, extendTable);
    tx.feePayer = payer;
    tx.recentBlockhash = fresh.blockhash;
    return { tx, lookup, recentSlot };
  }
  throw new Error("The devnet RPC is too far behind to open a lookup table. Retry.");
}

export async function waitForLookupTable(
  connection: LookupReader,
  lookup: PublicKey,
  wanted: readonly PublicKey[],
  sleep: (ms: number) => Promise<void> = delay,
): Promise<AddressLookupTableAccount> {
  const need = new Set(wanted.map((key) => key.toBase58()));
  if (need.size === 0) throw new Error("The budget deposit could not be prepared.");
  for (let attempt = 0; attempt < LOOKUP_WAIT_ATTEMPTS; attempt += 1) {
    const fetched = await connection.getAddressLookupTable(lookup);
    const table = fetched.value;
    const observed = fetched.context?.slot;
    // The slot that wrote the addresses cannot use them. A newer getSlot can
    // race ahead of this account read and report the table active too soon.
    if (table !== null && typeof observed === "number" && observed > table.state.lastExtendedSlot) {
      const have = new Set(table.state.addresses.map((key) => key.toBase58()));
      if ([...need].every((key) => have.has(key))) return table;
    }
    await sleep(LOOKUP_WAIT_MS);
  }
  throw new Error("The address table did not activate.");
}

export type DepositSimulationConfig = {
  readonly sigVerify: false;
  readonly replaceRecentBlockhash: true;
  readonly commitment: "confirmed";
  readonly minContextSlot: number;
};

export function depositSimulationConfig(lastExtendedSlot: number): DepositSimulationConfig {
  if (!Number.isSafeInteger(lastExtendedSlot) || lastExtendedSlot < 0) {
    throw new Error("The address table did not activate.");
  }
  return {
    sigVerify: false,
    replaceRecentBlockhash: true,
    commitment: "confirmed",
    minContextSlot: lastExtendedSlot + 1,
  };
}

export function depositSimulationFailure(err: unknown, logs: readonly string[] | null): string {
  const errText = scrubPayrollError(simulationErrText(err));
  const joined = scrubPayrollError((logs ?? []).join("\n"));
  if (joined.includes("PoolOccupied") || POOL_OCCUPIED_LOG.test(joined)) return BUDGET_ALREADY_HOLDS_NOTE;
  const failed = (logs ?? [])
    .map((line) => scrubPayrollError(line))
    .filter((line) => /failed|error|invalid/i.test(line));
  const detail = failed.slice(-4).join(" ");
  if (detail.length > 0) return `${detail} (${errText})`.slice(0, SIMULATION_MESSAGE_LIMIT);
  return `The budget deposit did not simulate. ${errText}`.slice(0, SIMULATION_MESSAGE_LIMIT);
}

export async function simulateBudgetDeposit(
  connection: LookupReader,
  transaction: VersionedTransaction,
  lastExtendedSlot: number,
  sleep: (ms: number) => Promise<void> = delay,
): Promise<void> {
  const config = depositSimulationConfig(lastExtendedSlot);
  let failure: unknown = "The budget deposit did not simulate.";
  let logs: string[] | null = null;
  for (let attempt = 0; attempt < DEPOSIT_SIM_ATTEMPTS; attempt += 1) {
    try {
      const simulation = await connection.simulateTransaction(transaction, config);
      if (!simulation.value.err) return;
      failure = simulation.value.err;
      logs = simulation.value.logs;
    } catch (error) {
      failure = error;
      logs = null;
    }
    if (!retryableSimulation(failure) || attempt + 1 === DEPOSIT_SIM_ATTEMPTS) break;
    await sleep(LOOKUP_WAIT_MS);
  }
  throw new Error(depositSimulationFailure(failure, logs));
}

export function depositVersionedTransaction(
  payer: PublicKey,
  blockhash: string,
  lookup: AddressLookupTableAccount,
  prepared: PreparedDeposit,
): VersionedTransaction {
  const instruction = new TransactionInstruction({
    programId: new PublicKey(prepared.programId),
    keys: prepared.keys.map((key) => ({
      pubkey: new PublicKey(key.pubkey),
      isSigner: key.isSigner,
      isWritable: key.isWritable,
    })),
    data: Buffer.from(prepared.dataHex, "hex"),
  });
  const budget = ComputeBudgetProgram.setComputeUnitLimit({ units: prepared.computeUnitLimit });
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions: [budget, instruction],
  }).compileToV0Message([lookup]);
  return new VersionedTransaction(message);
}

/** The spent note is owned by the ring key. Signing after the wallet leaves the wallet's signature in place. */
export function cosignWithRingKey(transaction: VersionedTransaction, seed: Uint8Array): VersionedTransaction {
  if (seed.byteLength !== RING_SEED_LEN) throw new Error(RING_KEY_NOT_SIGNER);
  const ring = Keypair.fromSeed(seed);
  const required = transaction.message.header.numRequiredSignatures;
  const signers = transaction.message.staticAccountKeys.slice(0, required);
  if (!signers.some((key) => key.equals(ring.publicKey))) throw new Error(RING_KEY_NOT_SIGNER);
  transaction.sign([ring]);
  return transaction;
}

export function activeLookup(
  key: PublicKey,
  authority: PublicKey,
  addresses: readonly PublicKey[],
  lastExtendedSlot = 0,
): AddressLookupTableAccount {
  return new AddressLookupTableAccount({
    key,
    state: {
      deactivationSlot: ACTIVE_FOREVER,
      lastExtendedSlot,
      lastExtendedSlotStartIndex: 0,
      authority,
      addresses: [...addresses],
    },
  });
}

function retryableSimulation(err: unknown): boolean {
  const text = simulationErrText(err);
  return (
    text.includes("InvalidAddressLookupTable") ||
    text.includes("AddressLookupTableNotFound") ||
    text.includes("Minimum context slot")
  );
}

function simulationErrText(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  try {
    const text = JSON.stringify(err);
    return typeof text === "string" ? text : "unknown simulation error";
  } catch {
    return "unknown simulation error";
  }
}

function parseMeta(value: unknown): DepositAccountMeta | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.pubkey !== "string" || !BASE58.test(row.pubkey)) return null;
  if (typeof row.isSigner !== "boolean" || typeof row.isWritable !== "boolean") return null;
  return { pubkey: row.pubkey, isSigner: row.isSigner, isWritable: row.isWritable };
}

function vaultMoveData(value: unknown, instruction: number): value is string {
  if (typeof value !== "string" || value.length < 2 || value.length > MAX_DATA_HEX || value.length % 2 !== 0) return false;
  if (!DATA_HEX.test(value)) return false;
  return Number.parseInt(value.slice(0, 2), 16) === instruction;
}

function sameAccounts(opened: PreparedDeposit, proved: PreparedDeposit): boolean {
  if (opened.lookupAddresses.length !== proved.lookupAddresses.length || opened.keys.length !== proved.keys.length) return false;
  for (let index = 0; index < opened.lookupAddresses.length; index += 1) {
    if (opened.lookupAddresses[index] !== proved.lookupAddresses[index]) return false;
  }
  for (let index = 0; index < opened.keys.length; index += 1) {
    const left = opened.keys[index];
    const right = proved.keys[index];
    if (left === undefined || right === undefined) return false;
    if (left.pubkey !== right.pubkey || left.isSigner !== right.isSigner || left.isWritable !== right.isWritable) return false;
  }
  return true;
}

function fits(data: Uint8Array, offset: number, length: number): boolean {
  return offset >= 0 && length >= 0 && offset + length <= data.length;
}

function take(data: Uint8Array, cursor: { offset: number }): number | null {
  const value = data[cursor.offset];
  if (value === undefined) return null;
  cursor.offset += 1;
  return value;
}

function skip(data: Uint8Array, cursor: { offset: number }, length: number): boolean {
  if (!fits(data, cursor.offset, length)) return false;
  cursor.offset += length;
  return true;
}

function u16(data: Uint8Array, cursor: { offset: number }): number | null {
  if (!fits(data, cursor.offset, 2)) return null;
  const value = (data[cursor.offset] ?? 0) | ((data[cursor.offset + 1] ?? 0) << 8);
  cursor.offset += 2;
  return value;
}

function skipOption(data: Uint8Array, cursor: { offset: number }, payload: number): boolean {
  const flag = take(data, cursor);
  if (flag === 0) return true;
  if (flag !== 1) return false;
  return skip(data, cursor, payload);
}

function uniquePubkeys(keys: readonly PublicKey[]): PublicKey[] {
  const seen = new Set<string>();
  const out: PublicKey[] = [];
  for (const key of keys) {
    const text = key.toBase58();
    if (seen.has(text)) continue;
    seen.add(text);
    out.push(key);
  }
  return out;
}

function rootSlot(tree: Uint8Array, offset: number, capacity: number, root: Uint8Array, preferred: number): number | null {
  if (root.length !== HASH_LEN || isZero(root)) return null;
  if (preferred >= 0 && preferred < capacity && equalAt(tree, offset + preferred * HASH_LEN, root)) return preferred;
  for (let index = 0; index < capacity; index += 1) {
    const at = offset + index * HASH_LEN;
    if (at < 0 || at + HASH_LEN > tree.length) return null;
    if (equalAt(tree, at, root)) return index;
  }
  return null;
}

function isZero(root: Uint8Array): boolean {
  for (const byte of root) {
    if (byte !== 0) return false;
  }
  return true;
}

function writeU16(data: Uint8Array, offset: number, value: number): void {
  data[offset] = value & 0xff;
  data[offset + 1] = (value >> 8) & 0xff;
}

function equalAt(data: Uint8Array, offset: number, bytes: Uint8Array): boolean {
  if (offset < 0 || offset + bytes.length > data.length) return false;
  for (let index = 0; index < bytes.length; index += 1) {
    if (data[offset + index] !== bytes[index]) return false;
  }
  return true;
}

function readHex(data: Uint8Array, offset: number, length: number): string {
  let hex = "";
  for (let index = 0; index < length; index += 1) {
    hex += (data[offset + index] ?? 0).toString(16).padStart(2, "0");
  }
  return hex;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
