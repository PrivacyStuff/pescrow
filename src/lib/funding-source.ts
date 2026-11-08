import {
  MAX_BASE_UNITS,
  MAX_SOL_LAMPORTS,
  MIN_CHUNK_LAMPORTS,
  SOL_MINT,
  carveMethod,
  type AssetKind,
  type CarveMethod,
} from "./chunk-plan.ts";

export type SpendableNote = {
  readonly hash: string;
  readonly mint: string;
  readonly amount: bigint;
};

export type FundingSource =
  | { readonly kind: "public"; readonly mint: string; readonly maxBase: bigint }
  | { readonly kind: "shielded"; readonly hash: string; readonly mint: string; readonly amount: bigint };

export type FundingRefusal = "mint-mismatch" | "shortfall" | "zero-amount" | "above-cap" | "not-splittable";

export type FundingDecision =
  | { readonly ok: true; readonly action: "wrap"; readonly amount: bigint }
  | { readonly ok: true; readonly action: "spend"; readonly noteHash: string; readonly amount: bigint }
  | {
      readonly ok: true;
      readonly action: "carve";
      readonly noteHash: string;
      readonly amount: bigint;
      readonly carve: CarveMethod;
    }
  | { readonly ok: false; readonly reason: FundingRefusal };

export type ShieldedFit =
  | { readonly fit: "exact" | "carve"; readonly hash: string; readonly amount: bigint }
  | { readonly fit: "short"; readonly hash: string; readonly amount: bigint };

/**
 * Note of `mint` to fund `amount`. An exact note wins. Otherwise the smallest
 * note that covers the amount. A mint with only smaller notes is a shortfall.
 */
export function chooseShieldedNote(notes: readonly SpendableNote[], mint: string, amount: bigint): ShieldedFit | null {
  const same = notes.filter((note) => note.mint === mint && note.amount > BigInt(0));
  if (same.length === 0) return null;
  const exact = same
    .filter((note) => note.amount === amount)
    .sort((left, right) => (left.hash < right.hash ? -1 : left.hash > right.hash ? 1 : 0));
  const picked = exact[0];
  if (picked !== undefined) return { fit: "exact", hash: picked.hash, amount: picked.amount };
  const covering = same
    .filter((note) => note.amount > amount)
    .sort((left, right) => {
      if (left.amount < right.amount) return -1;
      if (left.amount > right.amount) return 1;
      return left.hash < right.hash ? -1 : left.hash > right.hash ? 1 : 0;
    });
  const carveFrom = covering[0];
  if (carveFrom !== undefined) return { fit: "carve", hash: carveFrom.hash, amount: carveFrom.amount };
  const largest = same.reduce((best, note) => (note.amount > best.amount ? note : best));
  return { fit: "short", hash: largest.hash, amount: largest.amount };
}

/**
 * Public source wraps. A larger shielded note carves to `amount`. An equal
 * note is spent whole. A smaller note or a different mint does not start a transfer.
 */
export function decideFundingSource(input: {
  readonly mint: string;
  readonly amount: bigint;
  readonly kind: AssetKind;
  readonly source: FundingSource;
}): FundingDecision {
  if (input.amount < MIN_CHUNK_LAMPORTS) return { ok: false, reason: "zero-amount" };
  if (input.amount > MAX_BASE_UNITS) return { ok: false, reason: "above-cap" };
  if (input.mint === SOL_MINT && input.amount > MAX_SOL_LAMPORTS) return { ok: false, reason: "above-cap" };
  if (input.kind === "nft" && input.amount !== BigInt(1)) return { ok: false, reason: "not-splittable" };
  if (input.source.mint !== input.mint) return { ok: false, reason: "mint-mismatch" };
  if (input.source.kind === "public") {
    if (input.source.maxBase < input.amount) return { ok: false, reason: "shortfall" };
    return { ok: true, action: "wrap", amount: input.amount };
  }
  if (input.source.amount < input.amount) return { ok: false, reason: "shortfall" };
  if (input.kind === "nft" && input.source.amount !== BigInt(1)) return { ok: false, reason: "not-splittable" };
  if (input.source.amount === input.amount) {
    return { ok: true, action: "spend", noteHash: input.source.hash, amount: input.amount };
  }
  return {
    ok: true,
    action: "carve",
    noteHash: input.source.hash,
    amount: input.amount,
    carve: carveMethod(input.source.amount, input.amount),
  };
}

export function fundingRefusal(reason: FundingRefusal): string {
  switch (reason) {
    case "mint-mismatch":
      return "That balance is a different asset. Pick a shielded note or the public balance of the asset you are locking.";
    case "shortfall":
      return "That balance is smaller than the escrow amount. Nothing was shielded, carved, or locked.";
    case "zero-amount":
      return "Enter an amount above zero.";
    case "above-cap":
      return "SOL locks are at most 1 SOL. Any other amount has to fit in a u64.";
    case "not-splittable":
      return "An NFT is amount 1. Shield or spend the note that is exactly that NFT.";
  }
}
