import { encodeBase58 } from "./escrow-account.ts";

export const PPROLL_PROGRAM_ID = "5e6tZK4jSgHWUDW64PqRQwJBgN9VpgFEpcYiw5N9Lux6";
export const STREAM_ACCOUNT_LEN = 104;
export const PAYROLL_ACCOUNT_LEN = 264;
export const STREAM_TAG = 2;
export const PAYROLL_TAG = 5;
export const STREAM_APPROVE_IX = 1;
export const BUDGET_APPROVE_IX = 12;
export const IX_OPEN_VAULT = 10;
export const IX_OPEN_PAYROLL = 11;
export const IX_INITIATE = 13;
export const IX_PAY = 14;
export const VAULT_ACCOUNT_LEN = 112;
export const VAULT_TAG = 4;
export const VIEWING_LEN = 33;
const VAULT_OFF_OWNER = 8;
const HASH_LEN = 32;
export const RING_PERMISSIONLESS = 1;
export const WALLETS_PUBLIC = 1;
export const PERIOD_HOUR_SECS = 3_600;
export const PERIOD_DAY_SECS = 86_400;
export const PERIOD_WEEK_SECS = 604_800;
export const MAX_PERIOD_SECS = 366 * 24 * 60 * 60;

const STATUS_CLOSED = 4;
const STATUS_NAME = ["", "Proposed", "Active", "Stopped", "Closed"] as const;
const OFF_EMPLOYER = 32;
const OFF_PAYEE = 64;
const OFF_PAYEE_HASH = 96;
const OFF_NEXT = 260;
const OFF_FROZEN = 4;
const OFF_START = 8;
const OFF_DEADLINE = 16;
const OFF_PERIOD = 24;
const CREATE_BODY_LEN = 58;

export type PayrollKind = "stream" | "budget";
export type PayrollRole = "employer" | "payee";

export type PayrollView = {
  readonly address: string;
  readonly kind: PayrollKind;
  readonly status: string;
  readonly role: PayrollRole;
  readonly employerApproved: boolean;
  readonly payeeApproved: boolean;
  readonly startAt: number;
  readonly deadline: number;
  readonly periodSecs: number;
  readonly employer: string;
  readonly payee: string;
  readonly frozen: boolean;
  readonly payeeHashZero: boolean;
  readonly nextRedeem: number;
};

export function periodLabel(periodSecs: number): string {
  if (periodSecs === PERIOD_HOUR_SECS) return "Hourly";
  if (periodSecs === PERIOD_DAY_SECS) return "Daily";
  if (periodSecs === PERIOD_WEEK_SECS) return "Weekly";
  return `${periodSecs} seconds`;
}

export function scheduleAt(nowSecs: number, periodSecs: number, startInSecs: number): bigint | null {
  if (!Number.isSafeInteger(nowSecs) || !Number.isSafeInteger(periodSecs) || !Number.isSafeInteger(startInSecs)) return null;
  if (periodSecs <= 0 || periodSecs > MAX_PERIOD_SECS || startInSecs <= 0 || startInSecs > MAX_PERIOD_SECS) return null;
  const start = nowSecs + startInSecs;
  if (!Number.isSafeInteger(start) || start <= nowSecs) return null;
  return BigInt(start);
}

/** Instruction `create`. The approval deadline is the start, which the program accepts. */
export function streamCreateData(employee: Uint8Array, startAt: bigint, periodSecs: bigint): Uint8Array | null {
  if (employee.length !== 32 || periodSecs <= BigInt(0) || startAt <= BigInt(0)) return null;
  const data = new Uint8Array(1 + CREATE_BODY_LEN);
  data[0] = 0;
  data.set(employee, 1);
  writeI64(data, 1 + 32, startAt);
  writeI64(data, 1 + 40, startAt);
  writeI64(data, 1 + 48, periodSecs);
  data[1 + 56] = RING_PERMISSIONLESS;
  data[1 + 57] = WALLETS_PUBLIC;
  return data;
}

export function decodePayroll(address: string, data: Uint8Array, wallet: Uint8Array): PayrollView | null {
  const kind = kindOf(data);
  if (kind === null || wallet.length !== 32) return null;
  const statusByte = data[1] ?? 0;
  if (statusByte === STATUS_CLOSED) return null;
  const employer = data.subarray(OFF_EMPLOYER, OFF_EMPLOYER + 32);
  const payee = data.subarray(OFF_PAYEE, OFF_PAYEE + 32);
  const role = equal32(employer, wallet) ? "employer" : equal32(payee, wallet) ? "payee" : null;
  if (role === null) return null;
  const startAt = readI64(data, OFF_START);
  const deadline = readI64(data, OFF_DEADLINE);
  const periodSecs = readI64(data, OFF_PERIOD);
  if (startAt === null || deadline === null || periodSecs === null) return null;
  return {
    address,
    kind,
    status: STATUS_NAME[statusByte] ?? "Unknown",
    role,
    employerApproved: data[2] === 1,
    payeeApproved: data[3] === 1,
    startAt,
    deadline,
    periodSecs,
    employer: encodeBase58(employer),
    payee: encodeBase58(payee),
    frozen: kind === "budget" && data[OFF_FROZEN] === 1,
    payeeHashZero: kind === "budget" ? isZero(data.subarray(OFF_PAYEE_HASH, OFF_PAYEE_HASH + HASH_LEN)) : true,
    nextRedeem: kind === "budget" ? readU32(data, OFF_NEXT) : 0,
  };
}

