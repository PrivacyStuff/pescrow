"use client";

import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { Buffer } from "buffer";
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { useEffect, useRef, useState } from "react";
import { chunkRefusal, planChunk, sideView, type SwapTerms } from "@/lib/chunk-plan";
import { RING_FEE_RESERVE, RING_MESSAGE, sixHourDeadline, solToLamports } from "@/lib/desk-request";
import { type EscrowView } from "@/lib/escrow-account";

const PROGRAM_ID = new PublicKey("7c3yarLtR2eUebLqYcms7GViXZ5SpQVWmmiqJTp3QtYG");
const CLOCK = new PublicKey("SysvarC1ock11111111111111111111111111111111");
const LOCK_SEED = Buffer.from("escrow-lock");
const SHIELDED_KEY = "pescrow-shielded";

type Note = { hash: string; lamports: string; leaf: string };
type RingState = { ring: string; shieldedAddressHex: string; sol: string; notes: Note[] };

function sol(lamports: string): string {
  const value = BigInt(lamports);
  const scale = BigInt(1_000_000_000);
  const whole = value / scale;
  const fraction = (value % scale).toString().padStart(9, "0").replace(/0+$/, "");
  return fraction.length === 0 ? `${whole} SOL` : `${whole}.${fraction} SOL`;
}

