import { DEPOSIT_COMPUTE_UNIT_LIMIT, LOOKUP_ADDRESS_LIMIT, type DepositAccountMeta, type PreparedDeposit } from "./budget-deposit.ts";
import { IX_INITIATE, IX_PAY, PPROLL_PROGRAM_ID } from "./payroll-account.ts";

/** Second byte of initiate. The pool keeps its change note. Matches `KEEPS_NOTE` in the CLI. */
export const KEEPS_NOTE = 1;

export const MISSING_PAYROLL_KEY = "This browser does not have the payroll key.";
export const PUT_NOTE_IN_BUDGET = "Put a note in the budget before funding the payroll.";
export const MILESTONE_NOT_DUE = "The next roll is not due yet.";
export const BUDGET_NOTE_TOO_SMALL = "The budget note is not large enough to leave change in the budget.";
export const PAYROLL_NOTE_MISSING = "The payroll has no note to pay from.";
export const WRONG_SHIELDED_OWNER = "This private balance is not the one bound to the payroll.";
export const NOT_READY_TO_FUND = "The payroll is not ready to fund.";
export const NOT_READY_TO_CRANK = "The payroll is not ready to crank.";
export const PAYROLL_NOT_FUNDED = "Fund the payroll before cranking it.";
export const PAYROLL_SIMULATION_FAILED = "The payroll transaction did not simulate.";
export const PAYROLL_NOTE_SHORT = "The payroll note holds less than one roll.";
export const PAY_PROOF_NOT_BUILT = "The pay proof could not be built.";

/** Assertion labels from the pproll `Pay` circuit, which the SDK reports only as TRANSACTION_PROGRAM_BUILD. */
const PAY_CIRCUIT_FAILURES: Readonly<Record<string, string>> = {
  "the transfer exceeds the balance": PAYROLL_NOTE_SHORT,
  "the note owner": WRONG_SHIELDED_OWNER,
  "the amount commitment": MISSING_PAYROLL_KEY,
  "the payroll keeps its change": MISSING_PAYROLL_KEY,
};

const HEX_32 = /^[0-9a-f]{64}$/i;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const DATA_HEX = /^[0-9a-f]+$/i;
const ROLL_DATA_HEX_MAX = 200_000;
const KEY_MIN = 3;
const KEY_MAX = 64;
const DIGITS = /^\d{1,20}$/;
const U64_MAX = (BigInt(1) << BigInt(64)) - BigInt(1);
/** A weekly payroll for ten years. Keeps the form from asking for an absurd budget. */
export const MAX_ROLLS = 520;

export type PayrollStep =
  | { readonly action: "fund" }
  | { readonly action: "crank" }
  | { readonly action: "finished"; readonly rolls: number }
  | { readonly action: "due"; readonly dueAt: number }
  | { readonly action: "missing-payroll-key" }
  | { readonly action: "missing-budget-key" }
  | { readonly action: "need-note" }
  | { readonly action: "none" };

export type PayrollStepInput = {
  readonly kind: "stream" | "budget";
  readonly role: "employer" | "payee";
  readonly status: string;
  readonly employerApproved: boolean;
  readonly payeeApproved: boolean;
  readonly frozen: boolean;
  readonly payeeHashZero: boolean;
  readonly startAt: number;
  readonly periodSecs: number;
  readonly nextRedeem: number;
  readonly budgetFunded: boolean;
  readonly hasPayrollKey: boolean;
  readonly hasBudgetKey: boolean;
  /** Rolls the budget covers, from the browser terms. The chain only holds commitments. `null` when unknown. */
  readonly rollsTotal: number | null;
  /** Chain or browser unix seconds. `null` until the page has a clock, so Crank stays hidden. */
  readonly now: number | null;
};

/**
 * Budget for `rolls` installments. Fund later needs a budget note strictly larger than this,
 * because the pool keeps change.
 */
export function budgetForRolls(installment: bigint, rollsText: string): bigint | null {
  if (installment <= BigInt(0) || !/^\d{1,4}$/.test(rollsText)) return null;
  const rolls = Number(rollsText);
  if (rolls < 1 || rolls > MAX_ROLLS) return null;
  const budget = installment * BigInt(rolls);
  return budget > U64_MAX ? null : budget;
}

/** Whole installments in the budget. Terms saved before `budget` was stored had budget equal to the installment. */
export function rollsInBudget(installment: string, budget: string | undefined): number | null {
  if (!DIGITS.test(installment)) return null;
  const each = BigInt(installment);
  if (each === BigInt(0)) return null;
  if (budget === undefined) return 1;
  if (!DIGITS.test(budget)) return null;
  const rolls = BigInt(budget) / each;
  return rolls === BigInt(0) || rolls > BigInt(MAX_ROLLS) ? null : Number(rolls);
}

/**
 * Period `index` is claimable at `start + (index + 1) * period`.
 * Same formula as `claim_at` in `pproll/src/state.rs`.
 */
