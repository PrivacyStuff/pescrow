import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Keypair } from "@solana/web3.js";
import { SOL_MINT } from "./chunk-plan.ts";
import { viewingKeyBelongsTo } from "./budget-deposit.ts";
import { budgetKeyFor, chooseBudgetSlot, fundingBudget, parseBudgetKeyList, rememberBudget, withBudgetMint, type BudgetKeyRecord } from "./budget-keys.ts";

const SECRET = "ab".repeat(32);
const HASH = "cd".repeat(32);
const USDC = Keypair.generate().publicKey.toBase58();

function key(vault: string, mint: string | null = null): BudgetKeyRecord {
  return { viewingSecretHex: SECRET, ownerHashHex: HASH, vault, mint };
}

describe("budget key list", () => {
  it("reads a single record stored before several budgets", () => {
    const vault = Keypair.generate().publicKey.toBase58();
    assert.deepEqual(parseBudgetKeyList({ viewingSecretHex: SECRET, ownerHashHex: HASH, vault }), [key(vault)]);
  });

  it("keeps every budget, drops duplicates, a bad mint, and a record without a vault", () => {
    const first = Keypair.generate().publicKey.toBase58();
    const second = Keypair.generate().publicKey.toBase58();
    const list = parseBudgetKeyList([
      { viewingSecretHex: SECRET, ownerHashHex: HASH, vault: first, mint: SOL_MINT },
      { viewingSecretHex: SECRET, ownerHashHex: HASH, vault: first, mint: USDC },
      { viewingSecretHex: SECRET, ownerHashHex: HASH, vault: second, mint: "not a mint" },
      { viewingSecretHex: SECRET, ownerHashHex: HASH },
      "garbage",
    ]);
    assert.deepEqual(list, [key(first, SOL_MINT), key(second)]);
  });

  it("opening a second budget does not drop the key of the first", () => {
    const first = Keypair.generate().publicKey.toBase58();
    const second = Keypair.generate().publicKey.toBase58();
    const list = rememberBudget([key(first, SOL_MINT)], key(second));
    assert.equal(budgetKeyFor(list, first)?.mint, SOL_MINT);
    assert.equal(budgetKeyFor(list, second)?.mint, null);
    assert.equal(budgetKeyFor(withBudgetMint(list, second, USDC), second)?.mint, USDC);
  });
});

describe("chooseBudgetSlot", () => {
  it("offers another budget once every keyed budget holds a note", () => {
    const first = Keypair.generate().publicKey.toBase58();
    assert.deepEqual(chooseBudgetSlot([{ address: first, funded: true }], [key(first, SOL_MINT)]), { action: "open" });
  });

  it("deposits into the empty keyed budget, including one the RPC has not listed yet", () => {
    const first = Keypair.generate().publicKey.toBase58();
    const second = Keypair.generate().publicKey.toBase58();
    const slot = chooseBudgetSlot([{ address: first, funded: true }], [key(first, SOL_MINT), key(second)]);
    assert.equal(slot.action === "deposit" ? slot.vault : null, second);
  });

  it("refuses a listed empty budget when the stored key belongs to another vault", () => {
    const listed = "B4dTatRqgLJJLfGs7hw6YKVKzigcqdbDXDqKYc5QKH4D";
    const otherKey = "6oajRKsGoEQaESh9Us2RDCfxr6tDNrgVQ5R8eBqjY9g8";
    const otherVault = "D2xxTX4z1rurQaR7Lq9EE7c6bDnj9oJ3jhTLtn9LKZ5E";
    assert.deepEqual(chooseBudgetSlot([{ address: listed, funded: false }], [key(otherKey)]), {
      action: "refuse",
      message: viewingKeyBelongsTo(otherKey),
    });
    assert.deepEqual(chooseBudgetSlot([{ address: listed, funded: false }], [key(otherVault)]), {
      action: "refuse",
      message: viewingKeyBelongsTo(otherVault),
    });
    const matched = chooseBudgetSlot([{ address: listed, funded: false }], [key(listed)]);
    assert.equal(matched.action === "deposit" ? matched.vault : null, listed);
  });
});

describe("fundingBudget", () => {
  it("picks the budget holding the payroll's token", () => {
    const sol = Keypair.generate().publicKey.toBase58();
    const usdc = Keypair.generate().publicKey.toBase58();
    const vaults = [
      { address: sol, funded: true },
      { address: usdc, funded: true },
    ];
    const list = [key(sol, SOL_MINT), key(usdc, USDC)];
    assert.equal(fundingBudget(vaults, list, USDC)?.vault, usdc);
    assert.equal(fundingBudget(vaults, list, SOL_MINT)?.vault, sol);
    assert.equal(fundingBudget(vaults, list, Keypair.generate().publicKey.toBase58()), null);
  });

  it("uses a budget with no recorded token only when it is the only funded one", () => {
    const only = Keypair.generate().publicKey.toBase58();
    const other = Keypair.generate().publicKey.toBase58();
    assert.equal(fundingBudget([{ address: only, funded: true }], [key(only)], USDC)?.vault, only);
    const two = [
      { address: only, funded: true },
      { address: other, funded: true },
    ];
    assert.equal(fundingBudget(two, [key(only), key(other, SOL_MINT)], USDC), null);
  });

  it("skips an empty budget and a funded budget this browser has no key for", () => {
    const empty = Keypair.generate().publicKey.toBase58();
    const foreign = Keypair.generate().publicKey.toBase58();
    assert.equal(fundingBudget([{ address: empty, funded: false }, { address: foreign, funded: true }], [key(empty, USDC)], USDC), null);
  });
});
