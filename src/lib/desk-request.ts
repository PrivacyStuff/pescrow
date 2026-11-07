export const MIN_DESK_LAMPORTS = BigInt(1);
export const MAX_DESK_LAMPORTS = BigInt(1_000_000_000);
export const RING_FEE_RESERVE = 30_000_000;
export const RING_MESSAGE = "pescrow ring key v1";
const APPROVAL_WINDOW_SEC = 6 * 60 * 60;

export function sixHourDeadline(): number {
  return Math.floor(Date.now() / 1000) + APPROVAL_WINDOW_SEC;
}

export type DeskSide = "a" | "b";

export type DeskRequest =
  | { readonly action: "status" }
  | { readonly action: "open" | "swap" }
  | { readonly action: "shield" | "withdraw" | "lock"; readonly side: DeskSide; readonly lamports?: bigint; readonly note?: string }
  | { readonly action: "wallet-escrows"; readonly wallet: string }
  | { readonly action: "wallet-submit"; readonly tx: string }
  | { readonly action: "wallet-notes" | "wallet-return"; readonly seed: string; readonly wallet?: string }
  | { readonly action: "wallet-shield"; readonly seed: string; readonly lamports: bigint }
  | { readonly action: "wallet-lock"; readonly seed: string; readonly wallet: string; readonly escrow: string; readonly note: string; readonly lamports: bigint }
  | { readonly action: "wallet-terms"; readonly escrow: string; readonly lockLamports: bigint; readonly receiveLamports: bigint }
  | { readonly action: "wallet-swap"; readonly seed: string; readonly escrow: string; readonly toA: string; readonly toB: string };

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SEED = /^[0-9a-f]{64}$/i;
const HEX = /^[0-9a-f]+$/i;

function pubkey(value: unknown): value is string {
  return typeof value === "string" && BASE58.test(value);
}

function seed(value: unknown): value is string {
  return typeof value === "string" && SEED.test(value);
}

function parseLamports(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const lamports = BigInt(value);
  if (lamports < MIN_DESK_LAMPORTS || lamports > MAX_DESK_LAMPORTS) return null;
  return lamports;
}

export function solToLamports(text: string): bigint | null {
  if (!/^\d+(\.\d{1,9})?$/.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  if (whole === undefined || whole.length > 9) return null;
  const lamports = BigInt(whole) * BigInt(1_000_000_000) + BigInt(fraction.padEnd(9, "0"));
  if (lamports < MIN_DESK_LAMPORTS || lamports > MAX_DESK_LAMPORTS) return null;
  return lamports;
}

export function parseDeskRequest(value: unknown): DeskRequest | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record.action === "status" || record.action === "open" || record.action === "swap") return { action: record.action };
  if (record.action === "wallet-escrows") return pubkey(record.wallet) ? { action: record.action, wallet: record.wallet } : null;
  if (record.action === "wallet-submit") {
    if (typeof record.tx !== "string" || record.tx.length < 32 || record.tx.length > 20_000) return null;
    if (!/^[A-Za-z0-9+/=]+$/.test(record.tx)) return null;
    return { action: record.action, tx: record.tx };
  }
  if (record.action === "wallet-notes") return seed(record.seed) ? { action: record.action, seed: record.seed } : null;
  if (record.action === "wallet-return") {
    return seed(record.seed) && pubkey(record.wallet) ? { action: record.action, seed: record.seed, wallet: record.wallet } : null;
  }
  if (record.action === "wallet-shield") {
    if (!seed(record.seed)) return null;
    const lamports = parseLamports(record.lamports);
    if (lamports === null) return null;
    return { action: record.action, seed: record.seed, lamports };
  }
  if (record.action === "wallet-lock") {
    if (!seed(record.seed) || !pubkey(record.wallet) || !pubkey(record.escrow) || !pubkey(record.note)) return null;
    const lamports = parseLamports(record.lamports);
    if (lamports === null) return null;
    return { action: record.action, seed: record.seed, wallet: record.wallet, escrow: record.escrow, note: record.note, lamports };
  }
  if (record.action === "wallet-terms") {
    if (!pubkey(record.escrow)) return null;
    const lockLamports = parseLamports(record.lockLamports);
    const receiveLamports = parseLamports(record.receiveLamports);
    if (lockLamports === null || receiveLamports === null) return null;
    return { action: record.action, escrow: record.escrow, lockLamports, receiveLamports };
  }
  if (record.action === "wallet-swap") {
    if (!seed(record.seed) || !pubkey(record.escrow)) return null;
    if (typeof record.toA !== "string" || typeof record.toB !== "string") return null;
    if (!HEX.test(record.toA) || !HEX.test(record.toB) || record.toA.length > 400 || record.toB.length > 400) return null;
    return { action: record.action, seed: record.seed, escrow: record.escrow, toA: record.toA, toB: record.toB };
  }
  if (record.action !== "shield" && record.action !== "withdraw" && record.action !== "lock") return null;
  if (record.side !== "a" && record.side !== "b") return null;
  if (record.action === "lock") {
    if (typeof record.note !== "string" || !BASE58.test(record.note)) return null;
    return { action: "lock", side: record.side, note: record.note };
  }
  const lamports = parseLamports(record.lamports);
  if (lamports === null) return null;
  return { action: record.action, side: record.side, lamports };
}
