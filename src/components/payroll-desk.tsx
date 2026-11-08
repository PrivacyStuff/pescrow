"use client";

import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { Buffer } from "buffer";
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, VersionedTransaction } from "@solana/web3.js";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  BUDGET_ALREADY_HOLDS_NOTE,
  MISSING_BUDGET_VIEWING_KEY,
  budgetDepositNotes,
  budgetNoteLabel,
  cosignWithRingKey,
  depositVersionedTransaction,
  lookupReader,
  lookupTableTransaction,
  parseBudgetKeyRecord,
  parsePreparedDeposit,
  feePayerSignature,
  scrubPayrollError,
  selectedBudgetNote,
  signedDepositFailure,
  simulateBudgetDeposit,
  useFreshBudgetDeposit,
  waitForLookupTable,
} from "@/lib/budget-deposit";
import {
  budgetKeyFor,
  chooseBudgetSlot,
  fundingBudget,
  parseBudgetKeyList,
  rememberBudget,
  withBudgetMint,
  type BudgetKeyRecord,
} from "@/lib/budget-keys";
import { BUDGET_HAS_NO_NOTE, budgetCloseOffer, parsePreparedWithdraw } from "@/lib/budget-close";
import { SOL_DECIMALS, SOL_MINT } from "@/lib/chunk-plan";
import { parseBaseAmount } from "@/lib/escrow-params";
import {
  BUDGET_NOTE_TOO_SMALL,
  MAX_ROLLS,
  MISSING_PAYROLL_KEY,
  NOT_READY_TO_CRANK,
  NOT_READY_TO_FUND,
  PAYROLL_NOT_FUNDED,
  PAYROLL_SIMULATION_FAILED,
  PUT_NOTE_IN_BUDGET,
  MILESTONE_NOT_DUE,
  budgetForRolls,
  hasPayrollKey,
  parsePreparedRoll,
  payrollStep,
  rollsInBudget,
  type PayrollStepInput,
} from "@/lib/payroll-roll";
import {
  BUDGET_APPROVE_IX,
  MAX_PERIOD_SECS,
  PAYROLL_ACCOUNT_LEN,
  PERIOD_DAY_SECS,
  PERIOD_HOUR_SECS,
  PERIOD_WEEK_SECS,
  PPROLL_PROGRAM_ID,
  STREAM_APPROVE_IX,
  VAULT_ACCOUNT_LEN,
  payrollApproveData,
  periodLabel,
  scheduleAt,
  splitPayrolls,
  vaultOpenData,
  type PayrollView,
  type VaultView,
} from "@/lib/payroll-account";
import { AssetFields } from "./dashboard/asset-fields";
import { formatAsset, formatBase } from "./dashboard/format";
import { EMPTY_RING_SESSION, RingBalance, type RingApi, type RingSession } from "./dashboard/ring-balance";
import { TX_COPY } from "./dashboard/tx-copy";
import { useTxActivity, useTxLog } from "./dashboard/tx-drawer";
import type { AssetDraft } from "./dashboard/types";
import { afterSigning, wasTxLogged, withoutSignatures, type TxCopy } from "@/lib/tx-log";

const PROGRAM_ID = new PublicKey(PPROLL_PROGRAM_ID);
const CLOCK = new PublicKey("SysvarC1ock11111111111111111111111111111111");
const CUSTOM_CADENCE = "custom";
const TERMS_KEY = "pproll-roll";
const TERMS_PREFIX = "pproll-terms:";
const VAULT_SECRET = "pproll-budget";
const BUDGET_KEY_EVENT = "pproll-budget-key";
const FIELD = "mt-2 w-full border border-line bg-transparent px-3 py-2";
const DEFAULT_ROLLS = "3";
const DIGITS = /^\d{1,20}$/;

type RollTerms = {
  readonly mint: string;
  /** Installment per roll, in base units. */
  readonly amount: string;
  /** Total moved onto the payroll by Fund. Absent on terms saved before multi-roll payrolls. */
  readonly budget?: string;
  readonly rolls?: number;
  readonly decimals: number;
  readonly viewingSecretHex: string;
  readonly installmentBlindingHex: string;
  readonly budgetBlindingHex: string;
};

type PreparedVault = {
  readonly ownerHashHex?: string;
  readonly viewingPublicHex?: string;
  readonly viewingSecretHex?: string;
  readonly instructionHex?: string;
  readonly installmentBlindingHex?: string;
  readonly budgetBlindingHex?: string;
};

const CADENCES = [
  { id: String(PERIOD_HOUR_SECS), label: "Hourly" },
  { id: String(PERIOD_DAY_SECS), label: "Daily" },
  { id: String(PERIOD_WEEK_SECS), label: "Weekly" },
  { id: CUSTOM_CADENCE, label: "Custom seconds" },
] as const;

