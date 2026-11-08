import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { Keypair, PublicKey } from "@solana/web3.js";
import type { Bytes32 } from "../../../pescrow/sdk/node_modules/@heliuslabs/spr/dist/keypair/bytes.js";
import type { Address } from "../../../pescrow/sdk/node_modules/@heliuslabs/spr/dist/interface/types.js";
import type { TreeId } from "../../../pescrow/sdk/node_modules/@heliuslabs/spr/dist/transaction/utxo.js";
import type { WalletUtxo } from "../../../pescrow/sdk/node_modules/@heliuslabs/spr/dist/transaction/wallet/state.js";
import type { ProgramTransaction } from "../../../pescrow/sdk/node_modules/@heliuslabs/spr/dist/program/program-transaction.js";
import { ShieldedAddress, ShieldedKeypair, SigningKey, Wallet } from "../../../pescrow/sdk/node_modules/@heliuslabs/spr/dist/index.js";
import { initializePoseidon } from "../../../pescrow/sdk/node_modules/@heliuslabs/spr/dist/hasher/index.js";
import { ViewingKey, randomBlinding } from "../../../pescrow/sdk/node_modules/@heliuslabs/spr/dist/keypair/index.js";
import { ProgramOwner, bindProgramTransaction, toProgramWalletUtxo } from "../../../pescrow/sdk/node_modules/@heliuslabs/spr/dist/program/index.js";
import { treeAddress } from "../../../pescrow/sdk/node_modules/@heliuslabs/spr/dist/interface/pda/index.js";
import { SOL_MINT } from "../../../pescrow/sdk/node_modules/@heliuslabs/spr/dist/transaction/asset.js";
import { Utxo } from "../../../pescrow/sdk/node_modules/@heliuslabs/spr/dist/transaction/utxo.js";
import { PPROLL_PROGRAM_ID } from "../../../src/lib/payroll-account.ts";
import init, { withdrawTransaction } from "../../target/zk/pproll/wasm/node.mjs";
import { returnsToRing, ringOwner } from "./withdraw-note.ts";

const TREE_ID = 0 as TreeId;
const LEAF_INDEX = BigInt(7);
const NOTE_AMOUNT = BigInt(10_000_000);
const SOLANA_OWNER_TAG = 0x53;
const programKey = new PublicKey(PPROLL_PROGRAM_ID);

type Owner = { tag: number; key: Uint8Array; nullifierPk: Bytes32 };
type Built = { ok: true; built: ProgramTransaction; ring: ShieldedKeypair; wallet: PublicKey } | { ok: false; label: string };

/** A browser ring seed, not the wallet secret, as the private balance derives it. */
async function buildWithdraw(owner: (ring: ShieldedKeypair, wallet: PublicKey) => Owner): Promise<Built> {
  let label: string | null = null;
  await initializePoseidon();
  await init({ threads: 1 });
  const wallet = Keypair.generate().publicKey;
  const pool = PublicKey.findProgramAddressSync([Buffer.from("user-pool"), wallet.toBuffer()], programKey)[0];
  const viewing = ViewingKey.generate();
  const nullifierKey = ProgramOwner.nullifierKey();
  const ring = ShieldedKeypair.fromKeypair(SigningKey.fromEd25519Bytes(randomBytes(32) as unknown as Bytes32));
  try {
    const poolAddress = ShieldedAddress.forPda({
      pda: pool.toBytes() as Bytes32,
      nullifierPublicKey: nullifierKey.publicKey() as Bytes32,
      viewingPublicKey: viewing.publicKey(),
    });
    const registry = new Wallet({ identity: poolAddress }).registry;
    const utxo = new Utxo({ owner: poolAddress.signingPublicKey, asset: SOL_MINT, amount: NOTE_AMOUNT, blinding: randomBlinding() });
    const hash = utxo.hash(ProgramOwner.nullifierPublicKey(), TREE_ID);
    const source: WalletUtxo = {
      utxo,
      outputContext: { hash, tree: (await treeAddress(TREE_ID)) as Address, leafIndex: LEAF_INDEX },
      nullifier: utxo.nullifier(hash, nullifierKey),
      spent: false,
    };
    const build = bindProgramTransaction(
      (...args: Parameters<typeof withdrawTransaction>) => {
        try {
          return withdrawTransaction(...args);
        } catch (error) {
          label = error instanceof Error ? error.message : String(error);
          throw error;
        }
      },
      { assets: registry },
    );
    const built = await build(
      {
        private: {
          txContext: { blindingSeed: randomBlinding(), outputTreeId: TREE_ID },
          note: [toProgramWalletUtxo(source, { nullifierPublicKey: ProgramOwner.nullifierPublicKey(), treeId: TREE_ID, assets: registry })],
          owner: owner(ring, wallet),
        },
        public: { hash: poolAddress.ownerHash() },
      },
      ring.shieldedAddress().toBytes(),
      wallet.toBase58(),
    );
    return { ok: true, built, ring, wallet };
  } catch {
    ring.destroy();
    return { ok: false, label: label ?? "no circuit label" };
  } finally {
    viewing.destroy();
    nullifierKey.destroy();
  }
}

function walletOwner(ring: ShieldedKeypair, wallet: PublicKey): Owner {
  return { tag: SOLANA_OWNER_TAG, key: wallet.toBuffer(), nullifierPk: ring.nullifierPublicKey() };
}

function fundedOwnerHashes(built: ProgramTransaction): string[] {
  return built.transaction.outputs
    .filter((output) => !output.isDummy() && output.amount > BigInt(0))
    .map((output) => Buffer.from(output.ownerHash()).toString("hex"));
}

test("the withdrawn note is owned by the ring signing key the private balance spends", async () => {
  const result = await buildWithdraw(ringOwner);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const { built, ring, wallet } = result;
  try {
    assert.notDeepEqual(Buffer.from(ring.signingPublicKey().ed25519()), wallet.toBuffer());
    assert.deepEqual(fundedOwnerHashes(built), [Buffer.from(ring.ownerHash()).toString("hex")]);
    assert.equal(returnsToRing(built, ring), true);
    const [output] = built.transaction.outputs.filter((entry) => !entry.isDummy() && entry.amount > BigInt(0));
    assert.equal(output?.amount, NOTE_AMOUNT);
  } finally {
    ring.destroy();
  }
});

test("the wallet key as note owner is refused before any transaction exists", async () => {
  assert.deepEqual(await buildWithdraw(walletOwner), { ok: false, label: "output slot 0 has an owner no input names" });
});

test("the guard refuses a built withdraw whose note is not the ring key's", async () => {
  const result = await buildWithdraw(ringOwner);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const other = ShieldedKeypair.fromKeypair(SigningKey.fromEd25519Bytes(randomBytes(32) as unknown as Bytes32));
  try {
    assert.equal(returnsToRing(result.built, other), false);
  } finally {
    other.destroy();
    result.ring.destroy();
  }
});

test("the ring owner key is the ring signing key, not the wallet", () => {
  const ring = ShieldedKeypair.fromKeypair(SigningKey.fromEd25519Bytes(randomBytes(32) as unknown as Bytes32));
  const wallet = Keypair.generate().publicKey;
  try {
    const owner = ringOwner(ring);
    assert.equal(owner.tag, SOLANA_OWNER_TAG);
    assert.deepEqual(Buffer.from(owner.key), Buffer.from(ring.signingPublicKey().ed25519()));
    assert.notDeepEqual(Buffer.from(owner.key), wallet.toBuffer());
  } finally {
    ring.destroy();
  }
});
