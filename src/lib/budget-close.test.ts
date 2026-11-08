import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Keypair } from "@solana/web3.js";
import { DEPOSIT_COMPUTE_UNIT_LIMIT } from "./budget-deposit.ts";
import { PPROLL_PROGRAM_ID } from "./payroll-account.ts";
import {
  BUDGET_HAS_NO_NOTE,
  BUDGET_KEY_NOT_IN_BROWSER,
  EMPTY_BUDGET_STAYS,
  PROGRAM_CLOSES_EMPTY_VAULT,
  WITHDRAW_IX,
  budgetCloseOffer,
  chooseCloseBudget,
  parsePreparedWithdraw,
  vaultWithdrawRefusal,
} from "./budget-close.ts";
import { VAULT_NOT_FOUND, VAULT_WRONG_OWNER } from "./budget-deposit.ts";

const OWNER = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const HASH = "ab".repeat(32);
const FUNDED = "6oajRKsGoEQaESh9Us2RDCfxr6tDNrgVQ5R8eBqjY9g8";
const OTHER = "D2xxTX4z1rurQaR7Lq9EE7c6bDnj9oJ3jhTLtn9LKZ5E";

function vaultBytes(live: number, owner = OWNER, hash = HASH): Uint8Array {
  const data = new Uint8Array(112);
  data[0] = 4;
  data[1] = live;
  data.set(owner, 8);
  for (let index = 0; index < 32; index += 1) data[40 + index] = Number.parseInt(hash.slice(index * 2, index * 2 + 2), 16);
  return data;
}

describe("close budget choice", () => {
  const funded = { address: FUNDED, funded: true };
  const empty = { address: FUNDED, funded: false };
  const other = { address: OTHER, funded: true };
  const key = { viewingSecretHex: HASH, ownerHashHex: HASH, vault: FUNDED };

  it("withdraws a funded vault when this browser has its viewing key", () => {
    assert.equal(PROGRAM_CLOSES_EMPTY_VAULT, false);
    assert.deepEqual(chooseCloseBudget(funded, key), {
      action: "withdraw",
      vault: FUNDED,
      viewingSecretHex: HASH,
      ownerHashHex: HASH,
    });
    assert.deepEqual(budgetCloseOffer(funded, key).action, "withdraw");
  });

  it("stops when the funded vault's viewing key is missing", () => {
    assert.deepEqual(chooseCloseBudget(funded, null), { action: "stop", message: BUDGET_KEY_NOT_IN_BROWSER });
    assert.deepEqual(chooseCloseBudget(other, key), { action: "stop", message: BUDGET_KEY_NOT_IN_BROWSER });
    assert.deepEqual(chooseCloseBudget(funded, { ...key, vault: null }), { action: "stop", message: BUDGET_KEY_NOT_IN_BROWSER });
    assert.deepEqual(chooseCloseBudget(funded, { viewingSecretHex: "abcd", ownerHashHex: HASH, vault: FUNDED }), {
      action: "stop",
      message: BUDGET_KEY_NOT_IN_BROWSER,
    });
    assert.equal(budgetCloseOffer(other, null).action, "stop");
  });

  it("leaves an empty vault on chain when the program cannot close it", () => {
    const choice = chooseCloseBudget(empty, key, false);
    assert.deepEqual(choice, { action: "stay", message: EMPTY_BUDGET_STAYS });
    assert.equal("vault" in choice, false);
    assert.deepEqual(chooseCloseBudget({ address: OTHER, funded: false }, null, false), {
      action: "stay",
      message: EMPTY_BUDGET_STAYS,
    });
    assert.deepEqual(budgetCloseOffer(empty, key), { action: "stay", message: EMPTY_BUDGET_STAYS });
    assert.deepEqual(budgetCloseOffer({ address: OTHER, funded: false }, null).action, "stay");
  });

  it("returns the account only when a close instruction can reclaim the rent", () => {
    assert.deepEqual(chooseCloseBudget(empty, null, true), { action: "close", vault: FUNDED });
    assert.deepEqual(chooseCloseBudget(empty, key, true), { action: "close", vault: FUNDED });
    assert.equal(chooseCloseBudget(funded, key, true).action, "withdraw");
    assert.equal(chooseCloseBudget(funded, null, true).action, "stop");
  });
});

describe("vault withdraw refusal", () => {
  it("requires a live note, the owner, and the matching viewing hash", () => {
    assert.equal(vaultWithdrawRefusal(vaultBytes(1), OWNER, HASH), null);
    assert.equal(vaultWithdrawRefusal(vaultBytes(0), OWNER, HASH), BUDGET_HAS_NO_NOTE);
    assert.equal(vaultWithdrawRefusal(vaultBytes(1), OWNER, "cd".repeat(32)), BUDGET_KEY_NOT_IN_BROWSER);
    assert.equal(vaultWithdrawRefusal(vaultBytes(1, new Uint8Array(32)), OWNER, HASH), VAULT_WRONG_OWNER);
    assert.equal(vaultWithdrawRefusal(new Uint8Array(10), OWNER, HASH), VAULT_NOT_FOUND);
  });
});

describe("prepared withdraw", () => {
  it("keeps a withdraw instruction and drops a secret field", () => {
    const address = Keypair.generate().publicKey.toBase58();
    const parsed = parsePreparedWithdraw({
      computeUnitLimit: DEPOSIT_COMPUTE_UNIT_LIMIT,
      programId: PPROLL_PROGRAM_ID,
      dataHex: WITHDRAW_IX.toString(16).padStart(2, "0") + "aa",
      keys: [
        { pubkey: address, isSigner: false, isWritable: true },
        { pubkey: address, isSigner: true, isWritable: true },
      ],
      lookupAddresses: [address],
      viewingSecret: HASH,
    });
    assert.equal(parsed?.dataHex, "09aa");
    assert.equal(parsed === null || "viewingSecret" in parsed, false);
    assert.equal(
      parsePreparedWithdraw({
        computeUnitLimit: DEPOSIT_COMPUTE_UNIT_LIMIT,
        programId: PPROLL_PROGRAM_ID,
        dataHex: "07aa",
        keys: [
          { pubkey: address, isSigner: false, isWritable: true },
          { pubkey: address, isSigner: true, isWritable: true },
        ],
        lookupAddresses: [address],
      }),
      null,
    );
  });
});
