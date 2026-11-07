import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeBase58, decodeEscrow, noteMatchesAsk } from "./escrow-account.ts";

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
    assert.equal(decodeEscrow("Escrow111", data, new Uint8Array(32)), null);
    data[0] = 0;
    assert.equal(decodeEscrow("Escrow111", data, PARTY_A), null);
    const encoded = viewed?.partyA ?? "";
    assert.deepEqual(decodeBase58(encoded), PARTY_A);
  });
});

describe("noteMatchesAsk", () => {
  it("accepts any note when no amount was asked, and the exact amount when one was", () => {
    assert.equal(noteMatchesAsk(BigInt(10), null), true);
    assert.equal(noteMatchesAsk(BigInt(10), BigInt(10)), true);
    assert.equal(noteMatchesAsk(BigInt(9), BigInt(10)), false);
  });
});
