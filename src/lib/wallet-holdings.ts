import { MAX_BASE_UNITS, SOL_DECIMALS, SOL_MINT } from "./chunk-plan.ts";
import { MAX_DESK_LAMPORTS, RING_FEE_RESERVE } from "./desk-request.ts";
import { decodeBase58 } from "./escrow-account.ts";
import { parseBaseAmount } from "./escrow-params.ts";

/** Solana `getMultipleAccounts` accepts at most this many addresses. */
export const RPC_ACCOUNT_BATCH = 100;
/** Matches the whole-digit limit in `parseBaseAmount`. */
export const AMOUNT_WHOLE_DIGITS = 20;
export const AMOUNT_TEXT_MAX = 40;
export const HOLDING_DECIMALS_MAX = 18;
export const DEFAULT_SOL_SHIELD_TEXT = "0.01";
export const DEFAULT_TOKEN_WHOLE_TEXT = "1";
export const NFT_SHIELD_TEXT = "1";
export const NFT_SHIELD_AMOUNT = BigInt(1);
const INITIALIZED_STATE = "initialized";
const U64_DIGIT_MAX = 20;

export type HeldAsset = {
  readonly kind: "sol" | "token" | "nft";
  readonly mint: string;
  readonly maxBase: string;
  readonly decimals: number;
  readonly tokenAccount: string | null;
  readonly tokenProgram: string | null;
};

export type MintClass = {
  readonly kind: "token" | "nft";
  readonly decimals: number;
  readonly tokenProgram: string;
};

export type TokenAccountSnapshot = {
  readonly address: string;
  readonly mint: string;
  readonly owner: string;
  readonly amount: bigint;
  readonly decimals: number;
  readonly tokenProgram: string;
  readonly state: string;
};

export function rpcLamports(value: unknown): bigint | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return null;
  return BigInt(value);
}

/** Spendable SOL for a shield: wallet lamports above the ring fee reserve, capped by the desk. */
export function solShieldMax(walletLamports: bigint): bigint {
  if (walletLamports <= BigInt(RING_FEE_RESERVE)) return BigInt(0);
  const spendable = walletLamports - BigInt(RING_FEE_RESERVE);
  return spendable < MAX_DESK_LAMPORTS ? spendable : MAX_DESK_LAMPORTS;
}

export function readTokenAccountList(tokenProgram: string, payload: unknown): TokenAccountSnapshot[] {
  if (decodeBase58(tokenProgram) === null) return [];
  if (typeof payload !== "object" || payload === null) return [];
  const value = (payload as { value?: unknown }).value;
  if (!Array.isArray(value)) return [];
  const rows: TokenAccountSnapshot[] = [];
  for (const entry of value) {
    const row = readTokenAccount(tokenProgram, entry);
    if (row !== null) rows.push(row);
  }
  return rows;
}

export function selectHeldAssets(input: {
  readonly wallet: string;
  readonly solLamports: bigint;
  readonly accounts: readonly TokenAccountSnapshot[];
  readonly mints: Readonly<Record<string, MintClass>>;
}): HeldAsset[] {
  const rows: HeldAsset[] = [];
  if (input.solLamports > BigInt(0)) {
    rows.push({
      kind: "sol",
      mint: SOL_MINT,
      maxBase: solShieldMax(input.solLamports).toString(),
      decimals: SOL_DECIMALS,
      tokenAccount: null,
      tokenProgram: null,
    });
  }
  const best = new Map<string, TokenAccountSnapshot>();
  for (const account of input.accounts) {
    if (account.owner !== input.wallet || account.state !== INITIALIZED_STATE || account.amount <= BigInt(0)) continue;
    const mint = input.mints[account.mint];
    if (mint === undefined || mint.tokenProgram !== account.tokenProgram || mint.decimals !== account.decimals) continue;
    const current = best.get(account.mint);
    if (current === undefined || account.amount > current.amount) best.set(account.mint, account);
  }
  for (const mintId of [...best.keys()].sort()) {
    const account = best.get(mintId);
    const mint = input.mints[mintId];
    if (account === undefined || mint === undefined) continue;
    if (mint.kind === "nft") {
      if (account.amount < NFT_SHIELD_AMOUNT) continue;
      rows.push({
        kind: "nft",
        mint: mintId,
        maxBase: NFT_SHIELD_AMOUNT.toString(),
        decimals: mint.decimals,
        tokenAccount: account.address,
        tokenProgram: account.tokenProgram,
      });
      continue;
    }
    rows.push({
      kind: "token",
      mint: mintId,
      maxBase: account.amount.toString(),
      decimals: mint.decimals,
      tokenAccount: account.address,
      tokenProgram: account.tokenProgram,
    });
  }
  return rows;
}

export function openingShieldText(asset: HeldAsset): string {
  if (asset.kind === "nft") return NFT_SHIELD_TEXT;
  const max = BigInt(asset.maxBase);
  if (max <= BigInt(0)) return formatBaseUnits(BigInt(0), asset.decimals);
  const proposal = asset.kind === "sol" ? DEFAULT_SOL_SHIELD_TEXT : DEFAULT_TOKEN_WHOLE_TEXT;
  const parsed = parseBaseAmount(proposal, asset.decimals);
  if (parsed === null || parsed > max) return formatBaseUnits(max, asset.decimals);
  return proposal;
}

/** Keeps a typed amount, or the formatted max when the typed amount is larger. `null` rejects the edit. */
export function clampShieldText(typed: string, asset: HeldAsset): string | null {
  if (asset.kind === "nft") return NFT_SHIELD_TEXT;
  if (!amountShape(typed, asset.decimals)) return null;
  if (typed === "" || typed === "." || typed.endsWith(".")) return typed;
  const parsed = parseBaseAmount(typed, asset.decimals);
  const max = BigInt(asset.maxBase);
  if (parsed === null) return /^0+(\.0*)?$/.test(typed) ? typed : null;
  if (parsed > max) return formatBaseUnits(max, asset.decimals);
  return typed;
}

