import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CLOCK_SYSVAR } from "./escrow-program.ts";
import {
  APPROVE_TAG,
  CLOSE_TAG,
  CREATE_IX_LEN,
  CREATE_TAG,
  DECLINE_TAG,
  approveEscrowInstruction,
  closeEscrowInstruction,
  createEscrowInstruction,
  declineEscrowInstruction,
} from "./escrow-instructions.ts";
import { RING_PERMISSIONLESS, WALLETS_PUBLIC } from "./escrow-params.ts";

const ESCROW = "FN4yqDixHBi84WUZBqTg2rm6m1Rrvvm46Pum55nU99KF";
const OPENER = "AoBDpQ9KRQ1GBtnu1QURmdDv7RgN4Qyr5EWSkQzgF1B8";
const OTHER = "YrSYDo5dYGbnhGMASAAthdy3tgmXvgj8sF79WHwdDi5";

describe("escrow instructions", () => {
  it("lays out create the way parse_create reads it, after the tag", () => {
    const counterparty = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
    const built = createEscrowInstruction({
      escrow: ESCROW,
      opener: OPENER,
      counterparty,
      startAt: 1_700_000_100,
      approvalDeadline: 1_700_000_000,
      bump: 7,
    });
    assert.equal(built.data.length, CREATE_IX_LEN);
    assert.equal(built.data[0], CREATE_TAG);
    assert.deepEqual(built.data.subarray(1, 33), counterparty);
    assert.equal(built.data[49], RING_PERMISSIONLESS);
    assert.equal(built.data[50], WALLETS_PUBLIC);
    assert.equal(built.data[51], 7);
    assert.equal(readI64(built.data, 33), 1_700_000_100);
    assert.equal(readI64(built.data, 41), 1_700_000_000);
    assert.deepEqual(
      built.keys.map((key) => key.address),
      [ESCROW, OPENER],
    );
  });

  it("sends approve and decline with the clock, and close pays rent to party A", () => {
    const approve = approveEscrowInstruction(ESCROW, OTHER);
    assert.deepEqual(Array.from(approve.data), [APPROVE_TAG]);
    assert.equal(approve.keys[2]?.address, CLOCK_SYSVAR);
    assert.deepEqual(Array.from(declineEscrowInstruction(ESCROW, OTHER).data), [DECLINE_TAG]);
    const close = closeEscrowInstruction(ESCROW, OTHER, OPENER);
    assert.deepEqual(Array.from(close.data), [CLOSE_TAG]);
    assert.deepEqual(
      close.keys.map((key) => key.address),
      [ESCROW, OTHER, OPENER],
    );
    assert.equal(closeEscrowInstruction(ESCROW, OPENER, OPENER).keys.length, 2);
  });
});

function readI64(data: Uint8Array, offset: number): number {
  let value = BigInt(0);
  for (let index = 0; index < 8; index += 1) value += BigInt(data[offset + index] ?? 0) << BigInt(8 * index);
  return Number(value);
}
