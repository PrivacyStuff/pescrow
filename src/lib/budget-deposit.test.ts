import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Keypair, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { recentSlotFromCreateInstruction } from "../../pescrow/sdk/src/lookup-slot.ts";
import { PPROLL_PROGRAM_ID } from "./payroll-account.ts";
import { errorText, reduceTxLog, type TxEntry } from "./tx-log.ts";
import { SOL_MINT } from "./chunk-plan.ts";
import {
  BUDGET_ALREADY_HOLDS_NOTE,
  DEPOSIT_COMPUTE_UNIT_LIMIT,
  CIRCUIT_PROOF_LEN,
  DEPOSIT_ACCOUNTS_CHANGED,
  DEPOSIT_IX,
  FUNDED_BUDGET_KEY_MISSING,
  MISSING_BUDGET_VIEWING_KEY,
  NULLIFIER_ROOT_HISTORY_OFFSET,
  POOL_TRANSACT_TAG,
  RING_KEY_NOT_SIGNER,
  ROOT_MOVED,
  TREE_ACCOUNT_LEN,
  TREE_ACCOUNT_TAG,
  UTXO_ROOT_HISTORY_OFFSET,
  VAULT_NOT_FOUND,
  VAULT_WRONG_OWNER,
  activeLookup,
  budgetDepositNotes,
  budgetDepositRefusal,
  budgetNoteLabel,
  chooseBudgetAction,
  cosignWithRingKey,
  depositSimulationConfig,
  depositSimulationFailure,
  depositVersionedTransaction,
  lookupTableTransaction,
  parseBudgetKeyRecord,
  parsePreparedDeposit,
  alignDepositTreeContext,
  feePayerSignature,
  scrubPayrollError,
  readDepositTransact,
  signedDepositFailure,
  viewingKeyBelongsTo,
  selectedBudgetNote,
  simulateBudgetDeposit,
  useFreshBudgetDeposit,
  vaultDepositRefusal,
  waitForLookupTable,
  type LookupReader,
} from "./budget-deposit.ts";

const OWNER = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const HASH = "ab".repeat(32);
const BLOCKHASH = Keypair.generate().publicKey.toBase58();

function vaultBytes(live: number, owner = OWNER, hash = HASH): Uint8Array {
  const data = new Uint8Array(112);
  data[0] = 4;
  data[1] = live;
  data.set(owner, 8);
  for (let index = 0; index < 32; index += 1) data[40 + index] = Number.parseInt(hash.slice(index * 2, index * 2 + 2), 16);
  return data;
}

describe("budget deposit refusal", () => {
  it("rejects a missing viewing secret and a vault that already holds a note", () => {
    assert.equal(budgetDepositRefusal({ viewingSecretHex: null, funded: false }), MISSING_BUDGET_VIEWING_KEY);
    assert.equal(budgetDepositRefusal({ viewingSecretHex: "", funded: false }), MISSING_BUDGET_VIEWING_KEY);
    assert.equal(budgetDepositRefusal({ viewingSecretHex: "abcd", funded: false }), MISSING_BUDGET_VIEWING_KEY);
    assert.equal(budgetDepositRefusal({ viewingSecretHex: HASH, funded: true }), BUDGET_ALREADY_HOLDS_NOTE);
    assert.equal(budgetDepositRefusal({ viewingSecretHex: HASH, funded: false }), null);
  });

  it("reads the vault bytes before a deposit is proved", () => {
    assert.equal(vaultDepositRefusal(vaultBytes(0), OWNER, HASH), null);
    assert.equal(vaultDepositRefusal(vaultBytes(1), OWNER, HASH), BUDGET_ALREADY_HOLDS_NOTE);
    assert.equal(vaultDepositRefusal(vaultBytes(0), OWNER, "cd".repeat(32)), MISSING_BUDGET_VIEWING_KEY);
    assert.equal(vaultDepositRefusal(vaultBytes(0, new Uint8Array(32)), OWNER, HASH), VAULT_WRONG_OWNER);
    assert.equal(vaultDepositRefusal(new Uint8Array(10), OWNER, HASH), VAULT_NOT_FOUND);
  });
});

