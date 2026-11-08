import { createHmac } from "node:crypto";

export const MAX_EMAIL_LENGTH = 254;
export const MAX_ATTEMPTS_PER_WINDOW = 5;
export const MAX_ADDRESS_LENGTH = 64;
export const MIN_IP_SALT_LENGTH = 32;

const EMAIL_PATTERN =
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

const ADDRESS_PATTERN = /^[0-9a-f:.]+$/i;

export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  if (email.length < 3 || email.length > MAX_EMAIL_LENGTH) return null;
  if (email.includes("..")) return null;
  if (!EMAIL_PATTERN.test(email)) return null;
  return email;
}

export function isHoneypotTripped(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

export function isRateLimited(recentAttempts: number): boolean {
  return recentAttempts >= MAX_ATTEMPTS_PER_WINDOW;
}

export function clientAddressFromHeaders(
  forwardedFor: string | null,
  realIp: string | null,
): string {
  const forwarded = forwardedFor?.split(",")[0]?.trim() ?? "";
  if (isPlausibleAddress(forwarded)) return forwarded;
  const real = realIp?.trim() ?? "";
  if (isPlausibleAddress(real)) return real;
  return "unknown";
}

export function hashClientAddress(address: string, salt: string): string {
  return createHmac("sha256", salt).update(address).digest("hex");
}

export function isSameOriginSubmission(input: {
  origin: string | null;
  host: string | null;
  secFetchSite: string | null;
}): boolean {
  if (input.secFetchSite === "cross-site") return false;
  if (!input.origin || !input.host) return false;
  try {
    return new URL(input.origin).host === input.host;
  } catch {
    return false;
  }
}

function isPlausibleAddress(value: string): boolean {
  if (value.length < 3 || value.length > MAX_ADDRESS_LENGTH) return false;
  return ADDRESS_PATTERN.test(value);
}
