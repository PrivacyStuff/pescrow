import { readFileSync } from "node:fs";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram, Transaction, type TransactionInstruction } from "@solana/web3.js";
import { RPC_RATE_LIMIT_MESSAGE, rpcRateLimitMessage } from "@/lib/desk-request";
import {
  FAUCET_LABEL,
  FAUCET_MAX_BODY_BYTES,
  FAUCET_PUBLIC_KEY,
  FAUCET_SOL_LAMPORTS,
  FAUCET_USDC_BASE_UNITS,
  FAUCET_USDC_DECIMALS,
  FAUCET_USDC_MINT,
  FaucetLimiter,
  faucetCanSend,
  faucetEnabled,
  faucetKeySource,
  isDevnetGenesis,
  parseFaucetRequest,
  secretKeyCandidates,
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

type TokenAccountInfo = { mint?: string; owner?: string; tokenAmount?: { amount?: string } };
type ParsedTokenAccount = { value: { owner: string; data: { parsed?: { type?: string; info?: TokenAccountInfo } } } | null };
type SignatureStatus = { value: ({ err: unknown; confirmationStatus?: string } | null)[] };

const limiter = new FaucetLimiter();
const USDC_MINT = new PublicKey(FAUCET_USDC_MINT);
const NOT_CONFIGURED = "The faucet is not configured.";
let devnetConfirmed = false;
let cachedKeypair: Keypair | null = null;

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
  if (recipient.equals(faucet.publicKey)) throw new FaucetRefusal("That is the faucet wallet. Use your own address.", 400);
  const balance = await helius<{ value: number }>("getBalance", [faucet.publicKey.toBase58(), { commitment: "confirmed" }]);
  const lamports = BigInt(balance.value);

  if (request.asset === "sol") {
    if (!faucetCanSend("sol", lamports, BigInt(0))) throw new FaucetRefusal("The faucet wallet is out of SOL. Try again later.", 503);
    return send(faucet, [SystemProgram.transfer({ fromPubkey: faucet.publicKey, toPubkey: recipient, lamports: FAUCET_SOL_LAMPORTS })]);
  }

  const source = getAssociatedTokenAddressSync(USDC_MINT, faucet.publicKey, false, TOKEN_PROGRAM_ID);
  const usdc = await faucetUsdcBalance(source, faucet.publicKey);
  if (!faucetCanSend("usdc", lamports, usdc)) throw new FaucetRefusal("The faucet wallet is out of USDC or fee SOL. Try again later.", 503);
  const destination = getAssociatedTokenAddressSync(USDC_MINT, recipient, false, TOKEN_PROGRAM_ID);
  return send(faucet, [
    createAssociatedTokenAccountIdempotentInstruction(faucet.publicKey, destination, recipient, USDC_MINT, TOKEN_PROGRAM_ID),
    createTransferCheckedInstruction(source, USDC_MINT, destination, faucet.publicKey, FAUCET_USDC_BASE_UNITS, FAUCET_USDC_DECIMALS, [], TOKEN_PROGRAM_ID),
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
  const source = faucetKeySource(process.env);
  if (source === null) {
    console.error("faucet_config_missing");
    throw new FaucetRefusal(NOT_CONFIGURED, 503);
  }
  const candidates = secretKeyCandidates(source.kind === "inline" ? source.text : readKeyFile(source.path));
  if (candidates.length === 0) {
    console.error("faucet_key_malformed", source.kind);
    throw new FaucetRefusal(NOT_CONFIGURED, 503);
  }
  const keypair = candidates.map(toKeypair).find((candidate) => candidate?.publicKey.toBase58() === FAUCET_PUBLIC_KEY);
  if (keypair === undefined || keypair === null) {
    console.error("faucet_key_not_pinned_wallet", source.kind);
    throw new FaucetRefusal(NOT_CONFIGURED, 503);
  }
  cachedKeypair = keypair;
  return cachedKeypair;
}

function toKeypair(secret: Uint8Array): Keypair | null {
  try {
    return Keypair.fromSecretKey(secret);
  } catch {
    return null;
  }
}

function readKeyFile(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    console.error("faucet_key_unreadable");
    throw new FaucetRefusal(NOT_CONFIGURED, 503);
  }
}

async function faucetUsdcBalance(source: PublicKey, faucet: PublicKey): Promise<bigint> {
  const account = await helius<ParsedTokenAccount>("getAccountInfo", [source.toBase58(), { encoding: "jsonParsed", commitment: "confirmed" }]);
  if (account.value === null) return BigInt(0);
  const info = account.value.data.parsed?.info;
  const amount = info?.tokenAmount?.amount;
  const valid =
    account.value.owner === TOKEN_PROGRAM_ID.toBase58() &&
    account.value.data.parsed?.type === "account" &&
    info?.mint === FAUCET_USDC_MINT &&
    info.owner === faucet.toBase58();
  if (!valid || typeof amount !== "string" || !/^\d+$/.test(amount)) {
    console.error("faucet_usdc_account_invalid");
    throw new FaucetRefusal("The faucet cannot send USDC right now.", 503);
  }
  return BigInt(amount);
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
