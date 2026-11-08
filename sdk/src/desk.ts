import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import {
  createKeyPairSignerFromPrivateKeyBytes,
  getBase58Decoder,
  getSignatureFromTransaction,
  sendTransactionWithoutConfirmingFactory,
  signTransactionWithSigners,
} from "@solana/kit";
import {
  LocalKeys,
  ShieldedKeypair,
  SigningKey,
  Wallet,
  buildDepositTransaction,
  buildWithdrawalTransaction,
  createSprClient,
  syncWallet,
  type Bytes32,
} from "@heliuslabs/spr";
import { SignedTeePolicy } from "@heliuslabs/spr/client";
import { foldSolNotes } from "./fold-notes.ts";
import { devnetRpcUrl } from "./rpc-url.ts";
import { RING1_TREE } from "./notes.ts";

const PROGRAM_ID = "7c3yarLtR2eUebLqYcms7GViXZ5SpQVWmmiqJTp3QtYG";
const ACCOUNT_LEN = 160;
const LOCK_SEED = Buffer.from("escrow-lock");
const WINDOW_SEC = 6 * 60 * 60;
const MAX_LAMPORTS = 1_000_000_000n;
const CLOCK = "SysvarC1ock11111111111111111111111111111111";
const SIDES = { a: "party-a.json", b: "party-b.json" } as const;