describe("budget note picker", () => {
  const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const PUDGY = Keypair.generate().publicKey.toBase58();
  const usdcMeta = { name: "USD Coin", symbol: "USDC", image: null };
  const pudgyMeta = { name: "Pudgy Penguins", symbol: null, image: null };
  const notes = [
    { hash: "sol-note-hash-aaaa", amount: "10000000", mint: SOL_MINT },
    { hash: "usdc-100-note-bbbb", amount: "100000000", mint: USDC },
    { hash: "usdc-800-note-cccc", amount: "800000000", mint: USDC },
    { hash: "pudgy-one-note-dddd", amount: "1", mint: PUDGY },
    { hash: "pudgy-four-note-eeee", amount: "4", mint: PUDGY },
    { hash: "empty-sol-note-ffff", amount: "0", mint: SOL_MINT },
    { hash: "empty-token-note-gg", amount: "0", mint: USDC },
  ];

  it("offers every spendable private-balance note and keeps the amount on the note", () => {
    const offered = budgetDepositNotes(notes);
    assert.deepEqual(
      offered.map((note) => note.hash),
      ["sol-note-hash-aaaa", "usdc-100-note-bbbb", "usdc-800-note-cccc", "pudgy-one-note-dddd", "pudgy-four-note-eeee"],
    );
    assert.equal(offered.find((note) => note.mint === PUDGY && note.hash === "pudgy-one-note-dddd")?.amount, "1");
    assert.equal(offered.find((note) => note.hash === "pudgy-four-note-eeee")?.amount, "4");
    assert.equal(budgetDepositNotes([]).length, 0);
  });

  it("labels SOL, a token, and an NFT with the note amount and the asset name", () => {
    const sol = notes[0];
    const hundred = notes[1];
    const eightHundred = notes[2];
    const one = notes[3];
    const four = notes[4];
    assert.ok(sol !== undefined && hundred !== undefined && eightHundred !== undefined && one !== undefined && four !== undefined);
    assert.equal(budgetNoteLabel(sol, 9, null), "0.01 SOL · sol-…aaaa");
    assert.equal(budgetNoteLabel(hundred, 6, usdcMeta), "100 USDC · USD Coin · usdc…bbbb");
    assert.equal(budgetNoteLabel(eightHundred, 6, usdcMeta), "800 USDC · USD Coin · usdc…cccc");
    assert.equal(budgetNoteLabel(one, 0, pudgyMeta), "1 Pudgy Penguins · pudg…dddd");
    assert.equal(budgetNoteLabel(four, 0, pudgyMeta), "4 Pudgy Penguins · pudg…eeee");
    assert.equal(budgetNoteLabel(four, undefined, null).startsWith("4 base units"), true);
  });

  it("keeps the private-balance selection when that note is a token or an NFT", () => {
    const offered = budgetDepositNotes(notes);
    assert.equal(selectedBudgetNote(offered, "", "usdc-800-note-cccc"), "usdc-800-note-cccc");
    assert.equal(selectedBudgetNote(offered, "pudgy-one-note-dddd", "sol-note-hash-aaaa"), "pudgy-one-note-dddd");
    assert.equal(selectedBudgetNote(offered, "missing", "missing"), "sol-note-hash-aaaa");
    assert.equal(selectedBudgetNote([], "pudgy-one-note-dddd", "usdc-100-note-bbbb"), "");
  });
});

