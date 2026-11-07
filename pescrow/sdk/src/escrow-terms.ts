import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { MAX_CHUNK_LAMPORTS, MIN_CHUNK_LAMPORTS, type SwapTerms } from "./chunk-plan.ts";

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export type { SwapTerms };

export function termsFilePath(): string {
  return join(homedir(), ".config", "zolana", "escrow-terms.json");
}

function bounded(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const amount = BigInt(value);
  if (amount < MIN_CHUNK_LAMPORTS || amount > MAX_CHUNK_LAMPORTS) return null;
  return amount.toString();
}

export function readTerms(path = termsFilePath()): Record<string, SwapTerms> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null) return {};
  const terms: Record<string, SwapTerms> = {};
  for (const [escrow, value] of Object.entries(parsed)) {
    if (!BASE58.test(escrow) || typeof value !== "object" || value === null) continue;
    const row = value as Record<string, unknown>;
    const lockLamports = bounded(row.lockLamports);
    const receiveLamports = bounded(row.receiveLamports);
    if (lockLamports === null || receiveLamports === null) continue;
    terms[escrow] = { lockLamports, receiveLamports };
  }
  return terms;
}

export function writeTerms(escrow: string, terms: SwapTerms, path = termsFilePath()): void {
  if (!BASE58.test(escrow)) throw new Error("escrow address is not a public key");
  const lockLamports = bounded(terms.lockLamports);
  const receiveLamports = bounded(terms.receiveLamports);
  if (lockLamports === null || receiveLamports === null) throw new Error("swap amounts must be from 1 lamport to 1 SOL");
  const next = readTerms(path);
  next[escrow] = { lockLamports, receiveLamports };
  mkdirSync(dirname(path), { recursive: true, mode: DIR_MODE });
  writeFileSync(path, `${JSON.stringify(next)}\n`, { mode: FILE_MODE });
  chmodSync(path, FILE_MODE);
}
