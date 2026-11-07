export const ESCROW_ACCOUNT_LEN = 160;

const STATUS_NAME = ["", "Proposed", "Void", "Exchanged", "Reclaimed"] as const;

export type EscrowView = {
  readonly address: string;
  readonly status: string;
  readonly aApproved: boolean;
  readonly bApproved: boolean;
  readonly aSealed: boolean;
  readonly bSealed: boolean;
  readonly startAt: number;
  readonly partyA: string;
  readonly partyB: string;
  readonly role: "a" | "b";
};

export function decodeEscrow(address: string, data: Uint8Array, wallet: Uint8Array): EscrowView | null {
  if (data.length !== ESCROW_ACCOUNT_LEN || data[0] !== 1) return null;
  const partyA = data.subarray(24, 56);
  const partyB = data.subarray(56, 88);
  const role = equal32(partyA, wallet) ? "a" : equal32(partyB, wallet) ? "b" : null;
  if (role === null) return null;
  const statusByte = data[1] ?? 0;
  return {
    address,
    status: STATUS_NAME[statusByte] ?? "Unknown",
    aApproved: data[2] === 1,
    bApproved: data[3] === 1,
    aSealed: data[4] === 1,
    bSealed: data[5] === 1,
    startAt: readI64(data, 8),
    partyA: base58(partyA),
    partyB: base58(partyB),
    role,
  };
}

export function noteMatchesAsk(noteLamports: bigint, askLamports: bigint | null): boolean {
  if (askLamports === null) return true;
  return noteLamports === askLamports;
}

function readI64(data: Uint8Array, offset: number): number {
  let value = BigInt(0);
  for (let index = 0; index < 8; index += 1) {
    value += BigInt(data[offset + index] ?? 0) << BigInt(8 * index);
  }
  const sign = BigInt(1) << BigInt(63);
  const negative = value >= sign;
  const signed = negative ? value - (sign << BigInt(1)) : value;
  return Number(signed);
}

function equal32(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== 32 || right.length !== 32) return false;
  for (let index = 0; index < 32; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function decodeBase58(value: string): Uint8Array | null {
  if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(value)) return null;
  let acc = BigInt(0);
  for (const char of value) {
    const digit = ALPHABET.indexOf(char);
    if (digit < 0) return null;
    acc = acc * BigInt(58) + BigInt(digit);
  }
  const bytes: number[] = [];
  while (acc > BigInt(0)) {
    bytes.push(Number(acc & BigInt(255)));
    acc >>= BigInt(8);
  }
  let zeros = 0;
  for (const char of value) {
    if (char !== "1") break;
    zeros += 1;
  }
  const out = new Uint8Array(zeros + bytes.length);
  bytes.reverse().forEach((byte, index) => {
    out[zeros + index] = byte;
  });
  return out.length === 32 ? out : null;
}

function base58(bytes: Uint8Array): string {
  let value = BigInt(0);
  for (const byte of bytes) value = (value << BigInt(8)) + BigInt(byte);
  let out = "";
  while (value > BigInt(0)) {
    const digit = value % BigInt(58);
    out = ALPHABET[Number(digit)] + out;
    value /= BigInt(58);
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = `1${out}`;
  }
  return out;
}