describe("budget vault choice", () => {
  const empty = { address: Keypair.generate().publicKey.toBase58(), funded: false };
  const funded = { address: Keypair.generate().publicKey.toBase58(), funded: true };
  const replacement = { address: Keypair.generate().publicKey.toBase58(), funded: false };
  const key = { viewingSecretHex: HASH, ownerHashHex: HASH, vault: replacement.address };

  it("lets a missing key open another vault only when every listed vault is empty", () => {
    assert.deepEqual(chooseBudgetAction([empty], null), { action: "open" });
    assert.deepEqual(chooseBudgetAction([empty, { address: Keypair.generate().publicKey.toBase58(), funded: false }], null), { action: "open" });
    assert.deepEqual(chooseBudgetAction([], null), { action: "open" });
    assert.deepEqual(chooseBudgetAction([empty], { viewingSecretHex: "abcd", ownerHashHex: HASH, vault: empty.address }), { action: "open" });
    assert.deepEqual(chooseBudgetAction([funded], null), { action: "refuse", message: FUNDED_BUDGET_KEY_MISSING });
    assert.deepEqual(chooseBudgetAction([empty, funded], null), { action: "refuse", message: FUNDED_BUDGET_KEY_MISSING });
    assert.deepEqual(chooseBudgetAction([funded], key), { action: "refuse", message: viewingKeyBelongsTo(replacement.address) });
  });

  it("deposits into the vault named by the viewing key", () => {
    const chosen = chooseBudgetAction([empty, replacement], key);
    assert.deepEqual(chosen, {
      action: "deposit",
      vault: replacement.address,
      viewingSecretHex: HASH,
      ownerHashHex: HASH,
    });
    assert.equal(chosen.action === "deposit" && chosen.vault === empty.address, false);
    const sameVault = chooseBudgetAction([empty], { viewingSecretHex: HASH, ownerHashHex: HASH, vault: empty.address });
    assert.equal(sameVault.action === "deposit" && sameVault.vault, empty.address);
    const sessionKey = chooseBudgetAction([empty], { viewingSecretHex: HASH, ownerHashHex: HASH, vault: null });
    assert.equal(sessionKey.action === "deposit" && sessionKey.vault, empty.address);
    assert.deepEqual(chooseBudgetAction([funded], { ...key, vault: funded.address }), {
      action: "refuse",
      message: BUDGET_ALREADY_HOLDS_NOTE,
    });
    const stale = chooseBudgetAction([empty], key);
    assert.deepEqual(stale, { action: "refuse", message: viewingKeyBelongsTo(replacement.address) });
    const listed = { address: "B4dTatRqgLJJLfGs7hw6YKVKzigcqdbDXDqKYc5QKH4D", funded: false };
    const otherKey = "6oajRKsGoEQaESh9Us2RDCfxr6tDNrgVQ5R8eBqjY9g8";
    const otherVault = "D2xxTX4z1rurQaR7Lq9EE7c6bDnj9oJ3jhTLtn9LKZ5E";
    assert.deepEqual(chooseBudgetAction([listed], { viewingSecretHex: HASH, ownerHashHex: HASH, vault: otherKey }), {
      action: "refuse",
      message: viewingKeyBelongsTo(otherKey),
    });
    assert.deepEqual(chooseBudgetAction([listed], { viewingSecretHex: HASH, ownerHashHex: HASH, vault: otherVault }), {
      action: "refuse",
      message: viewingKeyBelongsTo(otherVault),
    });
    assert.equal(
      chooseBudgetAction([listed], { viewingSecretHex: HASH, ownerHashHex: HASH, vault: listed.address }).action === "deposit",
      true,
    );
  });

  it("reads one stored viewing key and ignores a secret that is not 32 bytes", () => {
    const parsed = parseBudgetKeyRecord({ viewingSecretHex: HASH.toUpperCase(), ownerHashHex: HASH, vault: replacement.address });
    assert.deepEqual(parsed, key);
    assert.equal(parseBudgetKeyRecord({ viewingSecretHex: HASH, ownerHashHex: HASH })?.vault, null);
    assert.equal(parseBudgetKeyRecord({ viewingSecretHex: "abcd", ownerHashHex: HASH, vault: replacement.address }), null);
    assert.equal(parseBudgetKeyRecord({ viewingSecretHex: HASH, ownerHashHex: HASH, vault: "not-a-vault" }), null);
  });
});

