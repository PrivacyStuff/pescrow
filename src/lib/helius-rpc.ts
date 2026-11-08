import { RPC_RATE_LIMIT_MESSAGE } from "./desk-request.ts";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HELIUS_RPC_URL_ENV = "HELIUS_RPC_URL";
const HELIUS_API_KEY_ENV = "HELIUS_API_KEY";
const HELIUS_DEVNET_RPC_ORIGIN = "https://devnet.helius-rpc.com/";
const HELIUS_API_KEY_QUERY = "api-key";
const MISSING_HELIUS_KEY = "Helius key is not in the Solana CLI config";
const INVALID_HELIUS_RPC_URL = "Helius RPC URL is not configured";

export function heliusRpcUrl(): string {
  const configured = httpsRpcUrl(serverEnv(HELIUS_RPC_URL_ENV));
  if (configured !== null) return configured;

  let key = serverEnv(HELIUS_API_KEY_ENV);
  if (key === undefined || key.length === 0) {
    const text = readFileSync(join(homedir(), ".config/solana/cli/config.yml"), "utf8");
    key = text.match(new RegExp(`${HELIUS_API_KEY_QUERY}=([0-9a-f-]+)`, "i"))?.[1];
  }
  if (key === undefined || key.length === 0) throw new Error(MISSING_HELIUS_KEY);
  return `${HELIUS_DEVNET_RPC_ORIGIN}?${HELIUS_API_KEY_QUERY}=${key}`;
}

function serverEnv(name: string): string | undefined {
  return process.env[name];
}

function httpsRpcUrl(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(INVALID_HELIUS_RPC_URL);
  }
  if (url.protocol !== "https:" || url.hostname.length === 0 || url.username.length > 0 || url.password.length > 0) {
    throw new Error(INVALID_HELIUS_RPC_URL);
  }
  return trimmed;
}

export async function helius<T>(method: string, params: unknown[] | Record<string, unknown>): Promise<T> {
  const url = heliusRpcUrl();
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      cache: "no-store",
    });
  } catch {
    throw new Error("devnet RPC could not be reached");
  }
  if (response.status === 429) throw new Error(RPC_RATE_LIMIT_MESSAGE);
  if (!response.ok) throw new Error("devnet RPC rejected the request");
  const body = (await response.json()) as { result?: T; error?: { code?: number; message?: string } };
  if (body.error?.code === 429) throw new Error(RPC_RATE_LIMIT_MESSAGE);
  if (body.error) throw new Error(body.error.message ?? "devnet RPC returned an error");
  if (body.result === undefined) throw new Error("devnet RPC returned no result");
  return body.result;
}
