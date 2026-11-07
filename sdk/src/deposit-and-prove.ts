import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
  syncWallet,
  type Bytes32,
} from "@heliuslabs/spr";
import { createDevnetClient } from "./client.ts";
import { RING1_TREE } from "./notes.ts";

const DEPOSIT_LAMPORTS = 10_000_000n;

interface WalletFile {
  readonly funding_pubkey: string;
  readonly funding_secret_hex: string;
}

function loadWallet(name: string): WalletFile {
  const path = join(homedir(), ".config/zolana", name);
  return JSON.parse(readFileSync(path, "utf8")) as WalletFile;
}

function scrub(value: unknown): string {
  return String(value).replace(/api-key=[^&\s"]+/g, "api-key=REDACTED");
}

const apiKey = process.env.HELIUS_API_KEY;
if (apiKey === undefined || apiKey.length === 0) {
  console.error("HELIUS_API_KEY is missing");
  process.exit(1);
}

const client = await createDevnetClient(apiKey);
const send = sendTransactionWithoutConfirmingFactory({ rpc: client.solanaRpc });

async function waitForConfirmation(signature: ReturnType<typeof getSignatureFromTransaction>): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const status = await client.solanaRpc.getSignatureStatuses([signature]).send();
    const row = status.value[0];
    if (row?.err) {
      throw new Error(`transaction ${signature} failed: ${JSON.stringify(row.err)}`);
    }
    if (row?.confirmationStatus === "confirmed" || row?.confirmationStatus === "finalized") {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`transaction ${signature} was not confirmed`);
}

for (const fileName of ["party-a.json", "party-b.json"]) {
  const file = loadWallet(fileName);
  const seed = Uint8Array.from(Buffer.from(file.funding_secret_hex, "hex"));
  if (seed.byteLength !== 32) {
    throw new Error(`${fileName} funding seed is ${seed.byteLength} bytes`);
  }
  const signer = await createKeyPairSignerFromPrivateKeyBytes(seed);
  if (signer.address !== file.funding_pubkey) {
    throw new Error(`${fileName} seed does not match its funding pubkey`);
  }
  const shielded = ShieldedKeypair.fromKeypair(SigningKey.fromEd25519Bytes(seed as Bytes32));
  seed.fill(0);
  try {
    const transaction = await buildDepositTransaction({
      client,
      feePayer: signer.address,
      recipient: shielded.shieldedAddress(),
      amount: DEPOSIT_LAMPORTS,
      tree: RING1_TREE,
    });
    const signed = await signTransactionWithSigners([signer], transaction);
    await send(signed, { commitment: "confirmed" });
    const signature = getSignatureFromTransaction(signed);
    await waitForConfirmation(signature);
    const slot = await client.confirmTransaction(signature);
    const wallet = new Wallet({ identity: shielded.shieldedAddress() });
    await syncWallet({
      client,
      wallet,
      keys: LocalKeys.fromKeypair(shielded, client.proofService),
      config: { requireSlot: slot },
    });
    const hashes = wallet
      .utxos()
      .filter((utxo) => utxo.outputContext.tree === RING1_TREE && !utxo.spent)
      .map((utxo) => getBase58Decoder().decode(utxo.outputContext.hash));
    const proofs = await client.getMerkleProofs(
      RING1_TREE,
      wallet
        .utxos()
        .filter((utxo) => utxo.outputContext.tree === RING1_TREE && !utxo.spent)
        .map((utxo) => utxo.outputContext.hash),
    );
    console.log(
      `${fileName} payer=${signer.address} signature=${signature} notes=${hashes.join(",")} proofs=${proofs.proofs.length}`,
    );
    for (const proof of proofs.proofs) {
      console.log(`leaf_index=${proof.leafIndex} path_len=${proof.path.length}`);
    }
  } catch (error) {
    console.error(`${fileName} failed: ${scrub(error)}`);
    process.exit(1);
  }
}
process.exit(0);
