import { randomBytes } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import type { Bytes32 } from "../../../pescrow/sdk/node_modules/@heliuslabs/spr/dist/keypair/bytes.js";
import { ShieldedAddress, ViewingKey } from "../../../pescrow/sdk/node_modules/@heliuslabs/spr/dist/keypair/index.js";
import { initializePoseidon, poseidon } from "../../../pescrow/sdk/node_modules/@heliuslabs/spr/dist/hasher/index.js";
import { ProgramOwner } from "../../../pescrow/sdk/node_modules/@heliuslabs/spr/dist/program/index.js";
import { payrollOpenData, PPROLL_PROGRAM_ID } from "../../../src/lib/payroll-account.ts";
import { be32 } from "./commitment.ts";

const PROGRAM_ID = new PublicKey(PPROLL_PROGRAM_ID);
const POOL_SEED = "user-pool";
const NOTE_SEED = "payroll";
const FIELD_BYTES = 32;

export type PreparedVault = {
  readonly ownerHashHex: string;
  readonly viewingPublicHex: string;
  readonly viewingSecretHex: string;
};

export type PreparedPayroll = PreparedVault & {
  readonly instructionHex: string;
  readonly installmentBlindingHex: string;
  readonly budgetBlindingHex: string;
};

type OpenInput = {
  readonly payroll: string;
  readonly payee: string;
  readonly payeeOwnerHash: string;
  readonly installment: string;
  readonly budget: string;
  readonly startAt: string;
  readonly periodSecs: string;
};

export async function prepareVaultFor(owner: PublicKey): Promise<PreparedVault> {
  await initializePoseidon();
  const viewing = ViewingKey.generate();
  try {
    return material(viewing, pdaAddress(poolPda(owner), viewing));
  } finally {
    viewing.destroy();
  }
}

export async function preparePayroll(input: OpenInput): Promise<PreparedPayroll> {
  await initializePoseidon();
  const viewing = ViewingKey.generate();
  try {
    const payroll = new PublicKey(input.payroll);
    const note = pdaAddress(notePda(payroll), viewing);
    const payeeHash = Buffer.from(input.payeeOwnerHash, "hex");
    const installmentBlind = freshBlinding();
    const budgetBlind = freshBlinding();
    const installment = await commitment(BigInt(input.installment), installmentBlind);
    const budget = await commitment(BigInt(input.budget), budgetBlind);
    const instruction = payrollOpenData({
      payee: new PublicKey(input.payee).toBytes(),
      payeeHash,
      noteHash: Buffer.from(note.ownerHash()),
      startAt: BigInt(input.startAt),
      periodSecs: BigInt(input.periodSecs),
      installment,
      budget,
      viewing: Buffer.from(viewing.publicKey().toBytes()),
    });
    if (instruction === null) throw new Error("the payroll instruction could not be built");
    const vault = material(viewing, note);
    return {
      ...vault,
      instructionHex: Buffer.from(instruction).toString("hex"),
      installmentBlindingHex: installmentBlind.toString("hex"),
      budgetBlindingHex: budgetBlind.toString("hex"),
    };
  } finally {
    viewing.destroy();
  }
}

function material(viewing: ViewingKey, address: ShieldedAddress): PreparedVault {
  return {
    ownerHashHex: Buffer.from(address.ownerHash()).toString("hex"),
    viewingPublicHex: Buffer.from(viewing.publicKey().toBytes()).toString("hex"),
    viewingSecretHex: Buffer.from(viewing.secretBytes()).toString("hex"),
  };
}

function poolPda(owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from(POOL_SEED), owner.toBuffer()], PROGRAM_ID)[0];
}

function notePda(payroll: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from(NOTE_SEED), payroll.toBuffer()], PROGRAM_ID)[0];
}

function pdaAddress(pda: PublicKey, viewing: ViewingKey): ShieldedAddress {
  const key = ProgramOwner.nullifierKey();
  try {
    return ShieldedAddress.forPda({
      pda: bytes32(pda.toBytes()),
      nullifierPublicKey: bytes32(key.publicKey()),
      viewingPublicKey: viewing.publicKey(),
    });
  } finally {
    key.destroy();
  }
}

async function commitment(amount: bigint, blinding: Uint8Array): Promise<Uint8Array> {
  return Uint8Array.from(poseidon([be32(amount), blinding]));
}

function freshBlinding(): Buffer {
  const bytes = randomBytes(FIELD_BYTES);
  bytes[0] = 0;
  return bytes;
}

function bytes32(value: Uint8Array): Bytes32 {
  if (value.byteLength !== FIELD_BYTES) throw new Error("expected 32 bytes");
  return value as Bytes32;
}
