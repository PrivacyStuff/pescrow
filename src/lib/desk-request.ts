import { MAX_SOL_LAMPORTS, SOL_MINT, parseIntegerAmount, type AssetKind } from "./chunk-plan.ts";

export const MIN_DESK_LAMPORTS = BigInt(1);
export const MAX_DESK_LAMPORTS = BigInt(1_000_000_000);
export const RING_FEE_RESERVE = 30_000_000;
export const RING_MESSAGE = "pescrow ring key v1";
export const MAX_RENT_SPACE = 10_240;
export const RPC_RATE_LIMIT_MESSAGE = "The devnet RPC is rate limiting. Retry in a moment.";
const APPROVAL_WINDOW_SEC = 6 * 60 * 60;

export function sixHourDeadline(): number {
  return Math.floor(Date.now() / 1000) + APPROVAL_WINDOW_SEC;
}

export type DeskSide = "a" | "b";

export type TermsSide = {
  readonly kind: AssetKind;
  readonly mint: string;
  readonly amount: bigint;
};

export type DeskRequest =
  | { readonly action: "status" }
  | { readonly action: "open" | "swap" }
  | { readonly action: "shield" | "withdraw" | "lock"; readonly side: DeskSide; readonly lamports?: bigint; readonly note?: string }
  | { readonly action: "wallet-escrows" | "wallet-holdings"; readonly wallet: string }
  | { readonly action: "wallet-asset-info" | "wallet-metadata"; readonly mint: string }
  | { readonly action: "wallet-chain"; readonly account?: string; readonly rentSpace?: number }
  | { readonly action: "wallet-submit"; readonly tx: string }
  | { readonly action: "wallet-notes" | "wallet-return"; readonly seed: string; readonly wallet?: string }
  | {
      readonly action: "wallet-shield";
      readonly seed: string;
      readonly lamports: bigint;
      readonly mint?: string;
      readonly tokenAccount?: string;
      readonly tokenProgram?: string;
    }
  | { readonly action: "wallet-lock"; readonly seed: string; readonly wallet: string; readonly escrow: string; readonly note: string; readonly lamports: bigint }
  | { readonly action: "wallet-carve"; readonly seed: string; readonly note: string; readonly lamports: bigint }
  | {
      readonly action: "wallet-withdraw";
      readonly seed: string;
      readonly wallet: string;
      readonly mint: string;
      readonly lamports: bigint;
      readonly tokenProgram?: string;
    }
  | { readonly action: "wallet-terms"; readonly escrow: string; readonly a: TermsSide; readonly b: TermsSide; readonly openerShield?: string }
  | { readonly action: "wallet-swap"; readonly seed: string; readonly escrow: string; readonly toA: string; readonly toB: string };

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SEED = /^[0-9a-f]{64}$/i;
const HEX = /^[0-9a-f]+$/i;
const SHIELD_HEX = /^[0-9a-fA-F]{64,400}$/;

