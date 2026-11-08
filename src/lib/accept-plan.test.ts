import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { acceptReason, planRecipientAccept, type AcceptGate } from "./accept-plan.ts";

const JUP = "jup-mint";
const USDC = "usdc-mint";
const NOW = 1_000;
const LATER = 2_000;
const LOCK = BigInt(540);
const COVER = BigInt(600);
const SHORT = BigInt(100);

function gate(overrides: {
  readonly bApproved?: boolean;
  readonly aSealed?: boolean;
  readonly bSealed?: boolean;
  readonly note?: bigint;
  readonly extraNote?: bigint;
  readonly publicMax?: bigint | null;
  readonly now?: number;
}): AcceptGate {
  const notes = [{ hash: "jup-note", mint: JUP, amount: (overrides.note ?? COVER).toString() }];
  if (overrides.extraNote !== undefined) notes.push({ hash: "jup-exact", mint: JUP, amount: overrides.extraNote.toString() });
  notes.push({ hash: "usdc-note", mint: USDC, amount: "200" });
  return planRecipientAccept({
    status: "Proposed",
    role: "b",
    bApproved: overrides.bApproved ?? false,
    aSealed: overrides.aSealed ?? false,
    bSealed: overrides.bSealed ?? false,
    approvalDeadline: LATER,
    startAt: LATER,
    now: overrides.now ?? NOW,
    lock: { mint: JUP, amount: LOCK.toString(), kind: "token" },
    notes,
    publicMax: overrides.publicMax === undefined ? BigInt(0) : overrides.publicMax,
  });
}

describe("planRecipientAccept", () => {
  it("lets an unapproved recipient approve while party A is unsealed, and does not lock", () => {
    const planned = gate({ bApproved: false, aSealed: false, note: COVER });
    assert.equal(planned.canApprove, true);
    assert.equal(planned.canLock, false);
    assert.equal(planned.carve, false);
    assert.equal(planned.enabled, true);
    assert.equal(planned.waitsForOpener, false);
  });

  it("does not lock after approval while party A is unsealed, even when the note covers the amount", () => {
    const planned = gate({ bApproved: true, aSealed: false, note: COVER });
    assert.equal(planned.canApprove, false);
    assert.equal(planned.canLock, false);
    assert.equal(planned.carve, false);
    assert.equal(planned.waitsForOpener, true);
    assert.equal(planned.enabled, false);
    assert.equal(planned.noteAmount, COVER);
    const reason = acceptReason({
      gate: planned,
      aSealed: false,
      lockLabel: "540 Jup",
      receiveLabel: "200 USD Coin",
      coverLabel: "600 Jup",
    });
    assert.equal(
      reason,
      "600 Jup covers 540 Jup. The note stays in the private balance. The lock waits until the opener seals 200 USD Coin.",
    );
  });

  it("carves a larger note and then locks once party A is sealed", () => {
    const planned = gate({ bApproved: true, aSealed: true, note: COVER });
    assert.equal(planned.canLock, true);
    assert.equal(planned.carve, true);
    assert.equal(planned.wrap, false);
    assert.equal(planned.shortfall, false);
    assert.equal(planned.noteHash, "jup-note");
    assert.equal(planned.noteAmount, COVER);
  });

  it("prefers an exact note over a larger one", () => {
    const planned = gate({ bApproved: true, aSealed: true, note: COVER, extraNote: LOCK });
    assert.equal(planned.carve, false);
    assert.equal(planned.canLock, true);
    assert.equal(planned.noteHash, "jup-exact");
    assert.equal(planned.noteAmount, LOCK);
  });

  it("reports a shortfall when the note is too small and the public balance cannot wrap", () => {
    const planned = gate({ bApproved: true, aSealed: true, note: SHORT, publicMax: BigInt(50) });
    assert.equal(planned.shortfall, true);
    assert.equal(planned.canLock, false);
    assert.equal(planned.carve, false);
    assert.equal(planned.wrap, false);
    assert.equal(planned.enabled, false);
    const reason = acceptReason({
      gate: planned,
      aSealed: true,
      lockLabel: "540 Jup",
      receiveLabel: "200 USD Coin",
      coverLabel: null,
    });
    assert.equal(reason?.includes("short of 540 Jup"), true);
    assert.equal(reason?.includes("public balance cannot cover the wrap"), true);
  });

  it("wraps from the public balance when the shielded note is short and party A is sealed", () => {
    const planned = gate({ bApproved: true, aSealed: true, note: SHORT, publicMax: LOCK });
    assert.equal(planned.shortfall, false);
    assert.equal(planned.wrap, true);
    assert.equal(planned.canLock, true);
    assert.equal(planned.carve, false);
  });

  it("names the lock and the unsealed opener asset while approval is still required", () => {
    const planned = gate({ bApproved: false, aSealed: false, note: COVER });
    const reason = acceptReason({
      gate: planned,
      aSealed: false,
      lockLabel: "540 Jup",
      receiveLabel: "200 USD Coin",
      coverLabel: "600 Jup",
    });
    assert.equal(reason, "Accept approves you. You lock 540 Jup. The opener has not sealed 200 USD Coin.");
    assert.equal(reason?.includes("waits until the opener's asset is in escrow"), false);
  });
});
