// One party approves. Accounts: escrow (writable), party (signer), Clock sysvar.
// Usage: node approve_escrow.mjs <escrow-pubkey> <party-keypair>

import { readFileSync } from "node:fs";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";

const CLOCK = new PublicKey("SysvarC1ock11111111111111111111111111111111");
const PROGRAM = new PublicKey("7c3yarLtR2eUebLqYcms7GViXZ5SpQVWmmiqJTp3QtYG");

const [escrowArg, partyPath] = process.argv.slice(2);
if (!escrowArg || !partyPath) {
  console.error("usage: node approve_escrow.mjs <escrow-pubkey> <party-keypair>");
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

const secret = Uint8Array.from(JSON.parse(readFileSync(partyPath, "utf8")));
const party = Keypair.fromSecretKey(secret);
const escrow = new PublicKey(escrowArg);
const connection = new Connection(rpcUrl(), "confirmed");
const tx = new Transaction().add(
  new TransactionInstruction({
    programId: PROGRAM,
    keys: [
      { pubkey: escrow, isSigner: false, isWritable: true },
      { pubkey: party.publicKey, isSigner: true, isWritable: false },
      { pubkey: CLOCK, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  }),
);
const signature = await sendAndConfirmTransaction(connection, tx, [party]);
console.log(`signature ${signature}`);
console.log(`party ${party.publicKey.toBase58()}`);
process.exit(0);