function short(value: string): string {
  return value.length <= 12 ? value : `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function when(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

export function PayrollDesk() {
  const { connection } = useConnection();
  const { publicKey, connected, signTransaction } = useWallet();
  const txLog = useTxLog();
  const [ringSession, setRingSession] = useState<RingSession>(EMPTY_RING_SESSION);
  const onRingSession = useCallback((session: RingSession) => {
    setRingSession(session);
  }, []);
  const [payrolls, setPayrolls] = useState<PayrollView[]>([]);
  const [budgets, setBudgets] = useState<VaultView[]>([]);
  const [terms, setTerms] = useState<Record<string, RollTerms>>({});
  const [destinataire, setDestinataire] = useState("");
  const [asset, setAsset] = useState<AssetDraft>({ kind: "sol", mint: "", amount: "0.01" });
  const [rolls, setRolls] = useState(DEFAULT_ROLLS);
  const [cadence, setCadence] = useState<string>(String(PERIOD_HOUR_SECS));
  const [customSeconds, setCustomSeconds] = useState("");
  const [startIn, setStartIn] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  useTxActivity(busy);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [budgetNote, setBudgetNote] = useState("");
  const ringApi = useRef<RingApi | null>(null);

  const now = useClock();
  const wallet = publicKey?.toBase58() ?? null;
  const budgetKeys = useBudgetKeys(wallet);
  const budgetAction = chooseBudgetSlot(budgets, budgetKeys);
  const fundedFor = (mint: string | null): boolean => fundingBudget(budgets, budgetKeys, mint) !== null;
  const formBusy = busy !== null || ringSession.busy;
  const depositNotes = budgetDepositNotes(ringSession.ring?.notes ?? []);
  const selectedDeposit = selectedBudgetNote(depositNotes, budgetNote, ringSession.selectedHash);
  const { issued, received } = splitPayrolls(payrolls);

  useEffect(() => {
    if (wallet === null) return;
    const storageKey = `${VAULT_SECRET}:${wallet}`;
    if (parseBudgetKeyList(parseJson(storageItem(localStorage, storageKey))).length > 0) return;
    const session = parseBudgetKeyList(parseJson(storageItem(sessionStorage, storageKey)));
    if (session.length === 0) return;
    try {
      localStorage.setItem(storageKey, JSON.stringify(session));
      window.dispatchEvent(new Event(BUDGET_KEY_EVENT));
    } catch (error) {
      if (!(error instanceof DOMException)) throw error;
    }
  }, [wallet]);

  useEffect(() => {
    if (wallet === null) {
      setPayrolls([]);
      setBudgets([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/payroll", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "wallet-payrolls", wallet }),
        });
        const payload = (await response.json()) as { ok?: boolean; result?: { payrolls?: PayrollView[] }; error?: string };
        if (cancelled) return;
        if (!response.ok || payload.ok === false) {
          setFailure(scrubPayrollError(payload.error ?? "The payrolls could not be read.").trim() || "The payrolls could not be read.");
          return;
        }
        setPayrolls(payload.result?.payrolls ?? []);
        const budgetPayload = await fetch("/api/payroll", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "wallet-budget", wallet }),
        });
        const budgetBody = (await budgetPayload.json()) as { ok?: boolean; error?: string; result?: { budgets?: VaultView[] } };
        if (cancelled) return;
        if (!budgetPayload.ok || budgetBody.ok === false) {
          setFailure(scrubPayrollError(budgetBody.error ?? "The budget could not be read.").trim() || "The budget could not be read.");
          return;
        }
        setBudgets(budgetBody.result?.budgets ?? []);
        setTerms(readTerms());
        setFailure(null);
      } catch (error) {
        if (!cancelled) setFailure(error instanceof Error ? error.message : "The payroll desk could not be reached.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [wallet]);

  async function post(body: unknown): Promise<{ result?: PreparedVault & { signature?: string; payrolls?: PayrollView[]; budgets?: VaultView[] } }> {
    const response = await fetch("/api/payroll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = (await response.json()) as {
      ok?: boolean;
      error?: string;
      result?: PreparedVault & { signature?: string; payrolls?: PayrollView[]; budgets?: VaultView[] };
    };
    if (!response.ok || payload.ok === false) throw new Error(payload.error ?? "The payroll command failed.");
    return payload;
  }

  function reportMoveFailure(copy: TxCopy, error: unknown, fallback: string): void {
    if (wasTxLogged(error)) return;
    const raw = error instanceof Error && error.message.length > 0 ? error.message : fallback;
    const shown = scrubPayrollError(raw).trim();
    if (shown.length === 0) return;
    txLog.fail(copy, shown);
  }

  async function refresh(): Promise<void> {
    if (wallet === null) return;
    const payload = await post({ action: "wallet-payrolls", wallet });
    setPayrolls(payload.result?.payrolls ?? []);
  }

  async function submit(tx: Transaction | VersionedTransaction): Promise<string> {
    const payload = await post({ action: "wallet-submit", tx: Buffer.from(tx.serialize()).toString("base64") });
    const signature = payload.result?.signature;
    if (typeof signature !== "string") throw new Error("The transaction did not return a signature.");
    return signature;
  }

  function signAndSubmit<T extends Transaction | VersionedTransaction>(copy: TxCopy, tx: T, cosign: (signed: T) => T = (signed) => signed): Promise<string> {
    const sign = signTransaction;
    if (sign === undefined) return Promise.reject(new Error("Select a wallet."));
    return txLog.run(copy, "wallet", async (signed) => submit(cosign(await afterSigning(sign, signed)(tx))));
  }

  function periodSecs(): number | null {
    if (cadence === CUSTOM_CADENCE) {
      if (!/^\d+$/.test(customSeconds)) return null;
      const value = Number(customSeconds);
      if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_PERIOD_SECS) return null;
      return value;
    }
    const value = Number(cadence);
    return Number.isSafeInteger(value) ? value : null;
  }

  async function openBudget(): Promise<void> {
    if (publicKey === null || wallet === null || signTransaction === undefined) return;
    const existing = chooseBudgetSlot(budgets, readBudgetKeys(wallet));
    if (existing.action !== "open") {
      setFailure("An empty budget is already open. Put a note in it first.");
      return;
    }
    setBusy("Opening the budget");
    setNotice(null);
    setFailure(null);
    const account = Keypair.generate();
    try {
      const prepared = await post({ action: "prepare-vault", owner: wallet });
      const ownerHash = hexToBytes(prepared.result?.ownerHashHex);
      const viewing = hexToBytes(prepared.result?.viewingPublicHex);
      const secret = prepared.result?.viewingSecretHex;
      const data = ownerHash === null || viewing === null ? null : vaultOpenData(ownerHash, viewing);
      const vaultAddress = account.publicKey.toBase58();
      const record =
        secret === undefined || ownerHash === null
          ? null
          : parseBudgetKeyRecord({
              viewingSecretHex: secret,
              ownerHashHex: Buffer.from(ownerHash).toString("hex"),
              vault: vaultAddress,
            });
      if (data === null || record === null || record.vault !== vaultAddress) throw new Error("The budget key could not be prepared.");
      const rent = await connection.getMinimumBalanceForRentExemption(VAULT_ACCOUNT_LEN);
      const tx = new Transaction().add(
        SystemProgram.createAccount({
          fromPubkey: publicKey,
          newAccountPubkey: account.publicKey,
          lamports: rent,
          space: VAULT_ACCOUNT_LEN,
          programId: PROGRAM_ID,
        }),
        new TransactionInstruction({
          keys: [
            { pubkey: account.publicKey, isSigner: true, isWritable: true },
            { pubkey: publicKey, isSigner: true, isWritable: true },
          ],
          programId: PROGRAM_ID,
          data: Buffer.from(data),
        }),
      );
      tx.feePayer = publicKey;
      tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
      tx.partialSign(account);
      const signature = await signAndSubmit(TX_COPY.openBudget, tx);
      storeBudgetKeys(
        wallet,
        rememberBudget(readBudgetKeys(wallet), {
          viewingSecretHex: record.viewingSecretHex,
          ownerHashHex: record.ownerHashHex,
          vault: vaultAddress,
          mint: null,
        }),
      );
      setNotice(`Budget ${vaultAddress} is open. Payrolls draw from it. ${signature}`);
      setBudgets((current) => (current.some((row) => row.address === vaultAddress) ? current : [...current, { address: vaultAddress, funded: false }]));
      try {
        const listed = await post({ action: "wallet-budget", wallet });
        const rows = listed.result?.budgets ?? [];
        setBudgets(rows.some((row) => row.address === vaultAddress) ? rows : [...rows, { address: vaultAddress, funded: false }]);
      } catch {
        setNotice(`Budget ${vaultAddress} is open. Refresh the page to see it. ${signature}`);
      }
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "The budget did not open.");
    } finally {
      setBusy(null);
    }
  }

  async function fundBudget(): Promise<void> {
    if (publicKey === null || wallet === null || signTransaction === undefined) return;
    const choice = chooseBudgetSlot(budgets, readBudgetKeys(wallet));
    if (choice.action !== "deposit") {
      setFailure(choice.action === "refuse" ? choice.message : "Open a budget first.");
      return;
    }
    const seed = ringSession.seed;
    if (seed === null) {
      setFailure("Unlock the private balance before putting a note in the budget.");
      return;
    }
    const note = depositNotes.find((row) => row.hash === selectedDeposit) ?? null;
    if (note === null) {
      setFailure("Pick a note from the private balance.");
      return;
    }
    setBusy("Putting the note in the budget");
    setNotice(null);
    setFailure(null);
    try {
      const prepared = await post({
        action: "prepare-deposit",
        owner: wallet,
        vault: choice.vault,
        note: note.hash,
        seed: Buffer.from(seed).toString("hex"),
        viewingSecret: choice.viewingSecretHex,
        ownerHash: choice.ownerHashHex,
      });
      const plan = parsePreparedDeposit(prepared.result);
      if (plan === null) throw new Error("The budget deposit could not be prepared.");
      const reader = lookupReader(connection);
      setBusy("Opening the address table");
      const lookup = await lookupTableTransaction(
        reader,
        publicKey,
        plan.lookupAddresses.map((address) => new PublicKey(address)),
      );
      await signAndSubmit(TX_COPY.lookupTable, lookup.tx);
      setBusy("Waiting for the address table");
      const table = await waitForLookupTable(
        reader,
        lookup.lookup,
        plan.lookupAddresses.map((address) => new PublicKey(address)),
      );
      setBusy("Proving the budget deposit again");
      const provedAgain = await post({
        action: "prepare-deposit",
        owner: wallet,
        vault: choice.vault,
        note: note.hash,
        seed: Buffer.from(seed).toString("hex"),
        viewingSecret: choice.viewingSecretHex,
        ownerHash: choice.ownerHashHex,
      });
      const fresh = parsePreparedDeposit(provedAgain.result);
      if (fresh === null) throw new Error("The budget deposit could not be prepared.");
      const signedPlan = useFreshBudgetDeposit(plan, fresh);
      const blockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
      setBusy("Signing the budget deposit");
      const depositTx = depositVersionedTransaction(publicKey, blockhash, table, signedPlan);
      const sign = signTransaction;
      if (sign === undefined) throw new Error("Select a wallet.");
      const signature = await txLog.run(TX_COPY.depositBudget, "wallet", async (markSigned) => {
        const walletSigned = await afterSigning(sign, markSigned)(depositTx);
        let signedTx = walletSigned;
        try {
          signedTx = cosignWithRingKey(walletSigned, seed);
          await simulateBudgetDeposit(reader, signedTx, table.state.lastExtendedSlot);
          return await submit(signedTx);
        } catch (error) {
          throw signedDepositFailure(feePayerSignature(signedTx), error);
        }
      });
      storeBudgetKeys(wallet, withBudgetMint(readBudgetKeys(wallet), choice.vault, note.mint));
      setFailure(null);
      setNotice(`The shielded note is in the budget. ${signature}`);
      try {
        const listed = await post({ action: "wallet-budget", wallet });
        setBudgets(listed.result?.budgets ?? []);
        await ringApi.current?.refreshNotes();
      } catch {
        setNotice(`The shielded note is in the budget. Refresh the page to see it. ${signature}`);
      }
    } catch (error) {
      reportMoveFailure(TX_COPY.depositBudget, error, "The note did not move into the budget.");
    } finally {
      setBusy(null);
    }
  }

  async function closeBudget(vaultAddress: string): Promise<void> {
    if (publicKey === null || wallet === null || signTransaction === undefined) return;
    const listed = budgets.find((row) => row.address === vaultAddress);
    if (listed === undefined) {
      setFailure("The budget account is not a vault.");
      return;
    }
    const choice = budgetCloseOffer(listed, budgetKeyFor(readBudgetKeys(wallet), vaultAddress));
    if (choice.action !== "withdraw") {
      setFailure(choice.message);
      return;
    }
    if (ringSession.seed === null) {
      setFailure("Unlock the private balance before closing the budget.");
      return;
    }
    setBusy("Closing the budget");
    setNotice(null);
    setFailure(null);
    try {
      const prepared = await post({
        action: "prepare-withdraw",
        owner: wallet,
        vault: choice.vault,
        seed: Buffer.from(ringSession.seed).toString("hex"),
        viewingSecret: choice.viewingSecretHex,
        ownerHash: choice.ownerHashHex,
      });
      const plan = parsePreparedWithdraw(prepared.result);
      if (plan === null) throw new Error("The budget withdraw could not be prepared.");
      const reader = lookupReader(connection);
      setBusy("Opening the address table");
      const lookup = await lookupTableTransaction(
        reader,
        publicKey,
        plan.lookupAddresses.map((address) => new PublicKey(address)),
      );
      await signAndSubmit(TX_COPY.lookupTable, lookup.tx);
      setBusy("Waiting for the address table");
      const table = await waitForLookupTable(
        reader,
        lookup.lookup,
        plan.lookupAddresses.map((address) => new PublicKey(address)),
      );
      const blockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
      setBusy("Signing the budget withdraw");
      const withdrawTx = depositVersionedTransaction(publicKey, blockhash, table, plan);
      const simulation = await connection.simulateTransaction(withdrawTx, { sigVerify: false });
      if (simulation.value.err) {
        const logs = (simulation.value.logs ?? []).join("\n");
        if (logs.includes("PoolEmpty")) throw new Error(BUDGET_HAS_NO_NOTE);
        throw new Error("The budget withdraw did not simulate.");
      }
      const signature = await signAndSubmit(TX_COPY.withdrawBudget, withdrawTx);
      setFailure(null);
      setNotice(`The shielded note is back in the private balance. ${signature}`);
      setBudgets((current) => current.map((row) => (row.address === choice.vault ? { ...row, funded: false } : row)));
      try {
        const refreshed = await post({ action: "wallet-budget", wallet });
        const rows = refreshed.result?.budgets ?? [];
        setBudgets(rows.map((row) => (row.address === choice.vault ? { ...row, funded: false } : row)));
        await ringApi.current?.refreshNotes();
      } catch {
        setNotice(`The shielded note is back in the private balance. Refresh the page to see it. ${signature}`);
      }
    } catch (error) {
      reportMoveFailure(TX_COPY.withdrawBudget, error, "The budget did not close.");
    } finally {
      setBusy(null);
    }
  }

  async function openPayroll(): Promise<void> {
    if (publicKey === null || wallet === null || signTransaction === undefined) return;
    if (budgets.length === 0) {
      setFailure("Open a budget first. Every payroll draws from it.");
      return;
    }
    let payee: PublicKey;
    try {
      payee = new PublicKey(destinataire.trim());
    } catch {
      setFailure("The destinataire is not a Solana address.");
      return;
    }
    if (payee.equals(publicKey)) {
      setFailure("The destinataire has to be a different address.");
      return;
    }
    const period = periodSecs();
    const startDelay = /^\d+$/.test(startIn) ? Number(startIn) : null;
    const start = period === null || startDelay === null ? null : scheduleAt(Math.floor(Date.now() / 1000), period, startDelay);
    if (start === null || period === null) {
      setFailure("Enter a payment rate from 1 second through 366 days, and a start that is still ahead.");
      return;
    }
    setBusy("Opening the payroll");
    setNotice(null);
    setFailure(null);
    const payroll = Keypair.generate();
    try {
      const decimals = await assetDecimals(asset);
      const base = decimals === null ? null : parseBaseAmount(asset.kind === "nft" ? "1" : asset.amount, decimals);
      if (base === null || decimals === null) {
        setFailure("Enter an amount for the token.");
        return;
      }
      const budget = budgetForRolls(base, rolls.trim());
      if (budget === null) {
        setFailure(`Enter a number of rolls from 1 through ${MAX_ROLLS}.`);
        return;
      }
      const rollCount = Number(rolls.trim());
      const mint = asset.kind === "sol" ? SOL_MINT : asset.mint.trim();
      const prepared = await post({
        action: "prepare-payroll",
        payroll: payroll.publicKey.toBase58(),
        payee: payee.toBase58(),
        installment: base.toString(),
        budget: budget.toString(),
        startAt: start.toString(),
        periodSecs: String(period),
      });
      const instruction = hexToBytes(prepared.result?.instructionHex);
      const viewingSecretHex = prepared.result?.viewingSecretHex;
      const installmentBlindingHex = prepared.result?.installmentBlindingHex;
      const budgetBlindingHex = prepared.result?.budgetBlindingHex;
      if (instruction === null || viewingSecretHex === undefined || installmentBlindingHex === undefined || budgetBlindingHex === undefined) {
        throw new Error("The payroll terms could not be prepared.");
      }
      const saved = readTerms();
      const record: RollTerms = {
        mint,
        amount: base.toString(),
        budget: budget.toString(),
        rolls: rollCount,
        decimals,
        viewingSecretHex,
        installmentBlindingHex,
        budgetBlindingHex,
      };
      saved[payroll.publicKey.toBase58()] = record;
      rememberJson(TERMS_KEY, saved);
      rememberJson(`${TERMS_PREFIX}${payroll.publicKey.toBase58()}`, record);
      setTerms(saved);
      const rent = await connection.getMinimumBalanceForRentExemption(PAYROLL_ACCOUNT_LEN);
      const tx = new Transaction().add(
        SystemProgram.createAccount({
          fromPubkey: publicKey,
          newAccountPubkey: payroll.publicKey,
          lamports: rent,
          space: PAYROLL_ACCOUNT_LEN,
          programId: PROGRAM_ID,
        }),
        new TransactionInstruction({
          keys: [
            { pubkey: payroll.publicKey, isSigner: true, isWritable: true },
            { pubkey: publicKey, isSigner: true, isWritable: true },
          ],
          programId: PROGRAM_ID,
          data: Buffer.from(instruction),
        }),
      );
      tx.feePayer = publicKey;
      tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
      tx.partialSign(payroll);
      const signature = await signAndSubmit(TX_COPY.openPayroll, tx);
      setNotice(
        `Payroll ${payroll.publicKey.toBase58()} is open. ${rollCount} rolls of ${formatAsset(base.toString(), mint, decimals)}, ${formatAsset(budget.toString(), mint, decimals)} in total, from the budget. ${signature}`,
      );
      await refresh();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "The payroll did not open.");
    } finally {
      setBusy(null);
    }
  }

  async function approve(row: PayrollView): Promise<void> {
    if (publicKey === null || signTransaction === undefined) return;
    setBusy("Approving");
    setNotice(null);
    setFailure(null);
    try {
      const owner = row.kind === "budget" && row.role === "payee" ? hexToBytes(ringSession.ownerHashHex ?? undefined) : null;
      const approval =
        row.kind === "budget" && row.role === "payee"
          ? owner === null || owner.length !== 32
            ? null
            : payrollApproveData(owner)
          : Uint8Array.of(row.kind === "budget" ? BUDGET_APPROVE_IX : STREAM_APPROVE_IX);
      if (approval === null) throw new Error("Unlock the private balance before approving. Connect signs the ring key.");
      setBusy("Approving");
      const tx = new Transaction().add(
        new TransactionInstruction({
          keys: [
            { pubkey: new PublicKey(row.address), isSigner: false, isWritable: true },
            { pubkey: publicKey, isSigner: true, isWritable: false },
            { pubkey: CLOCK, isSigner: false, isWritable: false },
          ],
          programId: PROGRAM_ID,
          data: Buffer.from(approval),
        }),
      );
      tx.feePayer = publicKey;
      tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
      const signature = await signAndSubmit(TX_COPY.approvePayroll, tx);
      setNotice(`Approved ${short(row.address)}. ${signature}`);
      await refresh();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "The approval failed.");
    } finally {
      setBusy(null);
    }
  }

  async function submitMove(plan: NonNullable<ReturnType<typeof parsePreparedRoll>>, signing: string, copy: TxCopy): Promise<string> {
    if (publicKey === null || signTransaction === undefined) throw new Error("Select a wallet.");
    const reader = lookupReader(connection);
    const addresses = plan.lookupAddresses.map((address) => new PublicKey(address));
    setBusy("Opening the address table");
    const lookup = await lookupTableTransaction(reader, publicKey, addresses);
    await signAndSubmit(TX_COPY.lookupTable, lookup.tx);
    setBusy("Waiting for the address table");
    const table = await waitForLookupTable(reader, lookup.lookup, addresses);
    const blockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
    setBusy(signing);
    const move = depositVersionedTransaction(publicKey, blockhash, table, plan);
    const simulation = await connection.simulateTransaction(move, { sigVerify: false });
    if (simulation.value.err) {
      const logs = (simulation.value.logs ?? []).join("\n");
      if (logs.includes("TooEarly")) throw new Error(MILESTONE_NOT_DUE);
      if (logs.includes("PoolEmpty")) throw new Error(PUT_NOTE_IN_BUDGET);
      if (logs.includes("NotFunded")) throw new Error(PAYROLL_NOT_FUNDED);
      throw new Error(PAYROLL_SIMULATION_FAILED);
    }
    return signAndSubmit(copy, move);
  }

  async function fundPayroll(row: PayrollView): Promise<void> {
    if (wallet === null) return;
    const roll = terms[row.address];
    const budget = fundingBudget(budgets, budgetKeys, roll?.mint ?? null);
    const step = payrollStep(stepInput(row, roll, budgetKeys.length > 0, budget !== null, now));
    if (step.action === "missing-payroll-key") {
      setFailure(MISSING_PAYROLL_KEY);
      return;
    }
    if (step.action === "missing-budget-key" || budgetKeys.length === 0) {
      setFailure(MISSING_BUDGET_VIEWING_KEY);
      return;
    }
    if (step.action === "need-note" || budget === null || roll === undefined) {
      setFailure(PUT_NOTE_IN_BUDGET);
      return;
    }
    if (step.action !== "fund") return;
    setBusy("Funding the payroll");
    setNotice(null);
    setFailure(null);
    try {
      const prepared = await post({
        action: "prepare-initiate",
        owner: wallet,
        payroll: row.address,
        vault: budget.vault,
        viewingSecret: roll.viewingSecretHex,
        budgetViewingSecret: budget.viewingSecretHex,
        budgetAmount: payrollBudget(roll),
        budgetBlinding: roll.budgetBlindingHex,
      }).catch((error: unknown) => {
        if (error instanceof Error && error.message === BUDGET_NOTE_TOO_SMALL) throw new Error(noteTooSmall(roll));
        throw error;
      });
      const plan = parsePreparedRoll(prepared.result);
      if (plan === null) throw new Error(NOT_READY_TO_FUND);
      const signature = await submitMove(plan, "Signing the payroll funding", TX_COPY.fundPayroll);
      setFailure(null);
      setNotice(`The budget note is on payroll ${row.address}. The destinataire can crank each roll once it is due. ${signature}`);
      try {
        await refresh();
        const listed = await post({ action: "wallet-budget", wallet });
        setBudgets(listed.result?.budgets ?? []);
      } catch {
        setNotice(`The budget note is on payroll ${row.address}. Refresh the page to see it. ${signature}`);
      }
    } catch (error) {
      reportMoveFailure(TX_COPY.fundPayroll, error, NOT_READY_TO_FUND);
    } finally {
      setBusy(null);
    }
  }

  async function crankPayroll(row: PayrollView): Promise<void> {
    if (wallet === null) return;
    const roll = terms[row.address];
    const step = payrollStep(stepInput(row, roll, false, false, now));
    if (step.action === "missing-payroll-key") {
      setFailure(MISSING_PAYROLL_KEY);
      return;
    }
    if (step.action === "due") {
      setFailure(`The next roll is due at ${when(step.dueAt)}.`);
      return;
    }
    if (step.action === "finished") {
      setFailure(rollsPaid(step.rolls));
      return;
    }
    if (step.action !== "crank" || roll === undefined) return;
    if (ringSession.seed === null) {
      setFailure("Unlock the private balance before cranking.");
      return;
    }
    setBusy("Cranking the payroll");
    setNotice(null);
    setFailure(null);
    try {
      const prepared = await post({
        action: "prepare-pay",
        owner: wallet,
        payroll: row.address,
        seed: Buffer.from(ringSession.seed).toString("hex"),
        viewingSecret: roll.viewingSecretHex,
        installmentAmount: roll.amount,
        installmentBlinding: roll.installmentBlindingHex,
      });
      const plan = parsePreparedRoll(prepared.result);
      if (plan === null) throw new Error(NOT_READY_TO_CRANK);
      const signature = await submitMove(plan, "Signing the roll", TX_COPY.crankPayroll);
      setFailure(null);
      setNotice(`Roll paid from ${short(row.address)}. ${signature}`);
      try {
        await refresh();
      } catch {
        setNotice(`Roll paid from ${short(row.address)}. Refresh the page to see it. ${signature}`);
      }
    } catch (error) {
      reportMoveFailure(TX_COPY.crankPayroll, error, NOT_READY_TO_CRANK);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <p className="text-sm tracking-[0.18em] text-stamp uppercase">pproll</p>
      <h1 className="mt-4 max-w-3xl font-serif text-5xl tracking-[-0.035em] md:text-6xl">Open a salary. See both sides.</h1>
      <p className="mt-6 max-w-2xl leading-7 text-muted">
        Issued lists the salaries this wallet opened. Received lists the salaries that name this wallet. Fund moves the budget note onto a payroll. Crank pays one due roll to the destinataire.
      </p>

      <RingBalance desk="balance" apiRef={ringApi} paused={busy !== null} onSession={onRingSession} />
      {ringSession.ownerHashHex !== null ? (
        <p className="mt-4 max-w-3xl break-all text-sm leading-6">Shielded owner {ringSession.ownerHashHex}</p>
      ) : null}

      {notice !== null ? <p className="mt-8 max-w-3xl break-all text-sm leading-6">{withoutSignatures(notice)}</p> : null}
      {failure !== null ? <p className="mt-8 max-w-3xl break-all text-sm leading-6 text-stamp">{failure}</p> : null}

      {connected ? (
        <section className="mt-12 border-t border-line pt-10">
          <h2 className="font-serif text-3xl tracking-[-0.03em]">Budget</h2>
          <p className="mt-3 max-w-xl text-sm leading-6 text-muted">
            This account is the budget. It starts with no shielded note. A note is deposited into it from your ring, and every payroll draws its rolls from that note. The note has to be larger than one roll, because funding leaves the remainder in the budget.
          </p>
          {budgets.length === 0 && budgetAction.action !== "deposit" ? <p className="mt-4 text-sm text-muted">No budget for this wallet yet.</p> : null}
          <ul className="mt-4 space-y-4 text-sm">
            {budgets.map((budget) => {
              const key = budgetKeyFor(budgetKeys, budget.address);
              const close = budgetCloseOffer(budget, key);
              return (
                <li key={budget.address} className="break-all">
                  <p>
                    {budget.address} <span className="text-muted">{budget.funded ? "shielded note" : "no shielded note"}</span>
                    {budget.funded && key?.mint ? <span className="text-muted"> · {short(key.mint)}</span> : null}
                  </p>
                  {close.action === "stay" ? <p className="mt-1 max-w-xl leading-6 text-muted">{close.message}</p> : null}
                  {close.action === "stop" ? <p className="mt-1 max-w-xl leading-6 text-stamp">{close.message}</p> : null}
                  {close.action === "withdraw" ? (
                    <div className="mt-2">
                      {ringSession.seed === null ? (
                        <p className="text-muted">Unlock the private balance before closing the budget.</p>
                      ) : null}
                      <button
                        type="button"
                        className="mt-2 border border-foreground px-4 py-2 disabled:opacity-40"
                        disabled={formBusy || ringSession.seed === null}
                        onClick={() => void closeBudget(budget.address)}
                      >
                        Close budget
                      </button>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {budgetAction.action === "refuse" ? <p className="mt-4 max-w-xl break-all text-sm leading-6 text-stamp">{budgetAction.message}</p> : null}
          {budgetAction.action === "open" && budgets.length > 0 ? (
            <p className="mt-4 max-w-xl text-sm leading-6 text-muted">
              A budget holds one note, so one token. Open another budget to pay in another token. A payroll draws from the budget holding its token.
            </p>
          ) : null}
          {budgetAction.action === "open" ? (
            <button type="button" className="mt-4 border border-foreground px-4 py-2 text-sm disabled:opacity-40" disabled={formBusy} onClick={() => void openBudget()}>
              {budgets.length === 0 ? "Open budget" : "Open a new budget"}
            </button>
          ) : null}
          {budgetAction.action === "deposit" ? (
            <div className="mt-4 max-w-xl">
              {budgets.length !== 1 || budgets[0]?.address !== budgetAction.vault ? (
                <p className="mb-4 break-all text-sm">The note goes into {budgetAction.vault}.</p>
              ) : null}
              {depositNotes.length === 0 ? (
                <p className="text-sm text-muted">Shield SOL, a token, or an NFT into the private balance, then put that note in the budget.</p>
              ) : (
                <label className="block text-sm">
                  Note
                  <select className={FIELD} value={selectedDeposit} onChange={(event) => setBudgetNote(event.target.value)}>
                    {depositNotes.map((note) => (
                      <option key={note.hash} value={note.hash}>
                        {budgetNoteLabel(note, ringSession.assets[note.mint]?.decimals, ringSession.metadata[note.mint])}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {ringSession.seed === null ? (
                <p className="mt-4 text-sm text-muted">Unlock the private balance before putting a note in the budget.</p>
              ) : null}
              <button
                type="button"
                className="mt-4 border border-foreground px-4 py-2 text-sm disabled:opacity-40"
                disabled={formBusy || depositNotes.length === 0 || ringSession.seed === null}
                onClick={() => void fundBudget()}
              >
                Put in budget
              </button>
            </div>
          ) : null}
        </section>
      ) : null}

      {connected ? (
        <section className="mt-12 border-t border-line pt-10">
          <h2 className="font-serif text-3xl tracking-[-0.03em]">Open a payroll</h2>
          <p className="mt-3 max-w-xl text-sm leading-6 text-muted">
            The payment rate, the token, and the amount per roll are written onto the payroll. The destinataire binds their shielded address when they approve. Each roll is taken from the budget.
          </p>
          <label className="mt-4 block max-w-xl text-sm">
            Destinataire
            <input className={FIELD} value={destinataire} onChange={(event) => setDestinataire(event.target.value)} />
          </label>
          <label className="mt-4 block max-w-xs text-sm">
            Payment rate
            <select className={FIELD} value={cadence} onChange={(event) => setCadence(event.target.value)}>
              {CADENCES.map((item) => (
                <option key={item.id} value={item.id}>{item.label}</option>
              ))}
            </select>
          </label>
          {cadence === CUSTOM_CADENCE ? (
            <label className="mt-4 block max-w-xs text-sm">
              Period in seconds
              <input className={FIELD} inputMode="numeric" value={customSeconds} onChange={(event) => setCustomSeconds(event.target.value)} />
            </label>
          ) : null}
          <label className="mt-4 block max-w-xs text-sm">
            Seconds until the first period starts
            <input className={FIELD} inputMode="numeric" value={startIn} onChange={(event) => setStartIn(event.target.value)} />
          </label>
          <AssetFields legend="Amount per roll" value={asset} disabled={formBusy} onChange={setAsset} />
          <label className="mt-4 block max-w-xs text-sm">
            Number of rolls
            <input
              className={FIELD}
              type="number"
              inputMode="numeric"
              min={1}
              max={MAX_ROLLS}
              step={1}
              value={rolls}
              disabled={formBusy}
              onChange={(event) => setRolls(event.target.value)}
            />
          </label>
          <p className="mt-2 max-w-xl text-sm text-muted">{formTotal(asset, rolls)}</p>
          <button type="button" className="mt-4 border border-foreground px-4 py-2 text-sm disabled:opacity-40" disabled={formBusy} onClick={() => void openPayroll()}>
            Open payroll
          </button>
        </section>
      ) : null}

      <PayrollList
        title="Issued"
        empty={wallet === null ? "Select a wallet to see the payrolls you opened." : "No open payroll issued by this wallet."}
        rows={issued}
        terms={terms}
        busy={formBusy}
        now={now}
        fundedFor={fundedFor}
        hasBudgetKey={budgetKeys.length > 0}
        ringUnlocked={ringSession.seed !== null}
        onApprove={(row) => void approve(row)}
        onFund={(row) => void fundPayroll(row)}
        onCrank={(row) => void crankPayroll(row)}
      />
      <PayrollList
        title="Received"
        empty={wallet === null ? "Select a wallet to see the payrolls that name you." : "No open payroll names this wallet."}
        rows={received}
        terms={terms}
        busy={formBusy}
        now={now}
        fundedFor={fundedFor}
        hasBudgetKey={budgetKeys.length > 0}
        ringUnlocked={ringSession.seed !== null}
        onApprove={(row) => void approve(row)}
        onFund={(row) => void fundPayroll(row)}
        onCrank={(row) => void crankPayroll(row)}
      />
    </div>
  );
}

function PayrollList({
  title,
  empty,
  rows,
  terms,
  busy,
  now,
  fundedFor,
  hasBudgetKey,
  ringUnlocked,
  onApprove,
  onFund,
  onCrank,
}: {
  title: string;
  empty: string;
  rows: readonly PayrollView[];
  terms: Record<string, RollTerms>;
  busy: boolean;
  now: number | null;
  fundedFor: (mint: string | null) => boolean;
  hasBudgetKey: boolean;
  ringUnlocked: boolean;
  onApprove: (row: PayrollView) => void;
  onFund: (row: PayrollView) => void;
  onCrank: (row: PayrollView) => void;
}) {
  return (
    <section className="mt-12 border-t border-line pt-10">
      <h2 className="font-serif text-3xl tracking-[-0.03em]">{title}</h2>
      {rows.length === 0 ? <p className="mt-4 text-sm text-muted">{empty}</p> : null}
      <ul className="mt-6 space-y-8">
        {rows.map((row) => {
          const mineApproved = row.role === "employer" ? row.employerApproved : row.payeeApproved;
          const roll = terms[row.address];
          const step = payrollStep(stepInput(row, roll, hasBudgetKey, fundedFor(roll?.mint ?? null), now));
          return (
            <li key={row.address} className="text-sm leading-7">
              <p className="break-all">{row.address}</p>
              {roll !== undefined ? <p>{rollSummary(roll)}</p> : null}
              <p className="text-muted">
                {row.kind === "budget" ? "Budget payroll" : "Per-period salary"} · {row.status} · {periodLabel(row.periodSecs)} · {row.role === "employer" ? "you pay" : "you receive"}
              </p>
              <p>Employer {short(row.employer)} · destinataire {short(row.payee)}</p>
              <p className="text-muted">Starts {when(row.startAt)} · approve until {when(row.deadline)}</p>
              {!mineApproved && row.status === "Proposed" ? (
                <button type="button" className="mt-3 border border-foreground px-4 py-2 disabled:opacity-40" disabled={busy} onClick={() => onApprove(row)}>
                  {row.kind === "budget" && row.role === "payee" ? "Approve with shielded address" : "Approve"}
                </button>
              ) : null}
              {step.action === "fund" ? (
                <button type="button" className="mt-3 border border-foreground px-4 py-2 disabled:opacity-40" disabled={busy} onClick={() => onFund(row)}>
                  Fund payroll
                </button>
              ) : null}
              {step.action === "crank" ? (
                <>
                  {ringUnlocked ? null : <p className="mt-3 text-muted">Unlock the private balance before cranking.</p>}
                  <button type="button" className="mt-3 border border-foreground px-4 py-2 disabled:opacity-40" disabled={busy || !ringUnlocked} onClick={() => onCrank(row)}>
                    Crank
                  </button>
                </>
              ) : null}
              {step.action === "due" ? <p className="mt-3 text-muted">The next roll is due at {when(step.dueAt)}.</p> : null}
              {step.action === "finished" ? <p className="mt-3 text-muted">{rollsPaid(step.rolls)}</p> : null}
              {step.action === "missing-payroll-key" ? <p className="mt-3 text-stamp">{MISSING_PAYROLL_KEY}</p> : null}
              {step.action === "missing-budget-key" ? <p className="mt-3 text-stamp">{MISSING_BUDGET_VIEWING_KEY}</p> : null}
              {step.action === "need-note" ? <p className="mt-3 text-muted">{PUT_NOTE_IN_BUDGET}</p> : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function hexToBytes(hex: string | undefined): Uint8Array | null {
  if (hex === undefined || hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let index = 0; index < out.length; index += 1) out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return out;
}

function readTerms(): Record<string, RollTerms> {
  try {
    const terms: Record<string, RollTerms> = {};
    const parsed = parseJson(storageItem(sessionStorage, TERMS_KEY));
    if (typeof parsed === "object" && parsed !== null) {
      for (const [address, value] of Object.entries(parsed)) {
        const row = rollTerms(value);
        if (row !== null) terms[address] = row;
      }
    }
    for (let index = 0; index < sessionStorage.length; index += 1) {
      const key = sessionStorage.key(index);
      if (key === null || !key.startsWith(TERMS_PREFIX)) continue;
      const row = rollTerms(parseJson(storageItem(sessionStorage, key)));
      if (row !== null) terms[key.slice(TERMS_PREFIX.length)] = row;
    }
    return terms;
  } catch {
    return {};
  }
}

function rollTerms(value: unknown): RollTerms | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.mint !== "string" || typeof row.amount !== "string" || typeof row.decimals !== "number") return null;
  if (!Number.isInteger(row.decimals) || row.decimals < 0) return null;
  if (typeof row.viewingSecretHex !== "string" || typeof row.installmentBlindingHex !== "string" || typeof row.budgetBlindingHex !== "string") return null;
  if (row.budget !== undefined && (typeof row.budget !== "string" || !DIGITS.test(row.budget))) return null;
  if (row.rolls !== undefined && (typeof row.rolls !== "number" || !Number.isInteger(row.rolls) || row.rolls < 1 || row.rolls > MAX_ROLLS)) return null;
  return {
    mint: row.mint,
    amount: row.amount,
    ...(row.budget === undefined ? {} : { budget: row.budget }),
    ...(row.rolls === undefined ? {} : { rolls: row.rolls }),
    decimals: row.decimals,
    viewingSecretHex: row.viewingSecretHex,
    installmentBlindingHex: row.installmentBlindingHex,
    budgetBlindingHex: row.budgetBlindingHex,
  };
}

function stepInput(
  row: PayrollView,
  roll: RollTerms | undefined,
  budgetKeyPresent: boolean,
  budgetFunded: boolean,
  now: number | null,
): PayrollStepInput {
  return {
    kind: row.kind,
    role: row.role,
    status: row.status,
    employerApproved: row.employerApproved,
    payeeApproved: row.payeeApproved,
    frozen: row.frozen,
    payeeHashZero: row.payeeHashZero,
    startAt: row.startAt,
    periodSecs: row.periodSecs,
    nextRedeem: row.nextRedeem,
    budgetFunded,
    hasPayrollKey: hasPayrollKey(roll ?? null),
    hasBudgetKey: budgetKeyPresent,
    rollsTotal: roll === undefined ? null : rollsInBudget(roll.amount, roll.budget),
    now,
  };
}

/** Terms saved before multi-roll payrolls committed the installment as the budget. */
function payrollBudget(roll: RollTerms): string {
  return roll.budget ?? roll.amount;
}

function noteTooSmall(roll: RollTerms): string {
  const total = formatAsset(payrollBudget(roll), roll.mint, roll.decimals);
  return `The budget note holds ${total} or less. Funding this payroll needs a note larger than ${total}, because the budget keeps the change.`;
}

function rollsPaid(rolls: number): string {
  return rolls === 1 ? "The only roll is paid." : `All ${rolls} rolls are paid.`;
}

function rollSummary(roll: RollTerms): string {
  const each = formatAsset(roll.amount, roll.mint, roll.decimals);
  const count = rollsInBudget(roll.amount, roll.budget);
  if (count === null || count === 1) return `Each roll pays ${each}.`;
  return `${count} rolls of ${each}, ${formatAsset(payrollBudget(roll), roll.mint, roll.decimals)} in total.`;
}

/** Live total for the open form. Token decimals are read only on submit, so tokens use the typed precision. */
function formTotal(asset: AssetDraft, rollsText: string): string {
  const text = asset.kind === "nft" ? "1" : asset.amount.trim();
  const match = /^(\d{1,20})(?:\.(\d{1,18}))?$/.exec(text);
  if (match === null) return "Enter an amount per roll to see the total.";
  const fraction = match[2] ?? "";
  const decimals = asset.kind === "sol" ? SOL_DECIMALS : fraction.length;
  if (fraction.length > decimals) return "Enter an amount per roll to see the total.";
  const installment = BigInt(`${match[1]}${fraction.padEnd(decimals, "0")}`);
  const total = budgetForRolls(installment, rollsText.trim());
  if (total === null) return `Enter a number of rolls from 1 through ${MAX_ROLLS}.`;
  if (asset.kind === "sol") return `Total ${formatAsset(total.toString(), SOL_MINT, SOL_DECIMALS)}. The budget note must hold more than this.`;
  const unit = asset.kind === "nft" ? " NFT" : asset.mint.trim() === "" ? " tokens" : ` · ${short(asset.mint.trim())}`;
  return `Total ${formatBase(total.toString(), decimals)}${unit}. The budget note must hold more than this.`;
}

function useClock(): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setNow(Math.floor(Date.now() / 1000));
    tick();
    const timer = window.setInterval(tick, 1_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

type BudgetKeySnapshot = {
  readonly wallet: string;
  readonly raw: string;
  readonly keys: readonly BudgetKeyRecord[];
};

const NO_BUDGET_KEYS: readonly BudgetKeyRecord[] = [];
let budgetKeySnapshotCache: BudgetKeySnapshot | null = null;

function useBudgetKeys(wallet: string | null): readonly BudgetKeyRecord[] {
  return useSyncExternalStore(
    subscribeBudgetKey,
    () => budgetKeySnapshot(wallet),
    () => NO_BUDGET_KEYS,
  );
}

function budgetKeySnapshot(wallet: string | null): readonly BudgetKeyRecord[] {
  if (wallet === null) return NO_BUDGET_KEYS;
  const storageKey = `${VAULT_SECRET}:${wallet}`;
  const raw = `${storageItem(localStorage, storageKey) ?? ""}\n${storageItem(sessionStorage, storageKey) ?? ""}`;
  if (budgetKeySnapshotCache !== null && budgetKeySnapshotCache.wallet === wallet && budgetKeySnapshotCache.raw === raw) {
    return budgetKeySnapshotCache.keys;
  }
  const keys = readBudgetKeys(wallet);
  budgetKeySnapshotCache = { wallet, raw, keys };
  return keys;
}

function subscribeBudgetKey(onChange: () => void): () => void {
  window.addEventListener("storage", onChange);
  window.addEventListener(BUDGET_KEY_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(BUDGET_KEY_EVENT, onChange);
  };
}

/** Local and session copies are merged, so a key written to only one of them is not lost. */
function readBudgetKeys(wallet: string): BudgetKeyRecord[] {
  const storageKey = `${VAULT_SECRET}:${wallet}`;
  const local = parseBudgetKeyList(parseJson(storageItem(localStorage, storageKey)));
  const session = parseBudgetKeyList(parseJson(storageItem(sessionStorage, storageKey)));
  return session.reduce((merged, key) => (budgetKeyFor(merged, key.vault) === null ? rememberBudget(merged, key) : merged), local);
}

function storeBudgetKeys(wallet: string, keys: readonly BudgetKeyRecord[]): void {
  const storageKey = `${VAULT_SECRET}:${wallet}`;
  const json = JSON.stringify(keys);
  try {
    localStorage.setItem(storageKey, json);
  } catch (error) {
    if (!(error instanceof DOMException)) throw error;
  }
  sessionStorage.setItem(storageKey, json);
  window.dispatchEvent(new Event(BUDGET_KEY_EVENT));
}

function storageItem(storage: Storage, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch (error) {
    if (error instanceof DOMException) return null;
    throw error;
  }
}

function parseJson(raw: string | null): unknown {
  if (raw === null || raw.length === 0) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

function rememberJson(key: string, value: unknown): void {
  sessionStorage.setItem(key, JSON.stringify(value));
}

async function assetDecimals(asset: AssetDraft): Promise<number | null> {
  if (asset.kind === "sol") return SOL_DECIMALS;
  if (asset.kind === "nft") return 0;
  const response = await fetch("/api/desk", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "wallet-asset-info", mint: asset.mint.trim() }),
  });
  const payload = (await response.json()) as { ok?: boolean; error?: string; result?: { decimals?: number } };
  if (!response.ok || payload.ok === false || typeof payload.result?.decimals !== "number") {
    throw new Error(payload.error ?? "The token mint could not be read.");
  }
  return payload.result.decimals;
}
