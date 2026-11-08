import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SOL_MINT } from "./chunk-plan.ts";
import { parseDeskRequest, rpcRateLimitMessage, solToLamports } from "./desk-request.ts";

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
      })?.action,
      "wallet-lock",
    );
    assert.equal(
      parseDeskRequest({
        action: "wallet-lock",
        seed: "11".repeat(32),
        wallet: "xUiK4RZz4JerbRzZjHVaBgaQM46A45eYhZ2uBMggNzY",
        escrow: "xUiK4RZz4JerbRzZjHVaBgaQM46A45eYhZ2uBMggNzY",
        note: "xUiK4RZz4JerbRzZjHVaBgaQM46A45eYhZ2uBMggNzY",
        lamports: "18446744073709551616",
      }),
      null,
    );
    assert.equal(
      parseDeskRequest({
        action: "wallet-carve",
        seed: "11".repeat(32),
        note: "xUiK4RZz4JerbRzZjHVaBgaQM46A45eYhZ2uBMggNzY",
        lamports: "100",
      })?.action,
      "wallet-carve",
    );
    assert.equal(parseDeskRequest({ action: "wallet-carve", seed: "11".repeat(32), note: "not-a-note", lamports: "100" }), null);
    const terms = parseDeskRequest({
      action: "wallet-terms",
      escrow: "xUiK4RZz4JerbRzZjHVaBgaQM46A45eYhZ2uBMggNzY",
      a: { kind: "sol", mint: SOL_MINT, amount: "10000000" },
      b: { kind: "token", mint: "9EmMw4C6ZUjacxM4rPQhNVGmxkPJNiUTiymrY1zJNSzX", amount: "2000000000" },
    });
    assert.equal(terms?.action, "wallet-terms");
    assert.equal(
      parseDeskRequest({
        action: "wallet-terms",
        escrow: "xUiK4RZz4JerbRzZjHVaBgaQM46A45eYhZ2uBMggNzY",
        a: { kind: "sol", mint: SOL_MINT, amount: "2000000000" },
        b: { kind: "sol", mint: SOL_MINT, amount: "1" },
      }),
      null,
    );
    const shield = "ab".repeat(32);
    const withShield = parseDeskRequest({
      action: "wallet-terms",
      escrow: "xUiK4RZz4JerbRzZjHVaBgaQM46A45eYhZ2uBMggNzY",
      a: { kind: "sol", mint: SOL_MINT, amount: "10000000" },
      b: { kind: "token", mint: "9EmMw4C6ZUjacxM4rPQhNVGmxkPJNiUTiymrY1zJNSzX", amount: "2000000000" },
      openerShield: shield,
    });
    assert.equal(withShield?.action === "wallet-terms" ? withShield.openerShield : undefined, shield);
    assert.equal(
      parseDeskRequest({
        action: "wallet-terms",
        escrow: "xUiK4RZz4JerbRzZjHVaBgaQM46A45eYhZ2uBMggNzY",
        a: { kind: "sol", mint: SOL_MINT, amount: "10000000" },
        b: { kind: "sol", mint: SOL_MINT, amount: "1" },
        openerShield: "zz",
      }),
      null,
    );
    assert.equal(parseDeskRequest({ action: "wallet-asset-info", mint: SOL_MINT })?.action, "wallet-asset-info");
    assert.deepEqual(parseDeskRequest({ action: "wallet-holdings", wallet: "xUiK4RZz4JerbRzZjHVaBgaQM46A45eYhZ2uBMggNzY" }), {
      action: "wallet-holdings",
      wallet: "xUiK4RZz4JerbRzZjHVaBgaQM46A45eYhZ2uBMggNzY",
    });
    assert.equal(parseDeskRequest({ action: "wallet-holdings", wallet: "not-a-wallet" }), null);
    assert.equal(parseDeskRequest({ action: "wallet-holdings", wallet: "https://127.0.0.1" }), null);
    assert.deepEqual(parseDeskRequest({ action: "wallet-metadata", mint: SOL_MINT }), { action: "wallet-metadata", mint: SOL_MINT });
    assert.equal(parseDeskRequest({ action: "wallet-metadata", mint: "not-a-mint" }), null);
    const redeem = parseDeskRequest({
      action: "wallet-withdraw",
      seed: "11".repeat(32),
      wallet: "xUiK4RZz4JerbRzZjHVaBgaQM46A45eYhZ2uBMggNzY",
      mint: SOL_MINT,
      amount: "1000",
    });
    assert.equal(redeem?.action, "wallet-withdraw");
    assert.equal(
      parseDeskRequest({
        action: "wallet-withdraw",
        seed: "11".repeat(32),
        wallet: "xUiK4RZz4JerbRzZjHVaBgaQM46A45eYhZ2uBMggNzY",
        mint: "9EmMw4C6ZUjacxM4rPQhNVGmxkPJNiUTiymrY1zJNSzX",
        amount: "100",
        tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      })?.action,
      "wallet-withdraw",
    );
    assert.equal(
      parseDeskRequest({
        action: "wallet-withdraw",
        seed: "11".repeat(32),
        wallet: "xUiK4RZz4JerbRzZjHVaBgaQM46A45eYhZ2uBMggNzY",
        mint: "not-a-mint",
        amount: "1",
      }),
      null,
    );
    assert.equal(
      parseDeskRequest({
        action: "wallet-withdraw",
        seed: "11".repeat(32),
        wallet: "xUiK4RZz4JerbRzZjHVaBgaQM46A45eYhZ2uBMggNzY",
        mint: SOL_MINT,
        amount: "18446744073709551616",
      }),
      null,
    );
    assert.equal(
      parseDeskRequest({
        action: "wallet-withdraw",
        seed: "11".repeat(32),
        wallet: "xUiK4RZz4JerbRzZjHVaBgaQM46A45eYhZ2uBMggNzY",
        mint: "9EmMw4C6ZUjacxM4rPQhNVGmxkPJNiUTiymrY1zJNSzX",
        amount: "100",
      }),
      null,
    );
    assert.deepEqual(parseDeskRequest({ action: "wallet-chain" }), { action: "wallet-chain" });
    assert.deepEqual(parseDeskRequest({ action: "wallet-chain", account: SOL_MINT, rentSpace: 160 }), {
      action: "wallet-chain",
      account: SOL_MINT,
      rentSpace: 160,
    });
    assert.equal(parseDeskRequest({ action: "wallet-chain", account: "not-a-key" }), null);
    assert.equal(parseDeskRequest({ action: "wallet-chain", rentSpace: 0 }), null);
    assert.equal(parseDeskRequest({ action: "wallet-chain", rentSpace: 20_000 }), null);
    assert.equal(
      rpcRateLimitMessage('429 : {"jsonrpc":"2.0","error":{"code": 429, "message":"Connection rate limits exceeded"}}'),
      "The devnet RPC is rate limiting. Retry in a moment.",
    );
    assert.equal(parseDeskRequest(null), null);
  });
});
