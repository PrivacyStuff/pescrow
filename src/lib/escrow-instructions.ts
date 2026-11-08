import { CLOCK_SYSVAR } from "./escrow-program.ts";
import { RING_PERMISSIONLESS, WALLETS_PUBLIC } from "./escrow-params.ts";

export const CREATE_TAG = 0;
export const APPROVE_TAG = 1;
export const DECLINE_TAG = 2;
export const CLOSE_TAG = 6;
/** Tag byte plus the 51-byte create body `parse_create` reads. */
export const CREATE_IX_LEN = 52;
const PARTY_LEN = 32;
const I64_LEN = 8;
const OFF_PARTY_B = 1;
const OFF_START = 33;
const OFF_DEADLINE = 41;
const OFF_RING = 49;
const OFF_WALLETS = 50;
const OFF_BUMP = 51;

export type InstructionAccount = {
  readonly address: string;
  readonly isSigner: boolean;
  readonly isWritable: boolean;
};

export type BuiltInstruction = {
  readonly data: Uint8Array;
  readonly keys: readonly InstructionAccount[];
};

export function createEscrowInstruction(input: {
  readonly escrow: string;
  readonly opener: string;
  readonly counterparty: Uint8Array;
  readonly startAt: number;
  readonly approvalDeadline: number;
  readonly bump: number;
}): BuiltInstruction {
  if (input.counterparty.length !== PARTY_LEN) throw new Error("counterparty must be 32 bytes");
  if (input.bump < 0 || input.bump > 255) throw new Error("bump is out of range");
  const data = new Uint8Array(CREATE_IX_LEN);
  data[0] = CREATE_TAG;
  data.set(input.counterparty, OFF_PARTY_B);
  writeI64(data, OFF_START, input.startAt);
  writeI64(data, OFF_DEADLINE, input.approvalDeadline);
  data[OFF_RING] = RING_PERMISSIONLESS;
  data[OFF_WALLETS] = WALLETS_PUBLIC;
  data[OFF_BUMP] = input.bump;
  return {
    data,
    keys: [
      { address: input.escrow, isSigner: false, isWritable: true },
      { address: input.opener, isSigner: true, isWritable: true },
    ],
  };
}

export function approveEscrowInstruction(escrow: string, signer: string): BuiltInstruction {
  return partyInstruction(APPROVE_TAG, escrow, signer);
}

export function declineEscrowInstruction(escrow: string, signer: string): BuiltInstruction {
  return partyInstruction(DECLINE_TAG, escrow, signer);
}

export function closeEscrowInstruction(escrow: string, signer: string, partyA: string): BuiltInstruction {
  const keys: InstructionAccount[] = [
    { address: escrow, isSigner: false, isWritable: true },
    { address: signer, isSigner: true, isWritable: true },
  ];
  if (signer !== partyA) keys.push({ address: partyA, isSigner: false, isWritable: true });
  return { data: Uint8Array.of(CLOSE_TAG), keys };
}

function partyInstruction(tag: number, escrow: string, signer: string): BuiltInstruction {
  return {
    data: Uint8Array.of(tag),
    keys: [
      { address: escrow, isSigner: false, isWritable: true },
      { address: signer, isSigner: true, isWritable: true },
      { address: CLOCK_SYSVAR, isSigner: false, isWritable: false },
    ],
  };
}

function writeI64(data: Uint8Array, offset: number, value: number): void {
  if (!Number.isSafeInteger(value)) throw new Error("time does not fit a safe integer");
  let rest = BigInt(value);
  for (let index = 0; index < I64_LEN; index += 1) {
    data[offset + index] = Number(rest & BigInt(0xff));
    rest >>= BigInt(8);
  }
}
