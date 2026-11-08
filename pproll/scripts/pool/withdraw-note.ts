// Ring seed and budget viewing secret arrive on stdin. They are not printed or written.

import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { join as pathJoin } from "node:path";
import { Connection, PublicKey, type AccountMeta } from "@solana/web3.js";
import type { Bytes32 } from "../../../pescrow/sdk/node_modules/@heliuslabs/spr/dist/keypair/bytes.js";
import type { Address } from "../../../pescrow/sdk/node_modules/@heliuslabs/spr/dist/interface/types.js";
import {
  LocalKeys,
  ShieldedAddress,
  ShieldedKeypair,
  SigningKey,
  Wallet,
  createSprClient,
  syncWallet,
} from "../../../pescrow/sdk/node_modules/@heliuslabs/spr/dist/index.js";
import { SignedTeePolicy } from "../../../pescrow/sdk/node_modules/@heliuslabs/spr/dist/client/index.js";
import { encodeTransactInstructionData } from "../../../pescrow/sdk/node_modules/@heliuslabs/spr/dist/interface/index.js";
import { initializePoseidon } from "../../../pescrow/sdk/node_modules/@heliuslabs/spr/dist/hasher/index.js";
import { ViewingKey, randomBlinding } from "../../../pescrow/sdk/node_modules/@heliuslabs/spr/dist/keypair/index.js";
import {
  ProgramOwner,
  ShieldedPda,
  bindProgramTransaction,
  toProgramWalletUtxo,
  transactCpiAccounts,
} from "../../../pescrow/sdk/node_modules/@heliuslabs/spr/dist/program/index.js";
import type { ProgramTransaction, ProgramTransactionKeys } from "../../../pescrow/sdk/node_modules/@heliuslabs/spr/dist/program/program-transaction.js";
import type { WalletUtxo } from "../../../pescrow/sdk/node_modules/@heliuslabs/spr/dist/transaction/wallet/state.js";
import type { TransactInstructionData } from "../../../pescrow/sdk/node_modules/@heliuslabs/spr/dist/interface/types.js";
import { heliusRpcUrl } from "../../../src/lib/helius-rpc.ts";
import { DEPOSIT_COMPUTE_UNIT_LIMIT, type PreparedDeposit } from "../../../src/lib/budget-deposit.ts";
import { BUDGET_HAS_NO_NOTE, BUDGET_KEY_NOT_IN_BROWSER, WITHDRAW_IX, vaultWithdrawRefusal } from "../../../src/lib/budget-close.ts";
import init, { WithdrawProver, withdrawTransaction } from "../../target/zk/pproll/wasm/node.mjs";

const PROGRAM_ID = "5e6tZK4jSgHWUDW64PqRQwJBgN9VpgFEpcYiw5N9Lux6";
const RING1_TREE = "777pvSGe5LaBd9nCczvE2FXEauiwtfGJ5XRpjKyniGor";
const POOL_ID = "ring1GaLCuJnkUMVkX2JeZLTTX17wKsV4fZmPVzXANW";
const ESCROW_NOTE = "xUiK4RZz4JerbRzZjHVaBgaQM46A45eYhZ2uBMggNzY";
const POOL_SEED = "user-pool";
const SOLANA_OWNER_TAG = 0x53;
const TREE_ID = 0;
const FIELD_BYTES = 32;
const PROOF_A = 32;
const PROOF_B = 64;
const PROOF_C = 32;
const ROLE_WRITABLE = 1;
const ROLE_READONLY_SIGNER = 2;
const ROLE_WRITABLE_SIGNER = 3;
const HEX_32 = /^[0-9a-f]{64}$/i;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const ESCROW_NOTE_BYTES = new PublicKey(ESCROW_NOTE).toBytes();
const HERE = fileURLToPath(new URL(".", import.meta.url));
const programKey = new PublicKey(PROGRAM_ID);
const WITHDRAW_OWNER_NOT_RING = "The withdrawn note would not return to the private balance.";

type Client = Awaited<ReturnType<typeof createSprClient>>;

type WithdrawJob = {
  readonly owner: string;
  readonly vault: string;
  readonly seed: string;
  readonly viewingSecret: string;
  readonly ownerHash: string;
};

