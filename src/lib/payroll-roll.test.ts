import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { IX_INITIATE, IX_PAY, PPROLL_PROGRAM_ID } from "./payroll-account.ts";
import { DEPOSIT_COMPUTE_UNIT_LIMIT } from "./budget-deposit.ts";
import {
  KEEPS_NOTE,
  MAX_ROLLS,
  MISSING_PAYROLL_KEY,
  PAYROLL_NOTE_SHORT,
  PAY_PROOF_NOT_BUILT,
  WRONG_SHIELDED_OWNER,
  budgetForRolls,
  claimAt,
  hasPayrollKey,
  payBuildFailure,
  payrollStep,
  parsePreparedRoll,
  rollsInBudget,
  type PayrollStepInput,
} from "./payroll-roll.ts";

const KEY = {
  viewingSecretHex: "ab".repeat(32),
  installmentBlindingHex: "cd".repeat(32),
  budgetBlindingHex: "ef".repeat(32),
};

function proposed(overrides: Partial<PayrollStepInput> = {}): PayrollStepInput {
  return {
    kind: "budget",
    role: "employer",
    status: "Proposed",
    employerApproved: true,
    payeeApproved: true,
    frozen: true,
    payeeHashZero: false,
    startAt: 1_000,
    periodSecs: 100,
    nextRedeem: 0,
    budgetFunded: true,
    hasPayrollKey: true,
    hasBudgetKey: true,
    rollsTotal: null,
    now: 2_000,
    ...overrides,
  };
}

describe("rolls", () => {
  it("budgets installment times rolls and refuses zero, junk, too many, or u64 overflow", () => {
    assert.equal(budgetForRolls(BigInt(10), "3"), BigInt(30));
    assert.equal(budgetForRolls(BigInt(10), "1"), BigInt(10));
    assert.equal(budgetForRolls(BigInt(10), String(MAX_ROLLS)), BigInt(10 * MAX_ROLLS));
    assert.equal(budgetForRolls(BigInt(10), "0"), null);
    assert.equal(budgetForRolls(BigInt(10), String(MAX_ROLLS + 1)), null);
    assert.equal(budgetForRolls(BigInt(10), "2.5"), null);
    assert.equal(budgetForRolls(BigInt(10), ""), null);
    assert.equal(budgetForRolls(BigInt(0), "3"), null);
    assert.equal(budgetForRolls(BigInt("18446744073709551615"), "2"), null);
  });

  it("counts whole installments in the saved budget, and one roll for older terms", () => {
    assert.equal(rollsInBudget("10", "30"), 3);
    assert.equal(rollsInBudget("10", "35"), 3);
    assert.equal(rollsInBudget("10", undefined), 1);
    assert.equal(rollsInBudget("10", "5"), null);
    assert.equal(rollsInBudget("0", "30"), null);
    assert.equal(rollsInBudget("ten", "30"), null);
  });

  it("shows the payroll as finished once every roll is paid, for both sides", () => {
    const received = proposed({ role: "payee", status: "Active", rollsTotal: 3, now: 9_999 });
    assert.equal(payrollStep({ ...received, nextRedeem: 2 }).action, "crank");
    assert.deepEqual(payrollStep({ ...received, nextRedeem: 3 }), { action: "finished", rolls: 3 });
    assert.deepEqual(payrollStep({ ...received, rollsTotal: 1, nextRedeem: 1 }), { action: "finished", rolls: 1 });
    assert.equal(payrollStep({ ...received, rollsTotal: null, nextRedeem: 1 }).action, "crank");
    assert.deepEqual(payrollStep({ ...received, role: "employer", nextRedeem: 3 }), { action: "finished", rolls: 3 });
    assert.equal(payrollStep({ ...received, role: "employer", nextRedeem: 2 }).action, "none");
  });
});

describe("claimAt", () => {
  it("matches the program: start plus one extra period", () => {
    assert.equal(claimAt(1_000, 100, 0), 1_100);
    assert.equal(claimAt(1_000, 100, 1), 1_200);
    assert.equal(claimAt(1_000, 0, 0), null);
    assert.equal(claimAt(1_000, 100, -1), null);
    assert.equal(claimAt(Number.MAX_SAFE_INTEGER, 1, 0), null);
  });
});

