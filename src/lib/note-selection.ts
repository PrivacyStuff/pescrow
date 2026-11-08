export type SpendNote = {
  readonly hash: string;
  readonly mint: string;
  readonly amount: bigint;
};

export type NotePick =
  | { readonly ok: true; readonly hash: string }
  | { readonly ok: false; readonly reason: "none" | "short"; readonly needed: string }
  | { readonly ok: false; readonly reason: "mixed"; readonly needed: string; readonly also: readonly string[] };

/**
 * One note for an action that cannot spend two notes in one proof.
 * One selected note is used as-is. Several notes of the needed mint use an
 * exact amount, otherwise the smallest selected note that covers it.
 */
export function pickNoteForAction(input: {
  readonly notes: readonly SpendNote[];
  readonly selected: readonly string[];
  readonly mint: string;
  readonly amount: bigint;
}): NotePick {
  const byHash = new Map(input.notes.map((note) => [note.hash, note]));
  const chosen: SpendNote[] = [];
  for (const hash of input.selected) {
    const note = byHash.get(hash);
    if (note !== undefined && note.amount > BigInt(0)) chosen.push(note);
  }
  const mints: string[] = [];
  for (const note of chosen) {
    if (!mints.includes(note.mint)) mints.push(note.mint);
  }
  if (mints.length > 1 || (mints.length === 1 && mints[0] !== input.mint)) {
    return { ok: false, reason: "mixed", needed: input.mint, also: mints.filter((mint) => mint !== input.mint) };
  }
  const only = chosen[0];
  if (chosen.length === 1 && only !== undefined) return { ok: true, hash: only.hash };
  const pool = chosen.filter((note) => note.mint === input.mint);
  if (pool.length === 0) return { ok: false, reason: "none", needed: input.mint };
  const exact = pool.filter((note) => note.amount === input.amount).sort(byHashOrder);
  const exactNote = exact[0];
  if (exactNote !== undefined) return { ok: true, hash: exactNote.hash };
  const covering = pool.filter((note) => note.amount > input.amount).sort(byAmountThenHash);
  const cover = covering[0];
  if (cover !== undefined) return { ok: true, hash: cover.hash };
  return { ok: false, reason: "short", needed: input.mint };
}

export function notePickRefusal(pick: Exclude<NotePick, { readonly ok: true }>, label: (mint: string) => string): string {
  const needed = label(pick.needed);
  if (pick.reason === "none") return `Select a ${needed} note.`;
  if (pick.reason === "short") return `None of the selected ${needed} notes cover this amount. Amounts are not combined.`;
  if (pick.reason === "mixed") {
    const also = pick.also.map(label).join(", ");
    return `Keep ${needed} selected. ${also} is also selected.`;
  }
  return `Select a ${needed} note.`;
}

/** Positive selected notes, in selection order. Zero notes and unknown hashes are skipped. */
export function notesForRedeem(notes: readonly SpendNote[], selected: readonly string[]): readonly SpendNote[] {
  const byHash = new Map(notes.map((note) => [note.hash, note]));
  const chosen: SpendNote[] = [];
  for (const hash of selected) {
    const note = byHash.get(hash);
    if (note !== undefined && note.amount > BigInt(0)) chosen.push(note);
  }
  return chosen;
}

export function redeemStopMessage(failed: string, sent: readonly string[], reason: string): string {
  const already = sent.length === 0 ? "None had been redeemed yet." : `Already redeemed: ${sent.join(", ")}.`;
  return `Redeem stopped on ${failed}. ${already} ${reason}`;
}

function byHashOrder(left: SpendNote, right: SpendNote): number {
  if (left.hash < right.hash) return -1;
  if (left.hash > right.hash) return 1;
  return 0;
}

function byAmountThenHash(left: SpendNote, right: SpendNote): number {
  if (left.amount < right.amount) return -1;
  if (left.amount > right.amount) return 1;
  return byHashOrder(left, right);
}