export async function prepareBudgetWithdraw(value: unknown): Promise<PreparedDeposit> {
  const job = readJob(value);
  const owner = new PublicKey(job.owner);
  const vault = new PublicKey(job.vault);
  const seed = Buffer.from(job.seed, "hex");
  const secret = Buffer.from(job.viewingSecret, "hex");
  let secretCopy = new Uint8Array(0);
  let viewing: ViewingKey | null = null;
  let shielded: ShieldedKeypair | null = null;
  let pda: ShieldedPda | null = null;
  let pdaKeys: LocalKeys | null = null;
  try {
    if (seed.length !== FIELD_BYTES || secret.length !== FIELD_BYTES) {
      throw new Error("The budget withdraw could not be prepared.");
    }
    const connection = new Connection(heliusRpcUrl(), "confirmed");
    const info = await connection.getAccountInfo(vault, "confirmed");
    const refusal = vaultWithdrawRefusal(info?.data ?? new Uint8Array(), owner.toBytes(), job.ownerHash);
    if (refusal !== null) throw new Error(refusal);
    secretCopy = Uint8Array.from(secret);
    viewing = ViewingKey.fromBytes(bytes32(secretCopy));
    await initializePoseidon();
    await init({ threads: 1 });
    const pool = poolPda(owner);
    const destination = pdaAddress(pool, viewing);
    if (Buffer.from(destination.ownerHash()).toString("hex") !== job.ownerHash) {
      throw new Error(BUDGET_KEY_NOT_IN_BROWSER);
    }
    const seedCopy = Uint8Array.from(seed);
    shielded = ShieldedKeypair.fromKeypair(SigningKey.fromEd25519Bytes(bytes32(seedCopy)));
    seedCopy.fill(0);
    const client = await createSprClient({
      solanaRpcUrl: heliusRpcUrl(),
      proverTee: SignedTeePolicy.forNetwork("devnet"),
    });
    pda = openPool(pool, viewing);
    pdaKeys = poolKeys(pda, client);
    const pdaWallet = new Wallet({ identity: pda.shieldedAddress() });
    await syncWallet({ client, wallet: pdaWallet, keys: pdaKeys });
    const note = findPoolNote(pdaWallet);
    const build = bindProgramTransaction(withdrawTransaction, { assets: pdaWallet.registry });
    const built = await build(
      {
        private: {
          txContext: { blindingSeed: randomBlinding(), outputTreeId: TREE_ID },
          note: [toProgramWalletUtxo(note, { nullifierPublicKey: ProgramOwner.nullifierPublicKey(), treeId: TREE_ID, assets: pdaWallet.registry })],
          owner: ringOwner(shielded),
        },
        public: { hash: destination.ownerHash() },
      },
      shielded.shieldedAddress().toBytes(),
      owner.toBase58(),
    );
    if (!returnsToRing(built, shielded)) throw new Error(WITHDRAW_OWNER_NOT_RING);
    const prover = withdrawProver();
    try {
      const proved = await proveMove(client, pdaKeys, shielded, built, prover);
      const tail = await tailAccounts(owner, pool, proved.proved);
      const data = Buffer.concat([Buffer.from([WITHDRAW_IX]), proved.data]);
      return {
        computeUnitLimit: DEPOSIT_COMPUTE_UNIT_LIMIT,
        programId: PROGRAM_ID,
        dataHex: data.toString("hex"),
        keys: vaultAccounts(vault, owner, tail).map(metaJson),
        lookupAddresses: unique(tail.map((key) => key.pubkey.toBase58())),
      };
    } finally {
      prover.free();
    }
  } finally {
    seed.fill(0);
    secret.fill(0);
    secretCopy.fill(0);
    pdaKeys?.destroy();
    pda?.destroy();
    shielded?.destroy();
    viewing?.destroy();
  }
}

/**
 * The private balance lists and spends notes under `shielded.ownerHash()`, the ring signing key.
 * The withdraw circuit does not bind this owner, so the wallet key here would land a note the balance cannot see.
 */
export function ringOwner(shielded: ShieldedKeypair): { tag: number; key: Uint8Array; nullifierPk: Bytes32 } {
  return { tag: SOLANA_OWNER_TAG, key: shielded.signingPublicKey().ed25519(), nullifierPk: shielded.nullifierPublicKey() };
}

export function returnsToRing(built: ProgramTransaction, shielded: ShieldedKeypair): boolean {
  const ring = Buffer.from(shielded.ownerHash());
  const funded = built.transaction.outputs.filter((output) => !output.isDummy() && output.amount > BigInt(0));
  return funded.length > 0 && funded.every((output) => Buffer.from(output.ownerHash()).equals(ring));
}

function readJob(value: unknown): WithdrawJob {
  if (typeof value !== "object" || value === null) throw new Error("The budget withdraw could not be prepared.");
  const record = value as Record<string, unknown>;
  if (!pubkey(record.owner) || !pubkey(record.vault)) {
    throw new Error("The budget withdraw could not be prepared.");
  }
  if (!hex32(record.seed) || !hex32(record.viewingSecret) || !hex32(record.ownerHash)) {
    throw new Error("The budget withdraw could not be prepared.");
  }
  return {
    owner: record.owner,
    vault: record.vault,
    seed: record.seed.toLowerCase(),
    viewingSecret: record.viewingSecret.toLowerCase(),
    ownerHash: record.ownerHash.toLowerCase(),
  };
}

function openPool(pool: PublicKey, viewing: ViewingKey): ShieldedPda {
  return ShieldedPda.withViewingKey(bytes32(pool.toBytes()), ProgramOwner.nullifierKey(), viewing.clone());
}