function shieldHex(value: string): boolean {
  return value.length % 2 === 0 && SHIELD_HEX.test(value);
}

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
  if (record.action === "wallet-escrows" || record.action === "wallet-holdings") {
    return pubkey(record.wallet) ? { action: record.action, wallet: record.wallet } : null;
  }
  if (record.action === "wallet-asset-info" || record.action === "wallet-metadata") {
    return pubkey(record.mint) ? { action: record.action, mint: record.mint } : null;
  }
  if (record.action === "wallet-chain") return parseChain(record);
  if (record.action === "wallet-submit") {
    if (typeof record.tx !== "string" || record.tx.length < 32 || record.tx.length > 20_000) return null;
    if (!/^[A-Za-z0-9+/=]+$/.test(record.tx)) return null;
    return { action: record.action, tx: record.tx };
  }
  if (record.action === "wallet-notes") return seed(record.seed) ? { action: record.action, seed: record.seed } : null;
  if (record.action === "wallet-return") {
    return seed(record.seed) && pubkey(record.wallet) ? { action: record.action, seed: record.seed, wallet: record.wallet } : null;
  }
  if (record.action === "wallet-shield") return parseShield(record);
  if (record.action === "wallet-withdraw") return parseWithdraw(record);
  if (record.action === "wallet-lock") {
    if (!seed(record.seed) || !pubkey(record.wallet) || !pubkey(record.escrow) || !pubkey(record.note)) return null;
    const lamports = parseIntegerAmount(record.lamports);
    if (lamports === null) return null;
    return { action: record.action, seed: record.seed, wallet: record.wallet, escrow: record.escrow, note: record.note, lamports };
  }
  if (record.action === "wallet-carve") {
    if (!seed(record.seed) || !pubkey(record.note)) return null;
    const lamports = parseIntegerAmount(record.lamports);
    if (lamports === null) return null;
    return { action: record.action, seed: record.seed, note: record.note, lamports };
  }
  if (record.action === "wallet-terms") {
    if (!pubkey(record.escrow)) return null;
    const a = parseTermsSide(record.a);
    const b = parseTermsSide(record.b);
    if (a === null || b === null) return null;
    if (record.openerShield !== undefined && (typeof record.openerShield !== "string" || !shieldHex(record.openerShield))) return null;
    return {
      action: record.action,
      escrow: record.escrow,
      a,
      b,
      ...(record.openerShield === undefined ? {} : { openerShield: record.openerShield }),
    };
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

function parseChain(record: Record<string, unknown>): DeskRequest | null {
  const account = record.account;
  const rentSpace = record.rentSpace;
  if (account !== undefined && !pubkey(account)) return null;
  if (rentSpace !== undefined && (!Number.isInteger(rentSpace) || (rentSpace as number) < 1 || (rentSpace as number) > MAX_RENT_SPACE)) {
    return null;
  }
  return {
    action: "wallet-chain",
    ...(account === undefined ? {} : { account }),
    ...(rentSpace === undefined ? {} : { rentSpace: rentSpace as number }),
  };
}

export function rpcRateLimitMessage(text: string): string | null {
  if (/\b429\b|rate limit/i.test(text)) return RPC_RATE_LIMIT_MESSAGE;
  return null;
}

function parseShield(record: Record<string, unknown>): DeskRequest | null {
  if (!seed(record.seed)) return null;
  const mint = record.mint;
  if (mint === undefined || mint === SOL_MINT) {
    const lamports = parseLamports(record.lamports);
    if (lamports === null) return null;
    return { action: "wallet-shield", seed: record.seed, lamports };
  }
  if (!pubkey(mint) || !pubkey(record.tokenAccount) || !pubkey(record.tokenProgram)) return null;
  const lamports = parseIntegerAmount(record.lamports);
  if (lamports === null) return null;
  return {
    action: "wallet-shield",
    seed: record.seed,
    lamports,
    mint,
    tokenAccount: record.tokenAccount,
    tokenProgram: record.tokenProgram,
  };
}

function parseWithdraw(record: Record<string, unknown>): DeskRequest | null {
  if (!seed(record.seed) || !pubkey(record.wallet) || !pubkey(record.mint)) return null;
  const lamports = parseIntegerAmount(record.amount);
  if (lamports === null) return null;
  if (record.mint === SOL_MINT) {
    return { action: "wallet-withdraw", seed: record.seed, wallet: record.wallet, mint: record.mint, lamports };
  }
  if (!pubkey(record.tokenProgram)) return null;
  return {
    action: "wallet-withdraw",
    seed: record.seed,
    wallet: record.wallet,
    mint: record.mint,
    lamports,
    tokenProgram: record.tokenProgram,
  };
}

function parseTermsSide(value: unknown): TermsSide | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  if (row.kind !== "sol" && row.kind !== "token" && row.kind !== "nft") return null;
  if (!pubkey(row.mint)) return null;
  const amount = parseIntegerAmount(row.amount);
  if (amount === null) return null;
  if (row.kind === "sol") {
    if (row.mint !== SOL_MINT || amount > MAX_SOL_LAMPORTS) return null;
  } else if (row.mint === SOL_MINT) {
    return null;
  }
  if (row.kind === "nft" && amount !== BigInt(1)) return null;
  return { kind: row.kind, mint: row.mint, amount };
}