function short(value: string): string {
  return value.length <= 12 ? value : `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function lamportsToInput(lamports: string): string {
  const value = BigInt(lamports);
  const scale = BigInt(1_000_000_000);
  const whole = value / scale;
  const fraction = (value % scale).toString().padStart(9, "0").replace(/0+$/, "");
  return fraction.length === 0 ? whole.toString() : `${whole}.${fraction}`;
}

function readTerms(value: unknown): Record<string, SwapTerms> {
  if (typeof value !== "object" || value === null) return {};
  const terms: Record<string, SwapTerms> = {};
  for (const [escrow, row] of Object.entries(value)) {
    if (typeof row !== "object" || row === null) continue;
    const record = row as Record<string, unknown>;
    if (typeof record.lockLamports !== "string" || typeof record.receiveLamports !== "string") continue;
    terms[escrow] = { lockLamports: record.lockLamports, receiveLamports: record.receiveLamports };
  }
  return terms;
}

function spendable(notes: Note[]): Note[] {
  return notes.filter((item) => item.lamports !== "0");
}

function rememberShielded(wallet: string, hex: string): void {
  const parsed = JSON.parse(sessionStorage.getItem(SHIELDED_KEY) ?? "{}") as Record<string, string>;
  parsed[wallet] = hex;
  sessionStorage.setItem(SHIELDED_KEY, JSON.stringify(parsed));
}

function shieldedFor(wallet: string): string | null {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(SHIELDED_KEY) ?? "{}") as Record<string, string>;
    return parsed[wallet] ?? null;
  } catch {
    return null;
  }
}

export function Desk() {
  const { connection } = useConnection();
  const { publicKey, connected, disconnect, signMessage, signTransaction } = useWallet();
  const { setVisible } = useWalletModal();
  const seenWallet = useRef<string | null>(null);
  const [seed, setSeed] = useState<Uint8Array | null>(null);
  const [ring, setRing] = useState<RingState | null>(null);
  const [escrows, setEscrows] = useState<EscrowView[]>([]);
  const [terms, setTerms] = useState<Record<string, SwapTerms>>({});
  const [lockAmounts, setLockAmounts] = useState<Record<string, string>>({});
  const [drafts, setDrafts] = useState<Record<string, { lock: string; receive: string }>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [shieldAmount, setShieldAmount] = useState("0.01");
  const [counterparty, setCounterparty] = useState("");
  const [giveAmount, setGiveAmount] = useState("0.01");
  const [wantAmount, setWantAmount] = useState("0.02");
  const [note, setNote] = useState("");

  const wallet = publicKey?.toBase58() ?? null;

  useEffect(() => {
    if (seenWallet.current === wallet) return;
    if (seenWallet.current !== null) {
      setSeed(null);
      setRing(null);
    }
    seenWallet.current = wallet;
  }, [wallet]);

  async function post(body: unknown): Promise<{ ok?: boolean; error?: string; result?: Record<string, unknown> }> {
    const response = await fetch("/api/desk", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = (await response.json()) as { ok?: boolean; error?: string; result?: Record<string, unknown> };
    if (!response.ok || payload.ok === false) throw new Error(payload.error ?? "The desk command failed.");
    return payload;
  }

  async function submit(tx: Transaction): Promise<string> {
    const payload = await post({ action: "wallet-submit", tx: tx.serialize().toString("base64") });
    const signature = payload.result?.signature;
    if (typeof signature !== "string") throw new Error("The transaction did not return a signature.");
    return signature;
  }

  async function refreshEscrows(current = wallet): Promise<void> {
    if (current === null) return;
    const payload = await post({ action: "wallet-escrows", wallet: current });
    const rows = payload.result?.escrows;
    setEscrows(Array.isArray(rows) ? (rows as EscrowView[]) : []);
    setTerms(readTerms(payload.result?.terms));
  }

  async function refreshNotes(current = seed): Promise<void> {
    if (current === null) return;
    const payload = await post({ action: "wallet-notes", seed: Buffer.from(current).toString("hex") });
    const result = payload.result as RingState | undefined;
    if (result === undefined || !Array.isArray(result.notes)) return;
    setRing(result);
    if (wallet !== null) rememberShielded(wallet, result.shieldedAddressHex);
    const open = spendable(result.notes);
    setNote((selected) => (open.some((item) => item.hash === selected) ? selected : (open[0]?.hash ?? "")));
  }

  useEffect(() => {
    if (wallet === null) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/desk", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "wallet-escrows", wallet }),
        });
        const payload = (await response.json()) as { ok?: boolean; result?: { escrows?: EscrowView[]; terms?: unknown }; error?: string };
        if (cancelled) return;
        if (!response.ok || payload.ok === false) {
          setFailure(payload.error ?? "The escrows could not be read.");
          return;
        }
        setEscrows(payload.result?.escrows ?? []);
        setTerms(readTerms(payload.result?.terms));
      } catch (error) {
        if (!cancelled) setFailure(error instanceof Error ? error.message : "The desk could not be reached.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [wallet]);

  async function unlockRing(): Promise<void> {
    if (signMessage === undefined) {
      setFailure("Solflare did not offer message signing.");
      return;
    }
    setBusy("Waiting for Solflare");
    setFailure(null);
    try {
      const signature = await signMessage(new TextEncoder().encode(RING_MESSAGE));
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", signature));
      setSeed(digest);
      setNotice("Ring key is unlocked in this tab. It is not stored.");
      await refreshNotes(digest);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "Solflare did not sign.");
    } finally {
      setBusy(null);
    }
  }

  async function shield(): Promise<void> {
    if (seed === null || publicKey === null || signTransaction === undefined) return;
    const lamports = solToLamports(shieldAmount);
    if (lamports === null) {
      setFailure("Enter an amount from 0.000000001 SOL up to 1 SOL.");
      return;
    }
    setBusy("Shielding");
    setNotice(null);
    setFailure(null);
    try {
      const ringKey = Keypair.fromSeed(seed);
      const balance = await connection.getBalance(ringKey.publicKey);
      const needed = Number(lamports) + RING_FEE_RESERVE;
      if (balance < needed) {
        const tx = new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: publicKey,
            toPubkey: ringKey.publicKey,
            lamports: needed - balance,
          }),
        );
        tx.feePayer = publicKey;
        tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
        setNotice("Confirm the SOL transfer in Solflare. It funds the ring key, then the note is created.");
        await submit(await signTransaction(tx));
      }
      const payload = await post({ action: "wallet-shield", seed: Buffer.from(seed).toString("hex"), lamports: lamports.toString() });
      const signature = payload.result?.signature;
      setNotice(typeof signature === "string" ? `Shielded. ${signature}` : "Shielded.");
      await refreshNotes();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "The shield failed.");
    } finally {
      setBusy(null);
    }
  }

  async function openEscrow(): Promise<void> {
    if (publicKey === null || signTransaction === undefined) return;
    let counterpartyKey: PublicKey;
    try {
      counterpartyKey = new PublicKey(counterparty.trim());
    } catch {
      setFailure("The other wallet address is not a Solana address.");
      return;
    }
    if (counterpartyKey.equals(publicKey)) {
      setFailure("The other wallet has to be a different address.");
      return;
    }
    const give = solToLamports(giveAmount);
    const want = solToLamports(wantAmount);
    if (give === null || want === null) {
      setFailure("Enter the SOL you will lock and the SOL you expect back, each up to 1 SOL.");
      return;
    }
    setBusy("Opening the escrow");
    setNotice(null);
    setFailure(null);
    try {
      const escrow = Keypair.generate();
      const deadline = sixHourDeadline();
      const [, bump] = PublicKey.findProgramAddressSync([LOCK_SEED, escrow.publicKey.toBuffer()], PROGRAM_ID);
      const data = Buffer.alloc(52);
      data[0] = 0;
      counterpartyKey.toBuffer().copy(data, 1);
      data.writeBigInt64LE(BigInt(deadline), 33);
      data.writeBigInt64LE(BigInt(deadline), 41);
      data[49] = 1;
      data[50] = 1;
      data[51] = bump;
      const rent = await connection.getMinimumBalanceForRentExemption(160);
      const create = new Transaction().add(
        SystemProgram.createAccount({
          fromPubkey: publicKey,
          newAccountPubkey: escrow.publicKey,
          lamports: rent,
          space: 160,
          programId: PROGRAM_ID,
        }),
        new TransactionInstruction({
          keys: [
            { pubkey: escrow.publicKey, isSigner: false, isWritable: true },
            { pubkey: publicKey, isSigner: true, isWritable: true },
          ],
          programId: PROGRAM_ID,
          data,
        }),
      );
      create.feePayer = publicKey;
      create.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
      create.partialSign(escrow);
      await submit(await signTransaction(create));
      const approve = new Transaction().add(
        new TransactionInstruction({
          keys: [
            { pubkey: escrow.publicKey, isSigner: false, isWritable: true },
            { pubkey: publicKey, isSigner: true, isWritable: true },
            { pubkey: CLOCK, isSigner: false, isWritable: false },
          ],
          programId: PROGRAM_ID,
          data: Buffer.from([1]),
        }),
      );
      approve.feePayer = publicKey;
      approve.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
      const signature = await submit(await signTransaction(approve));
      await post({
        action: "wallet-terms",
        escrow: escrow.publicKey.toBase58(),
        lockLamports: give.toString(),
        receiveLamports: want.toString(),
      });
      setNotice(`Escrow ${escrow.publicKey.toBase58()} is open. You lock ${sol(give.toString())}. You receive ${sol(want.toString())}. ${signature}`);
      await refreshEscrows();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "The escrow did not open.");
    } finally {
      setBusy(null);
    }
  }

  async function approve(row: EscrowView): Promise<void> {
    if (publicKey === null || signTransaction === undefined) return;
    setBusy("Approving");
    setFailure(null);
    try {
      const tx = new Transaction().add(
        new TransactionInstruction({
          keys: [
            { pubkey: new PublicKey(row.address), isSigner: false, isWritable: true },
            { pubkey: publicKey, isSigner: true, isWritable: true },
            { pubkey: CLOCK, isSigner: false, isWritable: false },
          ],
          programId: PROGRAM_ID,
          data: Buffer.from([1]),
        }),
      );
      tx.feePayer = publicKey;
      tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
      const signature = await submit(await signTransaction(tx));
      setNotice(`Approved. ${signature}`);
      await refreshEscrows();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "The approval failed.");
    } finally {
      setBusy(null);
    }
  }

  async function saveTerms(address: string, role: "a" | "b", lockText: string, receiveText: string): Promise<void> {
    const mineLock = solToLamports(lockText);
    const mineReceive = solToLamports(receiveText);
    if (mineLock === null || mineReceive === null) {
      setFailure("Enter both SOL amounts, each up to 1 SOL.");
      return;
    }
    const lockLamports = role === "a" ? mineLock : mineReceive;
    const receiveLamports = role === "a" ? mineReceive : mineLock;
    setBusy("Saving swap terms");
    setFailure(null);
    try {
      await post({
        action: "wallet-terms",
        escrow: address,
        lockLamports: lockLamports.toString(),
        receiveLamports: receiveLamports.toString(),
      });
      setNotice(`Saved. You lock ${sol(mineLock.toString())}. You receive ${sol(mineReceive.toString())}. The program does not enforce these amounts.`);
      await refreshEscrows();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "The swap terms were not saved.");
    } finally {
      setBusy(null);
    }
  }

  async function lock(row: EscrowView): Promise<void> {
    if (seed === null || wallet === null || signTransaction === undefined || publicKey === null) return;
    const selected = spendable(ring?.notes ?? []).find((item) => item.hash === note);
    if (selected === undefined) {
      setFailure("Choose a private note with a balance first. A zero note cannot be split.");
      return;
    }
    const stored = terms[row.address];
    if (stored === undefined) {
      setFailure(chunkRefusal("missing-terms"));
      return;
    }
    const agreed = BigInt(sideView(row.role, stored).lock);
    const typed = solToLamports(lockAmounts[row.address] ?? lamportsToInput(agreed.toString()));
    if (typed === null) {
      setFailure("Enter an amount from 0.000000001 SOL up to 1 SOL.");
      return;
    }
    const plan = planChunk({ noteLamports: BigInt(selected.lamports), typedLamports: typed, agreedLamports: agreed });
    if (!plan.ok) {
      setFailure(chunkRefusal(plan.reason));
      return;
    }
    setBusy(plan.split ? "Splitting the note, then locking the chunk" : "Locking the note");
    setNotice(null);
    setFailure(null);
    try {
      if (plan.split) {
        const ringKey = Keypair.fromSeed(seed);
        const balance = await connection.getBalance(ringKey.publicKey);
        if (balance < RING_FEE_RESERVE) {
          const tx = new Transaction().add(
            SystemProgram.transfer({ fromPubkey: publicKey, toPubkey: ringKey.publicKey, lamports: RING_FEE_RESERVE - balance }),
          );
          tx.feePayer = publicKey;
          tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
          setNotice("Confirm the SOL transfer. It pays the fee for splitting the note.");
          await submit(await signTransaction(tx));
        }
      }
      const payload = await post({
        action: "wallet-lock",
        seed: Buffer.from(seed).toString("hex"),
        wallet,
        escrow: row.address,
        note: selected.hash,
        lamports: typed.toString(),
      });
      const raw = payload.result?.tx;
      if (typeof raw !== "string") throw new Error("The lock transaction was not returned.");
      const tx = Transaction.from(Buffer.from(raw, "base64"));
      const signature = await submit(await signTransaction(tx));
      const split = payload.result?.split;
      const splitNote = typeof split === "string" ? ` Split ${split}.` : "";
      setNotice(`Locked ${sol(typed.toString())}.${splitNote} ${signature}`);
      await refreshEscrows();
      await refreshNotes();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "The lock failed.");
      try {
        await refreshNotes();
      } catch (refreshError) {
        setNotice(refreshError instanceof Error ? refreshError.message : "The notes could not be refreshed after the lock.");
      }
    } finally {
      setBusy(null);
    }
  }

  async function swap(row: EscrowView): Promise<void> {
    if (seed === null || wallet === null) return;
    const mine = ring?.shieldedAddressHex ?? shieldedFor(wallet);
    const otherWallet = row.role === "a" ? row.partyB : row.partyA;
    const other = shieldedFor(otherWallet);
    if (mine === undefined || mine === null || other === null) {
      setFailure("Unlock the ring on both wallets in this browser before the swap. The chain does not store the shielded addresses.");
      return;
    }
    setBusy("Swapping");
    setFailure(null);
    try {
      const ringKey = Keypair.fromSeed(seed);
      const balance = await connection.getBalance(ringKey.publicKey);
      if (balance < RING_FEE_RESERVE && publicKey !== null && signTransaction !== undefined) {
        const tx = new Transaction().add(
          SystemProgram.transfer({ fromPubkey: publicKey, toPubkey: ringKey.publicKey, lamports: RING_FEE_RESERVE - balance }),
        );
        tx.feePayer = publicKey;
        tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
        await submit(await signTransaction(tx));
      }
      const toA = row.role === "a" ? mine : other;
      const toB = row.role === "a" ? other : mine;
      const payload = await post({ action: "wallet-swap", seed: Buffer.from(seed).toString("hex"), escrow: row.address, toA, toB });
      const signature = payload.result?.signature;
      setNotice(typeof signature === "string" ? `Swapped. ${signature}` : "Swapped.");
      await refreshEscrows();
      await refreshNotes();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "The swap failed.");
    } finally {
      setBusy(null);
    }
  }

  async function finalize(row: EscrowView): Promise<void> {
    if (publicKey === null || signTransaction === undefined) return;
    setBusy("Finalizing");
    setFailure(null);
    try {
      const escrowKey = new PublicKey(row.address);
      const partyA = new PublicKey(row.partyA);
      const keys = [
        { pubkey: escrowKey, isSigner: false, isWritable: true },
        { pubkey: publicKey, isSigner: true, isWritable: true },
      ];
      if (!publicKey.equals(partyA)) keys.push({ pubkey: partyA, isSigner: false, isWritable: true });
      const tx = new Transaction().add(new TransactionInstruction({ keys, programId: PROGRAM_ID, data: Buffer.from([6]) }));
      tx.feePayer = publicKey;
      tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
      const signature = await submit(await signTransaction(tx));
      let returned = "";
      if (seed !== null && wallet !== null) {
        const back = await post({ action: "wallet-return", seed: Buffer.from(seed).toString("hex"), wallet });
        const lamports = back.result?.lamports;
        if (typeof lamports === "string" && lamports !== "0") returned = ` Returned ${sol(lamports)} from the ring key.`;
      }
      setNotice(`Closed. Rent went to the opener. ${signature}.${returned}`);
      await refreshEscrows();
      await refreshNotes();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "The close failed.");
    } finally {
      setBusy(null);
    }
  }

  const openNotes = spendable(ring?.notes ?? []);
  const selected = openNotes.find((item) => item.hash === note) ?? openNotes[0];

  return (
    <div>
      <p className="text-sm tracking-[0.18em] text-stamp uppercase">Desk</p>
      <h1 className="mt-4 max-w-3xl font-serif text-5xl tracking-[-0.035em] md:text-6xl">Connect a wallet. Trade a private note.</h1>
      <p className="mt-6 max-w-2xl leading-7 text-muted">
        Solflare is the public party on the escrow. One signature in this tab derives the key that holds the private notes. That key is sent to this local dev server to build proofs, and it is not written down.
      </p>
      <p className="mt-4 max-w-2xl text-sm leading-6 text-muted">
        Both wallets approve before either note can move. Opening an escrow records two SOL amounts on this machine: what you lock, and what you receive. The program does not enforce those amounts. This desk refuses a lock that does not match your side. Rent from the escrow goes back to the wallet that opened it.
      </p>

      <div className="mt-8 flex flex-wrap gap-3">
        <button type="button" className="border border-foreground px-4 py-2 text-sm" onClick={() => setVisible(true)}>
          {connected && wallet !== null ? short(wallet) : "Select wallet"}
        </button>
        {connected && wallet !== null ? (
          <button type="button" className="border border-line px-4 py-2 text-sm" onClick={() => void disconnect().then(() => { setSeed(null); setRing(null); })}>
            Disconnect
          </button>
        ) : null}
        {connected ? (
          <button type="button" className="border border-foreground px-4 py-2 text-sm disabled:opacity-40" disabled={busy !== null} onClick={() => void unlockRing()}>
            Unlock private notes
          </button>
        ) : null}
      </div>

      {busy !== null ? <p className="mt-8 text-sm">{busy}…</p> : null}
      {notice !== null ? <p className="mt-8 max-w-3xl break-all text-sm leading-6">{notice}</p> : null}
      {failure !== null ? <p className="mt-8 max-w-3xl break-all text-sm leading-6 text-stamp">{failure}</p> : null}

      {ring !== null ? (
        <section className="mt-12 border-t border-line pt-10">
          <h2 className="font-serif text-3xl tracking-[-0.03em]">Private SOL</h2>
          <p className="mt-2 text-sm text-muted">Ring key {short(ring.ring)} · public on that key {sol(ring.sol)}</p>
          <ul className="mt-4 space-y-2 text-sm">
            {ring.notes.length === 0 ? <li className="text-muted">No private SOL yet.</li> : ring.notes.map((item) => {
              const chunkSource = item.lamports !== "0";
              return (
                <li key={item.hash}>
                  <label className="flex items-start gap-2">
                    <input type="radio" name="note" disabled={!chunkSource} checked={chunkSource && (selected?.hash ?? "") === item.hash} onChange={() => setNote(item.hash)} />
                    <span>{sol(item.lamports)} <span className="text-muted">{short(item.hash)} · leaf {item.leaf}{chunkSource ? "" : " · not a chunk source"}</span></span>
                  </label>
                </li>
              );
            })}
          </ul>
          <label className="mt-6 block max-w-xs text-sm">
            Shield amount in SOL
            <input className="mt-2 w-full border border-line bg-transparent px-3 py-2" value={shieldAmount} onChange={(event) => setShieldAmount(event.target.value)} />
          </label>
          <button type="button" className="mt-4 border border-foreground px-4 py-2 text-sm disabled:opacity-40" disabled={busy !== null} onClick={() => void shield()}>
            Shield
          </button>
        </section>
      ) : null}

      {connected ? (
        <section className="mt-12 border-t border-line pt-10">
          <h2 className="font-serif text-3xl tracking-[-0.03em]">Open an escrow</h2>
          <label className="mt-4 block max-w-xl text-sm">
            Other wallet address
            <input className="mt-2 w-full border border-line bg-transparent px-3 py-2" value={counterparty} onChange={(event) => setCounterparty(event.target.value)} />
          </label>
          <label className="mt-4 block max-w-xs text-sm">
            SOL you will lock
            <input className="mt-2 w-full border border-line bg-transparent px-3 py-2" value={giveAmount} onChange={(event) => setGiveAmount(event.target.value)} />
          </label>
          <label className="mt-4 block max-w-xs text-sm">
            SOL you expect back
            <input className="mt-2 w-full border border-line bg-transparent px-3 py-2" value={wantAmount} onChange={(event) => setWantAmount(event.target.value)} />
          </label>
          <p className="mt-3 max-w-xl text-sm leading-6 text-muted">The program does not enforce these amounts. They are stored on this machine, and a lock must match your side.</p>
          <button type="button" className="mt-4 border border-foreground px-4 py-2 text-sm disabled:opacity-40" disabled={busy !== null} onClick={() => void openEscrow()}>
            Open and approve
          </button>
        </section>
      ) : null}

      <section className="mt-12 border-t border-line pt-10">
        <h2 className="font-serif text-3xl tracking-[-0.03em]">Escrows</h2>
        {wallet === null ? <p className="mt-4 text-sm text-muted">Select a wallet to see deals for that address.</p> : null}
        {wallet !== null && escrows.length === 0 ? <p className="mt-4 text-sm text-muted">No escrow for this wallet.</p> : null}
        <ul className="mt-6 space-y-8">
          {escrows.map((row) => {
            const mineApproved = row.role === "a" ? row.aApproved : row.bApproved;
            const stored = terms[row.address];
            const view = stored === undefined ? null : sideView(row.role, stored);
            const draft = drafts[row.address] ?? { lock: "0.01", receive: "0.02" };
            const canLock = row.aApproved && row.bApproved && row.status === "Proposed" && !(row.role === "a" ? row.aSealed : row.bSealed);
            return (
              <li key={row.address} className="text-sm leading-7">
                <p className="break-all">{row.address}</p>
                <p className="text-muted">
                  You are {row.role === "a" ? "the opener" : "the counterparty"} · {row.status} · seals {row.aSealed ? "1" : "0"}/{row.bSealed ? "1" : "0"}
                </p>
                {view !== null ? (
                  <p>You lock {sol(view.lock)}. You receive {sol(view.receive)}. The program does not enforce these amounts.</p>
                ) : (
                  <div className="mt-3 max-w-xl">
                    <p className="text-muted">No swap terms on this machine yet. The program does not store them.</p>
                    <label className="mt-3 block">
                      SOL you will lock
                      <input className="mt-2 w-full border border-line bg-transparent px-3 py-2" value={draft.lock} onChange={(event) => setDrafts((current) => ({ ...current, [row.address]: { ...draft, lock: event.target.value } }))} />
                    </label>
                    <label className="mt-3 block">
                      SOL you expect back
                      <input className="mt-2 w-full border border-line bg-transparent px-3 py-2" value={draft.receive} onChange={(event) => setDrafts((current) => ({ ...current, [row.address]: { ...draft, receive: event.target.value } }))} />
                    </label>
                    <button type="button" className="mt-3 border border-foreground px-4 py-2 disabled:opacity-40" disabled={busy !== null} onClick={() => void saveTerms(row.address, row.role, draft.lock, draft.receive)}>Save swap terms</button>
                  </div>
                )}
                <div className="mt-3 flex flex-wrap items-end gap-3">
                  {!mineApproved && row.status === "Proposed" ? (
                    <button type="button" className="border border-foreground px-4 py-2 disabled:opacity-40" disabled={busy !== null} onClick={() => void approve(row)}>Approve</button>
                  ) : null}
                  {canLock ? (
                    <label>
                      Amount in SOL
                      <input
                        className="mt-2 block w-40 border border-line bg-transparent px-3 py-2"
                        value={lockAmounts[row.address] ?? (view === null ? "" : lamportsToInput(view.lock))}
                        onChange={(event) => setLockAmounts((current) => ({ ...current, [row.address]: event.target.value }))}
                      />
                    </label>
                  ) : null}
                  {canLock ? (
                    <button type="button" className="border border-foreground px-4 py-2 disabled:opacity-40" disabled={busy !== null || seed === null} onClick={() => void lock(row)}>Lock into escrow</button>
                  ) : null}
                  {row.aSealed && row.bSealed && row.status === "Proposed" ? (
                    <button type="button" className="border border-foreground px-4 py-2 disabled:opacity-40" disabled={busy !== null || seed === null} onClick={() => void swap(row)}>Swap</button>
                  ) : null}
                  {row.status === "Exchanged" || row.status === "Reclaimed" || row.status === "Void" ? (
                    <button type="button" className="border border-foreground px-4 py-2 disabled:opacity-40" disabled={busy !== null} onClick={() => void finalize(row)}>Finalize</button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