function depositFixture(): Uint8Array {
  const ciphertext = new Uint8Array(89);
  ciphertext[0] = 1;
  ciphertext[1] = 84;
  ciphertext[5] = 3;
  const body = [
    ...new Uint8Array(8).fill(0xff),
    ...new Uint8Array(33),
    ...new Uint8Array(16),
    0,
    0,
    0,
    1,
    ...new Uint8Array(32),
    0,
    ...new Uint8Array(32),
    1,
    89,
    0,
    ...ciphertext,
    0,
  ];
  const tail = [
    ...new Uint8Array(32).fill(0x11),
    0,
    0,
    1,
    2,
    3,
    ...new Uint8Array(192),
    1,
    ...new Uint8Array(32),
    0,
    1,
    18,
    0,
    0,
    0,
  ];
  return Uint8Array.from([DEPOSIT_IX, ...new Uint8Array(CIRCUIT_PROOF_LEN), ...body, ...tail]);
}

describe("deposit transact prefix", () => {
  it("keeps the ciphertext in the CPI prefix and the tree-context indexes after it", () => {
    const data = depositFixture();
    const fields = readDepositTransact(data);
    assert.ok(fields !== null);
    assert.equal(fields.cpiTag, POOL_TRANSACT_TAG);
    assert.equal(fields.scheme, 3);
    assert.equal(fields.utxoRootIndex, 18);
    assert.equal(fields.nullifierRootIndex, 0);
    const transact = data.subarray(1 + CIRCUIT_PROOF_LEN);
    assert.deepEqual(fields.prefix, transact.subarray(0, fields.prefix.length));
    const cpi = Uint8Array.from([fields.cpiTag, ...transact]);
    assert.equal(cpi[0], POOL_TRANSACT_TAG);
    assert.deepEqual(cpi.subarray(1, 1 + fields.prefix.length), fields.prefix);
    const indexBytes = Uint8Array.from([1, 18, 0, 0, 0]);
    const indexAt = transact.length - indexBytes.length;
    assert.ok(indexAt >= fields.prefix.length);
    assert.deepEqual(transact.subarray(indexAt), indexBytes);
  });

  it("signs the proof made after the address table activates", () => {
    const address = Keypair.generate().publicKey.toBase58();
    const opened = parsePreparedDeposit({
      computeUnitLimit: DEPOSIT_COMPUTE_UNIT_LIMIT,
      programId: PPROLL_PROGRAM_ID,
      dataHex: "07aa",
      keys: [
        { pubkey: address, isSigner: false, isWritable: true },
        { pubkey: address, isSigner: true, isWritable: true },
      ],
      lookupAddresses: [address],
    });
    const proved = parsePreparedDeposit({
      computeUnitLimit: DEPOSIT_COMPUTE_UNIT_LIMIT,
      programId: PPROLL_PROGRAM_ID,
      dataHex: "07bb",
      keys: [
        { pubkey: address, isSigner: false, isWritable: true },
        { pubkey: address, isSigner: true, isWritable: true },
      ],
      lookupAddresses: [address],
    });
    assert.ok(opened !== null && proved !== null);
    assert.equal(useFreshBudgetDeposit(opened, proved).dataHex, "07bb");
    const moved = parsePreparedDeposit({ ...proved, lookupAddresses: [Keypair.generate().publicKey.toBase58()] });
    assert.ok(moved !== null);
    assert.throws(() => useFreshBudgetDeposit(opened, moved), new Error(DEPOSIT_ACCOUNTS_CHANGED));
  });
});

