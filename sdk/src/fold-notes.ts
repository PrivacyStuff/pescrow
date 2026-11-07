import {
  createKeyPairSignerFromPrivateKeyBytes,
  getSignatureFromTransaction,
  sendTransactionWithoutConfirmingFactory,
  signTransactionWithSigners,
} from "@solana/kit";
import {
  LocalKeys,
  MergeEncryptionScheme,
  SOL_MINT,
  ShieldedKeypair,
  SigningKey,
  Wallet,
  buildMergeTransaction,
  buildSetMergeEncryptionTransaction,
  createSprClient,
  syncWallet,
  type Bytes32,
} from "@heliuslabs/spr";
import { SignedTeePolicy } from "@heliuslabs/spr/client";
import { RING1_TREE } from "./notes.ts";

const MERGE_INPUT_CAP = 24;

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

function mentions(error: unknown, code: string): boolean {
  if (typeof error !== "object" || error === null) return false;
  if ("code" in error && error.code === code) return true;
  if ("causeCode" in error && error.causeCode === code) return true;
  if ("causeCodes" in error && Array.isArray(error.causeCodes) && error.causeCodes.includes(code)) return true;
  if ("cause" in error) return mentions(error.cause, code);
  return false;
}

async function sendSigned(
  client: Awaited<ReturnType<typeof createSprClient>>,
  signer: Awaited<ReturnType<typeof createKeyPairSignerFromPrivateKeyBytes>>,
  transaction: Parameters<typeof signTransactionWithSigners>[1],
): Promise<string> {
  const signed = await signTransactionWithSigners([signer], transaction);
  const send = sendTransactionWithoutConfirmingFactory({ rpc: client.solanaRpc });
  await send(signed, { commitment: "confirmed" });
  const signature = getSignatureFromTransaction(signed);
  await confirmSignature(client, signature);
  return signature;
}

/** Spends every open SOL note on ring1, including zeros, into one note. */
export async function foldSolNotes(input: { rpcUrl: string; seed: Uint8Array }): Promise<string | null> {
  const shielded = ShieldedKeypair.fromKeypair(SigningKey.fromEd25519Bytes(input.seed as Bytes32));
  const signer = await createKeyPairSignerFromPrivateKeyBytes(input.seed);
  const client = await createSprClient({
    solanaRpcUrl: input.rpcUrl,
    proverTee: SignedTeePolicy.forNetwork("devnet"),
    proofDataSource: "client",
  });
  const keys = LocalKeys.fromKeypair(shielded, client.proofService);
  try {
    const wallet = new Wallet({ identity: shielded.shieldedAddress() });
    await syncWallet({ client, wallet, keys });
    const notes = wallet.utxos().filter((utxo) => {
      return utxo.outputContext.tree === RING1_TREE && !utxo.spent && utxo.utxo.asset === SOL_MINT;
    });
    if (notes.length < 2) return null;
    const merge = () =>
      buildMergeTransaction({
        client,
        wallet,
        keys,
        feePayer: signer.address,
        asset: SOL_MINT,
        inputs: notes.slice(0, MERGE_INPUT_CAP).map((utxo) => utxo.outputContext.hash),
      });
    let transaction;
    try {
      transaction = await merge();
    } catch (error) {
      if (!mentions(error, "WALLET_MERGE_ENCRYPTION_SCHEME_UNSUPPORTED")) throw error;
      const enable = await buildSetMergeEncryptionTransaction({
        client,
        owner: signer.address,
        scheme: MergeEncryptionScheme.PoseidonCtrV1,
      });
      await sendSigned(client, signer, enable);
      transaction = await merge();
    }
    return await sendSigned(client, signer, transaction);
  } finally {
    keys.destroy();
  }
}
