import { SOL_DECIMALS, SOL_MINT } from "../../lib/chunk-plan.ts";
import { metadataLabel, type TokenMetadata } from "../../lib/token-metadata.ts";

export function short(value: string): string {
  return value.length <= 12 ? value : `${value.slice(0, 4)}…${value.slice(-4)}`;
}

export function formatBase(amount: string, decimals: number): string {
  const value = BigInt(amount);
  if (decimals <= 0) return value.toString();
  const scale = BigInt(10) ** BigInt(decimals);
  const whole = value / scale;
  const fraction = (value % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction.length === 0 ? whole.toString() : `${whole}.${fraction}`;
}

export function formatAsset(
  amount: string,
  mint: string,
  decimals: number | undefined,
  metadata?: TokenMetadata | null,
): string {
  if (mint === SOL_MINT) return `${formatBase(amount, SOL_DECIMALS)} SOL`;
  const shown = decimals === undefined ? `${amount} base units` : formatBase(amount, decimals);
  const label = metadataLabel(metadata);
  return label === null ? `${shown} · ${short(mint)}` : `${shown} ${label}`;
}

export function toLocalInput(unixSec: number): string {
  const date = new Date(unixSec * 1000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function fromLocalInput(value: string): number | null {
  if (value.length === 0) return null;
  const ms = new Date(value).getTime();
  if (Number.isNaN(ms)) return null;
  return Math.floor(ms / 1000);
}