describe("prepared deposit", () => {
  it("keeps a deposit instruction and drops a secret field", () => {
    const address = Keypair.generate().publicKey.toBase58();
    const parsed = parsePreparedDeposit({
      computeUnitLimit: DEPOSIT_COMPUTE_UNIT_LIMIT,
      programId: PPROLL_PROGRAM_ID,
      dataHex: DEPOSIT_IX.toString(16).padStart(2, "0") + "aa",
      keys: [
        { pubkey: address, isSigner: false, isWritable: true },
        { pubkey: address, isSigner: true, isWritable: true },
      ],
      lookupAddresses: [address],
      viewingSecret: HASH,
    });
    assert.equal(parsed?.dataHex, "07aa");
    assert.equal(parsed === null || "viewingSecret" in parsed, false);
    assert.equal(parsePreparedDeposit({ ...parsed, dataHex: "08aa" }), null);
  });

  it("builds a versioned deposit the wallet can sign", () => {
    const payer = Keypair.generate().publicKey;
    const vault = Keypair.generate().publicKey;
    const tail = Keypair.generate().publicKey;
    const lookupKey = Keypair.generate().publicKey;
    const prepared = parsePreparedDeposit({
      computeUnitLimit: DEPOSIT_COMPUTE_UNIT_LIMIT,
      programId: PPROLL_PROGRAM_ID,
      dataHex: "07abcd",
      keys: [
        { pubkey: vault.toBase58(), isSigner: false, isWritable: true },
        { pubkey: payer.toBase58(), isSigner: true, isWritable: true },
        { pubkey: tail.toBase58(), isSigner: false, isWritable: true },
      ],
      lookupAddresses: [tail.toBase58()],
    });
    assert.ok(prepared !== null);
    const tx = depositVersionedTransaction(payer, BLOCKHASH, activeLookup(lookupKey, payer, [tail]), prepared);
    assert.equal(tx.version, 0);
    assert.equal(tx.message.addressTableLookups.length, 1);
    const wire = Buffer.from(tx.serialize()).toString("base64");
    assert.equal(wire.includes(HASH), false);
  });

  it("adds the ring key signature next to the wallet signature, even when the ring key is in the table", () => {
    const payer = Keypair.generate();
    const seed = Uint8Array.from({ length: 32 }, (_, index) => index + 7);
    const ring = Keypair.fromSeed(seed).publicKey;
    const vault = Keypair.generate().publicKey;
    const tail = Keypair.generate().publicKey;
    const prepared = parsePreparedDeposit({
      computeUnitLimit: DEPOSIT_COMPUTE_UNIT_LIMIT,
      programId: PPROLL_PROGRAM_ID,
      dataHex: "07abcd",
      keys: [
        { pubkey: vault.toBase58(), isSigner: false, isWritable: true },
        { pubkey: payer.publicKey.toBase58(), isSigner: true, isWritable: true },
        { pubkey: tail.toBase58(), isSigner: false, isWritable: true },
        { pubkey: ring.toBase58(), isSigner: true, isWritable: false },
      ],
      lookupAddresses: [tail.toBase58(), ring.toBase58()],
    });
    assert.ok(prepared !== null);
    const lookup = activeLookup(Keypair.generate().publicKey, payer.publicKey, [tail, ring]);
    const tx = depositVersionedTransaction(payer.publicKey, BLOCKHASH, lookup, prepared);
    tx.sign([payer]);
    const walletSignature = Buffer.from(tx.signatures[0] ?? []).toString("hex");
    const signed = cosignWithRingKey(tx, seed);
    const signers = signed.message.staticAccountKeys.slice(0, signed.message.header.numRequiredSignatures);
    assert.equal(signers.length, 2);
    const ringAt = signers.findIndex((key) => key.equals(ring));
    assert.ok(ringAt > 0);
    assert.equal(Buffer.from(signed.signatures[0] ?? []).toString("hex"), walletSignature);
    assert.equal(signed.signatures[ringAt]?.some((byte) => byte !== 0), true);
  });

  it("refuses to cosign a deposit that does not name the ring key", () => {
    const payer = Keypair.generate().publicKey;
    const prepared = parsePreparedDeposit({
      computeUnitLimit: DEPOSIT_COMPUTE_UNIT_LIMIT,
      programId: PPROLL_PROGRAM_ID,
      dataHex: "07abcd",
      keys: [
        { pubkey: Keypair.generate().publicKey.toBase58(), isSigner: false, isWritable: true },
        { pubkey: payer.toBase58(), isSigner: true, isWritable: true },
      ],
      lookupAddresses: [Keypair.generate().publicKey.toBase58()],
    });
    assert.ok(prepared !== null);
    const lookup = activeLookup(Keypair.generate().publicKey, payer, []);
    const tx = depositVersionedTransaction(payer, BLOCKHASH, lookup, prepared);
    assert.throws(() => cosignWithRingKey(tx, new Uint8Array(32).fill(3)), new RegExp(RING_KEY_NOT_SIGNER.slice(0, 30)));
    assert.throws(() => cosignWithRingKey(tx, new Uint8Array(31)), new RegExp(RING_KEY_NOT_SIGNER.slice(0, 30)));
  });
});

