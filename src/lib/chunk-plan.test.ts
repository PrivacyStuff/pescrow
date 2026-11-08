import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_DESK_LAMPORTS } from "./desk-request.ts";
import { MAX_CHUNK_LAMPORTS, SOL_MINT, carveMethod, planChunk, sideView, type SwapTerms } from "./chunk-plan.ts";

const ONE_SOL = BigInt(1_000_000_000);
const CHUNK = BigInt(10_000_000);
const NOTE = BigInt(50_000_000);
const TOKEN = "9EmMw4C6ZUjacxM4rPQhNVGmxkPJNiUTiymrY1zJNSzX";

function chunk(overrides: Partial<Parameters<typeof planChunk>[0]> = {}) {
  return planChunk({
    noteAmount: NOTE,
    typedAmount: CHUNK,
    agreedAmount: CHUNK,
    noteMint: SOL_MINT,
    agreedMint: SOL_MINT,
    kind: "sol",
    ...overrides,
  });
}

describe("planChunk", () => {
  it("uses the same 1 SOL cap as the desk", () => {
    assert.equal(MAX_CHUNK_LAMPORTS, MAX_DESK_LAMPORTS);
  });

  it("accepts a chunk equal to the side's agreed amount", () => {
    assert.deepEqual(chunk(), { ok: true, amount: CHUNK, split: true, change: NOTE - CHUNK });
    assert.deepEqual(chunk({ noteAmount: CHUNK }), { ok: true, amount: CHUNK, split: false, change: BigInt(0) });
  });

  it("rejects a chunk that is not the agreed amount", () => {
    assert.deepEqual(chunk({ agreedAmount: CHUNK + BigInt(1) }), { ok: false, reason: "mismatch" });
    assert.deepEqual(chunk({ agreedAmount: null, agreedMint: null, kind: null }), { ok: false, reason: "missing-terms" });
  });

  it("rejects an amount larger than the note, a zero note, and a zero amount", () => {
    assert.deepEqual(chunk({ noteAmount: CHUNK, typedAmount: NOTE, agreedAmount: NOTE }), { ok: false, reason: "oversize" });
    assert.deepEqual(chunk({ noteAmount: BigInt(0) }), { ok: false, reason: "zero-note" });
    assert.deepEqual(chunk({ typedAmount: BigInt(0), agreedAmount: BigInt(0) }), { ok: false, reason: "zero-amount" });
    assert.deepEqual(
      chunk({
        noteAmount: ONE_SOL * BigInt(2),
        typedAmount: ONE_SOL + BigInt(1),
        agreedAmount: ONE_SOL + BigInt(1),
      }),
      { ok: false, reason: "above-cap" },
    );
  });

  it("lets a token exceed 1 SOL and refuses to split an NFT", () => {
    assert.equal(
      chunk({
        noteAmount: BigInt(5_000_000_000),
        typedAmount: BigInt(2_000_000_000),
        agreedAmount: BigInt(2_000_000_000),
        noteMint: TOKEN,
        agreedMint: TOKEN,
        kind: "token",
      }).ok,
      true,
    );
    assert.deepEqual(
      chunk({ noteMint: TOKEN, agreedMint: SOL_MINT, kind: "sol" }),
      { ok: false, reason: "mint-mismatch" },
    );
    assert.deepEqual(
      chunk({
        noteAmount: BigInt(2),
        typedAmount: BigInt(1),
        agreedAmount: BigInt(1),
        noteMint: TOKEN,
        agreedMint: TOKEN,
        kind: "nft",
      }),
      { ok: false, reason: "not-splittable" },
    );
  });
});

const TOKEN_SCALE = BigInt(1_000_000);

describe("carveMethod", () => {
  it("uses one equal split only when the part count is 2 to 8", () => {
    assert.deepEqual(carveMethod(BigInt(200), BigInt(100)), { kind: "split", parts: 2 });
    assert.deepEqual(carveMethod(BigInt(800), BigInt(100)), { kind: "split", parts: 8 });
  });

  it("self-transfers 10 or 100 out of 1000 because those part counts are above 8", () => {
    assert.deepEqual(carveMethod(BigInt(1000) * TOKEN_SCALE, BigInt(100) * TOKEN_SCALE), { kind: "transfer" });
    assert.deepEqual(carveMethod(BigInt(1000) * TOKEN_SCALE, BigInt(10) * TOKEN_SCALE), { kind: "transfer" });
    assert.deepEqual(carveMethod(BigInt(900), BigInt(100)), { kind: "transfer" });
  });

  it("self-transfers when the chunk does not divide the note", () => {
    assert.deepEqual(carveMethod(BigInt(1000), BigInt(300)), { kind: "transfer" });
  });

  it("leaves a note that is already the agreed amount whole", () => {
    assert.deepEqual(carveMethod(BigInt(10) * TOKEN_SCALE, BigInt(10) * TOKEN_SCALE), { kind: "whole" });
  });
});

describe("sideView", () => {
  it("shows the opener locking the first side and the counterparty locking the second", () => {
    const terms: SwapTerms = {
      a: { kind: "sol", mint: SOL_MINT, amount: "10" },
      b: { kind: "token", mint: TOKEN, amount: "20" },
    };
    assert.deepEqual(sideView("a", terms), { lock: terms.a, receive: terms.b });
    assert.deepEqual(sideView("b", terms), { lock: terms.b, receive: terms.a });
  });
});
