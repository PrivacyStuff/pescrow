import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { notePickRefusal, notesForRedeem, pickNoteForAction, redeemStopMessage, type SpendNote } from "./note-selection.ts";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const JUP = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";

const notes: readonly SpendNote[] = [
  { hash: "small", mint: USDC, amount: BigInt(1) },
  { hash: "mid", mint: USDC, amount: BigInt(90) },
  { hash: "exact", mint: USDC, amount: BigInt(200) },
  { hash: "large", mint: USDC, amount: BigInt(400) },
  { hash: "jup", mint: JUP, amount: BigInt(540) },
];

describe("pickNoteForAction", () => {
  it("uses the only selected note, even when a larger one exists", () => {
    const pick = pickNoteForAction({ notes, selected: ["small"], mint: USDC, amount: BigInt(90) });
    assert.deepEqual(pick, { ok: true, hash: "small" });
  });

  it("prefers an exact selected note, otherwise the smallest selected note that covers", () => {
    const exact = pickNoteForAction({ notes, selected: ["mid", "exact", "large"], mint: USDC, amount: BigInt(200) });
    assert.deepEqual(exact, { ok: true, hash: "exact" });
    const cover = pickNoteForAction({ notes, selected: ["mid", "large"], mint: USDC, amount: BigInt(100) });
    assert.deepEqual(cover, { ok: true, hash: "large" });
  });

  it("does not combine notes and names the other mint", () => {
    const short = pickNoteForAction({ notes, selected: ["small", "mid"], mint: USDC, amount: BigInt(100) });
    assert.equal(short.ok, false);
    if (short.ok) return;
    assert.equal(notePickRefusal(short, (mint) => mint), "None of the selected EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v notes cover this amount. Amounts are not combined.");
    const mixed = pickNoteForAction({ notes, selected: ["exact", "jup"], mint: USDC, amount: BigInt(200) });
    assert.equal(mixed.ok, false);
    if (mixed.ok || mixed.reason !== "mixed") return;
    assert.deepEqual(mixed.also, [JUP]);
    assert.match(notePickRefusal(mixed, (mint) => (mint === USDC ? "USD Coin" : "Jup")), /Keep USD Coin selected\. Jup is also selected\./);
  });
});

describe("notesForRedeem", () => {
  it("keeps selection order and skips zero notes", () => {
    const withEmpty: readonly SpendNote[] = [...notes, { hash: "empty", mint: USDC, amount: BigInt(0) }];
    const plan = notesForRedeem(withEmpty, ["empty", "jup", "missing", "small"]);
    assert.deepEqual(
      plan.map((note) => note.hash),
      ["jup", "small"],
    );
    assert.deepEqual(notesForRedeem(notes, []), []);
  });

  it("names the failed note and the notes that already went out", () => {
    assert.equal(
      redeemStopMessage("100 Jup", ["1 USD Coin"], "The wallet rejected the signature."),
      "Redeem stopped on 100 Jup. Already redeemed: 1 USD Coin. The wallet rejected the signature.",
    );
    assert.match(redeemStopMessage("90 USD Coin", [], "The redeem failed."), /None had been redeemed yet/);
  });
});