describe("lookup table", () => {
  it("uses the bank slot after the first recent-slot rejection", async () => {
    const payer = Keypair.generate().publicKey;
    const address = Keypair.generate().publicKey;
    let simulations = 0;
    const connection: LookupReader = {
      async getSlot() {
        return 1_000;
      },
      async getLatestBlockhashAndContext() {
        return { context: { slot: 1_000 }, value: { blockhash: BLOCKHASH } };
      },
      async getLatestBlockhash() {
        return { blockhash: BLOCKHASH };
      },
      async simulateTransaction() {
        simulations += 1;
        if (simulations === 1) {
          return { context: { slot: 1_500 }, value: { err: { InstructionError: [0, "InvalidArgument"] }, logs: ["not a recent slot"] } };
        }
        return { context: { slot: 1_500 }, value: { err: null, logs: [] } };
      },
      async getAddressLookupTable() {
        return { value: null };
      },
    };
    const plan = await lookupTableTransaction(connection, payer, [address]);
    assert.equal(simulations, 2);
    assert.equal(recentSlotFromCreateInstruction(plan.tx.instructions[0]?.data ?? new Uint8Array()), BigInt(1_500));
    assert.equal(plan.tx.feePayer?.equals(payer), true);
  });

  it("waits until the table contains the deposit accounts", async () => {
    const lookup = Keypair.generate().publicKey;
    const payer = Keypair.generate().publicKey;
    const address = Keypair.generate().publicKey;
    let reads = 0;
    const connection: LookupReader = {
      async getSlot() {
        return 10;
      },
      async getLatestBlockhashAndContext() {
        return { context: { slot: 10 }, value: { blockhash: BLOCKHASH } };
      },
      async getLatestBlockhash() {
        return { blockhash: BLOCKHASH };
      },
      async simulateTransaction() {
        return { context: { slot: 10 }, value: { err: null, logs: [] } };
      },
      async getAddressLookupTable() {
        reads += 1;
        if (reads === 1) return { context: { slot: 1 }, value: null };
        return { context: { slot: 10 }, value: activeLookup(lookup, payer, [address]) };
      },
    };
    const table = await waitForLookupTable(connection, lookup, [address], async () => undefined);
    assert.equal(table.key.equals(lookup), true);
    assert.equal(reads, 2);
  });

  it("waits until the table is observed after the slot that extended it", async () => {
    const lookup = Keypair.generate().publicKey;
    const payer = Keypair.generate().publicKey;
    const address = Keypair.generate().publicKey;
    const extended = 5;
    let reads = 0;
    const connection: LookupReader = {
      async getSlot() {
        return 100;
      },
      async getLatestBlockhashAndContext() {
        return { context: { slot: 100 }, value: { blockhash: BLOCKHASH } };
      },
      async getLatestBlockhash() {
        return { blockhash: BLOCKHASH };
      },
      async simulateTransaction() {
        return { context: { slot: 100 }, value: { err: null, logs: [] } };
      },
      async getAddressLookupTable() {
        reads += 1;
        const slot = reads === 1 ? extended : extended + 1;
        return { context: { slot }, value: activeLookup(lookup, payer, [address], extended) };
      },
    };
    const table = await waitForLookupTable(connection, lookup, [address], async () => undefined);
    assert.equal(reads, 2);
    assert.equal(table.state.lastExtendedSlot, extended);
  });
});