function poolKeys(pda: ShieldedPda, client: Client): LocalKeys {
  const viewing = pda.viewingKey();
  const nullifier = ProgramOwner.nullifierKey();
  try {
    return LocalKeys.fromKeys(
      {
        address: pda.shieldedAddress(),
        viewingKeys: [viewing],
        nullifierKey: nullifier,
      },
      client.proofService,
    );
  } finally {
    viewing.destroy();
    nullifier.destroy();
  }
}

function findPoolNote(wallet: Wallet): WalletUtxo {
  const notes = wallet
    .utxos()
    .filter((utxo) => utxo.outputContext.tree === asAddress(RING1_TREE) && !utxo.spent)
    .filter((utxo) => !Buffer.from(utxo.outputContext.hash).equals(Buffer.from(ESCROW_NOTE_BYTES)))
    .filter((utxo) => utxo.utxo.amount > BigInt(0))
    .sort((left, right) => (left.utxo.amount < right.utxo.amount ? -1 : 1));
  const note = notes[0];
  if (note === undefined) throw new Error(BUDGET_HAS_NO_NOTE);
  return note;
}

async function proveMove(
  client: Client,
  keys: LocalKeys,
  recipient: ProgramTransactionKeys,
  built: ProgramTransaction,
  prover: WithdrawProver,
): Promise<{ proved: TransactInstructionData; data: Buffer }> {
  const proved = await client.proveTransact(built.transaction.encryptWithKeys(recipient), keys);
  const circuit = prover.prove(built.proofInputs).compressedProof;
  if (circuit.a.byteLength !== PROOF_A || circuit.b.byteLength !== PROOF_B || circuit.c.byteLength !== PROOF_C) {
    throw new Error("circuit proof is not 128 bytes");
  }
  return {
    proved,
    data: Buffer.concat([
      Buffer.from(circuit.a),
      Buffer.from(circuit.b),
      Buffer.from(circuit.c),
      Buffer.from(encodeTransactInstructionData(proved)),
    ]),
  };
}

async function tailAccounts(payer: PublicKey, pool: PublicKey, proved: TransactInstructionData): Promise<AccountMeta[]> {
  const tail = await transactCpiAccounts({
    payer: asAddress(payer.toBase58()),
    inputTree: asAddress(RING1_TREE),
    outputTree: asAddress(RING1_TREE),
    ownerSigners: [],
    signerPdas: [asAddress(pool.toBase58())],
    data: proved,
  });
  const privacy = tail[2];
  if (privacy?.address !== POOL_ID) throw new Error("pool account is not at tail index 2");
  return tail.map(metaToKey);
}

function withdrawProver(): WithdrawProver {
  const zkDir = pathJoin(HERE, "../../target/zk/pproll");
  const provingKey = readFileSync(pathJoin(zkDir, "withdraw.pk"));
  const keyHashHex = readFileSync(pathJoin(zkDir, "withdraw.pk.sha256"), "utf8").slice(0, FIELD_BYTES * 2);
  return WithdrawProver.fromKey(provingKey, Buffer.from(keyHashHex, "hex"));
}

function vaultAccounts(vault: PublicKey, owner: PublicKey, tail: AccountMeta[]): AccountMeta[] {
  return [
    { pubkey: vault, isSigner: false, isWritable: true },
    { pubkey: owner, isSigner: true, isWritable: true },
    ...tail,
  ];
}

function poolPda(owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from(POOL_SEED), owner.toBuffer()], programKey)[0];
}

function pdaAddress(pda: PublicKey, viewing: ViewingKey): ShieldedAddress {
  const key = ProgramOwner.nullifierKey();
  try {
    return ShieldedAddress.forPda({
      pda: bytes32(pda.toBytes()),
      nullifierPublicKey: bytes32(key.publicKey()),
      viewingPublicKey: viewing.publicKey(),
    });
  } finally {
    key.destroy();
  }
}

function metaToKey(meta: { address: string; role: number }): AccountMeta {
  return {
    pubkey: new PublicKey(meta.address),
    isSigner: meta.role === ROLE_READONLY_SIGNER || meta.role === ROLE_WRITABLE_SIGNER,
    isWritable: meta.role === ROLE_WRITABLE || meta.role === ROLE_WRITABLE_SIGNER,
  };
}

function metaJson(meta: AccountMeta): PreparedDeposit["keys"][number] {
  return { pubkey: meta.pubkey.toBase58(), isSigner: meta.isSigner, isWritable: meta.isWritable };
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function asAddress(value: string): Address {
  return new PublicKey(value).toBase58() as Address;
}

function bytes32(value: Uint8Array): Bytes32 {
  if (value.byteLength !== FIELD_BYTES) throw new Error("expected 32 bytes");
  return value as Bytes32;
}

function pubkey(value: unknown): value is string {
  return typeof value === "string" && BASE58.test(value);
}

function hex32(value: unknown): value is string {
  return typeof value === "string" && HEX_32.test(value);
}
