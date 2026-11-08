import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EscrowView } from "./escrow-account.ts";
import { groupEscrows } from "./escrow-groups.ts";

function view(address: string, role: "a" | "b", status: string): EscrowView {
  return {
    address,
    status,
    aApproved: false,
    bApproved: false,
    aSealed: false,
    bSealed: false,
    startAt: 0,
    approvalDeadline: 0,
    partyA: "a",
    partyB: "b",
    role,
  };
}

describe("groupEscrows", () => {
  it("splits open escrows by who created them and parks finished ones in history", () => {
    const groups = groupEscrows([
      view("issued", "a", "Proposed"),
      view("received", "b", "Proposed"),
      view("done", "a", "Exchanged"),
      view("voided", "b", "Void"),
      view("back", "a", "Reclaimed"),
      view("odd", "a", "Unknown"),
    ]);
    assert.deepEqual(groups.issued.map((row) => row.address), ["issued"]);
    assert.deepEqual(groups.received.map((row) => row.address), ["received"]);
    assert.deepEqual(groups.history.map((row) => row.address), ["done", "voided", "back"]);
  });
});
