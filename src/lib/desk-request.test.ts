import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseDeskRequest, solToLamports } from "./desk-request.ts";

describe("solToLamports", () => {
  it("converts a SOL decimal into lamports inside the desk cap", () => {
    assert.equal(solToLamports("0.01"), BigInt(10_000_000));
    assert.equal(solToLamports("1"), BigInt(1_000_000_000));
    assert.equal(solToLamports("1.000000001"), null);
    assert.equal(solToLamports("0"), null);
    assert.equal(solToLamports("2"), null);
    assert.equal(solToLamports("0.01 SOL"), null);
  });
});

describe("parseDeskRequest", () => {
  it("accepts status, open, a bounded shield, and a lock note", () => {
    assert.deepEqual(parseDeskRequest({ action: "status" }), { action: "status" });
    assert.deepEqual(parseDeskRequest({ action: "open" }), { action: "open" });
    assert.deepEqual(parseDeskRequest({ action: "swap" }), { action: "swap" });
    assert.deepEqual(parseDeskRequest({ action: "shield", side: "a", lamports: "10000000" }), {
      action: "shield",
      side: "a",
      lamports: BigInt(10_000_000),
    });
    assert.deepEqual(
      parseDeskRequest({ action: "lock", side: "b", note: "xUiK4RZz4JerbRzZjHVaBgaQM46A45eYhZ2uBMggNzY" }),
      { action: "lock", side: "b", note: "xUiK4RZz4JerbRzZjHVaBgaQM46A45eYhZ2uBMggNzY" },
    );
  });

  it("rejects a missing side, a huge amount, and a note that is not base58", () => {
    assert.equal(parseDeskRequest({ action: "withdraw", lamports: "1" }), null);
    assert.equal(parseDeskRequest({ action: "shield", side: "a", lamports: "2000000000" }), null);
    assert.equal(parseDeskRequest({ action: "lock", side: "a", note: "not a note" }), null);
    assert.equal(parseDeskRequest({ action: "wallet-shield", seed: "ab", lamports: "1" }), null);
    assert.equal(
      parseDeskRequest({ action: "wallet-shield", seed: "11".repeat(32), lamports: "1000" })?.action,
      "wallet-shield",
    );
    assert.equal(
      parseDeskRequest({
        action: "wallet-lock",
        seed: "11".repeat(32),
        wallet: "xUiK4RZz4JerbRzZjHVaBgaQM46A45eYhZ2uBMggNzY",
        escrow: "xUiK4RZz4JerbRzZjHVaBgaQM46A45eYhZ2uBMggNzY",
        note: "xUiK4RZz4JerbRzZjHVaBgaQM46A45eYhZ2uBMggNzY",
      }),
      null,
    );
    assert.equal(
      parseDeskRequest({
        action: "wallet-lock",
        seed: "11".repeat(32),
        wallet: "xUiK4RZz4JerbRzZjHVaBgaQM46A45eYhZ2uBMggNzY",
        escrow: "xUiK4RZz4JerbRzZjHVaBgaQM46A45eYhZ2uBMggNzY",
        note: "xUiK4RZz4JerbRzZjHVaBgaQM46A45eYhZ2uBMggNzY",
        lamports: "2000000000",
      }),
      null,
    );
    assert.equal(
      parseDeskRequest({
        action: "wallet-terms",
        escrow: "xUiK4RZz4JerbRzZjHVaBgaQM46A45eYhZ2uBMggNzY",
        lockLamports: "10000000",
        receiveLamports: "20000000",
      })?.action,
      "wallet-terms",
    );
    assert.equal(parseDeskRequest(null), null);
  });
});