describe("payrollStep", () => {
  it("shows Fund when the proposal is frozen, bound, and the budget holds a note", () => {
    assert.equal(payrollStep(proposed()).action, "fund");
  });

  it("hides Fund when the payee hash is still zero", () => {
    assert.equal(payrollStep(proposed({ payeeHashZero: true, frozen: false })).action, "none");
    assert.equal(payrollStep(proposed({ payeeHashZero: true, frozen: true })).action, "none");
  });

  it("says the payroll key or the budget key is missing", () => {
    assert.equal(payrollStep(proposed({ hasPayrollKey: false })).action, "missing-payroll-key");
    assert.equal(payrollStep(proposed({ hasBudgetKey: false })).action, "missing-budget-key");
    assert.equal(payrollStep(proposed({ budgetFunded: false })).action, "need-note");
    assert.equal(hasPayrollKey(null), false);
    assert.equal(hasPayrollKey({ ...KEY, installmentBlindingHex: "" }), false);
    assert.equal(hasPayrollKey(KEY), true);
  });

  it("shows Crank once the milestone is due and the time until then", () => {
    const received = proposed({ role: "payee", status: "Active", hasBudgetKey: false, budgetFunded: false });
    assert.deepEqual(payrollStep({ ...received, now: 1_099 }), { action: "due", dueAt: 1_100 });
    assert.equal(payrollStep({ ...received, now: 1_100 }).action, "crank");
    assert.equal(payrollStep({ ...received, now: null }).action, "due");
    assert.deepEqual(payrollStep({ ...received, nextRedeem: 1, now: 1_199 }), { action: "due", dueAt: 1_200 });
  });

  it("does not crank a future milestone, a zero payee hash, or the employer", () => {
    const received = proposed({ role: "payee", status: "Active" });
    assert.equal(payrollStep({ ...received, now: 1_099, hasPayrollKey: false }).action, "missing-payroll-key");
    assert.equal(payrollStep({ ...received, payeeHashZero: true, now: 5_000 }).action, "none");
    assert.equal(payrollStep(proposed({ status: "Active", role: "employer" })).action, "none");
    assert.equal(payrollStep({ ...received, status: "Stopped" }).action, "none");
    assert.equal(payrollStep(proposed({ kind: "stream" })).action, "none");
  });
});

describe("payBuildFailure", () => {
  it("names the Pay circuit assertion instead of TRANSACTION_PROGRAM_BUILD", () => {
    assert.equal(payBuildFailure("the note owner"), WRONG_SHIELDED_OWNER);
    assert.equal(payBuildFailure("the transfer exceeds the balance"), PAYROLL_NOTE_SHORT);
    assert.equal(payBuildFailure("the amount commitment"), MISSING_PAYROLL_KEY);
    assert.equal(payBuildFailure("the payroll keeps its change"), MISSING_PAYROLL_KEY);
  });

  it("falls back for unknown labels, prototype keys, and no label", () => {
    assert.equal(payBuildFailure("invalid proof input: Error: invalid length 34"), PAY_PROOF_NOT_BUILT);
    assert.equal(payBuildFailure("constructor"), PAY_PROOF_NOT_BUILT);
    assert.equal(payBuildFailure("__proto__"), PAY_PROOF_NOT_BUILT);
    assert.equal(payBuildFailure(null), PAY_PROOF_NOT_BUILT);
  });
});

describe("parsePreparedRoll", () => {
  it("accepts initiate and pay instruction bytes", () => {
    const keys = [
      { pubkey: "AoBDpQ9KRQ1GBtnu1QURmdDv7RgN4Qyr5EWSkQzgF1B8", isSigner: false, isWritable: true },
      { pubkey: "YrSYDo5dYGbnhGMASAAthdy3tgmXvgj8sF79WHwdDi5", isSigner: true, isWritable: true },
      { pubkey: "D2xxTX4z1rurQaR7Lq9EE7c6bDnj9oJ3jhTLtn9LKZ5E", isSigner: false, isWritable: false },
    ];
    const initiate = parsePreparedRoll({
      computeUnitLimit: DEPOSIT_COMPUTE_UNIT_LIMIT,
      programId: PPROLL_PROGRAM_ID,
      dataHex: `${IX_INITIATE.toString(16).padStart(2, "0")}${KEEPS_NOTE.toString(16).padStart(2, "0")}${"aa".repeat(128)}`,
      keys,
      lookupAddresses: ["AoBDpQ9KRQ1GBtnu1QURmdDv7RgN4Qyr5EWSkQzgF1B8"],
    });
    assert.equal(initiate?.dataHex.startsWith("0d01"), true);
    const pay = parsePreparedRoll({
      computeUnitLimit: DEPOSIT_COMPUTE_UNIT_LIMIT,
      programId: PPROLL_PROGRAM_ID,
      dataHex: `${IX_PAY.toString(16).padStart(2, "0")}${"bb".repeat(128)}`,
      keys,
      lookupAddresses: ["AoBDpQ9KRQ1GBtnu1QURmdDv7RgN4Qyr5EWSkQzgF1B8"],
    });
    assert.equal(pay?.dataHex.startsWith("0e"), true);
    assert.equal(parsePreparedRoll({ ...pay, dataHex: "07" + "aa".repeat(128) }), null);
  });
});
