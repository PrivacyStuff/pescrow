export const MIN_CHUNK_LAMPORTS = BigInt(1);
export const MAX_SOL_LAMPORTS = BigInt(1_000_000_000);
/** SOL locks stay inside the desk cap. Token and NFT amounts use `MAX_BASE_UNITS`. */
export const MAX_CHUNK_LAMPORTS = MAX_SOL_LAMPORTS;
export const MAX_BASE_UNITS = (BigInt(1) << BigInt(64)) - BigInt(1);
export const SOL_MINT = "11111111111111111111111111111111";
export const SOL_DECIMALS = 9;
/** `buildSplitTransaction` only emits this many equal notes. */
export const SPLIT_MIN_PARTS = 2;
export const SPLIT_MAX_PARTS = 8;

export type CarveMethod =
  | { readonly kind: "whole" }
  | { readonly kind: "split"; readonly parts: number }
  | { readonly kind: "transfer" };

/**
 * How to take `chunkAmount` out of `noteAmount`.
 * One equal split only when the part count is 2–8. A larger count (10 out of
 * 1000, 100 out of 1000) and any amount that does not divide the note use a
 * self-transfer of the chunk; the remainder stays a separate note.
 */
export function carveMethod(noteAmount: bigint, chunkAmount: bigint): CarveMethod {
  if (chunkAmount <= BigInt(0) || noteAmount < chunkAmount) {
    throw new Error("a chunk has to fit inside the note");
  }
  if (chunkAmount === noteAmount) return { kind: "whole" };
  if (noteAmount % chunkAmount !== BigInt(0)) return { kind: "transfer" };
  const parts = noteAmount / chunkAmount;
  if (parts >= BigInt(SPLIT_MIN_PARTS) && parts <= BigInt(SPLIT_MAX_PARTS)) {
    return { kind: "split", parts: Number(parts) };
  }
  return { kind: "transfer" };
}
const U64_DIGITS = 20;

export type AssetKind = "sol" | "token" | "nft";

export type AssetSide = {
  readonly kind: AssetKind;
  readonly mint: string;
  readonly amount: string;
};

export type SwapTerms = {
  readonly a: AssetSide;
  readonly b: AssetSide;
  /** Opener's shielded address, hex. Saved so the same machine can name them in a swap. */
  readonly openerShield?: string;
};

export type ChunkRefusal =
  | "zero-note"
  | "zero-amount"
  | "oversize"
  | "above-cap"
  | "mismatch"
  | "missing-terms"
  | "mint-mismatch"
  | "not-splittable";

export type ChunkPlan =
  | { readonly ok: true; readonly amount: bigint; readonly split: boolean; readonly change: bigint }
  | { readonly ok: false; readonly reason: ChunkRefusal };

export function sideView(role: "a" | "b", terms: SwapTerms): { readonly lock: AssetSide; readonly receive: AssetSide } {
  if (role === "a") return { lock: terms.a, receive: terms.b };
  return { lock: terms.b, receive: terms.a };
}

export function parseIntegerAmount(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^\d+$/.test(value) || value.length > U64_DIGITS) return null;
  const amount = BigInt(value);
  if (amount < MIN_CHUNK_LAMPORTS || amount > MAX_BASE_UNITS) return null;
  return amount;
}

export function planChunk(input: {
  readonly noteAmount: bigint;
  readonly typedAmount: bigint;
  readonly agreedAmount: bigint | null;
  readonly noteMint: string;
  readonly agreedMint: string | null;
  readonly kind: AssetKind | null;
}): ChunkPlan {
  if (input.noteAmount <= BigInt(0)) return { ok: false, reason: "zero-note" };
  if (input.typedAmount <= BigInt(0)) return { ok: false, reason: "zero-amount" };
  if (input.typedAmount > MAX_BASE_UNITS) return { ok: false, reason: "above-cap" };
  if (input.noteMint === SOL_MINT && input.typedAmount > MAX_SOL_LAMPORTS) return { ok: false, reason: "above-cap" };
  if (input.typedAmount > input.noteAmount) return { ok: false, reason: "oversize" };
  if (input.agreedAmount === null || input.agreedMint === null || input.kind === null) {
    return { ok: false, reason: "missing-terms" };
  }
  if (input.noteMint !== input.agreedMint) return { ok: false, reason: "mint-mismatch" };
  if (input.typedAmount !== input.agreedAmount) return { ok: false, reason: "mismatch" };
  const change = input.noteAmount - input.typedAmount;
  if (input.kind === "nft" && change > BigInt(0)) return { ok: false, reason: "not-splittable" };
  return { ok: true, amount: input.typedAmount, split: change > BigInt(0), change };
}

export function chunkRefusal(reason: ChunkRefusal): string {
  switch (reason) {
    case "zero-note":
      return "A zero note cannot be locked or split.";
    case "zero-amount":
      return "Enter an amount above zero.";
    case "oversize":
      return "That amount is larger than the selected note.";
    case "above-cap":
      return "SOL locks are at most 1 SOL. Any other amount has to fit in a u64.";
    case "mismatch":
      return "The amount does not match this side's agreed amount. The program does not enforce it; this desk does.";
    case "missing-terms":
      return "Save what this side will lock and what it expects back before locking.";
    case "mint-mismatch":
      return "That note is a different asset from the one this side agreed to lock.";
    case "not-splittable":
      return "An NFT locks as a whole note. Pick the note that is exactly that NFT.";
  }
}