export type VaultView = {
  readonly address: string;
  readonly funded: boolean;
};

export type PayrollOpenParts = {
  readonly payee: Uint8Array;
  readonly payeeHash: Uint8Array;
  readonly noteHash: Uint8Array;
  readonly startAt: bigint;
  readonly periodSecs: bigint;
  readonly installment: Uint8Array;
  readonly budget: Uint8Array;
  readonly viewing: Uint8Array;
};

export function decodeVault(address: string, data: Uint8Array, wallet: Uint8Array): VaultView | null {
  if (data.length !== VAULT_ACCOUNT_LEN || data[0] !== VAULT_TAG || wallet.length !== HASH_LEN) return null;
  const owner = data.subarray(VAULT_OFF_OWNER, VAULT_OFF_OWNER + HASH_LEN);
  if (!equal32(owner, wallet)) return null;
  return { address, funded: data[1] === 1 };
}

export function vaultOpenData(ownerHash: Uint8Array, viewing: Uint8Array): Uint8Array | null {
  if (ownerHash.length !== HASH_LEN || viewing.length !== VIEWING_LEN || viewing[0] !== 4) return null;
  if (isZero(ownerHash)) return null;
  const data = new Uint8Array(1 + HASH_LEN + VIEWING_LEN);
  data[0] = IX_OPEN_VAULT;
  data.set(ownerHash, 1);
  data.set(viewing, 1 + HASH_LEN);
  return data;
}

/** Instruction `open_payroll`. The approval deadline equals the start. */
export function payrollOpenData(parts: PayrollOpenParts): Uint8Array | null {
  if (
    parts.payee.length !== HASH_LEN ||
    parts.payeeHash.length !== HASH_LEN ||
    parts.noteHash.length !== HASH_LEN ||
    parts.installment.length !== HASH_LEN ||
    parts.budget.length !== HASH_LEN ||
    parts.viewing.length !== VIEWING_LEN
  ) {
    return null;
  }
  if (parts.viewing[0] !== 4 || parts.periodSecs <= BigInt(0) || parts.startAt <= BigInt(0)) return null;
  if (isZero(parts.noteHash) || isZero(parts.installment) || isZero(parts.budget)) return null;
  const data = new Uint8Array(1 + 32 + 32 + 32 + 8 + 8 + 8 + 32 + 32 + VIEWING_LEN + 2);
  data[0] = IX_OPEN_PAYROLL;
  let offset = 1;
  data.set(parts.payee, offset);
  offset += HASH_LEN;
  data.set(parts.payeeHash, offset);
  offset += HASH_LEN;
  data.set(parts.noteHash, offset);
  offset += HASH_LEN;
  writeI64(data, offset, parts.startAt);
  offset += 8;
  writeI64(data, offset, parts.startAt);
  offset += 8;
  writeI64(data, offset, parts.periodSecs);
  offset += 8;
  data.set(parts.installment, offset);
  offset += HASH_LEN;
  data.set(parts.budget, offset);
  offset += HASH_LEN;
  data.set(parts.viewing, offset);
  offset += VIEWING_LEN;
  data[offset] = RING_PERMISSIONLESS;
  data[offset + 1] = WALLETS_PUBLIC;
  return data;
}

/** Payee approval. The 32-byte hash is the shielded owner the rolls are paid to. */
export function payrollApproveData(payeeHash: Uint8Array): Uint8Array | null {
  if (payeeHash.length !== HASH_LEN || isZero(payeeHash)) return null;
  const data = new Uint8Array(1 + HASH_LEN);
  data[0] = BUDGET_APPROVE_IX;
  data.set(payeeHash, 1);
  return data;
}

export function splitPayrolls(rows: readonly PayrollView[]): { issued: PayrollView[]; received: PayrollView[] } {
  return {
    issued: rows.filter((row) => row.role === "employer"),
    received: rows.filter((row) => row.role === "payee"),
  };
}

function kindOf(data: Uint8Array): PayrollKind | null {
  if (data.length === STREAM_ACCOUNT_LEN && data[0] === STREAM_TAG) return "stream";
  if (data.length === PAYROLL_ACCOUNT_LEN && data[0] === PAYROLL_TAG) return "budget";
  return null;
}

function readU32(data: Uint8Array, offset: number): number {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return view.getUint32(offset, true);
}

function readI64(data: Uint8Array, offset: number): number | null {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const value = view.getBigInt64(offset, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) return null;
  return Number(value);
}

function writeI64(data: Uint8Array, offset: number, value: bigint): void {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  view.setBigInt64(offset, value, true);
}

function isZero(bytes: Uint8Array): boolean {
  return bytes.every((byte) => byte === 0);
}

function equal32(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== 32 || right.length !== 32) return false;
  for (let index = 0; index < 32; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}