export function claimAt(startAt: number, periodSecs: number, index: number): number | null {
  if (!Number.isSafeInteger(startAt) || !Number.isSafeInteger(periodSecs) || !Number.isSafeInteger(index)) return null;
  if (periodSecs <= 0 || index < 0) return null;
  const due = BigInt(startAt) + (BigInt(index) + BigInt(1)) * BigInt(periodSecs);
  if (due > BigInt(Number.MAX_SAFE_INTEGER) || due < BigInt(Number.MIN_SAFE_INTEGER)) return null;
  return Number(due);
}

export function hasPayrollKey(terms: {
  readonly viewingSecretHex?: string;
  readonly installmentBlindingHex?: string;
  readonly budgetBlindingHex?: string;
} | null): boolean {
  if (terms === null) return false;
  return hex32(terms.viewingSecretHex) && hex32(terms.installmentBlindingHex) && hex32(terms.budgetBlindingHex);
}

/** The vault named by the budget key, when that vault holds a note. */
export function fundedBudgetAddress(
  vaults: readonly { readonly address: string; readonly funded: boolean }[],
  keyVault: string | null,
): string | null {
  if (keyVault !== null) {
    const named = vaults.find((vault) => vault.address === keyVault);
    return named?.funded === true ? named.address : null;
  }
  const funded = vaults.filter((vault) => vault.funded);
  return funded.length === 1 ? (funded[0]?.address ?? null) : null;
}

/**
 * Fund is the employer moving the budget note onto a frozen proposal.
 * Crank is the payee paying one due installment. A future milestone shows its time.
 */
export function payrollStep(input: PayrollStepInput): PayrollStep {
  if (canFund(input)) {
    if (!input.hasPayrollKey) return { action: "missing-payroll-key" };
    if (!input.hasBudgetKey) return { action: "missing-budget-key" };
    if (!input.budgetFunded) return { action: "need-note" };
    return { action: "fund" };
  }
  if (canCrank(input)) {
    if (!input.hasPayrollKey) return { action: "missing-payroll-key" };
    if (input.rollsTotal !== null && input.nextRedeem >= input.rollsTotal) return { action: "finished", rolls: input.rollsTotal };
    const dueAt = claimAt(input.startAt, input.periodSecs, input.nextRedeem);
    if (dueAt === null) return { action: "none" };
    if (input.now === null || input.now < dueAt) return { action: "due", dueAt };
    return { action: "crank" };
  }
  if (input.kind === "budget" && input.status === "Active" && input.rollsTotal !== null && input.nextRedeem >= input.rollsTotal) {
    return { action: "finished", rolls: input.rollsTotal };
  }
  return { action: "none" };
}

export function payBuildFailure(circuitLabel: string | null): string {
  if (circuitLabel === null || !Object.hasOwn(PAY_CIRCUIT_FAILURES, circuitLabel)) return PAY_PROOF_NOT_BUILT;
  return PAY_CIRCUIT_FAILURES[circuitLabel] ?? PAY_PROOF_NOT_BUILT;
}

export function parsePreparedRoll(value: unknown): PreparedDeposit | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record.computeUnitLimit !== DEPOSIT_COMPUTE_UNIT_LIMIT) return null;
  if (record.programId !== PPROLL_PROGRAM_ID) return null;
  if (!rollData(record.dataHex)) return null;
  if (!Array.isArray(record.keys) || record.keys.length < KEY_MIN || record.keys.length > KEY_MAX) return null;
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

function canFund(input: PayrollStepInput): boolean {
  return (
    input.kind === "budget" &&
    input.role === "employer" &&
    input.status === "Proposed" &&
    input.employerApproved &&
    input.payeeApproved &&
    input.frozen &&
    !input.payeeHashZero
  );
}

function canCrank(input: PayrollStepInput): boolean {
  return input.kind === "budget" && input.role === "payee" && input.status === "Active" && !input.payeeHashZero;
}

function rollData(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 4 || value.length > ROLL_DATA_HEX_MAX || value.length % 2 !== 0) return false;
  if (!DATA_HEX.test(value)) return false;
  const prefix = value.slice(0, 4).toLowerCase();
  if (prefix === `${byteHex(IX_INITIATE)}${byteHex(KEEPS_NOTE)}`) return true;
  return value.slice(0, 2).toLowerCase() === byteHex(IX_PAY);
}

function byteHex(value: number): string {
  return value.toString(16).padStart(2, "0");
}

function parseMeta(value: unknown): DepositAccountMeta | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.pubkey !== "string" || !BASE58.test(row.pubkey)) return null;
  if (typeof row.isSigner !== "boolean" || typeof row.isWritable !== "boolean") return null;
  return { pubkey: row.pubkey, isSigner: row.isSigner, isWritable: row.isWritable };
}

function hex32(value: unknown): boolean {
  return typeof value === "string" && HEX_32.test(value);
}
