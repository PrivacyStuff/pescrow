"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { Buffer } from "buffer";
import { useCallback, useEffect, useRef, useState } from "react";
import { acceptReason, planRecipientAccept, publicBalanceMax } from "@/lib/accept-plan";
import { chunkRefusal, planChunk, sideView, SOL_MINT, type AssetKind, type SwapTerms } from "@/lib/chunk-plan";
import { recipientCanLock, type EscrowView } from "@/lib/escrow-account";
import { decideFundingSource, fundingRefusal } from "@/lib/funding-source";
import { groupEscrows } from "@/lib/escrow-groups";
import {
  approveEscrowInstruction,
  closeEscrowInstruction,
  createEscrowInstruction,
  declineEscrowInstruction,
  type BuiltInstruction,
} from "@/lib/escrow-instructions";
import { parseBaseAmount, parseEscrowParams, paramRefusal, type ParsedSide } from "@/lib/escrow-params";
import { ESCROW_ACCOUNT_SPACE, ESCROW_PROGRAM_ID, LOCK_SEED } from "@/lib/escrow-program";
import { kindAgrees, solAssetInfo, type AssetInfo } from "@/lib/mint-account";
import { notePickRefusal, pickNoteForAction, type SpendNote } from "@/lib/note-selection";
import { metadataLabel, type TokenMetadata } from "@/lib/token-metadata";
import { readHeldAssetList, type HeldAsset } from "@/lib/wallet-holdings";
import { LinkedText } from "./chain-link";
import { chainRead, fundRingKey, loadAsset, post, rememberAssets, rememberMetadata, shieldedFor, signAndSend } from "./desk-client";
import { type DeskTab } from "./desk-tabs";
import { EscrowList } from "./escrow-list";
import { HistorySection } from "./history-section";
import { NewEscrowForm, type FundingDraft, type NewEscrowDraft } from "./new-escrow-form";
import { EMPTY_RING_SESSION, RingBalance, type RingApi, type RingSession } from "./ring-balance";
import type { AssetDraft } from "./types";
import { formatAsset, formatBase, short } from "./format";

const PROGRAM_ID = new PublicKey(ESCROW_PROGRAM_ID);

