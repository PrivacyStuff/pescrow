import { address, type Address } from "@solana/kit";

/** Tree that holds the two 0.01 SOL deposits. Owned by sppU489, not by ring1. */
export const DEPOSITED_TREE: Address = address("33KVhbT4QtdQDrrrGwwThqD47Dh4Q6tA443t9jMNcWFN");

/** Tree owned by ring1, the pool @heliuslabs/spr 0.9 builds against. */
export const RING1_TREE: Address = address("777pvSGe5LaBd9nCczvE2FXEauiwtfGJ5XRpjKyniGor");

/** Base58 note hashes from the sppU489 deposits. The live indexer rejects this tree. */
export const DEPOSITED_NOTE_HASHES = [
  "drhZVxX33Td18MLS8f1ALeFCc6o5xACy6N2UgqRgJhH",
  "3w2tFxbosTbfSR2TKzNj2JbXCAcaNaLxHdmVrQZsQtGV",
] as const;

/** Base58 note hashes from the ring1 deposits. A then B. Leaves 34448 and 34449. */
export const RING1_NOTE_HASHES = [
  "xUiK4RZz4JerbRzZjHVaBgaQM46A45eYhZ2uBMggNzY",
  "3UyqNELpp375h2oTWZwEP5y2McYaZiG6gS3KkCNmo3ey",
] as const;
