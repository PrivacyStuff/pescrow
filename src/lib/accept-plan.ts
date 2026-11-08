import type { AssetKind } from "./chunk-plan.ts";
import { recipientCanLock } from "./escrow-account.ts";
import { chooseShieldedNote, decideFundingSource, type SpendableNote } from "./funding-source.ts";

export type AcceptNote = {
  readonly hash: string;
  readonly mint: string;
  readonly amount: string;
};

export type AcceptLock = {
  readonly mint: string;
  readonly amount: string;
  readonly kind: AssetKind;
};

/** What Accept may do for the recipient. A lock is never planned before party A is sealed. */
export type AcceptGate = {
  readonly canApprove: boolean;
  readonly canLock: boolean;
  readonly canSwap: boolean;
  readonly carve: boolean;
  readonly wrap: boolean;
  readonly shortfall: boolean;
  readonly unreadable: boolean;
  readonly waitsForOpener: boolean;
  readonly deadlinePassed: boolean;
  readonly enabled: boolean;
  readonly noteHash: string | null;
  readonly noteAmount: bigint | null;
};

export function planRecipientAccept(input: {
  readonly status: string;
  readonly role: "a" | "b";
  readonly bApproved: boolean;
  readonly aSealed: boolean;
  readonly bSealed: boolean;
  readonly approvalDeadline: number;
  readonly startAt: number;
  readonly now: number;
  readonly lock: AcceptLock | null;
  readonly notes: readonly AcceptNote[];
  readonly publicMax: bigint | null;
}): AcceptGate {
  const proposed = input.status === "Proposed" && input.role === "b";
  const beforeDeadline = input.now < input.approvalDeadline && input.now < input.startAt;
  const canApprove = proposed && !input.bApproved && beforeDeadline;
  const deadlinePassed = proposed && !input.bApproved && !beforeDeadline;
  const funding = proposed && input.lock !== null ? assessLockFunding(input.lock, input.notes, input.publicMax) : { kind: "none" as const };
  const covered = funding.kind === "exact" || funding.kind === "carve";
  const fundable = covered || funding.kind === "wrap";
  // This click approves before it locks. The chain still requires b_approved and a sealed opener.
  const canLock =
    recipientCanLock({
      status: input.status,
      role: input.role,
      aSealed: input.aSealed,
      bApproved: input.bApproved || canApprove,
      bSealed: input.bSealed,
    }) && fundable;
  const canSwap = proposed && input.aSealed && input.bSealed && input.bApproved;
  const waitsForOpener = proposed && input.bApproved && !input.aSealed && !input.bSealed && covered;
  return {
    canApprove,
    canLock,
    canSwap,
    carve: canLock && funding.kind === "carve",
    wrap: canLock && funding.kind === "wrap",
    shortfall: funding.kind === "short",
    unreadable: funding.kind === "unread",
    waitsForOpener,
    deadlinePassed,
    enabled: canApprove || canLock || canSwap,
    noteHash: funding.kind === "exact" || funding.kind === "carve" ? funding.noteHash : null,
    noteAmount: funding.kind === "exact" || funding.kind === "carve" ? funding.noteAmount : null,
  };
}

export function acceptReason(input: {
  readonly gate: AcceptGate;
  readonly aSealed: boolean;
  readonly lockLabel: string | null;
  readonly receiveLabel: string | null;
  readonly coverLabel: string | null;
}): string | null {
  const { gate } = input;
  if (gate.canApprove && !input.aSealed) {
    if (input.lockLabel !== null && input.receiveLabel !== null) {
      return `Accept approves you. You lock ${input.lockLabel}. The opener has not sealed ${input.receiveLabel}.`;
    }
    return "Accept approves you. The opener has not sealed their asset.";
  }
  if (gate.waitsForOpener && input.coverLabel !== null && input.lockLabel !== null && input.receiveLabel !== null) {
    return `${input.coverLabel} covers ${input.lockLabel}. The note stays in the private balance. The lock waits until the opener seals ${input.receiveLabel}.`;
  }
  if (gate.canApprove && input.aSealed && gate.shortfall && input.lockLabel !== null) {
    return `Accept approves you. The shielded balance is short of ${input.lockLabel}, and the public balance cannot cover the wrap. Nothing will be carved or locked.`;
  }
  if (gate.shortfall && input.lockLabel !== null) {
    const wait = !input.aSealed && input.receiveLabel !== null ? ` The lock waits until the opener seals ${input.receiveLabel}.` : "";
    return `The shielded balance is short of ${input.lockLabel}, and the public balance cannot cover the wrap.${wait} Nothing was shielded, carved, or locked.`;
  }
  if (gate.unreadable && !gate.canLock && input.lockLabel !== null) {
    return `The shielded balance is short of ${input.lockLabel}. The public balance could not be read, so nothing was shielded, carved, or locked.`;
  }
  if (gate.deadlinePassed) return "The approval deadline has passed. This side cannot approve or lock.";
  return null;
}

export function publicBalanceMax(holdings: readonly { readonly mint: string; readonly maxBase: string }[] | null, mint: string | null): bigint | null {
  if (holdings === null || mint === null) return null;
  const holding = holdings.find((asset) => asset.mint === mint);
  if (holding === undefined || !/^\d+$/.test(holding.maxBase)) return BigInt(0);
  return BigInt(holding.maxBase);
}

type LockFunding =
  | { readonly kind: "exact" | "carve"; readonly noteHash: string; readonly noteAmount: bigint }
  | { readonly kind: "wrap" }
  | { readonly kind: "short" }
  | { readonly kind: "unread" }
  | { readonly kind: "none" };

function assessLockFunding(lock: AcceptLock, notes: readonly AcceptNote[], publicMax: bigint | null): LockFunding {
  const amount = parseBase(lock.amount);
  if (amount === null) return { kind: "none" };
  const chosen = chooseShieldedNote(spendable(notes), lock.mint, amount);
  if (chosen !== null && chosen.fit !== "short") {
    const decision = decideFundingSource({
      mint: lock.mint,
      amount,
      kind: lock.kind,
      source: { kind: "shielded", hash: chosen.hash, mint: lock.mint, amount: chosen.amount },
    });
    if (decision.ok && decision.action === "spend") return { kind: "exact", noteHash: chosen.hash, noteAmount: chosen.amount };
    if (decision.ok && decision.action === "carve") return { kind: "carve", noteHash: chosen.hash, noteAmount: chosen.amount };
  }
  if (publicMax === null) return { kind: "unread" };
  const pub = decideFundingSource({
    mint: lock.mint,
    amount,
    kind: lock.kind,
    source: { kind: "public", mint: lock.mint, maxBase: publicMax },
  });
  if (pub.ok && pub.action === "wrap") return { kind: "wrap" };
  return { kind: "short" };
}

function spendable(notes: readonly AcceptNote[]): SpendableNote[] {
  const parsed: SpendableNote[] = [];
  for (const note of notes) {
    const amount = parseBase(note.amount);
    if (amount === null) continue;
    parsed.push({ hash: note.hash, mint: note.mint, amount });
  }
  return parsed;
}

function parseBase(value: string): bigint | null {
  if (!/^\d+$/.test(value)) return null;
  const amount = BigInt(value);
  return amount > BigInt(0) ? amount : null;
}
