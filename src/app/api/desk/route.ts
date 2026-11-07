import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseDeskRequest, type DeskRequest } from "@/lib/desk-request";
import { decodeBase58, decodeEscrow } from "@/lib/escrow-account";
import { readTerms, writeTerms } from "@/lib/escrow-terms";
import { helius } from "@/lib/helius-rpc";

export const maxDuration = 300;

const SDK_DIR = join(process.cwd(), "pescrow/sdk");
const PROGRAM_ID = "7c3yarLtR2eUebLqYcms7GViXZ5SpQVWmmiqJTp3QtYG";
const STATUS_MS = 90_000;
const CHAIN_MS = 180_000;

function deskEnabled(): boolean {
  return process.env.NODE_ENV !== "production" || process.env.DESK_ENABLED === "1";
}

function scrub(text: string): string {
  return text.replace(/api-key=[^&\s"]+/g, "api-key=REDACTED");
}

function escrowAddress(): string | null {
  try {
    const saved = JSON.parse(readFileSync(join(homedir(), ".config/zolana/desk-escrow.json"), "utf8")) as {
      address?: string;
    };
    return typeof saved.address === "string" ? saved.address : null;
  } catch {
    return null;
  }
}

function runNode(args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", args, { cwd: SDK_DIR, env, timeout: timeoutMs });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

async function runDesk(request: DeskRequest): Promise<Response> {
  if (request.action === "lock" || request.action === "swap") {
    const address = escrowAddress();
    if (address === null) {
      return Response.json({ ok: false, error: "Open an escrow before locking a note." }, { status: 400, headers: { "cache-control": "no-store" } });
    }
    const env: NodeJS.ProcessEnv = { ...process.env, ESCROW_ID: address };
    const script = request.action === "swap" ? "src/swap-and-close.ts" : "src/lock-into-escrow.ts";
    if (request.action === "lock") {
      const note = request.note ?? "";
      env.LOCK_SIDE = request.side;
      env.NOTE_A = note;
      env.NOTE_B = note;
    }
    const run = await runNode(["--import", "./src/wasm-node-preload.mjs", script], env, CHAIN_MS);
    const lines = run.stdout.split("\n").map((line) => line.trim()).filter((line) => line.includes("signature="));
    const shown = scrub(lines.length > 0 ? lines.join("\n") : run.stderr || run.stdout).trim();
    if (run.code !== 0) {
      return Response.json({ ok: false, error: shown.slice(-1200) }, { status: 502, headers: { "cache-control": "no-store" } });
    }
    return Response.json({ ok: true, result: { log: shown.slice(-1200) } }, { headers: { "cache-control": "no-store" } });
  }

  const args = ["src/desk.ts", request.action];
  if (request.action === "shield" || request.action === "withdraw") {
    args.push(request.side, request.lamports?.toString() ?? "");
  }
  const run = await runNode(args, process.env, request.action === "status" ? STATUS_MS : CHAIN_MS);
  const line = run.stdout.trim().split("\n").findLast((entry) => entry.startsWith("{"));
  if (line === undefined) {
    return Response.json(
      { ok: false, error: scrub(run.stderr || "The desk command returned no result.") },
      { status: 502, headers: { "cache-control": "no-store" } },
    );
  }
  const parsed: unknown = JSON.parse(line);
  const failed = run.code !== 0 || (typeof parsed === "object" && parsed !== null && "ok" in parsed && parsed.ok === false);
  return Response.json(parsed, { status: failed ? 502 : 200, headers: { "cache-control": "no-store" } });
}

type ProgramAccount = { pubkey: string; account: { data: [string, string] } };

async function listEscrows(wallet: string): Promise<unknown> {
  const walletBytes = decodeBase58(wallet);
  if (walletBytes === null) throw new Error("wallet address is not a public key");
  const calls = [24, 56].map((offset) =>
    helius<ProgramAccount[]>("getProgramAccounts", [
      PROGRAM_ID,
      {
        encoding: "base64",
        commitment: "confirmed",
        filters: [
          { dataSize: 160 },
          { memcmp: { offset, bytes: wallet } },
        ],
      },
    ]),
  );
  const batches = await Promise.all(calls);
  const seen = new Set<string>();
  const escrows = [];
  for (const batch of batches) {
    for (const row of batch) {
      if (seen.has(row.pubkey)) continue;
      seen.add(row.pubkey);
      const view = decodeEscrow(row.pubkey, Buffer.from(row.account.data[0], "base64"), walletBytes);
      if (view !== null) escrows.push(view);
    }
  }
  const saved = readTerms();
  const terms: Record<string, { lockLamports: string; receiveLamports: string }> = {};
  for (const row of escrows) {
    const found = saved[row.address];
    if (found !== undefined) terms[row.address] = found;
  }
  return { escrows, terms };
}

async function submitTransaction(tx: string): Promise<unknown> {
  const signature = await helius<string>("sendTransaction", [
    tx,
    { encoding: "base64", preflightCommitment: "confirmed" },
  ]);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const status = await helius<{ value: ({ err: unknown; confirmationStatus?: string } | null)[] }>("getSignatureStatuses", [
      [signature],
      { searchTransactionHistory: true },
    ]);
    const row = status.value[0];
    if (row?.err) throw new Error(`transaction ${signature} failed`);
    if (row?.confirmationStatus === "confirmed" || row?.confirmationStatus === "finalized") return { signature };
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`transaction ${signature} was not confirmed`);
}

function ringPayload(request: DeskRequest): { cmd: string; seedHex: string; [key: string]: string } | null {
  if (request.action === "wallet-notes") return { cmd: "notes", seedHex: request.seed };
  if (request.action === "wallet-shield") return { cmd: "shield", seedHex: request.seed, lamports: request.lamports.toString() };
  if (request.action === "wallet-return" && request.wallet !== undefined) {
    return { cmd: "return", seedHex: request.seed, wallet: request.wallet };
  }
  if (request.action === "wallet-lock") {
    return {
      cmd: "lock",
      seedHex: request.seed,
      wallet: request.wallet,
      escrow: request.escrow,
      note: request.note,
      lamports: request.lamports.toString(),
    };
  }
  if (request.action === "wallet-swap") {
    return { cmd: "swap", seedHex: request.seed, escrow: request.escrow, toAHex: request.toA, toBHex: request.toB };
  }
  return null;
}

async function runWallet(request: DeskRequest): Promise<Response> {
  const headers = { "cache-control": "no-store" };
  if (request.action === "wallet-escrows") {
    return Response.json({ ok: true, result: await listEscrows(request.wallet) }, { headers });
  }
  if (request.action === "wallet-terms") {
    writeTerms(request.escrow, {
      lockLamports: request.lockLamports.toString(),
      receiveLamports: request.receiveLamports.toString(),
    });
    return Response.json({ ok: true, result: { escrow: request.escrow } }, { headers });
  }
  if (request.action === "wallet-submit") return Response.json({ ok: true, result: await submitTransaction(request.tx) }, { headers });
  const payload = ringPayload(request);
  if (payload === null) return Response.json({ ok: false, error: "The wallet request is incomplete." }, { status: 400, headers });
  const run = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn("node", ["--import", "./src/wasm-node-preload.mjs", "src/wallet-desk.ts"], {
      cwd: SDK_DIR,
      env: process.env,
      timeout: request.action === "wallet-notes" ? STATUS_MS : CHAIN_MS,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(JSON.stringify(payload));
  });
  const line = run.stdout.trim().split("\n").findLast((entry) => entry.startsWith("{"));
  if (line === undefined) {
    return Response.json({ ok: false, error: scrub(run.stderr || "The wallet command returned no result.").slice(-1200) }, { status: 502, headers });
  }
  const parsed: unknown = JSON.parse(line);
  const failed = run.code !== 0 || (typeof parsed === "object" && parsed !== null && "ok" in parsed && parsed.ok === false);
  return Response.json(parsed, { status: failed ? 502 : 200, headers });
}

export async function POST(request: Request) {
  if (!deskEnabled()) return new Response(null, { status: 404 });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: "The request could not be read." }, { status: 400 });
  }
  const parsed = parseDeskRequest(body);
  if (parsed === null) {
    return Response.json({ ok: false, error: "Choose a side and an amount up to 1 SOL." }, { status: 400 });
  }
  try {
    if (parsed.action.startsWith("wallet-")) return await runWallet(parsed);
    return await runDesk(parsed);
  } catch (error) {
    return Response.json({ ok: false, error: scrub(String(error)) }, { status: 500, headers: { "cache-control": "no-store" } });
  }
}
