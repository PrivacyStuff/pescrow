import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Keypair, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { parsePayrollRequest } from "./payroll-request.ts";

const WALLET = "AoBDpQ9KRQ1GBtnu1QURmdDv7RgN4Qyr5EWSkQzgF1B8";

describe("parsePayrollRequest", () => {
  it("accepts a wallet list and a signed transaction", () => {
    assert.deepEqual(parsePayrollRequest({ action: "wallet-payrolls", wallet: WALLET }), {
      action: "wallet-payrolls",
      wallet: WALLET,
    });
    const tx = "A".repeat(64);
    assert.equal(parsePayrollRequest({ action: "wallet-submit", tx })?.action, "wallet-submit");
  });

  it("rejects a short address and a transaction that is not base64", () => {
    assert.equal(parsePayrollRequest({ action: "wallet-payrolls", wallet: "nope" }), null);
    assert.equal(parsePayrollRequest({ action: "wallet-submit", tx: "not base64 $$$" }), null);
    assert.equal(parsePayrollRequest({ action: "open" }), null);
    assert.equal(parsePayrollRequest({ action: "prepare-vault", owner: WALLET })?.action, "prepare-vault");
    assert.equal(
      parsePayrollRequest({
        action: "prepare-payroll",
        payroll: WALLET,
        payee: "YrSYDo5dYGbnhGMASAAthdy3tgmXvgj8sF79WHwdDi5",
        payeeOwnerHash: "ab".repeat(32),
        installment: "1000",
        budget: "1000",
        startAt: "1700000000",
        periodSecs: "3600",
      })?.action,
      "prepare-payroll",
    );
    assert.equal(parsePayrollRequest({ action: "prepare-payroll", payroll: WALLET, installment: "0" }), null);
    const unbound = parsePayrollRequest({
      action: "prepare-payroll",
      payroll: WALLET,
      payee: "YrSYDo5dYGbnhGMASAAthdy3tgmXvgj8sF79WHwdDi5",
      installment: "1000",
      budget: "1000",
      startAt: "1700000000",
      periodSecs: "3600",
    });
    assert.equal(unbound?.action === "prepare-payroll" ? unbound.payeeOwnerHash : null, "00".repeat(32));
  });

  it("accepts a deposit of one note and a signed versioned transaction", () => {
    const secret = "ab".repeat(32);
    const parsed = parsePayrollRequest({
      action: "prepare-deposit",
      owner: WALLET,
      vault: "D2xxTX4z1rurQaR7Lq9EE7c6bDnj9oJ3jhTLtn9LKZ5E",
      note: "YrSYDo5dYGbnhGMASAAthdy3tgmXvgj8sF79WHwdDi5",
      seed: secret.toUpperCase(),
      viewingSecret: secret,
      ownerHash: secret,
    });
    assert.equal(parsed?.action, "prepare-deposit");
    assert.equal(parsed?.action === "prepare-deposit" ? parsed.seed : null, secret);
    const payer = Keypair.generate().publicKey;
    const versioned = new VersionedTransaction(
      new TransactionMessage({
        payerKey: payer,
        recentBlockhash: Keypair.generate().publicKey.toBase58(),
        instructions: [SystemProgram.transfer({ fromPubkey: payer, toPubkey: payer, lamports: 1 })],
      }).compileToV0Message(),
    );
    const tx = Buffer.from(versioned.serialize()).toString("base64");
    assert.equal(parsePayrollRequest({ action: "wallet-submit", tx })?.action, "wallet-submit");
    assert.doesNotThrow(() => VersionedTransaction.deserialize(Buffer.from(tx, "base64")));
  });

  it("accepts a withdraw of the budget note and rejects a missing viewing secret", () => {
    const secret = "cd".repeat(32);
    const parsed = parsePayrollRequest({
      action: "prepare-withdraw",
      owner: WALLET,
      vault: "6oajRKsGoEQaESh9Us2RDCfxr6tDNrgVQ5R8eBqjY9g8",
      seed: secret,
      viewingSecret: secret.toUpperCase(),
      ownerHash: secret,
    });
    assert.equal(parsed?.action, "prepare-withdraw");
    assert.equal(parsed?.action === "prepare-withdraw" ? parsed.viewingSecret : null, secret);
    assert.equal(
      parsePayrollRequest({
        action: "prepare-withdraw",
        owner: WALLET,
        vault: "6oajRKsGoEQaESh9Us2RDCfxr6tDNrgVQ5R8eBqjY9g8",
        seed: secret,
        ownerHash: secret,
      }),
      null,
    );
  });

  it("accepts fund and crank proofs and rejects a missing payroll key", () => {
    const secret = "ab".repeat(32);
    const funded = parsePayrollRequest({
      action: "prepare-initiate",
      owner: WALLET,
      payroll: "D2xxTX4z1rurQaR7Lq9EE7c6bDnj9oJ3jhTLtn9LKZ5E",
      vault: "YrSYDo5dYGbnhGMASAAthdy3tgmXvgj8sF79WHwdDi5",
      viewingSecret: secret.toUpperCase(),
      budgetViewingSecret: secret,
      budgetAmount: "1000",
      budgetBlinding: secret,
    });
    assert.equal(funded?.action, "prepare-initiate");
    assert.equal(funded?.action === "prepare-initiate" ? funded.viewingSecret : null, secret);
    assert.equal(
      parsePayrollRequest({
        action: "prepare-initiate",
        owner: WALLET,
        payroll: "D2xxTX4z1rurQaR7Lq9EE7c6bDnj9oJ3jhTLtn9LKZ5E",
        vault: "YrSYDo5dYGbnhGMASAAthdy3tgmXvgj8sF79WHwdDi5",
        viewingSecret: secret,
        budgetViewingSecret: secret,
        budgetAmount: "1000",
      }),
      null,
    );
    const paid = parsePayrollRequest({
      action: "prepare-pay",
      owner: WALLET,
      payroll: "D2xxTX4z1rurQaR7Lq9EE7c6bDnj9oJ3jhTLtn9LKZ5E",
      seed: secret,
      viewingSecret: secret,
      installmentAmount: "1000",
      installmentBlinding: "cd".repeat(32),
    });
    assert.equal(paid?.action, "prepare-pay");
    assert.equal(parsePayrollRequest({ action: "prepare-pay", owner: WALLET, payroll: "D2xxTX4z1rurQaR7Lq9EE7c6bDnj9oJ3jhTLtn9LKZ5E" }), null);
  });

  it("rejects a deposit when the viewing secret is missing", () => {
    assert.equal(
      parsePayrollRequest({
        action: "prepare-deposit",
        owner: WALLET,
        vault: "D2xxTX4z1rurQaR7Lq9EE7c6bDnj9oJ3jhTLtn9LKZ5E",
        note: "YrSYDo5dYGbnhGMASAAthdy3tgmXvgj8sF79WHwdDi5",
        seed: "ab".repeat(32),
        ownerHash: "ab".repeat(32),
      }),
      null,
    );
    assert.equal(
      parsePayrollRequest({
        action: "prepare-deposit",
        owner: WALLET,
        vault: "D2xxTX4z1rurQaR7Lq9EE7c6bDnj9oJ3jhTLtn9LKZ5E",
        note: "YrSYDo5dYGbnhGMASAAthdy3tgmXvgj8sF79WHwdDi5",
        seed: "ab".repeat(32),
        viewingSecret: "abcd",
        ownerHash: "ab".repeat(32),
      }),
      null,
    );
  });
});
