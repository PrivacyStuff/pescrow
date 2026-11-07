// Opens one escrow: System createAccount (160 bytes, owner = pescrow) and instruction 0.
// Party A is the fee payer. Party B is only a pubkey in the instruction.
// Usage: node create_escrow.mjs <rpc> <program-keypair> <payer-keypair> <escrow-keypair> <party-b-keypair>

import { readFileSync } from "node:fs";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";

const ACCOUNT_LEN = 160;
const LOCK_SEED = Buffer.from("escrow-lock");
const APPROVAL_WINDOW_SEC = 6 * 60 * 60;
const RELEASE_DELAY_SEC = 12 * 60 * 60;

const [programPath, payerPath, escrowPath, partyBPath] = process.argv.slice(2);
if (!programPath || !payerPath || !escrowPath || !partyBPath) {
  console.error("usage: node create_escrow.mjs <program-keypair> <payer-keypair> <escrow-keypair> <party-b-keypair>");
  process.exit(2);
}

function rpcUrl() {
  const config = readFileSync(`${process.env.HOME}/.config/solana/cli/config.yml`, "utf8");
  const line = config.split("\n").find((entry) => entry.startsWith("json_rpc_url:"));
  if (!line) {
    throw new Error("json_rpc_url missing from solana config");
  }
  return line.slice("json_rpc_url:".length).trim();
}

const rpc = rpcUrl();

function loadKeypair(path) {
  const secret = Uint8Array.from(JSON.parse(readFileSync(path, "utf8")));
  return Keypair.fromSecretKey(secret);
}

const program = loadKeypair(programPath);
const payer = loadKeypair(payerPath);
const escrow = loadKeypair(escrowPath);
const partyB = loadKeypair(partyBPath);
const connection = new Connection(rpc, "confirmed");

const existing = await connection.getAccountInfo(escrow.publicKey);
if (existing !== null) {
  console.error("escrow address already exists; createAccount would fail");
  process.exit(1);
}

const now = Math.floor(Date.now() / 1000);
const approvalDeadline = now + APPROVAL_WINDOW_SEC;
const startAt = now + RELEASE_DELAY_SEC;
const [, bump] = PublicKey.findProgramAddressSync(
  [LOCK_SEED, escrow.publicKey.toBuffer()],
  program.publicKey,
);

const data = Buffer.alloc(1 + 51);
data[0] = 0;
partyB.publicKey.toBuffer().copy(data, 1);
data.writeBigInt64LE(BigInt(startAt), 1 + 32);
data.writeBigInt64LE(BigInt(approvalDeadline), 1 + 40);
data[1 + 48] = 1;
data[1 + 49] = 1;
data[1 + 50] = bump;

const lamports = await connection.getMinimumBalanceForRentExemption(ACCOUNT_LEN);
const tx = new Transaction().add(
  SystemProgram.createAccount({
    fromPubkey: payer.publicKey,
    newAccountPubkey: escrow.publicKey,
    lamports,
    space: ACCOUNT_LEN,
    programId: program.publicKey,
  }),
  new TransactionInstruction({
    programId: program.publicKey,
    keys: [
      { pubkey: escrow.publicKey, isSigner: false, isWritable: true },
      { pubkey: payer.publicKey, isSigner: true, isWritable: false },
    ],
    data,
  }),
);

const signature = await sendAndConfirmTransaction(connection, tx, [payer, escrow]);
console.log(`signature ${signature}`);
console.log(`escrow ${escrow.publicKey.toBase58()}`);
console.log(`party_a ${payer.publicKey.toBase58()}`);
console.log(`party_b ${partyB.publicKey.toBase58()}`);
console.log(`bump ${bump}`);
console.log(`approval_deadline ${approvalDeadline}`);
console.log(`start_at ${startAt}`);
process.exit(0);
