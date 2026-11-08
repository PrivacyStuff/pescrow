import { decodeBase58, decodeBase58Bytes } from "./escrow-account.ts";

export type FaucetAsset = "sol" | "usdc";

export type FaucetRequest = {
  readonly recipient: string;
  readonly asset: FaucetAsset;
};

export type FaucetEnv = {
  readonly NODE_ENV?: string;
  readonly FAUCET_ENABLED?: string;
  readonly FAUCET_SECRET_KEY?: string;
  readonly FAUCET_KEYPAIR_PATH?: string;
};

export type FaucetKeySource = { readonly kind: "inline"; readonly text: string } | { readonly kind: "file"; readonly path: string };

export type ReserveResult = { readonly ok: true; readonly keys: readonly string[] } | { readonly ok: false; readonly retryAfterMs: number };

const LAMPORTS_PER_SOL = BigInt(1_000_000_000);
const HALF = BigInt(2);
const MS_PER_MINUTE = 60_000;
const COOLDOWN_MINUTES = 10;
const USDC_WHOLE_TOKENS = 1000;
const SECRET_KEY_LENGTH = 64;
const BYTE_MAX = 255;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

export const FAUCET_PUBLIC_KEY = "en4DfpEXZgNs6o8qhUWsJMTWTrfUCEMyJ5bHZmkbxqt";

export const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
export const FAUCET_USDC_MINT = "EjNepo4NzDGSud16ExFf6Vum4xU1UZ76Bt98HyGY1DHG";
export const FAUCET_USDC_DECIMALS = 6;
export const FAUCET_SOL_LAMPORTS = LAMPORTS_PER_SOL / HALF;
export const FAUCET_USDC_BASE_UNITS = BigInt(USDC_WHOLE_TOKENS) * BigInt(10) ** BigInt(FAUCET_USDC_DECIMALS);
export const FAUCET_FEE_RESERVE_LAMPORTS = LAMPORTS_PER_SOL / BigInt(100);
export const FAUCET_COOLDOWN_MS = COOLDOWN_MINUTES * MS_PER_MINUTE;
export const FAUCET_COOLDOWN_MINUTES = COOLDOWN_MINUTES;
export const FAUCET_MAX_BODY_BYTES = 1_024;
export const FAUCET_MAX_TRACKED_KEYS = 10_000;
export const FAUCET_UNREACHABLE_MESSAGE = "The faucet could not be reached. Try again.";
export const FAUCET_LABEL: Readonly<Record<FaucetAsset, string>> = {
  sol: "0.5 SOL",
  usdc: `${USDC_WHOLE_TOKENS} USDC`,
};

const HTTP_SUCCESS_MIN = 200;
const HTTP_SUCCESS_MAX = 299;

export type FaucetDrop = {
  readonly signature: string;
  readonly amount: string;
};

export type FaucetOutcome =
  | { readonly ok: true; readonly drop: FaucetDrop }
  | { readonly ok: false; readonly error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFaucetAmount(value: unknown): value is string {
  return value === FAUCET_LABEL.sol || value === FAUCET_LABEL.usdc;
}

export function faucetOutcome(status: number, body: unknown): FaucetOutcome {
  if (isRecord(body) && body.ok === false && typeof body.error === "string" && body.error.trim().length > 0) {
    return { ok: false, error: body.error.trim() };
  }
  const success = status >= HTTP_SUCCESS_MIN && status <= HTTP_SUCCESS_MAX;
  if (!success || !isRecord(body) || body.ok !== true || !isRecord(body.result)) {
    return { ok: false, error: FAUCET_UNREACHABLE_MESSAGE };
  }
  const { signature, amount } = body.result;
  if (typeof signature !== "string" || signature.trim().length === 0 || !isFaucetAmount(amount)) {
    return { ok: false, error: FAUCET_UNREACHABLE_MESSAGE };
  }
  return { ok: true, drop: { signature: signature.trim(), amount } };
}

export function faucetEnabled(env: FaucetEnv): boolean {
  return env.NODE_ENV !== "production" || env.FAUCET_ENABLED === "1";
}

export function isDevnetGenesis(hash: unknown): boolean {
  return hash === DEVNET_GENESIS_HASH;
}

export function parseFaucetRequest(body: unknown): FaucetRequest | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "recipient" && key !== "asset")) return null;
  const { recipient, asset } = record;
  if (asset !== "sol" && asset !== "usdc") return null;
  if (typeof recipient !== "string") return null;
  const trimmed = recipient.trim();
  if (decodeBase58(trimmed) === null) return null;
  return { recipient: trimmed, asset };
}

