import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { Keypair, PublicKey } from "@solana/web3.js";
import type { Bytes32 } from "../../../pescrow/sdk/node_modules/@heliuslabs/spr/dist/keypair/bytes.js";
import type { Address } from "../../../pescrow/sdk/node_modules/@heliuslabs/spr/dist/interface/types.js";
import type { TreeId } from "../../../pescrow/sdk/node_modules/@heliuslabs/spr/dist/transaction/utxo.js";
import type { WalletUtxo } from "../../../pescrow/sdk/node_modules/@heliuslabs/spr/dist/transaction/wallet/state.js";
import { ShieldedAddress, ShieldedKeypair, SigningKey, Wallet } from "../../../pescrow/sdk/node_modules/@heliuslabs/spr/dist/index.js";
import { initializePoseidon, poseidon } from "../../../pescrow/sdk/node_modules/@heliuslabs/spr/dist/hasher/index.js";
import { ViewingKey, randomBlinding } from "../../../pescrow/sdk/node_modules/@heliuslabs/spr/dist/keypair/index.js";
import { ProgramOwner, bindProgramTransaction, toProgramWalletUtxo } from "../../../pescrow/sdk/node_modules/@heliuslabs/spr/dist/program/index.js";
import { treeAddress } from "../../../pescrow/sdk/node_modules/@heliuslabs/spr/dist/interface/pda/index.js";
import { SOL_MINT } from "../../../pescrow/sdk/node_modules/@heliuslabs/spr/dist/transaction/asset.js";
import { Utxo } from "../../../pescrow/sdk/node_modules/@heliuslabs/spr/dist/transaction/utxo.js";
import { PPROLL_PROGRAM_ID } from "../../../src/lib/payroll-account.ts";
import init, { payTransaction } from "../../target/zk/pproll/wasm/node.mjs";
import { be32, limbs } from "./commitment.ts";
import { payeeOwner } from "./payroll-move.ts";

const TREE_ID = 0 as TreeId;
const LEAF_INDEX = BigInt(7);
const NOTE_AMOUNT = BigInt(10_000_000);
const SOLANA_OWNER_TAG = 0x53;
const programKey = new PublicKey(PPROLL_PROGRAM_ID);

type Owner = { tag: number; key: Uint8Array; nullifierPk: Bytes32 };

/** A browser ring seed, not the wallet secret: the shape that failed with TRANSACTION_PROGRAM_BUILD. */
async function buildPay(installment: bigint, owner: (ring: ShieldedKeypair, wallet: PublicKey) => Owner): Promise<{ ok: true } | { ok: false; label: string }> {
  await initializePoseidon();
  await init({ threads: 1 });
  const notePda = PublicKey.findProgramAddressSync([Buffer.from("payroll"), Keypair.generate().publicKey.toBuffer()], programKey)[0];
  const viewing = ViewingKey.generate();
  const nullifierKey = ProgramOwner.nullifierKey();
  const ring = ShieldedKeypair.fromKeypair(SigningKey.fromEd25519Bytes(randomBytes(32) as unknown as Bytes32));
  const wallet = Keypair.generate().publicKey;
  try {
    const payrollAddress = ShieldedAddress.forPda({
      pda: notePda.toBytes() as Bytes32,
      nullifierPublicKey: nullifierKey.publicKey() as Bytes32,
      viewingPublicKey: viewing.publicKey(),
    });
    const registry = new Wallet({ identity: payrollAddress }).registry;
    const utxo = new Utxo({ owner: payrollAddress.signingPublicKey, asset: SOL_MINT, amount: NOTE_AMOUNT, blinding: randomBlinding() });
    const hash = utxo.hash(ProgramOwner.nullifierPublicKey(), TREE_ID);
    const source: WalletUtxo = {
      utxo,
      outputContext: { hash, tree: (await treeAddress(TREE_ID)) as Address, leafIndex: LEAF_INDEX },
      nullifier: utxo.nullifier(hash, nullifierKey),
      spent: false,
    };
    const blind = Buffer.from(randomBlinding());
    blind[0] = 0;
    const [blind0, blind1, blind2, blind3] = limbs(blind);
    let label: string | null = null;
    const build = bindProgramTransaction(
      (...args: Parameters<typeof payTransaction>) => {
        try {
          return payTransaction(...args);
        } catch (error) {
          label = error instanceof Error ? error.message : String(error);
          throw error;
        }
      },
      { assets: registry },
    );
    try {
      await build(
        {
          private: {
            txContext: { blindingSeed: randomBlinding(), outputTreeId: TREE_ID },
            note: [toProgramWalletUtxo(source, { nullifierPublicKey: ProgramOwner.nullifierPublicKey(), treeId: TREE_ID, assets: registry })],
            amount: installment,
            blind0,
            blind1,
            blind2,
            blind3,
            payee: owner(ring, wallet),
            payrollAddress: payrollAddress.toBytes(),
          },
          public: { index: BigInt(0), due: BigInt(1), installment: poseidon([be32(installment), blind]), payee: ring.ownerHash() },
        } as unknown as Parameters<typeof payTransaction>[0],
        ring.shieldedAddress().toBytes(),
        wallet.toBase58(),
      );
      return { ok: true };
    } catch {
      return { ok: false, label: label ?? "no circuit label" };
    }
  } finally {
    ring.destroy();
    viewing.destroy();
    nullifierKey.destroy();
  }
}

function walletOwner(ring: ShieldedKeypair, wallet: PublicKey): Owner {
  return { tag: SOLANA_OWNER_TAG, key: wallet.toBuffer(), nullifierPk: ring.nullifierPublicKey() };
}

test("the pay circuit builds when the payee owner is the ring signing key", async () => {
  assert.deepEqual(await buildPay(NOTE_AMOUNT / BigInt(10), payeeOwner), { ok: true });
});

test("the last roll may empty the payroll note", async () => {
  assert.deepEqual(await buildPay(NOTE_AMOUNT, payeeOwner), { ok: true });
});

test("the wallet key misses the committed payee hash", async () => {
  assert.deepEqual(await buildPay(NOTE_AMOUNT / BigInt(10), walletOwner), { ok: false, label: "the note owner" });
});

test("an installment above the note is refused by the circuit", async () => {
  assert.deepEqual(await buildPay(NOTE_AMOUNT * BigInt(2), payeeOwner), { ok: false, label: "the transfer exceeds the balance" });
});
