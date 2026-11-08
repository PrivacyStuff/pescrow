import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PublicKey } from "@solana/web3.js";
import { SOL_MINT } from "@/lib/chunk-plan";
import { parseDeskRequest, rpcRateLimitMessage, type DeskRequest } from "@/lib/desk-request";
import { decodeBase58, decodeEscrow } from "@/lib/escrow-account";
import { ESCROW_PROGRAM_ID } from "@/lib/escrow-program";
import { readTerms, writeTerms, type SwapTerms } from "@/lib/escrow-terms";
import { helius } from "@/lib/helius-rpc";
import { decodeMint, kindAgrees, solAssetInfo, SPL_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, type AssetInfo } from "@/lib/mint-account";
import {
  readTokenAccountList,
  rpcLamports,
  RPC_ACCOUNT_BATCH,
  selectHeldAssets,
  type MintClass,
} from "@/lib/wallet-holdings";
import {
  METAPLEX_METADATA_PROGRAM_ID,
  emptyTokenMetadata,
  parseDasAsset,
  parseMetaplexMetadata,
  parseToken2022Metadata,
  preferMetadata,
  type TokenMetadata,
} from "@/lib/token-metadata";

export const maxDuration = 300;

const SDK_DIR = join(process.cwd(), "pescrow/sdk");
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
    const child = spawn(process.execPath, args, { cwd: SDK_DIR, env, timeout: timeoutMs });
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
type MintAccount = { value: { owner: string; data: [string, string] } | null };

async function readAsset(mint: string): Promise<AssetInfo> {
  if (mint === SOL_MINT) return solAssetInfo();
  const account = await helius<MintAccount>("getAccountInfo", [mint, { encoding: "base64", commitment: "confirmed" }]);
  if (account.value === null) throw new Error("mint account is missing");
  const decoded = decodeMint(account.value.owner, Buffer.from(account.value.data[0], "base64"));
  if (decoded === null) throw new Error("that address is not a token mint");
  return decoded;
}

async function readMetadata(mint: string): Promise<TokenMetadata> {
  if (mint === SOL_MINT) return { name: null, symbol: "SOL", image: null };
  let fromDas: TokenMetadata | null = null;
  try {
    fromDas = parseDasAsset(await helius<unknown>("getAsset", { id: mint }));
  } catch {
    fromDas = null;
  }
  if (fromDas?.name != null && fromDas.symbol != null && fromDas.image != null) return fromDas;
  try {
    const mintAccount = await helius<MintAccount>("getAccountInfo", [mint, { encoding: "base64", commitment: "confirmed" }]);
    const mintData = mintAccount.value === null ? null : Buffer.from(mintAccount.value.data[0], "base64");
    const fromMint = mintData === null ? null : parseToken2022Metadata(mintData);
    const [metadataAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from("metadata"), new PublicKey(METAPLEX_METADATA_PROGRAM_ID).toBuffer(), new PublicKey(mint).toBuffer()],
      new PublicKey(METAPLEX_METADATA_PROGRAM_ID),
    );
    const account = await helius<MintAccount>("getAccountInfo", [
      metadataAccount.toBase58(),
      { encoding: "base64", commitment: "confirmed" },
    ]);
    const metaAccount = account.value;
    const fromMetaplex =
      metaAccount !== null && metaAccount.owner === METAPLEX_METADATA_PROGRAM_ID
        ? parseMetaplexMetadata(Buffer.from(metaAccount.data[0], "base64"))
        : null;
    return preferMetadata(preferMetadata(fromDas, fromMint), fromMetaplex);
  } catch {
    return fromDas ?? emptyTokenMetadata();
  }
}

