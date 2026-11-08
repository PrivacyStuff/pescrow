import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SOL_DECIMALS, SOL_MINT } from "./chunk-plan.ts";
import { parseBaseAmount, parseEscrowParams, RING_PERMISSIONLESS, WALLETS_PUBLIC } from "./escrow-params.ts";

const OPENER = "xUiK4RZz4JerbRzZjHVaBgaQM46A45eYhZ2uBMggNzY";
const OTHER = "3UyqNELpp375h2oTWZwEP5y2McYaZiG6gS3KkCNmo3ey";
const TOKEN = "9EmMw4C6ZUjacxM4rPQhNVGmxkPJNiUTiymrY1zJNSzX";
const NOW = 1_700_000_000;

function form(overrides: Partial<Parameters<typeof parseEscrowParams>[0]> = {}) {
  return {
    opener: OPENER,
    counterparty: OTHER,
    mine: { kind: "sol" as const, mint: "", amount: "0.01", decimals: SOL_DECIMALS },
    theirs: { kind: "sol" as const, mint: "", amount: "0.02", decimals: SOL_DECIMALS },
    approvalDeadline: NOW + 60,
    startAt: NOW + 120,
    ...overrides,
  };
}

describe("parseEscrowParams", () => {
  it("opens a permissionless public escrow and keeps SOL inside the cap", () => {
    const parsed = parseEscrowParams(form(), NOW);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.value.ring, RING_PERMISSIONLESS);
    assert.equal(parsed.value.wallets, WALLETS_PUBLIC);
    assert.equal(parsed.value.mine.mint, SOL_MINT);
    assert.equal(parsed.value.mine.amount, BigInt(10_000_000));
    assert.equal(parsed.value.theirs.amount, BigInt(20_000_000));
  });

  it("accepts a token amount above 1 SOL in base units and an NFT of one", () => {
    const parsed = parseEscrowParams(
      form({
        mine: { kind: "token", mint: TOKEN, amount: "2", decimals: 9 },
        theirs: { kind: "nft", mint: "3GmWRnrhhUrxNChCX1DAhbZudaLs6LgwfoTUjZb2KKst", amount: "1", decimals: 0 },
      }),
      NOW,
    );
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.value.mine.amount, BigInt(2_000_000_000));
    assert.equal(parsed.value.theirs.amount, BigInt(1));
  });

  it("rejects the same wallet, a deadline after the reclaim time, and a bad NFT amount", () => {
    assert.equal(parseEscrowParams(form({ counterparty: OPENER }), NOW).ok, false);
    assert.equal(parseEscrowParams(form({ approvalDeadline: NOW + 200, startAt: NOW + 100 }), NOW).ok, false);
    assert.equal(parseEscrowParams(form({ approvalDeadline: NOW }), NOW).ok, false);
    const nft = parseEscrowParams(
      form({ theirs: { kind: "nft", mint: TOKEN, amount: "2", decimals: 0 } }),
      NOW,
    );
    assert.equal(nft.ok, false);
    if (!nft.ok) assert.equal(nft.reason, "nft-amount");
    const capped = parseEscrowParams(form({ mine: { kind: "sol", mint: "", amount: "2", decimals: SOL_DECIMALS } }), NOW);
    assert.equal(capped.ok, false);
    if (!capped.ok) assert.equal(capped.reason, "sol-cap");
  });
});

describe("parseBaseAmount", () => {
  it("scales a decimal by the mint decimals and rejects extra places", () => {
    assert.equal(parseBaseAmount("1.5", 6), BigInt(1_500_000));
    assert.equal(parseBaseAmount("1.5", 0), null);
    assert.equal(parseBaseAmount("0", 9), null);
  });
});