export function shieldBaseAmount(text: string, asset: HeldAsset): bigint | null {
  if (asset.kind === "nft") {
    if (text !== NFT_SHIELD_TEXT || BigInt(asset.maxBase) < NFT_SHIELD_AMOUNT) return null;
    return NFT_SHIELD_AMOUNT;
  }
  const parsed = parseBaseAmount(text, asset.decimals);
  if (parsed === null || parsed > BigInt(asset.maxBase)) return null;
  return parsed;
}

export function readHeldAssetList(value: unknown): HeldAsset[] {
  if (!Array.isArray(value)) return [];
  const rows: HeldAsset[] = [];
  for (const entry of value) {
    const row = readHeldAsset(entry);
    if (row !== null) rows.push(row);
  }
  return rows;
}

export function formatBaseUnits(amount: bigint, decimals: number): string {
  if (decimals <= 0) return amount.toString();
  const scale = BigInt(10) ** BigInt(decimals);
  const whole = amount / scale;
  const fraction = (amount % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction.length === 0 ? whole.toString() : `${whole.toString()}.${fraction}`;
}

function readHeldAsset(value: unknown): HeldAsset | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  if (row.kind !== "sol" && row.kind !== "token" && row.kind !== "nft") return null;
  if (typeof row.mint !== "string" || decodeBase58(row.mint) === null) return null;
  if (typeof row.maxBase !== "string" || !/^\d+$/.test(row.maxBase)) return null;
  const max = BigInt(row.maxBase);
  if (max < BigInt(0) || max > MAX_BASE_UNITS) return null;
  if (typeof row.decimals !== "number" || !Number.isInteger(row.decimals) || row.decimals < 0 || row.decimals > HOLDING_DECIMALS_MAX) {
    return null;
  }
  if (row.kind === "sol") {
    if (row.mint !== SOL_MINT || row.decimals !== SOL_DECIMALS || row.tokenAccount !== null || row.tokenProgram !== null) return null;
    if (max > MAX_DESK_LAMPORTS) return null;
    return { kind: "sol", mint: row.mint, maxBase: row.maxBase, decimals: row.decimals, tokenAccount: null, tokenProgram: null };
  }
  if (typeof row.tokenAccount !== "string" || typeof row.tokenProgram !== "string") return null;
  if (decodeBase58(row.tokenAccount) === null || decodeBase58(row.tokenProgram) === null) return null;
  if (row.mint === SOL_MINT) return null;
  if (row.kind === "nft" && (row.maxBase !== NFT_SHIELD_AMOUNT.toString() || row.decimals !== 0)) return null;
  return {
    kind: row.kind,
    mint: row.mint,
    maxBase: row.maxBase,
    decimals: row.decimals,
    tokenAccount: row.tokenAccount,
    tokenProgram: row.tokenProgram,
  };
}

function readTokenAccount(tokenProgram: string, value: unknown): TokenAccountSnapshot | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.pubkey !== "string" || decodeBase58(row.pubkey) === null) return null;
  if (typeof row.account !== "object" || row.account === null) return null;
  const account = row.account as Record<string, unknown>;
  if (account.owner !== tokenProgram) return null;
  const info = parsedInfo(account.data);
  if (info === null) return null;
  if (typeof info.mint !== "string" || typeof info.owner !== "string") return null;
  if (decodeBase58(info.mint) === null || decodeBase58(info.owner) === null) return null;
  if (info.state !== INITIALIZED_STATE && info.state !== "frozen") return null;
  const tokenAmount = info.tokenAmount;
  if (typeof tokenAmount !== "object" || tokenAmount === null) return null;
  const amountRow = tokenAmount as Record<string, unknown>;
  const amount = parseU64(amountRow.amount);
  if (amount === null) return null;
  if (typeof amountRow.decimals !== "number" || !Number.isInteger(amountRow.decimals)) return null;
  if (amountRow.decimals < 0 || amountRow.decimals > HOLDING_DECIMALS_MAX) return null;
  return {
    address: row.pubkey,
    mint: info.mint,
    owner: info.owner,
    amount,
    decimals: amountRow.decimals,
    tokenProgram,
    state: info.state,
  };
}

function parsedInfo(data: unknown): { mint?: unknown; owner?: unknown; state?: unknown; tokenAmount?: unknown } | null {
  if (typeof data !== "object" || data === null) return null;
  const parsed = (data as { parsed?: unknown }).parsed;
  if (typeof parsed !== "object" || parsed === null) return null;
  const info = (parsed as { info?: unknown }).info;
  if (typeof info !== "object" || info === null) return null;
  return info as { mint?: unknown; owner?: unknown; state?: unknown; tokenAmount?: unknown };
}

function parseU64(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^\d{1,20}$/.test(value) || value.length > U64_DIGIT_MAX) return null;
  const amount = BigInt(value);
  if (amount < BigInt(0) || amount > MAX_BASE_UNITS) return null;
  return amount;
}

function amountShape(typed: string, decimals: number): boolean {
  if (typed.length > AMOUNT_TEXT_MAX || !/^\d*\.?\d*$/.test(typed)) return false;
  const parts = typed.split(".");
  if (parts.length > 2) return false;
  const whole = parts[0] ?? "";
  const fraction = parts[1] ?? "";
  if (whole.length > AMOUNT_WHOLE_DIGITS) return false;
  return fraction.length <= decimals;
}
