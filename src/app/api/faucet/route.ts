import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToCheckedInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram, Transaction, type TransactionInstruction } from "@solana/web3.js";
import { RPC_RATE_LIMIT_MESSAGE, rpcRateLimitMessage } from "@/lib/desk-request";
import {
  FAUCET_FEE_RESERVE_LAMPORTS,
  FAUCET_LABEL,
  FAUCET_MAX_BODY_BYTES,
  FAUCET_SOL_LAMPORTS,
  FAUCET_USDC_BASE_UNITS,
  FAUCET_USDC_DECIMALS,
  FAUCET_USDC_MINT,
  FaucetLimiter,
  faucetEnabled,
  faucetKeypairPath,
  isDevnetGenesis,
  parseFaucetRequest,
  parseSecretKey,
  rateLimitMessage,
  type FaucetRequest,
} from "@/lib/faucet";
import { helius } from "@/lib/helius-rpc";
import { clientAddressFromHeaders, isSameOriginSubmission } from "@/lib/waitlist-policy";

const JSON_MIME = "application/json";
const CONFIRM_ATTEMPTS = 30;
const CONFIRM_INTERVAL_MS = 1_000;
const NO_STORE = { "cache-control": "no-store" };
const GENERIC_FAILURE = "The drop failed. Try again.";

class FaucetRefusal extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

type MintInfo = { mintAuthority: string | null; decimals: number };
type ParsedMintAccount = { value: { owner: string; data: { parsed?: { type?: string; info?: MintInfo } } } | null };
type SignatureStatus = { value: ({ err: unknown; confirmationStatus?: string } | null)[] };

const limiter = new FaucetLimiter();
let devnetConfirmed = false;
let cachedKeypair: Keypair | null = null;
let mintChecked = false;

export async function POST(request: Request) {
  if (!faucetEnabled(process.env)) return new Response(null, { status: 404 });
  if (!isJson(request.headers.get("content-type"))) return refuse("Send the request as JSON.", 415);
  const sameOrigin = isSameOriginSubmission({
    origin: request.headers.get("origin"),
    host: request.headers.get("host"),
    secFetchSite: request.headers.get("sec-fetch-site"),
  });
  if (!sameOrigin) return refuse("Use the faucet from this site.", 403);

  const parsed = parseFaucetRequest(await readBody(request));
  if (parsed === null) return refuse("Enter a Solana wallet address and pick SOL or USDC.", 400);
  if (!PublicKey.isOnCurve(new PublicKey(parsed.recipient).toBytes())) {
    return refuse("Use a wallet address, not a program address.", 400);
  }

  const ip = clientAddressFromHeaders(request.headers.get("x-forwarded-for"), request.headers.get("x-real-ip"));
  const reservation = limiter.reserve(parsed.asset, parsed.recipient, ip, Date.now());
  if (!reservation.ok) {
    return Response.json(
      { ok: false, error: rateLimitMessage(parsed.asset, reservation.retryAfterMs) },
      { status: 429, headers: { ...NO_STORE, "retry-after": String(Math.ceil(reservation.retryAfterMs / 1000)) } },
    );
  }

  try {
    const signature = await drop(parsed);
    return Response.json({ ok: true, result: { signature, asset: parsed.asset, amount: FAUCET_LABEL[parsed.asset] } }, { headers: NO_STORE });
  } catch (error) {
    limiter.release(reservation.keys);
    return failure(error);
  }
}

async function drop(request: FaucetRequest): Promise<string> {
  await assertDevnet();
  const faucet = loadFaucetKey();
  const recipient = new PublicKey(request.recipient);
  const balance = await helius<{ value: number }>("getBalance", [faucet.publicKey.toBase58(), { commitment: "confirmed" }]);
  const lamports = BigInt(balance.value);

  if (request.asset === "sol") {
    if (lamports < FAUCET_SOL_LAMPORTS + FAUCET_FEE_RESERVE_LAMPORTS) return airdropFallback(recipient);
    return send(faucet, [SystemProgram.transfer({ fromPubkey: faucet.publicKey, toPubkey: recipient, lamports: FAUCET_SOL_LAMPORTS })]);
  }

  if (lamports < FAUCET_FEE_RESERVE_LAMPORTS) throw new FaucetRefusal("The faucet is out of SOL for fees. Try again later.", 503);
  const mint = new PublicKey(FAUCET_USDC_MINT);
  await assertMintAuthority(faucet.publicKey);
  const ata = getAssociatedTokenAddressSync(mint, recipient, false, TOKEN_PROGRAM_ID);
  return send(faucet, [
    createAssociatedTokenAccountIdempotentInstruction(faucet.publicKey, ata, recipient, mint, TOKEN_PROGRAM_ID),
    createMintToCheckedInstruction(mint, ata, faucet.publicKey, FAUCET_USDC_BASE_UNITS, FAUCET_USDC_DECIMALS, [], TOKEN_PROGRAM_ID),
  ]);
}

