/** Address Lookup Table program rejects a recent_slot more than this many slots behind the bank. */
export const LOOKUP_RECENT_SLOTS = 512;
/** CreateLookupTable data: u32 index, u64 recent_slot, u8 bump. */
const CREATE_INDEX_LEN = 4;
const SLOT_LEN = 8;

/**
 * Slot written into CreateLookupTable. `getSlot` and `getLatestBlockhash` can
 * come from a backend hundreds of slots behind the bank that simulates. Once
 * that bank has rejected a slot, use its context slot. Otherwise take the newer
 * RPC slot that is still at or behind the simulation slot and inside the recent window.
 */
export function chooseLookupSlot(input: {
  readonly processed: number;
  readonly blockhashSlot: number;
  readonly simulationSlot: number | null;
  readonly previousRejected: boolean;
}): number {
  if (input.simulationSlot !== null && input.previousRejected) return input.simulationSlot;
  const observed = Math.max(input.processed, input.blockhashSlot);
  if (input.simulationSlot === null) return observed;
  if (observed > input.simulationSlot) return input.simulationSlot;
  if (input.simulationSlot - observed > LOOKUP_RECENT_SLOTS) return input.simulationSlot;
  return observed;
}

export function recentSlotFromCreateInstruction(data: Uint8Array): bigint {
  if (data.length < CREATE_INDEX_LEN + SLOT_LEN) throw new Error("lookup table instruction is short");
  let slot = BigInt(0);
  for (let byte = 0; byte < SLOT_LEN; byte += 1) {
    slot += BigInt(data[CREATE_INDEX_LEN + byte] ?? 0) << BigInt(8 * byte);
  }
  return slot;
}
