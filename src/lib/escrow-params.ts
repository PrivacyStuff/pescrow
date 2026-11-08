import { SOL_DECIMALS, SOL_MINT, MAX_BASE_UNITS, MAX_SOL_LAMPORTS, MIN_CHUNK_LAMPORTS, type AssetKind } from "./chunk-plan.ts";
import { decodeBase58 } from "./escrow-account.ts";

export const RING_PERMISSIONLESS = 1;
export const WALLETS_PUBLIC = 1;
export const APPROVAL_WINDOW_HOURS = 6;
const SECONDS_PER_HOUR = 60 * 60;
const MAX_DECIMALS = 18;

export type ParamRefusal =
  | "bad-counterparty"
  | "same-party"
  | "bad-deadline"
  | "bad-asset"
  | "bad-amount"
  | "nft-amount"
  | "sol-cap";

export type AssetInput = {
  readonly kind: AssetKind;
  readonly mint: string;
  readonly amount: string;
  readonly decimals: number;
};

export type EscrowFormInput = {
  readonly opener: string;
  readonly counterparty: string;
  readonly mine: AssetInput;
  readonly theirs: AssetInput;
  readonly approvalDeadline: number;
  readonly startAt: number;
};

export type ParsedSide = {
  readonly kind: AssetKind;
  readonly mint: string;
  readonly amount: bigint;
  readonly decimals: number;
};

export type ParsedEscrow = {
  readonly counterparty: string;
  readonly mine: ParsedSide;
  readonly theirs: ParsedSide;
  readonly approvalDeadline: number;
  readonly startAt: number;
  readonly ring: typeof RING_PERMISSIONLESS;
  readonly wallets: typeof WALLETS_PUBLIC;
};

export function defaultWindow(nowSec: number): { readonly approvalDeadline: number; readonly startAt: number } {
  const deadline = nowSec + APPROVAL_WINDOW_HOURS * SECONDS_PER_HOUR;
  return { approvalDeadline: deadline, startAt: deadline };
}

export function parseBaseAmount(text: string, decimals: number): bigint | null {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) return null;
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  if (whole === undefined || whole.length > 20 || fraction.length > decimals) return null;
  const scale = BigInt(10) ** BigInt(decimals);
  const base = BigInt(whole) * scale + BigInt(fraction.padEnd(decimals, "0") || "0");
  if (base < MIN_CHUNK_LAMPORTS || base > MAX_BASE_UNITS) return null;
  return base;
}

export function parseEscrowParams(
  form: EscrowFormInput,
  nowSec: number,
): { readonly ok: true; readonly value: ParsedEscrow } | { readonly ok: false; readonly reason: ParamRefusal } {
  const opener = decodeBase58(form.opener);
  const counterparty = decodeBase58(form.counterparty.trim());
  if (opener === null || counterparty === null) return { ok: false, reason: "bad-counterparty" };
  if (equal32(opener, counterparty)) return { ok: false, reason: "same-party" };
  if (!Number.isSafeInteger(nowSec) || !Number.isSafeInteger(form.approvalDeadline) || !Number.isSafeInteger(form.startAt)) {
    return { ok: false, reason: "bad-deadline" };
  }
  if (nowSec >= form.approvalDeadline || form.approvalDeadline > form.startAt) return { ok: false, reason: "bad-deadline" };
  const mine = parseSide(form.mine);
  if (typeof mine === "string") return { ok: false, reason: mine };
  const theirs = parseSide(form.theirs);
  if (typeof theirs === "string") return { ok: false, reason: theirs };
  return {
    ok: true,
    value: {
      counterparty: form.counterparty.trim(),
      mine,
      theirs,
      approvalDeadline: form.approvalDeadline,
      startAt: form.startAt,
      ring: RING_PERMISSIONLESS,
      wallets: WALLETS_PUBLIC,
    },
  };
}

export function paramRefusal(reason: ParamRefusal): string {
  switch (reason) {
    case "bad-counterparty":
      return "The other wallet address is not a Solana address.";
    case "same-party":
      return "The other wallet has to be a different address.";
    case "bad-deadline":
      return "The approval deadline has to be in the future, and the reclaim time has to be at or after that deadline.";
    case "bad-asset":
      return "Pick SOL, a token mint, or an NFT mint.";
    case "bad-amount":
      return "Enter an amount above zero that fits the asset's decimals.";
    case "nft-amount":
      return "An NFT escrow locks exactly one.";
    case "sol-cap":
      return "SOL on a side is at most 1 SOL.";
  }
}

function parseSide(side: AssetInput): ParsedSide | ParamRefusal {
  if (side.kind === "sol") {
    if (side.decimals !== SOL_DECIMALS) return "bad-asset";
    const amount = parseBaseAmount(side.amount, SOL_DECIMALS);
    if (amount === null) return "bad-amount";
    if (amount > MAX_SOL_LAMPORTS) return "sol-cap";
    return { kind: "sol", mint: SOL_MINT, amount, decimals: SOL_DECIMALS };
  }
  if (side.kind !== "token" && side.kind !== "nft") return "bad-asset";
  if (decodeBase58(side.mint.trim()) === null || side.mint.trim() === SOL_MINT) return "bad-asset";
  if (!Number.isInteger(side.decimals) || side.decimals < 0 || side.decimals > MAX_DECIMALS) return "bad-asset";
  if (side.kind === "nft" && side.decimals !== 0) return "bad-asset";
  const amount = parseBaseAmount(side.amount, side.decimals);
  if (amount === null) return "bad-amount";
  if (side.kind === "nft" && amount !== BigInt(1)) return "nft-amount";
  return { kind: side.kind, mint: side.mint.trim(), amount, decimals: side.decimals };
}

function equal32(left: Uint8Array, right: Uint8Array): boolean {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}
