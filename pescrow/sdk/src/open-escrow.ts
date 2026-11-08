import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { devnetRpcUrl } from "./rpc-url.ts";

const PROGRAM_ID = "7c3yarLtR2eUebLqYcms7GViXZ5SpQVWmmiqJTp3QtYG";
const ACCOUNT_LEN = 160;
const LOCK_SEED = Buffer.from("escrow-lock");
const APPROVAL_WINDOW_SEC = 6 * 60 * 60;
const RELEASE_DELAY_SEC = 12 * 60 * 60;
const CLOCK = "SysvarC1ock11111111111111111111111111111111";

const require = createRequire(import.meta.url);
const web3 = require("@solana/web3.js") as {
  Connection: new (url: string, commitment: string) => {
    getMinimumBalanceForRentExemption(space: number): Promise<number>;
    sendRawTransaction(raw: Buffer, opts: { skipPreflight: boolean }): Promise<string>;
    confirmTransaction(signature: string, commitment: string): Promise<{ value: { err: unknown } }>;
    getLatestBlockhash(commitment: string): Promise<{ blockhash: string }>;
  };
  PublicKey: {
    new (value: string): {
      toBuffer(): Buffer;
      toBase58(): string;
      equals(other: { toBase58(): string }): boolean;
    };
    findProgramAddressSync(
      seeds: Buffer[],
      program: { toBuffer(): Buffer },
    ): [{ toBuffer(): Buffer; toBase58(): string }, number];
  };
  Keypair: {
    generate(): { publicKey: { toBuffer(): Buffer; toBase58(): string }; secretKey: Uint8Array };
    fromSeed(seed: Uint8Array): { publicKey: { toBuffer(): Buffer; toBase58(): string }; secretKey: Uint8Array };
  };
  SystemProgram: {
    createAccount(args: {
      fromPubkey: { toBuffer(): Buffer };
      newAccountPubkey: { toBuffer(): Buffer };
      lamports: number;
      space: number;
      programId: { toBuffer(): Buffer };
    }): unknown;
  };
  Transaction: new () => {
    add(...items: unknown[]): unknown;
    recentBlockhash: string;
    feePayer: { toBuffer(): Buffer };
    sign(...signers: { secretKey: Uint8Array }[]): void;
    serialize(): Buffer;
  };
  TransactionInstruction: new (args: {
    programId: { toBuffer(): Buffer };
    keys: { pubkey: { toBuffer(): Buffer }; isSigner: boolean; isWritable: boolean }[];
    data: Buffer;
  }) => unknown;
};

function heliusApiKey(): string {
  const fromEnv = process.env.HELIUS_API_KEY;
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  const text = readFileSync(join(homedir(), ".config/solana/cli/config.yml"), "utf8");
  const match = text.match(/api-key=([0-9a-f-]+)/i);
  const key = match?.[1];
  if (key === undefined) throw new Error("Helius key is not in the Solana CLI config");
  return key;
}

function loadSeed(name: string): Uint8Array {
  const file = JSON.parse(readFileSync(join(homedir(), ".config/zolana", name), "utf8")) as {
    funding_secret_hex?: string;
  };
  const seed = Uint8Array.from(Buffer.from(file.funding_secret_hex ?? "", "hex"));
  if (seed.byteLength !== 32) throw new Error(`${name} funding seed is ${seed.byteLength} bytes`);
  return seed;
}

async function send(
  connection: InstanceType<typeof web3.Connection>,
  instructions: unknown[],
  feePayer: { publicKey: { toBuffer(): Buffer; toBase58(): string }; secretKey: Uint8Array },
  signers: { secretKey: Uint8Array }[],
): Promise<string> {
  const tx = new web3.Transaction();
  for (const instruction of instructions) tx.add(instruction);
  const hash = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = hash.blockhash;
  tx.feePayer = feePayer.publicKey;
  tx.sign(...signers);
  const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  const confirmed = await connection.confirmTransaction(signature, "confirmed");
  if (confirmed.value.err) throw new Error(`${signature} failed: ${JSON.stringify(confirmed.value.err)}`);
  return signature;
}

const connection = new web3.Connection(devnetRpcUrl(heliusApiKey()), "confirmed");
const program = new web3.PublicKey(PROGRAM_ID);
const clock = new web3.PublicKey(CLOCK);
const seedA = loadSeed("party-a.json");
const seedB = loadSeed("party-b.json");
const partyA = web3.Keypair.fromSeed(seedA);
const partyB = web3.Keypair.fromSeed(seedB);
seedA.fill(0);
seedB.fill(0);
const escrow = web3.Keypair.generate();
const now = Math.floor(Date.now() / 1000);
const approvalDeadline = now + APPROVAL_WINDOW_SEC;
const startAt = now + RELEASE_DELAY_SEC;
const [, bump] = web3.PublicKey.findProgramAddressSync([LOCK_SEED, escrow.publicKey.toBuffer()], program);
const data = Buffer.alloc(1 + 51);
data[0] = 0;
partyB.publicKey.toBuffer().copy(data, 1);
data.writeBigInt64LE(BigInt(startAt), 1 + 32);
data.writeBigInt64LE(BigInt(approvalDeadline), 1 + 40);
data[1 + 48] = 1;
data[1 + 49] = 1;
data[1 + 50] = bump;
const lamports = await connection.getMinimumBalanceForRentExemption(ACCOUNT_LEN);
const createSignature = await send(
  connection,
  [
    web3.SystemProgram.createAccount({
      fromPubkey: partyA.publicKey,
      newAccountPubkey: escrow.publicKey,
      lamports,
      space: ACCOUNT_LEN,
      programId: program,
    }),
    new web3.TransactionInstruction({
      programId: program,
      keys: [
        { pubkey: escrow.publicKey, isSigner: false, isWritable: true },
        { pubkey: partyA.publicKey, isSigner: true, isWritable: true },
      ],
      data,
    }),
  ],
  partyA,
  [partyA, escrow],
);

async function approve(party: typeof partyA): Promise<string> {
  return send(
    connection,
    [
      new web3.TransactionInstruction({
        programId: program,
        keys: [
          { pubkey: escrow.publicKey, isSigner: false, isWritable: true },
          { pubkey: party.publicKey, isSigner: true, isWritable: true },
          { pubkey: clock, isSigner: false, isWritable: false },
        ],
        data: Buffer.from([1]),
      }),
    ],
    party,
    [party],
  );
}

const approveA = await approve(partyA);
const approveB = await approve(partyB);
console.log(`escrow ${escrow.publicKey.toBase58()}`);
console.log(`create ${createSignature}`);
console.log(`approve_a ${approveA}`);
console.log(`approve_b ${approveB}`);
console.log(`party_a ${partyA.publicKey.toBase58()}`);
console.log(`party_b ${partyB.publicKey.toBase58()}`);
process.exit(0);
