import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function rpcUrl(): string {
  const fromEnv = process.env.HELIUS_API_KEY;
  let key = fromEnv;
  if (key === undefined || key.length === 0) {
    const text = readFileSync(join(homedir(), ".config/solana/cli/config.yml"), "utf8");
    key = text.match(/api-key=([0-9a-f-]+)/i)?.[1];
  }
  if (key === undefined || key.length === 0) throw new Error("Helius key is not in the Solana CLI config");
  return `https://devnet.helius-rpc.com/?api-key=${key}`;
}

export async function helius<T>(method: string, params: unknown[]): Promise<T> {
  let response: Response;
  try {
    response = await fetch(rpcUrl(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      cache: "no-store",
    });
  } catch {
    throw new Error("devnet RPC could not be reached");
  }
  if (!response.ok) throw new Error("devnet RPC rejected the request");
  const body = (await response.json()) as { result?: T; error?: { message?: string } };
  if (body.error) throw new Error(body.error.message ?? "devnet RPC returned an error");
  if (body.result === undefined) throw new Error("devnet RPC returned no result");
  return body.result;
}
