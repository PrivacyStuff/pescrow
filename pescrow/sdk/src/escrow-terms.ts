import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  MAX_BASE_UNITS,
  MAX_SOL_LAMPORTS,
  MIN_CHUNK_LAMPORTS,
  SOL_MINT,
  type AssetKind,
  type AssetSide,
  type SwapTerms,
} from "./chunk-plan.ts";

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SHIELD_HEX = /^[0-9a-fA-F]{64,400}$/;

function shieldHex(value: string): boolean {
  return value.length % 2 === 0 && SHIELD_HEX.test(value);
}

export type { AssetKind, AssetSide, SwapTerms };

export function termsFilePath(): string {
  return join(homedir(), ".config", "zolana", "escrow-terms.json");
}

function integerAmount(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const amount = BigInt(value);
  if (amount < MIN_CHUNK_LAMPORTS || amount > MAX_BASE_UNITS) return null;
  return amount;
}

function parseSide(value: unknown): AssetSide | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  if (row.kind !== "sol" && row.kind !== "token" && row.kind !== "nft") return null;
  if (typeof row.mint !== "string" || !BASE58.test(row.mint)) return null;
  const amount = integerAmount(row.amount);
  if (amount === null) return null;
  if (row.kind === "sol") {
    if (row.mint !== SOL_MINT || amount > MAX_SOL_LAMPORTS) return null;
  } else if (row.mint === SOL_MINT) {
    return null;
  }
  if (row.kind === "nft" && amount !== BigInt(1)) return null;
  return { kind: row.kind, mint: row.mint, amount: amount.toString() };
}

function legacySol(value: unknown): AssetSide | null {
  const amount = integerAmount(value);
  if (amount === null || amount > MAX_SOL_LAMPORTS) return null;
  return { kind: "sol", mint: SOL_MINT, amount: amount.toString() };
}

function parseRow(value: unknown): SwapTerms | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  if (row.a === undefined && row.b === undefined) {
    const lock = legacySol(row.lockLamports);
    const receive = legacySol(row.receiveLamports);
    if (lock === null || receive === null) return null;
    return { a: lock, b: receive };
  }
  const a = parseSide(row.a);
  const b = parseSide(row.b);
  if (a === null || b === null) return null;
  if (row.openerShield !== undefined && (typeof row.openerShield !== "string" || !shieldHex(row.openerShield))) return null;
  return row.openerShield === undefined ? { a, b } : { a, b, openerShield: row.openerShield };
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
    if (!BASE58.test(escrow)) continue;
    const row = parseRow(value);
    if (row !== null) terms[escrow] = row;
  }
  return terms;
}

export function writeTerms(escrow: string, terms: SwapTerms, path = termsFilePath()): void {
  if (!BASE58.test(escrow)) throw new Error("escrow address is not a public key");
  const a = parseSide(terms.a);
  const b = parseSide(terms.b);
  if (a === null || b === null) throw new Error("each side needs a mint and an amount that fits the asset");
  if (terms.openerShield !== undefined && !shieldHex(terms.openerShield)) {
    throw new Error("the opener shielded address is not hex");
  }
  const next = readTerms(path);
  const openerShield = terms.openerShield ?? next[escrow]?.openerShield;
  next[escrow] = openerShield === undefined ? { a, b } : { a, b, openerShield };
  mkdirSync(dirname(path), { recursive: true, mode: DIR_MODE });
  writeFileSync(path, `${JSON.stringify(next)}\n`, { mode: FILE_MODE });
  chmodSync(path, FILE_MODE);
}
