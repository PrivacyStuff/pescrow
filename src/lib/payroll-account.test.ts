import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BUDGET_APPROVE_IX,
  IX_OPEN_PAYROLL,
  IX_OPEN_VAULT,
  PAYROLL_ACCOUNT_LEN,
  PERIOD_HOUR_SECS,
  STREAM_ACCOUNT_LEN,
  STREAM_APPROVE_IX,
  VAULT_ACCOUNT_LEN,
  VIEWING_LEN,
  decodePayroll,
  decodeVault,
  payrollApproveData,
  payrollOpenData,
  periodLabel,
  scheduleAt,
  splitPayrolls,
  streamCreateData,
  vaultOpenData,
} from "./payroll-account.ts";

const EMPLOYER = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const PAYEE = Uint8Array.from({ length: 32 }, (_, index) => index + 40);

function writeI64(data: Uint8Array, offset: number, value: bigint): void {
  new DataView(data.buffer).setBigInt64(offset, value, true);
}

function stream(): Uint8Array {
  const data = new Uint8Array(STREAM_ACCOUNT_LEN);
  data[0] = 2;
  data[1] = 1;
  data[2] = 1;
  data[3] = 0;
  writeI64(data, 8, BigInt(1_700_000_000));
  writeI64(data, 16, BigInt(1_700_000_000));
  writeI64(data, 24, BigInt(PERIOD_HOUR_SECS));
  data.set(EMPLOYER, 32);
  data.set(PAYEE, 64);
  return data;
}

describe("decodePayroll", () => {
  it("reads an issued stream and drops a closed one", () => {
    const data = stream();
    const issued = decodePayroll("Stream111", data, EMPLOYER);
    assert.equal(issued?.role, "employer");
    assert.equal(issued?.kind, "stream");
    assert.equal(issued?.status, "Proposed");
    assert.equal(issued?.employerApproved, true);
    assert.equal(issued?.payeeApproved, false);
    assert.equal(issued?.periodSecs, PERIOD_HOUR_SECS);
    const received = decodePayroll("Stream111", data, PAYEE);
    assert.equal(received?.role, "payee");
    assert.equal(decodePayroll("Stream111", data, new Uint8Array(32)), null);
    data[1] = 4;
    assert.equal(decodePayroll("Stream111", data, EMPLOYER), null);
  });

  it("reads a budget payroll by its tag and length", () => {
    const data = new Uint8Array(PAYROLL_ACCOUNT_LEN);
    data[0] = 5;
    data[1] = 2;
    data[2] = 1;
    data[3] = 1;
    writeI64(data, 8, BigInt(10));
    writeI64(data, 16, BigInt(10));
    writeI64(data, 24, BigInt(86_400));
    data.set(EMPLOYER, 32);
    data.set(PAYEE, 64);
    const view = decodePayroll("Budget111", data, PAYEE);
    assert.equal(view?.kind, "budget");
    assert.equal(view?.status, "Active");
    assert.equal(view?.role, "payee");
    assert.equal(view?.frozen, false);
    assert.equal(view?.payeeHashZero, true);
    assert.equal(view?.nextRedeem, 0);
    data[4] = 1;
    data.set(PAYEE, 96);
    new DataView(data.buffer).setUint32(260, 3, true);
    const bound = decodePayroll("Budget111", data, PAYEE);
    assert.equal(bound?.frozen, true);
    assert.equal(bound?.payeeHashZero, false);
    assert.equal(bound?.nextRedeem, 3);
  });
});

describe("splitPayrolls", () => {
  it("keeps the employer on the issued side and the payee on the received side", () => {
    const data = stream();
    const issued = decodePayroll("Stream111", data, EMPLOYER);
    const received = decodePayroll("Stream111", data, PAYEE);
    assert.ok(issued !== null && received !== null);
    const split = splitPayrolls([issued, received]);
    assert.deepEqual(split.issued.map((row) => row.role), ["employer"]);
    assert.deepEqual(split.received.map((row) => row.role), ["payee"]);
  });
});

describe("streamCreateData", () => {
  it("writes the destinataire, one start, and the public ring", () => {
    const start = scheduleAt(1_700_000_000, PERIOD_HOUR_SECS, 21_600);
    assert.equal(start, BigInt(1_700_021_600));
    assert.equal(scheduleAt(1, 0, 10), null);
    const data = streamCreateData(PAYEE, start ?? BigInt(0), BigInt(PERIOD_HOUR_SECS));
    assert.ok(data !== null);
    assert.equal(data[0], 0);
    assert.deepEqual(data.subarray(1, 33), PAYEE);
    assert.equal(data[1 + 56], 1);
    assert.equal(data[1 + 57], 1);
    assert.equal(periodLabel(PERIOD_HOUR_SECS), "Hourly");
    assert.equal(STREAM_APPROVE_IX, 1);
    assert.equal(BUDGET_APPROVE_IX, 12);
  });
});

describe("budget payroll open", () => {
  it("writes the amount commitments and rejects an empty hash", () => {
    const owner = Uint8Array.from({ length: 32 }, (_, index) => index + 3);
    const viewing = Uint8Array.from({ length: VIEWING_LEN }, () => 9);
    viewing[0] = 4;
    const vault = new Uint8Array(VAULT_ACCOUNT_LEN);
    vault[0] = 4;
    vault[1] = 1;
    vault.set(EMPLOYER, 8);
    assert.equal(decodeVault("Vault111", vault, EMPLOYER)?.funded, true);
    assert.equal(decodeVault("Vault111", vault, PAYEE), null);
    const vaultIx = vaultOpenData(owner, viewing);
    assert.equal(vaultIx?.[0], IX_OPEN_VAULT);
    assert.equal(vaultIx?.length, 1 + 32 + VIEWING_LEN);
    const hash = Uint8Array.from({ length: 32 }, (_, index) => index + 8);
    const opened = payrollOpenData({
      payee: PAYEE,
      payeeHash: hash,
      noteHash: hash,
      startAt: BigInt(1_700_021_600),
      periodSecs: BigInt(PERIOD_HOUR_SECS),
      installment: hash,
      budget: owner,
      viewing,
    });
    assert.equal(opened?.[0], IX_OPEN_PAYROLL);
    assert.equal(opened?.length, 220);
    assert.deepEqual(opened?.subarray(1, 33), PAYEE);
    const unbound = payrollOpenData({
      payee: PAYEE,
      payeeHash: new Uint8Array(32),
      noteHash: hash,
      startAt: BigInt(10),
      periodSecs: BigInt(10),
      installment: hash,
      budget: owner,
      viewing,
    });
    assert.equal(unbound?.length, 220);
    assert.equal(unbound?.subarray(33, 65).every((byte) => byte === 0), true);
    assert.equal(payrollOpenData({
      payee: PAYEE,
      payeeHash: hash,
      noteHash: new Uint8Array(32),
      startAt: BigInt(10),
      periodSecs: BigInt(10),
      installment: hash,
      budget: owner,
      viewing,
    }), null);
    const approval = payrollApproveData(hash);
    assert.equal(approval?.[0], 12);
    assert.equal(approval?.length, 33);
    assert.equal(payrollApproveData(new Uint8Array(32)), null);
  });
});