export function Dashboard() {
  const { publicKey, connected, signTransaction } = useWallet();
  const ringApi = useRef<RingApi | null>(null);
  const [ringSession, setRingSession] = useState<RingSession>(EMPTY_RING_SESSION);
  const onRingSession = useCallback((session: RingSession) => {
    setRingSession(session);
  }, []);
  const seed = ringSession.seed;
  const ring = ringSession.ring;
  const selectedHashes = ringSession.selectedHashes;
  const [escrows, setEscrows] = useState<EscrowView[]>([]);
  const [terms, setTerms] = useState<Record<string, SwapTerms>>({});
  const [assets, setAssets] = useState<Record<string, AssetInfo>>({ [SOL_MINT]: solAssetInfo() });
  const [metadata, setMetadata] = useState<Record<string, TokenMetadata>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [holdings, setHoldings] = useState<readonly HeldAsset[] | null>(null);
  const [tab, setTab] = useState<DeskTab>("balance");

  const wallet = publicKey?.toBase58() ?? null;
  const groups = groupEscrows(escrows);
  const openNotes = (ring?.notes ?? []).filter((item) => item.amount !== "0");
  const selectedNotes = openNotes.filter((item) => selectedHashes.includes(item.hash));
  const labelMint = (mint: string) => (mint === SOL_MINT ? "SOL" : (metadataLabel(metadata[mint]) ?? short(mint)));
  const formBusy = busy !== null || ringSession.busy;
  const resolveMint = useCallback((kind: AssetKind, mint: string) => {
    if (kind === "sol" || assets[mint] !== undefined) return;
    void loadAsset({ kind, mint, amount: "1" })
      .then((info) => {
        setAssets((current) => ({ ...current, [mint]: info }));
      })
      .catch(() => {
        // The create handler reports a mint that cannot be read.
      });
    void rememberMetadata([mint], (resolved, meta) => {
      setMetadata((current) => ({ ...current, [resolved]: meta }));
    });
  }, [assets]);

  useEffect(() => {
    if (wallet === null) {
      setHoldings(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const payload = await post({ action: "wallet-escrows", wallet });
        if (cancelled) return;
        const nextTerms = readTermsMap(payload.result?.terms);
        setEscrows(readEscrows(payload.result?.escrows));
        setTerms(nextTerms);
        const sides = sidesOf(Object.values(nextTerms));
        await rememberAssets(sides, (mint, info) => {
          if (!cancelled) setAssets((current) => ({ ...current, [mint]: info }));
        });
        await rememberMetadata(sides.map((side) => side.mint), (mint, meta) => {
          if (!cancelled) setMetadata((current) => ({ ...current, [mint]: meta }));
        });
        const held = await post({ action: "wallet-holdings", wallet });
        if (!cancelled) setHoldings(readHeldAssetList(held.result?.holdings));
      } catch (error) {
        if (!cancelled) setFailure(error instanceof Error ? error.message : "The desk could not be reached.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [wallet]);

  async function refreshEscrows(current = wallet): Promise<EscrowView[] | undefined> {
    if (current === null) return undefined;
    const payload = await post({ action: "wallet-escrows", wallet: current });
    const nextEscrows = readEscrows(payload.result?.escrows);
    const nextTerms = readTermsMap(payload.result?.terms);
    setEscrows(nextEscrows);
    setTerms(nextTerms);
    const sides = sidesOf(Object.values(nextTerms));
    await rememberAssets(sides, (mint, info) => {
      setAssets((currentAssets) => ({ ...currentAssets, [mint]: info }));
    });
    await rememberMetadata(sides.map((side) => side.mint), (mint, meta) => {
      setMetadata((current) => ({ ...current, [mint]: meta }));
    });
    return nextEscrows;
  }

  async function openEscrow(draft: NewEscrowDraft): Promise<void> {
    if (publicKey === null || wallet === null || signTransaction === undefined) return;
    setBusy("Opening the escrow");
    setNotice(null);
    setFailure(null);
    let openedAddress: string | null = null;
    try {
      const mineInfo = await loadAsset(draft.mine);
      const theirInfo = await loadAsset(draft.theirs);
      const parsed = parseEscrowParams(
        {
          opener: wallet,
          counterparty: draft.counterparty,
          mine: { ...draft.mine, mint: draft.mine.kind === "sol" ? SOL_MINT : draft.mine.mint, decimals: mineInfo.decimals },
          theirs: { ...draft.theirs, mint: draft.theirs.kind === "sol" ? SOL_MINT : draft.theirs.mint, decimals: theirInfo.decimals },
          approvalDeadline: draft.approvalDeadline,
          startAt: draft.startAt,
        },
        Math.floor(Date.now() / 1000),
      );
      if (!parsed.ok) {
        setFailure(paramRefusal(parsed.reason));
        return;
      }
      if (!kindAgrees(parsed.value.mine.kind, parsed.value.mine.mint, mineInfo) || !kindAgrees(parsed.value.theirs.kind, parsed.value.theirs.mint, theirInfo)) {
        setFailure("The asset kind does not match the mint.");
        return;
      }
      const preview = inspectFunding(parsed.value.mine, draft.funding);
      if (!preview.ok) {
        setFailure(preview.error);
        return;
      }
      if (seed === null) {
        setFailure("Unlock private balance before preparing this asset. Nothing was shielded, carved, or locked.");
        return;
      }
      const escrow = Keypair.generate();
      const counterparty = new PublicKey(parsed.value.counterparty);
      const [, bump] = PublicKey.findProgramAddressSync([Buffer.from(LOCK_SEED), escrow.publicKey.toBuffer()], PROGRAM_ID);
      const create = createEscrowInstruction({
        escrow: escrow.publicKey.toBase58(),
        opener: wallet,
        counterparty: counterparty.toBytes(),
        startAt: parsed.value.startAt,
        approvalDeadline: parsed.value.approvalDeadline,
        bump,
      });
      const approve = approveEscrowInstruction(escrow.publicKey.toBase58(), wallet);
      const rent = (await chainRead({ rentSpace: ESCROW_ACCOUNT_SPACE })).rentLamports;
      const tx = new Transaction().add(
        SystemProgram.createAccount({
          fromPubkey: publicKey,
          newAccountPubkey: escrow.publicKey,
          lamports: rent,
          space: ESCROW_ACCOUNT_SPACE,
          programId: PROGRAM_ID,
        }),
        toInstruction(create),
        toInstruction(approve),
      );
      const signature = await signAndSend(tx, publicKey, signTransaction, (ready) => {
        ready.partialSign(escrow);
      });
      const address = escrow.publicKey.toBase58();
      openedAddress = address;
      const openerShield = ring?.shieldedAddressHex || shieldedFor(wallet) || "";
      const savedTerms = {
        a: sideRecord(parsed.value.mine),
        b: sideRecord(parsed.value.theirs),
        ...(openerShield.length > 0 ? { openerShield } : {}),
      };
      await post({
        action: "wallet-terms",
        escrow: address,
        ...savedTerms,
      });
      setAssets((current) => ({ ...current, [parsed.value.mine.mint]: mineInfo, [parsed.value.theirs.mint]: theirInfo }));
      const knownAssets = { ...assets, [parsed.value.mine.mint]: mineInfo, [parsed.value.theirs.mint]: theirInfo };
      let prepared: { readonly text: string; readonly hash: string };
      try {
        const funded = await prepareFunding(parsed.value.mine, draft.funding);
        if (!funded.ok) {
          setFailure(`${funded.error} Escrow ${address} is open but the asset was not locked.`);
          await refreshEscrows().catch(() => undefined);
          return;
        }
        prepared = funded;
      } catch (error) {
        const message = error instanceof Error ? error.message : "The note was not prepared.";
        setFailure(`${message} Escrow ${address} is open but the asset was not locked.`);
        await refreshEscrows().catch(() => undefined);
        return;
      }
      try {
        const amountText = parsed.value.mine.kind === "nft" ? "1" : formatBase(parsed.value.mine.amount.toString(), mineInfo.decimals);
        const locked = await runLock(
          {
            address,
            status: "Proposed",
            aApproved: true,
            bApproved: false,
            aSealed: false,
            bSealed: false,
            startAt: parsed.value.startAt,
            approvalDeadline: parsed.value.approvalDeadline,
            partyA: wallet,
            partyB: parsed.value.counterparty,
            role: "a",
          },
          amountText,
          savedTerms,
          knownAssets,
          prepared.hash,
        );
        setNotice(`Escrow ${address} is open. You approved. ${prepared.text} ${locked} ${signature}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : "The lock failed.";
        setFailure(`${message} Escrow ${address} is open but the asset was not locked. The prepared note stays spendable.`);
      }
      try {
        await refreshEscrows();
      } catch {
        // The account is already open. A failed reload must not hide that.
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "The escrow did not open.";
      setFailure(
        openedAddress === null
          ? message
          : `${message} Escrow ${openedAddress} is open but the asset was not locked.`,
      );
    } finally {
      setBusy(null);
    }
  }

  function inspectFunding(mine: ParsedSide, funding: FundingDraft): { readonly ok: true } | { readonly ok: false; readonly error: string } {
    const funded = fundingDecision(mine, funding);
    return funded.ok ? { ok: true } : { ok: false, error: funded.error };
  }

  function fundingDecision(
    mine: ParsedSide,
    funding: FundingDraft,
  ):
    | { readonly ok: true; readonly decision: ReturnType<typeof decideFundingSource> & { readonly ok: true } }
    | { readonly ok: false; readonly error: string } {
    let shieldedHash = funding.kind === "shielded" ? funding.noteHash : undefined;
    if (selectedHashes.length > 0) {
      const pick = pickNoteForAction({
        notes: spendNotes(openNotes),
        selected: selectedHashes,
        mint: mine.mint,
        amount: mine.amount,
      });
      if (!pick.ok && (pick.reason === "mixed" || funding.kind === "shielded")) {
        return { ok: false, error: notePickRefusal(pick, labelMint) };
      }
      if (pick.ok && funding.kind === "shielded") shieldedHash = pick.hash;
    }
    const note = shieldedHash === undefined ? undefined : openNotes.find((item) => item.hash === shieldedHash);
    const holding = holdings?.find((asset) => asset.mint === mine.mint) ?? null;
    const source =
      funding.kind === "public"
        ? holding === null
          ? null
          : { kind: "public" as const, mint: holding.mint, maxBase: BigInt(holding.maxBase) }
        : note === undefined
          ? null
          : { kind: "shielded" as const, hash: note.hash, mint: note.mint, amount: BigInt(note.amount) };
    if (source === null) {
      return {
        ok: false,
        error:
          funding.kind === "public"
            ? "The public balance of this asset could not be read. Nothing was shielded or locked."
            : "That shielded note is no longer spendable. Nothing was carved or locked.",
      };
    }
    const decision = decideFundingSource({ mint: mine.mint, amount: mine.amount, kind: mine.kind, source });
    if (!decision.ok) return { ok: false, error: fundingRefusal(decision.reason) };
    return { ok: true, decision };
  }

  async function prepareFunding(
    mine: ParsedSide,
    funding: FundingDraft,
  ): Promise<{ readonly ok: true; readonly text: string; readonly hash: string } | { readonly ok: false; readonly error: string }> {
    const funded = fundingDecision(mine, funding);
    if (!funded.ok) return funded;
    const decision = funded.decision;
    const holding = holdings?.find((asset) => asset.mint === mine.mint) ?? null;
    if (decision.action === "spend") {
      ringApi.current?.selectNote(decision.noteHash);
      return { ok: true, text: "The shielded note already matches the escrow amount.", hash: decision.noteHash };
    }
    if (seed === null || publicKey === null || signTransaction === undefined || ringApi.current === null) {
      return { ok: false, error: "Unlock private balance before preparing this asset. Nothing was shielded, carved, or locked." };
    }
    if (decision.action === "wrap") {
      if (holding === null) return { ok: false, error: fundingRefusal("shortfall") };
      setBusy("Shielding the escrow amount");
      const before = new Set(openNotes.map((item) => item.hash));
      const amountText = mine.kind === "nft" ? "1" : formatBase(mine.amount.toString(), holding.decimals);
      const next = await ringApi.current.shield(holding, amountText);
      const created = next.notes.find((item) => {
        return item.mint === mine.mint && item.amount === mine.amount.toString() && !before.has(item.hash);
      });
      if (created === undefined) {
        throw new Error("The shielded note of the escrow amount did not appear.");
      }
      ringApi.current.selectNote(created.hash);
      return { ok: true, text: "Shielded the public balance into a private note.", hash: created.hash };
    }
    setBusy("Carving the note to the escrow amount");
    await fundRingKey(publicKey, seed, signTransaction);
    const payload = await post({
      action: "wallet-carve",
      seed: Buffer.from(seed).toString("hex"),
      note: decision.noteHash,
      lamports: decision.amount.toString(),
    });
    const hash = payload.result?.hash;
    if (typeof hash !== "string" || hash.length === 0) {
      throw new Error("The carve did not return the new note. The remainder of the original note stays spendable.");
    }
    await ringApi.current.refreshNotes();
    ringApi.current.selectNote(hash);
    return { ok: true, text: "Carved the shielded note to the escrow amount. The change note stays spendable.", hash };
  }

  async function saveTerms(address: string, role: "a" | "b", mine: AssetDraft, theirs: AssetDraft): Promise<void> {
    setBusy("Saving swap terms");
    setFailure(null);
    try {
      const mineInfo = await loadAsset(mine);
      const theirInfo = await loadAsset(theirs);
      const mineSide = sideFromDraft(mine, mineInfo);
      const theirSide = sideFromDraft(theirs, theirInfo);
      if (mineSide === null || theirSide === null) {
        setFailure("Enter an amount above zero that fits each asset.");
        return;
      }
      if (!kindAgrees(mine.kind, mineSide.mint, mineInfo) || !kindAgrees(theirs.kind, theirSide.mint, theirInfo)) {
        setFailure("The asset kind does not match the mint.");
        return;
      }
      await post({
        action: "wallet-terms",
        escrow: address,
        a: role === "a" ? mineSide : theirSide,
        b: role === "a" ? theirSide : mineSide,
      });
      setNotice(`Saved. You lock ${formatAsset(mineSide.amount, mineSide.mint, mineInfo.decimals)}. You receive ${formatAsset(theirSide.amount, theirSide.mint, theirInfo.decimals)}.`);
      await refreshEscrows();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "The swap terms were not saved.");
    } finally {
      setBusy(null);
    }
  }

  async function decline(row: EscrowView): Promise<void> {
    if (publicKey === null || wallet === null || signTransaction === undefined) return;
    await sendParty("Declining", "Declined.", declineEscrowInstruction(row.address, wallet), publicKey, signTransaction);
  }

  async function sendParty(
    label: string,
    done: string,
    built: BuiltInstruction,
    payer: PublicKey,
    sign: (tx: Transaction) => Promise<Transaction>,
  ): Promise<void> {
    setBusy(label);
    setFailure(null);
    try {
      const tx = new Transaction().add(toInstruction(built));
      const signature = await signAndSend(tx, payer, sign);
      setNotice(`${done} ${signature}`);
      await refreshEscrows();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "The transaction failed.");
    } finally {
      setBusy(null);
    }
  }

  async function lock(row: EscrowView, amountText: string): Promise<void> {
    setBusy("Locking your asset into the escrow");
    setNotice(null);
    setFailure(null);
    try {
      setNotice(await runLock(row, amountText));
      const hex = ring?.shieldedAddressHex || (wallet === null ? "" : shieldedFor(wallet) ?? "");
      const stored = terms[row.address];
      if (row.role === "a" && hex.length > 0 && stored !== undefined) {
        await post({ action: "wallet-terms", escrow: row.address, a: stored.a, b: stored.b, openerShield: hex });
      }
      await refreshEscrows();
      await ringApi.current?.refreshNotes();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "The lock failed.");
    } finally {
      setBusy(null);
    }
  }

  async function runLock(
    row: EscrowView,
    amountText: string,
    storedTerms?: SwapTerms,
    knownAssets?: Readonly<Record<string, AssetInfo>>,
    noteHash?: string,
  ): Promise<string> {
    if (wallet === null || publicKey === null || signTransaction === undefined) throw new Error("Connect a wallet before locking.");
    if (seed === null) throw new Error("Unlock private balance, then pick the note you are locking.");
    const stored = storedTerms ?? terms[row.address];
    if (stored === undefined) throw new Error(chunkRefusal("missing-terms"));
    const agreed = sideView(row.role, stored).lock;
    const sameMint = openNotes.filter((item) => item.mint === agreed.mint);
    let lockedHash = noteHash;
    if (lockedHash === undefined) {
      const preview = knownAssets?.[agreed.mint] ?? assets[agreed.mint] ?? (agreed.kind === "sol" ? solAssetInfo() : undefined);
      if (preview === undefined) throw new Error("The asset for this side is not loaded yet.");
      const previewAmount = parseBaseAmount(amountText, preview.decimals);
      if (previewAmount === null) throw new Error("Enter an amount above zero that fits the asset.");
      const pick = pickNoteForAction({
        notes: spendNotes(openNotes),
        selected: selectedHashes,
        mint: agreed.mint,
        amount: previewAmount,
      });
      if (!pick.ok) throw new Error(notePickRefusal(pick, labelMint));
      lockedHash = pick.hash;
    }
    const selected = sameMint.find((item) => item.hash === lockedHash);
    const picked = selected;
    if (picked === undefined && noteHash === undefined) {
      throw new Error("Shield the asset this side agreed to lock, then pick that note. A note of another asset cannot lock here.");
    }
    const info = knownAssets?.[agreed.mint] ?? assets[agreed.mint] ?? (agreed.kind === "sol" ? solAssetInfo() : undefined);
    if (info === undefined) throw new Error("The asset for this side is not loaded yet.");
    const typed = parseBaseAmount(amountText, info.decimals);
    if (typed === null) throw new Error("Enter an amount above zero that fits the asset.");
    const plan = planChunk({
      noteAmount: picked === undefined ? BigInt(agreed.amount) : BigInt(picked.amount),
      typedAmount: typed,
      agreedAmount: BigInt(agreed.amount),
      noteMint: picked?.mint ?? agreed.mint,
      agreedMint: agreed.mint,
      kind: agreed.kind,
    });
    if (!plan.ok) throw new Error(chunkRefusal(plan.reason));
    let spendHash = picked?.hash ?? lockedHash;
    if (spendHash === undefined) {
      throw new Error("Shield the asset this side agreed to lock, then pick that note. A note of another asset cannot lock here.");
    }
    if (plan.split) {
      if (picked === undefined) throw new Error("The note to carve is not in the private balance.");
      setBusy("Splitting the note, then locking the chunk");
      await fundRingKey(publicKey, seed, signTransaction);
    }
    const payload = await post({
      action: "wallet-lock",
      seed: Buffer.from(seed).toString("hex"),
      wallet,
      escrow: row.address,
      note: spendHash,
      lamports: typed.toString(),
    });
    const raw = payload.result?.tx;
    if (typeof raw !== "string") throw new Error("The lock transaction was not returned.");
    const tx = Transaction.from(Buffer.from(raw, "base64"));
    const signature = await signAndSend(tx, publicKey, signTransaction);
    const split = payload.result?.split;
    const splitNote = typeof split === "string" ? ` Split ${split}.` : "";
    return `Locked ${formatAsset(typed.toString(), agreed.mint, info.decimals)}.${splitNote} ${signature}`;
  }

  async function accept(row: EscrowView, amountText: string): Promise<void> {
    if (publicKey === null || wallet === null || signTransaction === undefined) return;
    const stored = terms[row.address];
    const view = stored === undefined ? null : sideView(row.role, stored);
    const gate = planRecipientAccept({
      status: row.status,
      role: row.role,
      bApproved: row.bApproved,
      aSealed: row.aSealed,
      bSealed: row.bSealed,
      approvalDeadline: row.approvalDeadline,
      startAt: row.startAt,
      now: Math.floor(Date.now() / 1000),
      lock: view === null ? null : { mint: view.lock.mint, amount: view.lock.amount, kind: view.lock.kind },
      notes: openNotes,
      publicMax: publicBalanceMax(holdings, view?.lock.mint ?? null),
    });
    const lockLabel = view === null ? null : formatAsset(view.lock.amount, view.lock.mint, assets[view.lock.mint]?.decimals, metadata[view.lock.mint]);
    const receiveLabel = view === null ? null : formatAsset(view.receive.amount, view.receive.mint, assets[view.receive.mint]?.decimals, metadata[view.receive.mint]);
    const coverLabel =
      gate.noteAmount === null || view === null
        ? null
        : formatAsset(gate.noteAmount.toString(), view.lock.mint, assets[view.lock.mint]?.decimals, metadata[view.lock.mint]);
    const reason = acceptReason({ gate, aSealed: row.aSealed, lockLabel, receiveLabel, coverLabel });
    if (!gate.canApprove && !gate.canLock && !gate.canSwap) {
      setNotice(null);
      setFailure(reason ?? "Accept cannot continue.");
      return;
    }
    setNotice(null);
    setFailure(null);
    let carved = false;
    try {
      if (gate.canApprove) {
        setBusy("Approving");
        const tx = new Transaction().add(toInstruction(approveEscrowInstruction(row.address, wallet)));
        await signAndSend(tx, publicKey, signTransaction);
      }
      if (!row.aSealed) {
        const waiting =
          gate.shortfall && lockLabel !== null
            ? `You approved. The shielded balance is short of ${lockLabel}, and the public balance cannot cover the wrap. Nothing was carved.`
            : coverLabel !== null && lockLabel !== null && receiveLabel !== null
              ? `${coverLabel} covers ${lockLabel}. The note stays in the private balance. The lock waits until the opener seals ${receiveLabel}.`
              : `You approved. The lock waits until the opener seals ${receiveLabel ?? "their asset"}. Nothing was carved.`;
        setNotice(waiting);
        await refreshEscrows().catch(() => undefined);
        return;
      }
      let latest: EscrowView[] | undefined;
      try {
        latest = await refreshEscrows();
      } catch {
        setFailure(
          gate.canApprove
            ? "You approved. The escrow could not be reloaded, so nothing was carved or locked."
            : "The escrow could not be reloaded, so nothing was carved or locked.",
        );
        return;
      }
      const current = latest?.find((item) => item.address === row.address);
      const approved = (current?.bApproved ?? false) || gate.canApprove;
      if (current === undefined || !current.aSealed || !approved) {
        setNotice(reason ?? "The opener has not sealed their asset, so nothing was carved or locked.");
        return;
      }
      if (current.bSealed) {
        setBusy("Swapping");
        const swapped = await runSwap(current);
        setNotice(swapped);
        await refreshEscrows();
        await ringApi.current?.refreshNotes();
        return;
      }
      if (!recipientCanLock({ ...current, bApproved: approved }) || !gate.canLock || view === null || stored === undefined) {
        setFailure(reason ?? "The lock cannot be submitted. Nothing was carved.");
        return;
      }
      if (seed === null) {
        setFailure(
          gate.canApprove
            ? "You approved. Unlock private balance before the lock. Nothing was carved or locked."
            : "Unlock private balance before the lock. Nothing was carved or locked.",
        );
        return;
      }
      const info = assets[view.lock.mint] ?? (view.lock.kind === "sol" ? solAssetInfo() : undefined);
      if (info === undefined || !/^\d+$/.test(view.lock.amount)) {
        setFailure("The asset for this side is not loaded yet. Nothing was carved or locked.");
        return;
      }
      const mine: ParsedSide = {
        kind: view.lock.kind,
        mint: view.lock.mint,
        amount: BigInt(view.lock.amount),
        decimals: info.decimals,
      };
      const prepared = gate.wrap
        ? await prepareFunding(mine, { kind: "public" })
        : gate.noteHash === null
          ? { ok: false as const, error: "No shielded note covers this lock. Nothing was carved or locked." }
          : await prepareFunding(mine, { kind: "shielded", noteHash: gate.noteHash });
      if (!prepared.ok) {
        setFailure(gate.canApprove ? `You approved. ${prepared.error}` : prepared.error);
        return;
      }
      carved = gate.carve;
      setBusy("Locking your asset into the escrow");
      const locked = await runLock(row, amountText, stored, assets, prepared.hash);
      const sealed = await refreshEscrows();
      const after = sealed?.find((item) => item.address === row.address);
      if (after === undefined || !after.aSealed || !after.bSealed) {
        setNotice(`${locked} Both seals are not set, so nothing was swapped or closed.`);
        return;
      }
      setBusy("Swapping");
      const swapped = await runSwap(after);
      setNotice(`${prepared.text} ${locked} ${swapped}`.trim());
      await refreshEscrows();
      await ringApi.current?.refreshNotes();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Accept failed.";
      setFailure(carved ? `${message} If a note was carved, it is still spendable in the private balance.` : message);
    } finally {
      setBusy(null);
    }
  }

  async function reject(row: EscrowView): Promise<void> {
    if (row.aSealed || row.bSealed) {
      setFailure(
        "Reject cannot return the opener's note. Give-back only returns the sealed party's own note, only after the reclaim time, and the destination is a private witness. A recipient-built proof could send that note anywhere. The 160-byte account has no field for the opener's shielded address, so the program cannot force the return. Decline stays frozen once a side is sealed.",
      );
      return;
    }
    await decline(row);
  }

  async function runSwap(row: EscrowView): Promise<string> {
    if (seed === null || wallet === null || publicKey === null || signTransaction === undefined) {
      throw new Error("Unlock private balance before the swap.");
    }
    const storedOpener = shieldHex(terms[row.address]?.openerShield);
    const mine = ring?.shieldedAddressHex || shieldedFor(wallet) || (row.role === "a" ? storedOpener : null);
    const otherWallet = row.role === "a" ? row.partyB : row.partyA;
    const other = shieldedFor(otherWallet) ?? (otherWallet === row.partyA ? storedOpener : null);
    if (mine === null || other === null) {
      throw new Error("Unlock the ring on both wallets in this browser before the swap. The chain does not store the shielded addresses.");
    }
    try {
      await fundRingKey(publicKey, seed, signTransaction);
      const payload = await post({
        action: "wallet-swap",
        seed: Buffer.from(seed).toString("hex"),
        escrow: row.address,
        toA: row.role === "a" ? mine : other,
        toB: row.role === "a" ? other : mine,
      });
      const swapSignature = payload.result?.signature;
      if (typeof swapSignature !== "string") throw new Error("The swap did not return a signature.");
      setBusy("Closing");
      try {
        const closed = await submitClose(row);
        return `Swapped and closed. ${swapSignature} ${closed.signature}.${closed.returned}`;
      } catch (error) {
        const reason = error instanceof Error ? error.message : "The close was rejected.";
        throw new Error(`The swap landed and the close did not. ${swapSignature} ${reason}`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("The swap landed")) throw error;
      throw error instanceof Error ? error : new Error("The swap failed.");
    }
  }

  async function submitClose(row: EscrowView): Promise<{ signature: string; returned: string }> {
    if (publicKey === null || wallet === null || signTransaction === undefined) {
      throw new Error("Connect a wallet before closing.");
    }
    const tx = new Transaction().add(toInstruction(closeEscrowInstruction(row.address, wallet, row.partyA)));
    const signature = await signAndSend(tx, publicKey, signTransaction);
    let returned = "";
    if (seed !== null) {
      const back = await post({ action: "wallet-return", seed: Buffer.from(seed).toString("hex"), wallet });
      const lamports = back.result?.lamports;
      if (typeof lamports === "string" && lamports !== "0") returned = ` Returned ${formatAsset(lamports, SOL_MINT, 9)} from the ring key.`;
    }
    return { signature, returned };
  }

  async function close(row: EscrowView): Promise<void> {
    if (publicKey === null || wallet === null || signTransaction === undefined) return;
    setBusy("Closing");
    setFailure(null);
    try {
      const closed = await submitClose(row);
      setNotice(`Closed. Rent went to the opener. ${closed.signature}.${closed.returned}`);
      await refreshEscrows();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "The close failed.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <p className="text-sm tracking-[0.18em] text-stamp uppercase">Dashboard</p>
      <h1 className="mt-4 max-w-3xl font-serif text-5xl tracking-[-0.035em] md:text-6xl">Open an escrow. See both sides.</h1>
      <p className="mt-6 max-w-2xl leading-7 text-muted">
        Connect a wallet to load every pescrow that names it. Ones you opened sit under Issued. Ones that name you as the counterparty sit under Received. SOL, a token, or an NFT can be either side. The ring is permissionless and the wallets are public.
      </p>
      <RingBalance
        desk="escrow"
        apiRef={ringApi}
        paused={busy !== null}
        onSession={onRingSession}
        tab={tab}
        onTab={setTab}
        create={
          connected && wallet !== null ? (
            <NewEscrowForm
              busy={formBusy}
              notes={openNotes}
              holdings={holdings}
              assets={assets}
              metadata={metadata}
              onCreate={(draft) => void openEscrow(draft)}
              onInvalid={setFailure}
              onResolveMint={resolveMint}
            />
          ) : (
            <p className="mt-6 text-sm text-muted">Select a wallet to create an escrow.</p>
          )
        }
        balance={
          wallet === null ? (
            <p className="mt-6 text-sm text-muted">Select a wallet to see escrows for that address.</p>
          ) : (
            <>
              <EscrowList
                title="Issued"
                empty="You have not opened an escrow from this wallet."
                rows={groups.issued}
                terms={terms}
                assets={assets}
                metadata={metadata}
                selectedNotes={selectedNotes}
                notes={openNotes}
                holdings={holdings}
                seedReady={seed !== null}
                busy={formBusy}
                onLock={(row, amount) => void lock(row, amount)}
                onAccept={(row, amount) => void accept(row, amount)}
                onReject={(row) => void reject(row)}
                onSaveTerms={(address, role, mine, theirs) => void saveTerms(address, role, mine, theirs)}
              />
              <EscrowList
                title="Received"
                empty="No open escrow names this wallet as the counterparty."
                rows={groups.received}
                terms={terms}
                assets={assets}
                metadata={metadata}
                selectedNotes={selectedNotes}
                notes={openNotes}
                holdings={holdings}
                seedReady={seed !== null}
                busy={formBusy}
                onLock={(row, amount) => void lock(row, amount)}
                onAccept={(row, amount) => void accept(row, amount)}
                onReject={(row) => void reject(row)}
                onSaveTerms={(address, role, mine, theirs) => void saveTerms(address, role, mine, theirs)}
              />
              <HistorySection rows={groups.history} busy={formBusy} onClose={(row) => void close(row)} />
            </>
          )
        }
      />
      {notice !== null ? (
        <p className="mt-8 max-w-3xl text-sm leading-6 break-all">
          <LinkedText text={notice} />
        </p>
      ) : null}
      {failure !== null ? (
        <p className="mt-8 max-w-3xl text-sm leading-6 break-all text-stamp">
          <LinkedText text={failure} />
        </p>
      ) : null}
    </div>
  );
}

function sidesOf(rows: readonly SwapTerms[]): { kind: AssetKind; mint: string }[] {
  return rows.flatMap((row) => [row.a, row.b]);
}

function toInstruction(built: BuiltInstruction): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: built.keys.map((key) => ({
      pubkey: new PublicKey(key.address),
      isSigner: key.isSigner,
      isWritable: key.isWritable,
    })),
    data: Buffer.from(built.data),
  });
}

function sideRecord(side: { kind: AssetKind; mint: string; amount: bigint }): { kind: AssetKind; mint: string; amount: string } {
  return { kind: side.kind, mint: side.mint, amount: side.amount.toString() };
}

function sideFromDraft(draft: AssetDraft, info: AssetInfo): { kind: AssetKind; mint: string; amount: string } | null {
  const mint = draft.kind === "sol" ? SOL_MINT : draft.mint.trim();
  const amount = parseBaseAmount(draft.kind === "nft" ? "1" : draft.amount, info.decimals);
  if (amount === null) return null;
  return { kind: draft.kind, mint, amount: amount.toString() };
}

function shieldHex(value: unknown): string | null {
  if (typeof value !== "string" || value.length < 64 || value.length > 400 || value.length % 2 !== 0) return null;
  return /^[0-9a-fA-F]+$/.test(value) ? value : null;
}

function readEscrows(value: unknown): EscrowView[] {
  if (!Array.isArray(value)) return [];
  return value.filter((row): row is EscrowView => {
    if (typeof row !== "object" || row === null) return false;
    const record = row as Record<string, unknown>;
    return typeof record.address === "string" && (record.role === "a" || record.role === "b") && typeof record.status === "string";
  });
}

function readTermsMap(value: unknown): Record<string, SwapTerms> {
  if (typeof value !== "object" || value === null) return {};
  const terms: Record<string, SwapTerms> = {};
  for (const [escrow, row] of Object.entries(value)) {
    if (typeof row !== "object" || row === null) continue;
    const record = row as Record<string, unknown>;
    const a = readSide(record.a);
    const b = readSide(record.b);
    if (a !== null && b !== null) {
      const openerShield = shieldHex(record.openerShield);
      terms[escrow] = openerShield === null ? { a, b } : { a, b, openerShield };
    }
  }
  return terms;
}

function spendNotes(notes: readonly { readonly hash: string; readonly mint: string; readonly amount: string }[]): SpendNote[] {
  const parsed: SpendNote[] = [];
  for (const item of notes) {
    if (!/^\d+$/.test(item.amount)) continue;
    const amount = BigInt(item.amount);
    if (amount <= BigInt(0)) continue;
    parsed.push({ hash: item.hash, mint: item.mint, amount });
  }
  return parsed;
}

function readSide(value: unknown): SwapTerms["a"] | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  if (row.kind !== "sol" && row.kind !== "token" && row.kind !== "nft") return null;
  if (typeof row.mint !== "string" || typeof row.amount !== "string") return null;
  return { kind: row.kind, mint: row.mint, amount: row.amount };
}
