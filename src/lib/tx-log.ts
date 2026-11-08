import { splitChainText } from "./explorer-link.ts";
import { stripProverStderr } from "./prover-stderr.ts";

const TX_LOGGED = Symbol.for("privacy.txLogged");

export function markTxLogged(error: unknown): void {
  if (typeof error === "object" && error !== null) {
    Object.defineProperty(error, TX_LOGGED, { value: true, enumerable: false });
  }
}

export function wasTxLogged(error: unknown): boolean {
  return typeof error === "object" && error !== null && TX_LOGGED in error;
}

export const TX_LOG_LIMIT = 50;
export const TOAST_LINGER_MS = 6000;
const ERROR_TEXT_MAX = 240;

export type TxStatus = "signing" | "confirming" | "confirmed" | "failed";
export type TxOrigin = "wallet" | "desk";
export type TxCopy = { readonly step: string; readonly explanation: string };

export type TxEntry = {
  readonly id: number;
  readonly step: string;
  readonly explanation: string;
  readonly status: TxStatus;
  readonly signature: string | null;
  readonly error: string | null;
  readonly startedAt: number;
  readonly settledAt: number | null;
};

export type TxEvent =
  | { readonly kind: "start"; readonly id: number; readonly copy: TxCopy; readonly origin: TxOrigin; readonly at: number }
  | { readonly kind: "signed"; readonly id: number }
  | { readonly kind: "confirmed"; readonly id: number; readonly signature: string | null; readonly at: number }
  | { readonly kind: "failed"; readonly id: number; readonly error: string; readonly at: number }
  | { readonly kind: "clear-settled" };

export function reduceTxLog(log: readonly TxEntry[], event: TxEvent): readonly TxEntry[] {
  if (event.kind === "clear-settled") return log.filter((entry) => isPending(entry.status));
  if (event.kind === "start") {
    const entry: TxEntry = {
      id: event.id,
      step: event.copy.step,
      explanation: event.copy.explanation,
      status: event.origin === "wallet" ? "signing" : "confirming",
      signature: null,
      error: null,
      startedAt: event.at,
      settledAt: null,
    };
    return [entry, ...log].slice(0, TX_LOG_LIMIT);
  }
  return log.map((entry) => {
    if (entry.id !== event.id || !isPending(entry.status)) return entry;
    if (event.kind === "signed") return entry.status === "signing" ? { ...entry, status: "confirming" } : entry;
    if (event.kind === "confirmed") return { ...entry, status: "confirmed", signature: event.signature, settledAt: event.at };
    return { ...entry, status: "failed", error: event.error, signature: signatureIn(event.error), settledAt: event.at };
  });
}

export function isPending(status: TxStatus): boolean {
  return status === "signing" || status === "confirming";
}

export function pendingCount(log: readonly TxEntry[]): number {
  return log.filter((entry) => isPending(entry.status)).length;
}

export function toastEntry(log: readonly TxEntry[], now: number, dismissedId: number | null): TxEntry | null {
  const pending = log.find((entry) => isPending(entry.status));
  if (pending !== undefined) return pending;
  const latest = log[0];
  if (latest === undefined || latest.id === dismissedId) return null;
  if (latest.status === "failed") return latest;
  return latest.settledAt !== null && now - latest.settledAt < TOAST_LINGER_MS ? latest : null;
}

export function signatureOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const spans = splitChainText(value);
  return spans.length === 1 && spans[0]?.kind === "tx" ? value : null;
}

export function withoutSignatures(text: string): string {
  return splitChainText(text)
    .filter((span) => span.kind !== "tx")
    .map((span) => span.text)
    .join("")
    .replace(/\s+([.,])/g, "$1")
    .replace(/\.{2,}/g, ".")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function errorText(error: unknown, fallback: string): string {
  const raw = error instanceof Error && error.message.length > 0 ? error.message : fallback;
  const stripped = stripProverStderr(raw).trim();
  const message = stripped.length > 0 ? stripped : fallback;
  return message.length > ERROR_TEXT_MAX ? `${message.slice(0, ERROR_TEXT_MAX)}…` : message;
}

export function afterSigning<A, R>(sign: (value: A) => Promise<R>, signed: () => void): (value: A) => Promise<R> {
  return async (value) => {
    const result = await sign(value);
    signed();
    return result;
  };
}

function signatureIn(text: string): string | null {
  return splitChainText(text).find((span) => span.kind === "tx")?.text ?? null;
}
