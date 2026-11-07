// Close an escrow and return its rent to party A.
// Accounts: escrow (writable), party A (signer, writable). Tag 6.
// Usage: node close_escrow.mjs <escrow-pubkey> <party-a-keypair>

import { readFileSync } from "node:fs";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";

const PROGRAM = new PublicKey("7c3yarLtR2eUebLqYcms7GViXZ5SpQVWmmiqJTp3QtYG");

const [escrowArg, partyPath] = process.argv.slice(2);
if (!escrowArg || !partyPath) {
  console.error("usage: node close_escrow.mjs <escrow-pubkey> <party-a-keypair>");
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

const party = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(partyPath, "utf8"))));
const escrow = new PublicKey(escrowArg);
const connection = new Connection(rpcUrl(), "confirmed");
const before = await connection.getBalance(party.publicKey);
const tx = new Transaction().add(
  new TransactionInstruction({
    programId: PROGRAM,
    keys: [
      { pubkey: escrow, isSigner: false, isWritable: true },
      { pubkey: party.publicKey, isSigner: true, isWritable: true },
    ],
    data: Buffer.from([6]),
  }),
);
const signature = await sendAndConfirmTransaction(connection, tx, [party]);
const after = await connection.getBalance(party.publicKey);
console.log(`signature ${signature}`);
console.log(`party_a ${party.publicKey.toBase58()}`);
console.log(`lamports_before ${before}`);
console.log(`lamports_after ${after}`);
process.exit(0);