export function faucetKeySource(env: FaucetEnv): FaucetKeySource | null {
  const inline = env.FAUCET_SECRET_KEY?.trim();
  if (inline !== undefined && inline.length > 0) return { kind: "inline", text: inline };
  const path = env.FAUCET_KEYPAIR_PATH?.trim();
  if (path !== undefined && path.length > 0) return { kind: "file", path };
  return null;
}

export function faucetCanSend(asset: FaucetAsset, lamports: bigint, usdcBaseUnits: bigint): boolean {
  if (asset === "sol") return lamports >= FAUCET_SOL_LAMPORTS + FAUCET_FEE_RESERVE_LAMPORTS;
  return lamports >= FAUCET_FEE_RESERVE_LAMPORTS && usdcBaseUnits >= FAUCET_USDC_BASE_UNITS;
}

export function parseSecretKey(text: string): Uint8Array | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== SECRET_KEY_LENGTH) return null;
  if (!parsed.every((value) => Number.isInteger(value) && value >= 0 && value <= BYTE_MAX)) return null;
  return Uint8Array.from(parsed as number[]);
}

/** Base58 and base64 can both match one string, so the caller keeps the candidate whose keypair is the pinned faucet. */
export function secretKeyCandidates(text: string): readonly Uint8Array[] {
  const trimmed = text.trim().replace(/^["']|["']$/g, "");
  const json = parseSecretKey(trimmed);
  if (json !== null) return [json];
  return [decodeBase58Bytes(trimmed), decodeBase64(trimmed)].filter(
    (bytes): bytes is Uint8Array => bytes !== null && bytes.length === SECRET_KEY_LENGTH,
  );
}

function decodeBase64(text: string): Uint8Array | null {
  if (!BASE64_PATTERN.test(text)) return null;
  try {
    return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

export function cooldownRemaining(lastAt: number | undefined, now: number, cooldownMs: number = FAUCET_COOLDOWN_MS): number {
  if (lastAt === undefined) return 0;
  return Math.max(0, lastAt + cooldownMs - now);
}

export function rateLimitMessage(asset: FaucetAsset, retryAfterMs: number): string {
  const minutes = Math.max(1, Math.ceil(retryAfterMs / MS_PER_MINUTE));
  return `This wallet or network already got ${FAUCET_LABEL[asset]}. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`;
}

export class FaucetLimiter {
  private readonly last = new Map<string, number>();
  private readonly cooldownMs: number;
  private readonly maxKeys: number;

  constructor(cooldownMs: number = FAUCET_COOLDOWN_MS, maxKeys: number = FAUCET_MAX_TRACKED_KEYS) {
    this.cooldownMs = cooldownMs;
    this.maxKeys = maxKeys;
  }

  reserve(asset: FaucetAsset, recipient: string, ip: string, now: number): ReserveResult {
    const keys = [`wallet:${asset}:${recipient}`, `ip:${asset}:${ip}`];
    const retryAfterMs = Math.max(...keys.map((key) => cooldownRemaining(this.last.get(key), now, this.cooldownMs)));
    if (retryAfterMs > 0) return { ok: false, retryAfterMs };
    this.prune(now);
    if (this.last.size + keys.length > this.maxKeys) return { ok: false, retryAfterMs: this.cooldownMs };
    for (const key of keys) this.last.set(key, now);
    return { ok: true, keys };
  }

  release(keys: readonly string[]): void {
    for (const key of keys) this.last.delete(key);
  }

  private prune(now: number): void {
    for (const [key, at] of this.last) {
      if (cooldownRemaining(at, now, this.cooldownMs) === 0) this.last.delete(key);
    }
  }
}
