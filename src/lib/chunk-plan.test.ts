import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_DESK_LAMPORTS } from "./desk-request.ts";
import { MAX_CHUNK_LAMPORTS, planChunk, sideView } from "./chunk-plan.ts";

const ONE_SOL = BigInt(1_000_000_000);
const CHUNK = BigInt(10_000_000);
const NOTE = BigInt(50_000_000);

describe("planChunk", () => {
  it("uses the same 1 SOL cap as the desk", () => {
    assert.equal(MAX_CHUNK_LAMPORTS, MAX_DESK_LAMPORTS);
  });

  it("accepts a chunk equal to the side's agreed amount", () => {
    assert.deepEqual(planChunk({ noteLamports: NOTE, typedLamports: CHUNK, agreedLamports: CHUNK }), {
      ok: true,
      lamports: CHUNK,
      split: true,
      change: NOTE - CHUNK,
    });
    assert.deepEqual(planChunk({ noteLamports: CHUNK, typedLamports: CHUNK, agreedLamports: CHUNK }), {
      ok: true,
      lamports: CHUNK,
      split: false,
      change: BigInt(0),
    });
  });

  it("rejects a chunk that is not the agreed amount", () => {
    assert.deepEqual(planChunk({ noteLamports: NOTE, typedLamports: CHUNK, agreedLamports: CHUNK + BigInt(1) }), {
      ok: false,
      reason: "mismatch",
    });
    assert.deepEqual(planChunk({ noteLamports: NOTE, typedLamports: CHUNK, agreedLamports: null }), {
      ok: false,
      reason: "missing-terms",
    });
  });

  it("rejects an amount larger than the note, a zero note, and a zero amount", () => {
    const oversize = planChunk({ noteLamports: CHUNK, typedLamports: NOTE, agreedLamports: NOTE });
    assert.equal(oversize.ok, false);
    if (!oversize.ok) assert.equal(oversize.reason, "oversize");
    assert.deepEqual(planChunk({ noteLamports: BigInt(0), typedLamports: CHUNK, agreedLamports: CHUNK }), {
      ok: false,
      reason: "zero-note",
    });
    assert.deepEqual(planChunk({ noteLamports: NOTE, typedLamports: BigInt(0), agreedLamports: BigInt(0) }), {
      ok: false,
      reason: "zero-amount",
    });
    assert.deepEqual(planChunk({ noteLamports: ONE_SOL * BigInt(2), typedLamports: ONE_SOL + BigInt(1), agreedLamports: ONE_SOL + BigInt(1) }), {
      ok: false,
      reason: "above-cap",
    });
  });
});

describe("sideView", () => {
  it("shows the opener locking the first amount and the counterparty locking the second", () => {
    const terms = { lockLamports: "10", receiveLamports: "20" };
    assert.deepEqual(sideView("a", terms), { lock: "10", receive: "20" });
    assert.deepEqual(sideView("b", terms), { lock: "20", receive: "10" });
  });
});
