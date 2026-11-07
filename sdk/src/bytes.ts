import { getBase58Encoder } from "@solana/kit";
import type { Bytes32 } from "@heliuslabs/spr";

const NOTE_HASH_BYTES = 32;

/** A base58 32-byte note hash, the form `getMerkleProofs` accepts. */
export function bytes32FromBase58(value: string): Bytes32 {
  const bytes = getBase58Encoder().encode(value);
  if (bytes.byteLength !== NOTE_HASH_BYTES) {
    throw new Error(`note hash must be ${NOTE_HASH_BYTES} bytes, got ${bytes.byteLength}`);
  }
  return bytes as Bytes32;
}
