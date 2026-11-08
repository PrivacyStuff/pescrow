import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeBase58, decodeEscrow, noteMatchesAsk, openerCanLock, recipientCanLock } from "./escrow-account.ts";

const PARTY_A = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const PARTY_B = Uint8Array.from({ length: 32 }, (_, index) => index + 33);

function account(): Uint8Array {
  const data = new Uint8Array(160);
  data[0] = 1;
  data[1] = 1;
  data[2] = 1;
  data[3] = 0;
  data[4] = 0;
  data[5] = 0;
  data.set(PARTY_A, 24);
  data.set(PARTY_B, 56);
  writeI64(data, 8, 1_700_000_100);
  writeI64(data, 16, 1_700_000_000);
  return data;
}

describe("decodeEscrow", () => {
  it("reads the side, the approvals, and ignores an account for someone else", () => {
    const data = account();
    const viewed = decodeEscrow("Escrow111", data, PARTY_B);
    assert.equal(viewed?.role, "b");
    assert.equal(viewed?.aApproved, true);
    assert.equal(viewed?.bApproved, false);
    assert.equal(viewed?.status, "Proposed");
    assert.equal(viewed?.startAt, 1_700_000_100);
    assert.equal(viewed?.approvalDeadline, 1_700_000_000);
    assert.equal(decodeEscrow("Escrow111", data, new Uint8Array(32)), null);
    data[0] = 0;
    assert.equal(decodeEscrow("Escrow111", data, PARTY_A), null);
    const encoded = viewed?.partyA ?? "";
    assert.deepEqual(decodeBase58(encoded), PARTY_A);
  });
});

function writeI64(data: Uint8Array, offset: number, value: number): void {
  let rest = BigInt(value);
  for (let index = 0; index < 8; index += 1) {
    data[offset + index] = Number(rest & BigInt(0xff));
    rest >>= BigInt(8);
  }
}

describe("openerCanLock", () => {
  const proposed = {
    status: "Proposed",
    role: "a" as const,
    aApproved: true,
    bApproved: false,
    aSealed: false,
    bSealed: false,
  };

  it("lets party A lock while the counterparty approval byte is 0", () => {
    assert.equal(openerCanLock(proposed), true);
    assert.equal(openerCanLock({ ...proposed, bApproved: true }), true);
    assert.equal(openerCanLock({ ...proposed, aSealed: true }), false);
    assert.equal(openerCanLock({ ...proposed, aApproved: false }), false);
    assert.equal(openerCanLock({ ...proposed, role: "b" }), false);
    assert.equal(openerCanLock({ ...proposed, status: "Void" }), false);
  });

  it("lets party B lock only after A is sealed and B has approved", () => {
    assert.equal(recipientCanLock({ ...proposed, role: "b" }), false);
    assert.equal(recipientCanLock({ ...proposed, role: "b", bApproved: true }), false);
    assert.equal(recipientCanLock({ ...proposed, role: "b", aSealed: true }), false);
    assert.equal(recipientCanLock({ ...proposed, role: "b", aSealed: true, bApproved: true }), true);
    assert.equal(recipientCanLock({ ...proposed, role: "b", aSealed: true, bApproved: true, bSealed: true }), false);
    assert.equal(recipientCanLock(proposed), false);
  });
});

describe("noteMatchesAsk", () => {
  it("accepts any note when no amount was asked, and the exact amount when one was", () => {
    assert.equal(noteMatchesAsk(BigInt(10), null), true);
    assert.equal(noteMatchesAsk(BigInt(10), BigInt(10)), true);
    assert.equal(noteMatchesAsk(BigInt(9), BigInt(10)), false);
  });
});