describe("deposit simulation", () => {
  const extended = 520_056_221;

  it("asks for the slot after the address table was extended", () => {
    const config = depositSimulationConfig(extended);
    assert.equal(config.commitment, "confirmed");
    assert.equal(config.sigVerify, false);
    assert.equal(config.replaceRecentBlockhash, true);
    assert.equal(config.minContextSlot, extended + 1);
  });

  it("surfaces the program log and scrubs secrets", () => {
    const message = depositSimulationFailure({ InstructionError: [1, { Custom: 118 }] }, [
      "Program 5e6tZK4jSgHWUDW64PqRQwJBgN9VpgFEpcYiw5N9Lux6 failed: custom program error: 0x76",
      `rpc api-key=secret-key hash ${HASH}`,
    ]);
    assert.match(message, /custom program error: 0x76/);
    assert.match(message, /Custom":118/);
    assert.equal(message.includes("secret-key"), false);
    assert.equal(message.includes(HASH), false);
    assert.equal(
      depositSimulationFailure("InvalidAddressLookupTableIndex", null),
      "The budget deposit did not simulate. InvalidAddressLookupTableIndex",
    );
    assert.equal(depositSimulationFailure(null, ["Program failed: custom program error: 0x81"]), BUDGET_ALREADY_HOLDS_NOTE);
  });

  it("retries while the address table is still inactive", async () => {
    let calls = 0;
    const slots: number[] = [];
    const connection: LookupReader = {
      async getSlot() {
        return 1;
      },
      async getLatestBlockhashAndContext() {
        return { context: { slot: 1 }, value: { blockhash: BLOCKHASH } };
      },
      async getLatestBlockhash() {
        return { blockhash: BLOCKHASH };
      },
      async getAddressLookupTable() {
        return { value: null };
      },
      async simulateTransaction(_transaction, config) {
        calls += 1;
        slots.push(config.minContextSlot ?? 0);
        if (calls === 1) return { context: { slot: extended }, value: { err: "InvalidAddressLookupTableIndex", logs: null } };
        return { context: { slot: extended + 1 }, value: { err: null, logs: [] } };
      },
    };
    await simulateBudgetDeposit(connection, {} as VersionedTransaction, extended, async () => undefined);
    assert.equal(calls, 2);
    assert.deepEqual(slots, [extended + 1, extended + 1]);
  });
});

describe("deposit tree context", () => {
  const HASH_LEN = 32;

  function treeWith(utxoIndex: number, utxoRoot: Uint8Array, nullifierIndex: number, nullifierRoot: Uint8Array): Uint8Array {
    const tree = new Uint8Array(TREE_ACCOUNT_LEN);
    tree[0] = TREE_ACCOUNT_TAG;
    tree.set(utxoRoot, UTXO_ROOT_HISTORY_OFFSET + utxoIndex * HASH_LEN);
    tree.set(nullifierRoot, NULLIFIER_ROOT_HISTORY_OFFSET + nullifierIndex * HASH_LEN);
    return tree;
  }

  it("points the context indexes at the slots that still hold the proved roots and leaves the CPI prefix", () => {
    const data = depositFixture();
    const before = readDepositTransact(data);
    assert.ok(before !== null);
    const utxoRoot = Uint8Array.from({ length: HASH_LEN }, (_, index) => index + 1);
    const nullifierRoot = Uint8Array.from({ length: HASH_LEN }, (_, index) => index + 40);
    const aligned = alignDepositTreeContext(data, treeWith(9, utxoRoot, 4, nullifierRoot), { utxoRoot, nullifierRoot });
    const after = readDepositTransact(aligned);
    assert.ok(after !== null);
    assert.equal(after.utxoRootIndex, 9);
    assert.equal(after.nullifierRootIndex, 4);
    assert.deepEqual(after.prefix, before.prefix);
    assert.equal(after.cpiTag, before.cpiTag);
    assert.equal(after.scheme, before.scheme);
  });

  it("keeps the instruction when the named slots already hold those roots", () => {
    const data = depositFixture();
    const fields = readDepositTransact(data);
    assert.ok(fields !== null);
    const utxoRoot = Uint8Array.from({ length: HASH_LEN }, () => 2);
    const nullifierRoot = Uint8Array.from({ length: HASH_LEN }, () => 3);
    const tree = treeWith(fields.utxoRootIndex, utxoRoot, fields.nullifierRootIndex, nullifierRoot);
    assert.equal(alignDepositTreeContext(data, tree, { utxoRoot, nullifierRoot }), data);
  });

  it("stops when the proved root is gone or zero", () => {
    const data = depositFixture();
    const utxoRoot = Uint8Array.from({ length: HASH_LEN }, () => 5);
    const nullifierRoot = Uint8Array.from({ length: HASH_LEN }, () => 6);
    const tree = treeWith(9, utxoRoot, 4, nullifierRoot);
    const missing = Uint8Array.from({ length: HASH_LEN }, () => 7);
    assert.throws(() => alignDepositTreeContext(data, tree, { utxoRoot: missing, nullifierRoot }), new Error(ROOT_MOVED));
    assert.throws(() => alignDepositTreeContext(data, tree, { utxoRoot: new Uint8Array(HASH_LEN), nullifierRoot }), new Error(ROOT_MOVED));
    assert.throws(() => alignDepositTreeContext(data, new Uint8Array(1), { utxoRoot, nullifierRoot }), new Error("The budget deposit could not be prepared."));
  });
});

describe("signed deposit failure", () => {
  it("names the fee-payer signature and drops secrets", () => {
    const payer = Keypair.generate();
    const message = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: new PublicKey(BLOCKHASH).toBase58(),
      instructions: [],
    }).compileToV0Message();
    const tx = new VersionedTransaction(message);
    assert.equal(feePayerSignature(tx), null);
    tx.sign([payer]);
    const signature = feePayerSignature(tx);
    assert.ok(signature !== null);
    const failed = signedDepositFailure(
      signature,
      new Error(`TransactProofVerificationFailed custom program error: 0x1b60 api-key=secret-key ${HASH}`),
    );
    assert.match(failed.message, new RegExp(`transaction ${signature} failed`));
    assert.equal(failed.message.includes("secret-key"), false);
    assert.equal(failed.message.includes(HASH), false);
    const started: readonly TxEntry[] = reduceTxLog([], {
      kind: "start",
      id: 1,
      copy: { step: "Put in budget", explanation: "Moves the note into the budget." },
      origin: "wallet",
      at: 1000,
    });
    const logged = reduceTxLog(started, { kind: "failed", id: 1, error: errorText(failed, "The budget deposit failed."), at: 2000 });
    assert.equal(logged[0]?.status, "failed");
    assert.equal(logged[0]?.signature, signature);
  });
});

describe("scrubPayrollError", () => {
  it("removes an api key and a hex secret", () => {
    const text = scrubPayrollError(`rpc failed api-key=secret-key note ${HASH}`);
    assert.equal(text.includes("secret-key"), false);
    assert.equal(text.includes(HASH), false);
    assert.match(text, /REDACTED/);
    assert.match(text, /\[redacted\]/);
  });

  it("drops prover stderr noise and keeps a program error", () => {
    const text = scrubPayrollError(
      [
        "(node:1) [MODULE_TYPELESS_PACKAGE_JSON] Warning: Module type of file:///budget-deposit.ts is not specified and it doesn't parse as CommonJS.",
        "using deprecated parameters for the initialization function; pass a single object instead",
        "TRANSACTION_PROGRAM_BUILD",
        "custom program error: 0x1b60",
      ].join("\n"),
    );
    assert.equal(text, "custom program error: 0x1b60");
  });
});
