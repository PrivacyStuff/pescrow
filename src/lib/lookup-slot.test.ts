import assert from "node:assert/strict";
import test from "node:test";
import { chooseLookupSlot, recentSlotFromCreateInstruction } from "../../pescrow/sdk/src/lookup-slot.ts";

test("a rejected lookup slot is replaced by the simulation bank slot", () => {
  const slot = chooseLookupSlot({
    processed: 520_014_339,
    blockhashSlot: 520_014_300,
    simulationSlot: 520_015_000,
    previousRejected: true,
  });
  assert.equal(slot, 520_015_000);
});

test("an RPC slot ahead of the simulating bank is not used", () => {
  const slot = chooseLookupSlot({
    processed: 520_015_800,
    blockhashSlot: 520_015_700,
    simulationSlot: 520_015_200,
    previousRejected: false,
  });
  assert.equal(slot, 520_015_200);
});

test("a slot more than 512 behind the bank is replaced before the first rejection flag", () => {
  const slot = chooseLookupSlot({
    processed: 520_014_339,
    blockhashSlot: 520_014_400,
    simulationSlot: 520_015_000,
    previousRejected: false,
  });
  assert.equal(slot, 520_015_000);
});

test("CreateLookupTable instruction data stores the chosen slot", () => {
  const slot = 520_015_000;
  const data = new Uint8Array(13);
  let rest = BigInt(slot);
  for (let byte = 0; byte < 8; byte += 1) {
    data[4 + byte] = Number(rest & BigInt(0xff));
    rest >>= BigInt(8);
  }
  assert.equal(recentSlotFromCreateInstruction(data), BigInt(slot));
});
