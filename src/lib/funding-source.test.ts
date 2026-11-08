import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SOL_MINT } from "./chunk-plan.ts";
import { chooseShieldedNote, decideFundingSource } from "./funding-source.ts";

const PYTH = "59u7ATTfq9czVEVojnetEsY4neb8oj32xdvYq6C7V22";
const OTHER = "9EmMw4C6ZUjacxM4rPQhNVGmxkPJNiUTiymrY1zJNSzX";
const TOKEN = BigInt(1_000_000);

describe("decideFundingSource", () => {
  it("wraps a public balance of the same asset", () => {
    const decision = decideFundingSource({
      mint: PYTH,
      amount: TOKEN * BigInt(100),
      kind: "token",
      source: { kind: "public", mint: PYTH, maxBase: TOKEN * BigInt(250) },
    });
    assert.deepEqual(decision, { ok: true, action: "wrap", amount: TOKEN * BigInt(100) });
  });

  it("carves a larger shielded note down to the escrow amount", () => {
    const decision = decideFundingSource({
      mint: SOL_MINT,
      amount: BigInt(100),
      kind: "sol",
      source: { kind: "shielded", hash: "large", mint: SOL_MINT, amount: BigInt(1_000) },
    });
    assert.equal(decision.ok, true);
    if (!decision.ok) return;
    assert.equal(decision.action, "carve");
    if (decision.action !== "carve") return;
    assert.equal(decision.noteHash, "large");
    assert.equal(decision.amount, BigInt(100));
    assert.notEqual(decision.amount, BigInt(1_000));
    assert.deepEqual(decision.carve, { kind: "transfer" });
  });

  it("spends an exact shielded note whole", () => {
    const decision = decideFundingSource({
      mint: PYTH,
      amount: TOKEN,
      kind: "token",
      source: { kind: "shielded", hash: "exact", mint: PYTH, amount: TOKEN },
    });
    assert.deepEqual(decision, { ok: true, action: "spend", noteHash: "exact", amount: TOKEN });
  });

  it("refuses a note that is too small", () => {
    const decision = decideFundingSource({
      mint: PYTH,
      amount: TOKEN * BigInt(5),
      kind: "token",
      source: { kind: "shielded", hash: "small", mint: PYTH, amount: TOKEN },
    });
    assert.deepEqual(decision, { ok: false, reason: "shortfall" });
  });

  it("rejects a different mint", () => {
    const shielded = decideFundingSource({
      mint: PYTH,
      amount: TOKEN,
      kind: "token",
      source: { kind: "shielded", hash: "other", mint: OTHER, amount: TOKEN },
    });
    const pub = decideFundingSource({
      mint: PYTH,
      amount: TOKEN,
      kind: "token",
      source: { kind: "public", mint: OTHER, maxBase: TOKEN },
    });
    assert.deepEqual(shielded, { ok: false, reason: "mint-mismatch" });
    assert.deepEqual(pub, { ok: false, reason: "mint-mismatch" });
  });

  it("refuses a public balance that cannot cover the amount", () => {
    const decision = decideFundingSource({
      mint: SOL_MINT,
      amount: BigInt(50_000_000),
      kind: "sol",
      source: { kind: "public", mint: SOL_MINT, maxBase: BigInt(10_000_000) },
    });
    assert.deepEqual(decision, { ok: false, reason: "shortfall" });
  });
});

describe("chooseShieldedNote", () => {
  const notes = [
    { hash: "b", mint: PYTH, amount: TOKEN * BigInt(80) },
    { hash: "a", mint: PYTH, amount: TOKEN * BigInt(100) },
    { hash: "c", mint: PYTH, amount: TOKEN * BigInt(100) },
    { hash: "z", mint: OTHER, amount: TOKEN * BigInt(100) },
    { hash: "s", mint: PYTH, amount: TOKEN * BigInt(40) },
  ];

  it("prefers an exact note, then the smallest note that covers", () => {
    assert.deepEqual(chooseShieldedNote(notes, PYTH, TOKEN * BigInt(100)), {
      fit: "exact",
      hash: "a",
      amount: TOKEN * BigInt(100),
    });
    assert.deepEqual(chooseShieldedNote(notes, PYTH, TOKEN * BigInt(50)), {
      fit: "carve",
      hash: "b",
      amount: TOKEN * BigInt(80),
    });
  });

  it("reports a shortfall when every note of that mint is smaller", () => {
    assert.deepEqual(chooseShieldedNote(notes, PYTH, TOKEN * BigInt(200)), {
      fit: "short",
      hash: "a",
      amount: TOKEN * BigInt(100),
    });
    assert.equal(chooseShieldedNote(notes, "missing", TOKEN), null);
  });
});
