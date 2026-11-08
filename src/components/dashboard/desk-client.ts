"use client";

import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { Buffer } from "buffer";
import { SOL_MINT, type AssetKind } from "@/lib/chunk-plan";
import { RING_FEE_RESERVE, rpcRateLimitMessage } from "@/lib/desk-request";
import { solAssetInfo, type AssetInfo } from "@/lib/mint-account";
import { type TokenMetadata } from "@/lib/token-metadata";
import { afterSigning, type TxCopy } from "@/lib/tx-log";
import { TX_COPY } from "./tx-copy";
import type { TxLogApi } from "./tx-drawer";
import type { AssetDraft, Note } from "./types";

const SHIELDED_KEY = "pescrow-shielded";
const LAMPORTS_PER_SAFE_TRANSFER = BigInt(Number.MAX_SAFE_INTEGER);

export type DeskResult = { ok?: boolean; error?: string; result?: Record<string, unknown> };

export async function chainRead(input: { readonly account?: string; readonly rentSpace?: number }): Promise<{
  blockhash: string;
  lamports: number;
  rentLamports: number;
}> {
  const payload = await post({
    action: "wallet-chain",
    ...(input.account === undefined ? {} : { account: input.account }),
    ...(input.rentSpace === undefined ? {} : { rentSpace: input.rentSpace }),
  });
  const result = payload.result;
  if (result === undefined || typeof result.blockhash !== "string") throw new Error("The desk did not return a blockhash.");
  if (input.account !== undefined && typeof result.lamports !== "number") throw new Error("The desk did not return a balance.");
  if (input.rentSpace !== undefined && typeof result.rentLamports !== "number") throw new Error("The desk did not return the rent exemption.");
  return {
    blockhash: result.blockhash,
    lamports: typeof result.lamports === "number" ? result.lamports : 0,
    rentLamports: typeof result.rentLamports === "number" ? result.rentLamports : 0,
  };
}

export async function post(body: unknown): Promise<DeskResult> {
  const response = await fetch("/api/desk", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await response.json()) as DeskResult;
  if (!response.ok || payload.ok === false) {
    const message = payload.error ?? "The desk command failed.";
    throw new Error(rpcRateLimitMessage(message) ?? message);
  }
  return payload;
}

export async function loadAsset(draft: AssetDraft): Promise<AssetInfo> {
  if (draft.kind === "sol") return solAssetInfo();
  const payload = await post({ action: "wallet-asset-info", mint: draft.mint.trim() });
  return readAssetInfo(payload.result);
}

export async function rememberMetadata(mints: readonly string[], save: (mint: string, meta: TokenMetadata) => void): Promise<void> {
  const unique = [...new Set(mints.filter((mint) => mint !== SOL_MINT))];
  await Promise.all(
    unique.map(async (mint) => {
      try {
        const payload = await post({ action: "wallet-metadata", mint });
        const meta = readTokenMetadata(payload.result);
        if (meta !== null) save(mint, meta);
      } catch {
        // One mint without metadata must not block the note list.
      }
    }),
  );
}

export async function rememberAssets(
  sides: readonly { kind: AssetKind; mint: string }[],
  save: (mint: string, info: AssetInfo) => void,
): Promise<void> {
  const mints = [...new Set(sides.filter((side) => side.kind !== "sol" && side.mint !== SOL_MINT).map((side) => side.mint))];
  await Promise.all(
    mints.map(async (mint) => {
      try {
        const info = await loadAsset({ kind: "token", mint, amount: "1" });
        save(mint, info);
      } catch {
        // A missing mint stays as raw base units. The next action reports the error.
      }
    }),
  );
}

