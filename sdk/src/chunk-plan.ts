export const MIN_CHUNK_LAMPORTS = BigInt(1);
export const MAX_CHUNK_LAMPORTS = BigInt(1_000_000_000);

export type ChunkRefusal = "zero-note" | "zero-amount" | "oversize" | "above-cap" | "mismatch" | "missing-terms";

export type ChunkPlan =
  | { readonly ok: true; readonly lamports: bigint; readonly split: boolean; readonly change: bigint }
  | { readonly ok: false; readonly reason: ChunkRefusal };

export type SwapTerms = { readonly lockLamports: string; readonly receiveLamports: string };

export function sideView(role: "a" | "b", terms: SwapTerms): { readonly lock: string; readonly receive: string } {
  if (role === "a") return { lock: terms.lockLamports, receive: terms.receiveLamports };
  return { lock: terms.receiveLamports, receive: terms.lockLamports };
}

export function planChunk(input: {
  readonly noteLamports: bigint;
  readonly typedLamports: bigint;
  readonly agreedLamports: bigint | null;
}): ChunkPlan {
  if (input.noteLamports <= BigInt(0)) return { ok: false, reason: "zero-note" };
  if (input.typedLamports <= BigInt(0)) return { ok: false, reason: "zero-amount" };
  if (input.typedLamports > MAX_CHUNK_LAMPORTS) return { ok: false, reason: "above-cap" };
  if (input.typedLamports > input.noteLamports) return { ok: false, reason: "oversize" };
  if (input.agreedLamports === null) return { ok: false, reason: "missing-terms" };
  if (input.typedLamports !== input.agreedLamports) return { ok: false, reason: "mismatch" };
  const change = input.noteLamports - input.typedLamports;
  return { ok: true, lamports: input.typedLamports, split: change > BigInt(0), change };
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
      return "Amount must be at most 1 SOL.";
    case "mismatch":
      return "The chunk does not match this side's agreed amount. The program does not enforce it; this desk does.";
    case "missing-terms":
      return "Save what this side will lock and what it expects back before locking.";
  }
}