async function listEscrows(wallet: string): Promise<unknown> {
  const walletBytes = decodeBase58(wallet);
  if (walletBytes === null) throw new Error("wallet address is not a public key");
  const calls = [24, 56].map((offset) =>
    helius<ProgramAccount[]>("getProgramAccounts", [
      ESCROW_PROGRAM_ID,
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
  const terms: Record<string, SwapTerms> = {};
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
  if (request.action === "wallet-shield") {
    const payload: { cmd: string; seedHex: string; [key: string]: string } = {
      cmd: "shield",
      seedHex: request.seed,
      lamports: request.lamports.toString(),
    };
    if (request.mint !== undefined && request.tokenAccount !== undefined && request.tokenProgram !== undefined) {
      payload.mint = request.mint;
      payload.tokenAccount = request.tokenAccount;
      payload.tokenProgram = request.tokenProgram;
    }
    return payload;
  }
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
  if (request.action === "wallet-carve") {
    return {
      cmd: "carve",
      seedHex: request.seed,
      note: request.note,
      lamports: request.lamports.toString(),
    };
  }
  if (request.action === "wallet-swap") {
    return { cmd: "swap", seedHex: request.seed, escrow: request.escrow, toAHex: request.toA, toBHex: request.toB };
  }
  if (request.action === "wallet-withdraw") {
    const payload: { cmd: string; seedHex: string; [key: string]: string } = {
      cmd: "withdraw",
      seedHex: request.seed,
      wallet: request.wallet,
      mint: request.mint,
      lamports: request.lamports.toString(),
    };
    if (request.tokenProgram !== undefined) payload.tokenProgram = request.tokenProgram;
    return payload;
  }
  return null;
}

async function runWallet(request: DeskRequest): Promise<Response> {
  const headers = { "cache-control": "no-store" };
  if (request.action === "wallet-escrows") {
    return Response.json({ ok: true, result: await listEscrows(request.wallet) }, { headers });
  }
  if (request.action === "wallet-holdings") {
    if (decodeBase58(request.wallet) === null) {
      return Response.json({ ok: false, error: "The wallet address is not a public key." }, { status: 400, headers });
    }
    return Response.json({ ok: true, result: await listHoldings(request.wallet) }, { headers });
  }
  if (request.action === "wallet-asset-info") {
    return Response.json({ ok: true, result: await readAsset(request.mint) }, { headers });
  }
  if (request.action === "wallet-metadata") {
    return Response.json({ ok: true, result: await readMetadata(request.mint) }, { headers });
  }
  if (request.action === "wallet-chain") {
    return Response.json({ ok: true, result: await readChain(request) }, { headers });
  }
  if (request.action === "wallet-terms") {
    const aInfo = await readAsset(request.a.mint);
    const bInfo = await readAsset(request.b.mint);
    if (!kindAgrees(request.a.kind, request.a.mint, aInfo) || !kindAgrees(request.b.kind, request.b.mint, bInfo)) {
      return Response.json({ ok: false, error: "The asset kind does not match the mint." }, { status: 400, headers });
    }
    writeTerms(request.escrow, {
      a: { kind: request.a.kind, mint: request.a.mint, amount: request.a.amount.toString() },
      b: { kind: request.b.kind, mint: request.b.mint, amount: request.b.amount.toString() },
      ...(request.openerShield === undefined ? {} : { openerShield: request.openerShield }),
    });
    return Response.json({ ok: true, result: { escrow: request.escrow } }, { headers });
  }
  if (request.action === "wallet-withdraw" && request.mint !== SOL_MINT && request.tokenProgram !== undefined) {
    const info = await readAsset(request.mint);
    if (info.tokenProgram !== request.tokenProgram) {
      return Response.json({ ok: false, error: "The token program does not match the mint." }, { status: 400, headers });
    }
    if (info.kind === "nft" && request.lamports !== BigInt(1)) {
      return Response.json({ ok: false, error: "An NFT redeems as one." }, { status: 400, headers });
    }
  }
  if (request.action === "wallet-submit") return Response.json({ ok: true, result: await submitTransaction(request.tx) }, { headers });
  const payload = ringPayload(request);
  if (payload === null) return Response.json({ ok: false, error: "The wallet request is incomplete." }, { status: 400, headers });
  const run = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "./src/wasm-node-preload.mjs", "src/wallet-desk.ts"], {
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
    return Response.json({ ok: false, error: shownRpcError(run.stderr || "The wallet command returned no result.").slice(0, 1200) }, { status: 502, headers });
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
    return Response.json({ ok: false, error: shownRpcError(error) }, { status: 500, headers: { "cache-control": "no-store" } });
  }
}

function shownRpcError(error: unknown): string {
  const text = scrub(String(error));
  return rpcRateLimitMessage(text) ?? text;
}

async function listHoldings(wallet: string): Promise<{ holdings: ReturnType<typeof selectHeldAssets> }> {
  const [balance, spl, token2022] = await Promise.all([
    helius<{ value: number }>("getBalance", [wallet, { commitment: "confirmed" }]),
    helius<unknown>("getTokenAccountsByOwner", [
      wallet,
      { programId: SPL_TOKEN_PROGRAM_ID },
      { encoding: "jsonParsed", commitment: "confirmed" },
    ]),
    helius<unknown>("getTokenAccountsByOwner", [
      wallet,
      { programId: TOKEN_2022_PROGRAM_ID },
      { encoding: "jsonParsed", commitment: "confirmed" },
    ]),
  ]);
  const solLamports = rpcLamports(balance.value);
  if (solLamports === null) throw new Error("devnet RPC returned no balance");
  const accounts = [...readTokenAccountList(SPL_TOKEN_PROGRAM_ID, spl), ...readTokenAccountList(TOKEN_2022_PROGRAM_ID, token2022)];
  return { holdings: selectHeldAssets({ wallet, solLamports, accounts, mints: await classifyMints(accounts.map((account) => account.mint)) }) };
}

async function classifyMints(mints: readonly string[]): Promise<Record<string, MintClass>> {
  const unique = [...new Set(mints)];
  const classes: Record<string, MintClass> = {};
  for (let offset = 0; offset < unique.length; offset += RPC_ACCOUNT_BATCH) {
    const slice = unique.slice(offset, offset + RPC_ACCOUNT_BATCH);
    const result = await helius<{ value: ({ owner?: unknown; data?: unknown } | null)[] }>("getMultipleAccounts", [
      slice,
      { encoding: "base64", commitment: "confirmed" },
    ]);
    if (!Array.isArray(result.value)) throw new Error("devnet RPC returned no mint accounts");
    slice.forEach((mint, index) => {
      const row = result.value[index];
      if (row === null || row === undefined || typeof row.owner !== "string" || !Array.isArray(row.data)) return;
      const encoded = row.data[0];
      if (typeof encoded !== "string") return;
      const info = decodeMint(row.owner, Buffer.from(encoded, "base64"));
      if (info === null || info.kind === "sol" || info.tokenProgram === null) return;
      classes[mint] = { kind: info.kind, decimals: info.decimals, tokenProgram: info.tokenProgram };
    });
  }
  return classes;
}

async function readChain(request: { readonly account?: string; readonly rentSpace?: number }): Promise<{
  blockhash: string;
  lamports?: number;
  rentLamports?: number;
}> {
  const latest = await helius<{ value?: { blockhash?: string } }>("getLatestBlockhash", [{ commitment: "confirmed" }]);
  const blockhash = latest.value?.blockhash;
  if (typeof blockhash !== "string" || blockhash.length < 32) throw new Error("devnet RPC returned no blockhash");
  const result: { blockhash: string; lamports?: number; rentLamports?: number } = { blockhash };
  if (request.account !== undefined) {
    const balance = await helius<{ value: number }>("getBalance", [request.account, { commitment: "confirmed" }]);
    if (!Number.isSafeInteger(balance.value) || balance.value < 0) throw new Error("devnet RPC returned no balance");
    result.lamports = balance.value;
  }
  if (request.rentSpace !== undefined) {
    const rent = await helius<number>("getMinimumBalanceForRentExemption", [request.rentSpace, { commitment: "confirmed" }]);
    if (!Number.isSafeInteger(rent) || rent < 0) throw new Error("devnet RPC returned no rent exemption");
    result.rentLamports = rent;
  }
  return result;
}
