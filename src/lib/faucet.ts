import { decodeBase58 } from "./escrow-account.ts";

export type FaucetAsset = "sol" | "usdc";

export type FaucetRequest = {
  readonly recipient: string;
  readonly asset: FaucetAsset;
};

export type FaucetEnv = {
  readonly NODE_ENV?: string;
  readonly FAUCET_ENABLED?: string;
  readonly FAUCET_KEYPAIR_PATH?: string;
};

export type ReserveResult = { readonly ok: true; readonly keys: readonly string[] } | { readonly ok: false; readonly retryAfterMs: number };

const LAMPORTS_PER_SOL = BigInt(1_000_000_000);
const HALF = BigInt(2);
const MS_PER_MINUTE = 60_000;
const COOLDOWN_MINUTES = 10;
const USDC_WHOLE_TOKENS = 1000;
const SECRET_KEY_LENGTH = 64;
const BYTE_MAX = 255;
const DEV_KEYPAIR_FILE = ".config/solana/8BD6L3iE4VfXT4m8wKNrDBPBFJ6ycAX9Y75YaiNXVhBZ(admin).json";

export const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
export const FAUCET_USDC_MINT = "EjNepo4NzDGSud16ExFf6Vum4xU1UZ76Bt98HyGY1DHG";
export const FAUCET_USDC_DECIMALS = 6;
export const FAUCET_SOL_LAMPORTS = LAMPORTS_PER_SOL / HALF;
export const FAUCET_USDC_BASE_UNITS = BigInt(USDC_WHOLE_TOKENS) * BigInt(10) ** BigInt(FAUCET_USDC_DECIMALS);
export const FAUCET_FEE_RESERVE_LAMPORTS = LAMPORTS_PER_SOL / BigInt(100);
export const FAUCET_COOLDOWN_MS = COOLDOWN_MINUTES * MS_PER_MINUTE;
export const FAUCET_MAX_BODY_BYTES = 1_024;
export const FAUCET_MAX_TRACKED_KEYS = 10_000;
export const FAUCET_LABEL: Readonly<Record<FaucetAsset, string>> = {
  sol: "0.5 SOL",
  usdc: `${USDC_WHOLE_TOKENS} USDC`,
};

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

export function faucetKeypairPath(env: FaucetEnv, homeDir: string): string | null {
  const configured = env.FAUCET_KEYPAIR_PATH?.trim();
  if (configured !== undefined && configured.length > 0) return configured;
  if (env.NODE_ENV === "production") return null;
  return `${homeDir}/${DEV_KEYPAIR_FILE}`;
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