async function assertDevnet(): Promise<void> {
  if (devnetConfirmed) return;
  const genesis = await helius<string>("getGenesisHash", []);
  if (!isDevnetGenesis(genesis)) throw new FaucetRefusal("The faucet only runs on devnet.", 503);
  devnetConfirmed = true;
}

function loadFaucetKey(): Keypair {
  if (cachedKeypair !== null) return cachedKeypair;
  const path = faucetKeypairPath(process.env, homedir());
  if (path === null) {
    console.error("faucet_config_missing");
    throw new FaucetRefusal("The faucet is not configured.", 503);
  }
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    console.error("faucet_key_unreadable");
    throw new FaucetRefusal("The faucet is not configured.", 503);
  }
  const secret = parseSecretKey(text);
  if (secret === null) {
    console.error("faucet_key_malformed");
    throw new FaucetRefusal("The faucet is not configured.", 503);
  }
  cachedKeypair = Keypair.fromSecretKey(secret);
  return cachedKeypair;
}

async function assertMintAuthority(faucet: PublicKey): Promise<void> {
  if (mintChecked) return;
  const account = await helius<ParsedMintAccount>("getAccountInfo", [FAUCET_USDC_MINT, { encoding: "jsonParsed", commitment: "confirmed" }]);
  const info = account.value?.data.parsed?.info;
  const valid =
    account.value?.owner === TOKEN_PROGRAM_ID.toBase58() &&
    account.value.data.parsed?.type === "mint" &&
    info?.decimals === FAUCET_USDC_DECIMALS &&
    info.mintAuthority === faucet.toBase58();
  if (!valid) {
    console.error("faucet_mint_authority_mismatch");
    throw new FaucetRefusal("The faucet cannot mint USDC right now.", 503);
  }
  mintChecked = true;
}

async function airdropFallback(recipient: PublicKey): Promise<string> {
  const signature = await helius<string>("requestAirdrop", [recipient.toBase58(), Number(FAUCET_SOL_LAMPORTS), { commitment: "confirmed" }]);
  await confirm(signature);
  return signature;
}

async function send(payer: Keypair, instructions: readonly TransactionInstruction[]): Promise<string> {
  const latest = await helius<{ value?: { blockhash?: string; lastValidBlockHeight?: number } }>("getLatestBlockhash", [{ commitment: "confirmed" }]);
  const blockhash = latest.value?.blockhash;
  if (typeof blockhash !== "string") throw new Error("devnet RPC returned no blockhash");
  const tx = new Transaction({ feePayer: payer.publicKey, recentBlockhash: blockhash }).add(...instructions);
  tx.sign(payer);
  const signature = await helius<string>("sendTransaction", [
    tx.serialize().toString("base64"),
    { encoding: "base64", preflightCommitment: "confirmed" },
  ]);
  await confirm(signature);
  return signature;
}

async function confirm(signature: string): Promise<void> {
  for (let attempt = 0; attempt < CONFIRM_ATTEMPTS; attempt += 1) {
    const status = await helius<SignatureStatus>("getSignatureStatuses", [[signature], { searchTransactionHistory: true }]);
    const row = status.value[0];
    if (row?.err) throw new FaucetRefusal("The drop transaction failed on chain.", 502);
    if (row?.confirmationStatus === "confirmed" || row?.confirmationStatus === "finalized") return;
    await new Promise((resolve) => setTimeout(resolve, CONFIRM_INTERVAL_MS));
  }
  throw new FaucetRefusal(`The drop was sent but not confirmed yet: ${signature}`, 504);
}

function isJson(contentType: string | null): boolean {
  return (contentType ?? "").split(";")[0]?.trim().toLowerCase() === JSON_MIME;
}

async function readBody(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (!Number.isFinite(declared) || declared > FAUCET_MAX_BODY_BYTES) return null;
  let text: string;
  try {
    text = await request.text();
  } catch {
    return null;
  }
  if (text.length > FAUCET_MAX_BODY_BYTES) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function refuse(message: string, status: number): Response {
  return Response.json({ ok: false, error: message }, { status, headers: NO_STORE });
}

function failure(error: unknown): Response {
  if (error instanceof FaucetRefusal) return refuse(error.message, error.status);
  const text = error instanceof Error ? error.message : String(error);
  if (rpcRateLimitMessage(text) !== null) return refuse(RPC_RATE_LIMIT_MESSAGE, 503);
  console.error("faucet_drop_failed", text.replace(/api-key=[^&\s"]+/g, "api-key=REDACTED").slice(0, 200));
  return refuse(GENERIC_FAILURE, 502);
}