const require = createRequire(import.meta.url);
const web3 = require("@solana/web3.js") as {
  Connection: new (url: string, commitment: string) => {
    getBalance(key: { toBase58(): string }): Promise<number>;
    getAccountInfo(key: { toBase58(): string }): Promise<{ data: Buffer } | null>;
    getMinimumBalanceForRentExemption(space: number): Promise<number>;
    sendRawTransaction(raw: Buffer, opts: { skipPreflight: boolean }): Promise<string>;
    confirmTransaction(signature: string, commitment: string): Promise<{ value: { err: unknown } }>;
    getLatestBlockhash(commitment: string): Promise<{ blockhash: string }>;
  };
  PublicKey: {
    new (value: string): { toBuffer(): Buffer; toBase58(): string };
    findProgramAddressSync(seeds: Buffer[], program: { toBuffer(): Buffer }): [{ toBase58(): string; toBuffer(): Buffer }, number];
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
    add(item: unknown): unknown;
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

interface WalletFile {
  readonly funding_pubkey: string;
  readonly funding_secret_hex: string;
}

function scrub(value: unknown): string {
  return String(value).replace(/api-key=[^&\s"]+/g, "api-key=REDACTED");
}

function heliusApiKey(): string {
  const fromEnv = process.env.HELIUS_API_KEY;
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  const text = readFileSync(join(homedir(), ".config/solana/cli/config.yml"), "utf8");
  const match = text.match(/api-key=([0-9a-f-]+)/i);
  const key = match?.[1];
  if (key === undefined) throw new Error("Helius key is not in the Solana CLI config");
  return key;
}

function walletPath(side: keyof typeof SIDES): string {
  return join(homedir(), ".config/zolana", SIDES[side]);
}

function escrowPath(): string {
  return join(homedir(), ".config/zolana/desk-escrow.json");
}

function loadWallet(side: keyof typeof SIDES): WalletFile {
  const file = JSON.parse(readFileSync(walletPath(side), "utf8")) as WalletFile;
  if (typeof file.funding_pubkey !== "string" || typeof file.funding_secret_hex !== "string") {
    throw new Error(`${SIDES[side]} is missing its funding key`);
  }
  return file;
}

function loadSeed(file: WalletFile): Uint8Array {
  const seed = Uint8Array.from(Buffer.from(file.funding_secret_hex, "hex"));
  if (seed.byteLength !== 32) throw new Error("funding seed is not 32 bytes");
  return seed;
}

function readEscrowAddress(): string | null {
  try {
    const saved = JSON.parse(readFileSync(escrowPath(), "utf8")) as { address?: string };
    return typeof saved.address === "string" ? saved.address : null;
  } catch {
    return null;
  }
}

async function confirmSignature(
  client: Awaited<ReturnType<typeof createSprClient>>,
  signature: string,
): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const status = await client.solanaRpc.getSignatureStatuses([signature as never]).send();
    const row = status.value[0];
    if (row?.err) throw new Error(`transaction ${signature} failed: ${JSON.stringify(row.err)}`);
    if (row?.confirmationStatus === "confirmed" || row?.confirmationStatus === "finalized") return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`transaction ${signature} was not confirmed`);
}

async function walletNotes(
  client: Awaited<ReturnType<typeof createSprClient>>,
  side: keyof typeof SIDES,
): Promise<{ address: string; sol: string; notes: { hash: string; lamports: string; leaf: string }[] }> {
  const file = loadWallet(side);
  const connection = new web3.Connection(devnetRpcUrl(heliusApiKey()), "confirmed");
  const sol = await connection.getBalance(new web3.PublicKey(file.funding_pubkey));
  const seed = loadSeed(file);
  const shielded = ShieldedKeypair.fromKeypair(SigningKey.fromEd25519Bytes(seed as Bytes32));
  seed.fill(0);
  const keys = LocalKeys.fromKeypair(shielded, client.proofService);
  try {
    const wallet = new Wallet({ identity: shielded.shieldedAddress() });
    await syncWallet({ client, wallet, keys });
    const notes = wallet
      .utxos()
      .filter((utxo) => utxo.outputContext.tree === RING1_TREE && !utxo.spent)
      .map((utxo) => ({
        hash: getBase58Decoder().decode(utxo.outputContext.hash),
        lamports: utxo.utxo.amount.toString(),
        leaf: utxo.outputContext.leafIndex.toString(),
      }));
    return { address: file.funding_pubkey, sol: String(sol), notes };
  } finally {
    keys.destroy();
  }
}

function escrowView(connection: InstanceType<typeof web3.Connection>, address: string) {
  return connection.getAccountInfo(new web3.PublicKey(address)).then((account) => {
    if (account === null || account.data.length !== ACCOUNT_LEN) return { address, open: false as const };
    const data = account.data;
    const startAt = Number(data.readBigInt64LE(8));
    return {
      address,
      open: true as const,
      aApproved: data[2] === 1,
      bApproved: data[3] === 1,
      aSealed: data[4] === 1,
      bSealed: data[5] === 1,
      startAt,
    };
  });
}

async function status(): Promise<unknown> {
  const client = await createSprClient({ solanaRpcUrl: devnetRpcUrl(heliusApiKey()) });
  const connection = new web3.Connection(devnetRpcUrl(heliusApiKey()), "confirmed");
  const [a, b] = await Promise.all([walletNotes(client, "a"), walletNotes(client, "b")]);
  const address = readEscrowAddress();
  const escrow = address === null ? null : await escrowView(connection, address);
  return { a, b, escrow, tree: RING1_TREE, program: PROGRAM_ID };
}

function bounded(lamports: bigint): bigint {
  if (lamports < 1n || lamports > MAX_LAMPORTS) throw new Error("amount must be between 1 lamport and 1 SOL");
  return lamports;
}

async function shield(side: keyof typeof SIDES, lamports: bigint): Promise<unknown> {
  bounded(lamports);
  const file = loadWallet(side);
  const seed = loadSeed(file);
  const foldSeed = seed.slice();
  const signer = await createKeyPairSignerFromPrivateKeyBytes(seed);
  const shielded = ShieldedKeypair.fromKeypair(SigningKey.fromEd25519Bytes(seed as Bytes32));
  seed.fill(0);
  if (signer.address !== file.funding_pubkey) throw new Error("seed does not match its funding pubkey");
  const client = await createSprClient({ solanaRpcUrl: devnetRpcUrl(heliusApiKey()) });
  const transaction = await buildDepositTransaction({
    client,
    feePayer: signer.address,
    recipient: shielded.shieldedAddress(),
    amount: lamports,
    tree: RING1_TREE,
  });
  const signed = await signTransactionWithSigners([signer], transaction);
  const send = sendTransactionWithoutConfirmingFactory({ rpc: client.solanaRpc });
  await send(signed, { commitment: "confirmed" });
  const signature = getSignatureFromTransaction(signed);
  await confirmSignature(client, signature);
  try {
    const merged = await foldSolNotes({ rpcUrl: devnetRpcUrl(heliusApiKey()), seed: foldSeed });
    return merged === null ? { signature } : { signature, merged };
  } finally {
    foldSeed.fill(0);
  }
}

async function withdraw(side: keyof typeof SIDES, lamports: bigint): Promise<unknown> {
  bounded(lamports);
  const file = loadWallet(side);
  const seed = loadSeed(file);
  const signer = await createKeyPairSignerFromPrivateKeyBytes(seed);
  const shielded = ShieldedKeypair.fromKeypair(SigningKey.fromEd25519Bytes(seed as Bytes32));
  seed.fill(0);
  const client = await createSprClient({
    solanaRpcUrl: devnetRpcUrl(heliusApiKey()),
    proverTee: SignedTeePolicy.forNetwork("devnet"),
    proofDataSource: "client",
  });
  const keys = LocalKeys.fromKeypair(shielded, client.proofService);
  try {
    const wallet = new Wallet({ identity: shielded.shieldedAddress() });
    await syncWallet({ client, wallet, keys });
    const transaction = await buildWithdrawalTransaction({
      client,
      wallet,
      keys,
      feePayer: signer.address,
      recipient: signer.address,
      amount: lamports,
    });
    const signed = await signTransactionWithSigners([signer], transaction);
    const send = sendTransactionWithoutConfirmingFactory({ rpc: client.solanaRpc });
    await send(signed, { commitment: "confirmed" });
    const signature = getSignatureFromTransaction(signed);
    await confirmSignature(client, signature);
    return { signature };
  } finally {
    keys.destroy();
  }
}

async function sendWeb3(
  connection: InstanceType<typeof web3.Connection>,
  instructions: unknown[],
  feePayer: { publicKey: { toBuffer(): Buffer }; secretKey: Uint8Array },
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

async function openEscrow(): Promise<unknown> {
  const connection = new web3.Connection(devnetRpcUrl(heliusApiKey()), "confirmed");
  const program = new web3.PublicKey(PROGRAM_ID);
  const clock = new web3.PublicKey(CLOCK);
  const seedA = loadSeed(loadWallet("a"));
  const seedB = loadSeed(loadWallet("b"));
  const partyA = web3.Keypair.fromSeed(seedA);
  const partyB = web3.Keypair.fromSeed(seedB);
  seedA.fill(0);
  seedB.fill(0);
  const escrow = web3.Keypair.generate();
  const deadline = Math.floor(Date.now() / 1000) + WINDOW_SEC;
  const [, bump] = web3.PublicKey.findProgramAddressSync([LOCK_SEED, escrow.publicKey.toBuffer()], program);
  const data = Buffer.alloc(1 + 51);
  data[0] = 0;
  partyB.publicKey.toBuffer().copy(data, 1);
  data.writeBigInt64LE(BigInt(deadline), 1 + 32);
  data.writeBigInt64LE(BigInt(deadline), 1 + 40);
  data[1 + 48] = 1;
  data[1 + 49] = 1;
  data[1 + 50] = bump;
  const lamports = await connection.getMinimumBalanceForRentExemption(ACCOUNT_LEN);
  const createSignature = await sendWeb3(
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
    return sendWeb3(
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
  const address = escrow.publicKey.toBase58();
  writeFileSync(escrowPath(), `${JSON.stringify({ address })}\n`, { mode: 0o600 });
  return { address, createSignature, approveA, approveB, lockBefore: deadline };
}

async function main(): Promise<void> {
  const [action, side, amount] = process.argv.slice(2);
  let result: unknown;
  if (action === "status") result = await status();
  else if ((action === "shield" || action === "withdraw") && (side === "a" || side === "b") && amount !== undefined) {
    result = action === "shield" ? await shield(side, BigInt(amount)) : await withdraw(side, BigInt(amount));
  } else if (action === "open") result = await openEscrow();
  else throw new Error("unknown desk action");
  process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
}

main()
  .catch((error: unknown) => {
    process.stdout.write(`${JSON.stringify({ ok: false, error: scrub(error) })}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    setTimeout(() => process.exit(process.exitCode ?? 0), 20);
  });