export async function fundRingKey(
  payer: PublicKey,
  seed: Uint8Array,
  sign: (tx: Transaction) => Promise<Transaction>,
  txLog: TxLogApi,
  extraLamports: bigint = BigInt(0),
): Promise<void> {
  if (extraLamports < BigInt(0)) throw new Error("The shield amount is not valid.");
  const ringKey = Keypair.fromSeed(seed);
  const balance = BigInt((await chainRead({ account: ringKey.publicKey.toBase58() })).lamports);
  const target = BigInt(RING_FEE_RESERVE) + extraLamports;
  if (balance >= target) return;
  const missing = target - balance;
  if (missing > LAMPORTS_PER_SAFE_TRANSFER) throw new Error("The fee top-up does not fit a transfer.");
  const tx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: payer, toPubkey: ringKey.publicKey, lamports: Number(missing) }),
  );
  try {
    await sendTracked(txLog, TX_COPY.fundRingKey, tx, payer, sign);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (/cancel|reject|denied/i.test(message)) {
      throw new Error("The fee top-up was rejected, so the private transaction did not start. Approve it when the ring key needs SOL.");
    }
    throw error instanceof Error ? error : new Error("The fee top-up failed.");
  }
}

export async function signAndSend(
  tx: Transaction,
  payer: PublicKey,
  sign: (tx: Transaction) => Promise<Transaction>,
  afterBlockhash?: (tx: Transaction) => void,
): Promise<string> {
  if (tx.feePayer === undefined) tx.feePayer = payer;
  if (tx.recentBlockhash === undefined) {
    tx.recentBlockhash = (await chainRead({})).blockhash;
  }
  afterBlockhash?.(tx);
  const signed = await sign(tx);
  const submitted = await post({ action: "wallet-submit", tx: signed.serialize().toString("base64") });
  const signature = submitted.result?.signature;
  if (typeof signature !== "string") throw new Error("The transaction did not return a signature.");
  return signature;
}

export function sendTracked(
  txLog: TxLogApi,
  copy: TxCopy,
  tx: Transaction,
  payer: PublicKey,
  sign: (tx: Transaction) => Promise<Transaction>,
  afterBlockhash?: (tx: Transaction) => void,
): Promise<string> {
  return txLog.run(copy, "wallet", (signed) => signAndSend(tx, payer, afterSigning(sign, signed), afterBlockhash));
}

export function deskSignature(payload: DeskResult): unknown {
  return payload.result?.signature;
}

export function signatureNotice(label: string, signature: unknown): string {
  return typeof signature === "string" ? `${label} ${signature}` : label;
}

export function rememberShielded(wallet: string, hex: string): void {
  const parsed = JSON.parse(sessionStorage.getItem(SHIELDED_KEY) ?? "{}") as Record<string, string>;
  parsed[wallet] = hex;
  sessionStorage.setItem(SHIELDED_KEY, JSON.stringify(parsed));
}

export function shieldedFor(wallet: string): string | null {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(SHIELDED_KEY) ?? "{}") as Record<string, string>;
    return parsed[wallet] ?? null;
  } catch {
    return null;
  }
}

export function readNotes(value: unknown[]): Note[] {
  const notes: Note[] = [];
  for (const row of value) {
    if (typeof row !== "object" || row === null) continue;
    const record = row as Record<string, unknown>;
    const amount = typeof record.amount === "string" ? record.amount : typeof record.lamports === "string" ? record.lamports : null;
    if (typeof record.hash !== "string" || amount === null || typeof record.leaf !== "string") continue;
    const mint = typeof record.mint === "string" ? record.mint : SOL_MINT;
    notes.push({ hash: record.hash, amount, mint, leaf: record.leaf });
  }
  return notes;
}

export function readAssetInfo(value: unknown): AssetInfo {
  if (typeof value !== "object" || value === null) throw new Error("The mint could not be read.");
  const row = value as Record<string, unknown>;
  if (row.kind !== "sol" && row.kind !== "token" && row.kind !== "nft") throw new Error("The mint could not be read.");
  if (typeof row.decimals !== "number") throw new Error("The mint could not be read.");
  return {
    kind: row.kind,
    decimals: row.decimals,
    supply: typeof row.supply === "string" ? row.supply : null,
    tokenProgram: typeof row.tokenProgram === "string" ? row.tokenProgram : null,
  };
}

function readTokenMetadata(value: unknown): TokenMetadata | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  const name = optionalLabel(row.name);
  const symbol = optionalLabel(row.symbol);
  const image = optionalImage(row.image);
  if (name === undefined || symbol === undefined || image === undefined) return null;
  return { name, symbol, image };
}

function optionalLabel(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string" || value.length === 0 || value.length > 64) return undefined;
  return value;
}

function optionalImage(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > 500 || !/^https?:\/\//i.test(value)) return undefined;
  return value;
}
