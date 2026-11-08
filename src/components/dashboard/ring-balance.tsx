"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { Buffer } from "buffer";
import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { SOL_MINT } from "@/lib/chunk-plan";
import { RING_MESSAGE } from "@/lib/desk-request";
import { parseBaseAmount } from "@/lib/escrow-params";
import { kindAgrees, solAssetInfo, type AssetInfo } from "@/lib/mint-account";
import { type TokenMetadata } from "@/lib/token-metadata";
import { readHeldAssetList, shieldBaseAmount, type HeldAsset } from "@/lib/wallet-holdings";
import {
  fundRingKey,
  loadAsset,
  post,
  readNotes,
  rememberAssets,
  rememberMetadata,
  rememberShielded,
  signAndSend,
  signatureNotice,
} from "./desk-client";
import { Fold } from "./fold";
import { PrivateBalance } from "./private-balance";
import { RedeemDialog } from "./redeem-dialog";
import { ShieldDialog } from "./shield-dialog";
import type { Note, RingState } from "./types";
import { WalletBar } from "./wallet-bar";

export type RingSession = {
  readonly seed: Uint8Array | null;
  readonly ring: RingState | null;
  readonly ownerHashHex: string | null;
  readonly wallet: string | null;
  readonly selectedHash: string;
  readonly busy: boolean;
  readonly assets: Readonly<Record<string, AssetInfo>>;
  readonly metadata: Readonly<Record<string, TokenMetadata>>;
};

export type RingApi = {
  refreshNotes: () => Promise<RingState | null>;
  selectNote: (hash: string) => void;
  shield: (asset: HeldAsset, amountText: string) => Promise<RingState>;
};

export const EMPTY_RING_SESSION: RingSession = {
  seed: null,
  ring: null,
  ownerHashHex: null,
  wallet: null,
  selectedHash: "",
  busy: false,
  assets: { [SOL_MINT]: solAssetInfo() },
  metadata: {},
};

const METADATA_SCAN_LIMIT = 32;

export function RingBalance({
  apiRef,
  paused,
  onSession,
}: {
  apiRef?: MutableRefObject<RingApi | null>;
  paused: boolean;
  onSession: (session: RingSession) => void;
}) {
  const { publicKey, connected, disconnect, signMessage, signTransaction } = useWallet();
  const { setVisible } = useWalletModal();
  const seenWallet = useRef<string | null>(null);
  const unlockAttempt = useRef<string | null>(null);
  const [seed, setSeed] = useState<Uint8Array | null>(null);
  const [ring, setRing] = useState<RingState | null>(null);
  const [ownerHashHex, setOwnerHashHex] = useState<string | null>(null);
  const [assets, setAssets] = useState<Record<string, AssetInfo>>({ [SOL_MINT]: solAssetInfo() });
  const [metadata, setMetadata] = useState<Record<string, TokenMetadata>>({});
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [shieldOpen, setShieldOpen] = useState(false);
  const [holdings, setHoldings] = useState<readonly HeldAsset[] | null>(null);
  const [holdingsLoading, setHoldingsLoading] = useState(false);
  const [redeemNote, setRedeemNote] = useState<Note | null>(null);

  const wallet = publicKey?.toBase58() ?? null;
  const locked = busy !== null || paused;

  useEffect(() => {
    if (seenWallet.current === wallet) return;
    if (seenWallet.current !== null) {
      setSeed(null);
      setRing(null);
      setOwnerHashHex(null);
      setNote("");
    }
    seenWallet.current = wallet;
  }, [wallet]);

  async function refreshNotes(current = seed): Promise<RingState | null> {
    if (current === null) return null;
    const payload = await post({ action: "wallet-notes", seed: Buffer.from(current).toString("hex") });
    const result = payload.result;
    if (result === undefined || !Array.isArray(result.notes)) return null;
    const notes = readNotes(result.notes);
    const next: RingState = {
      ring: typeof result.ring === "string" ? result.ring : "",
      shieldedAddressHex: typeof result.shieldedAddressHex === "string" ? result.shieldedAddressHex : "",
      sol: typeof result.sol === "string" ? result.sol : "0",
      notes,
    };
    setRing(next);
    setOwnerHashHex(typeof result.ownerHashHex === "string" ? result.ownerHashHex : null);
    if (wallet !== null && next.shieldedAddressHex.length > 0) rememberShielded(wallet, next.shieldedAddressHex);
    const spendable = notes.filter((item) => item.amount !== "0");
    setNote((selectedHash) => (spendable.some((item) => item.hash === selectedHash) ? selectedHash : (spendable[0]?.hash ?? "")));
    await rememberAssets(
      spendable.map((item) => ({ kind: item.mint === SOL_MINT ? "sol" : "token", mint: item.mint, amount: item.amount })),
      (mint, info) => setAssets((currentAssets) => ({ ...currentAssets, [mint]: info })),
    );
    await rememberMetadata(
      notes.map((item) => item.mint),
      (mint, meta) => setMetadata((current) => ({ ...current, [mint]: meta })),
    );
    return next;
  }

  async function unlockRing(): Promise<void> {
    if (signMessage === undefined) {
      setFailure("The wallet did not offer message signing.");
      return;
    }
    setBusy("Waiting for the wallet");
    setFailure(null);
    try {
      const signature = await signMessage(new TextEncoder().encode(RING_MESSAGE));
      const signed = new Uint8Array(signature.byteLength);
      signed.set(signature);
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", signed));
      setSeed(digest);
      setNotice("Ring key is unlocked in this tab. It is not stored.");
      await refreshNotes(digest);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "The wallet did not sign.");
    } finally {
      setBusy(null);
    }
  }

  const unlockRingRef = useRef(unlockRing);
  unlockRingRef.current = unlockRing;
  const refreshRef = useRef(refreshNotes);
  refreshRef.current = refreshNotes;
  const shieldRef = useRef(shield);
  shieldRef.current = shield;

  useEffect(() => {
    if (apiRef === undefined) return;
    apiRef.current = {
      refreshNotes: () => refreshRef.current(),
      selectNote: (hash) => setNote(hash),
      shield: (asset, amountText) => shieldRef.current(asset, amountText),
    };
    return () => {
      apiRef.current = null;
    };
  }, [apiRef]);

  useEffect(() => {
    if (wallet === null) {
      unlockAttempt.current = null;
      return;
    }
    if (signMessage === undefined || seed !== null || unlockAttempt.current === wallet) return;
    unlockAttempt.current = wallet;
    void unlockRingRef.current();
  }, [wallet, signMessage, seed]);

  useEffect(() => {
    onSession({
      seed,
      ring,
      ownerHashHex,
      wallet: connected ? wallet : null,
      selectedHash: note,
      busy: busy !== null,
      assets,
      metadata,
    });
  }, [seed, ring, ownerHashHex, wallet, connected, note, busy, assets, metadata, onSession]);

  async function openAdd(): Promise<void> {
    setFailure(null);
    setShieldOpen(true);
    if (wallet === null) return;
    setHoldingsLoading(true);
    setHoldings(null);
    try {
      const payload = await post({ action: "wallet-holdings", wallet });
      const list = readHeldAssetList(payload.result?.holdings);
      setHoldings(list);
      await rememberMetadata(
        list.slice(0, METADATA_SCAN_LIMIT).map((asset) => asset.mint),
        (mint, meta) => setMetadata((current) => ({ ...current, [mint]: meta })),
      );
    } catch (error) {
      setHoldings([]);
      setFailure(error instanceof Error ? error.message : "The wallet balances could not be read.");
    } finally {
      setHoldingsLoading(false);
    }
  }

  async function shield(asset: HeldAsset, amountText: string): Promise<RingState> {
    if (seed === null || publicKey === null || signTransaction === undefined) {
      throw new Error("Unlock private balance before shielding.");
    }
    setBusy("Shielding");
    setNotice(null);
    setFailure(null);
    try {
      const info = await loadAsset({ kind: asset.kind, mint: asset.mint, amount: amountText });
      if (!kindAgrees(asset.kind, asset.mint, info)) {
        throw new Error("The asset kind does not match the mint.");
      }
      const amount = shieldBaseAmount(asset.kind === "nft" ? "1" : amountText, asset);
      if (amount === null) {
        throw new Error("Enter an amount above zero, up to the balance in this wallet.");
      }
      await fundRingKey(publicKey, seed, signTransaction, asset.kind === "sol" ? amount : BigInt(0));
      if (asset.kind === "sol") {
        const payload = await post({ action: "wallet-shield", seed: Buffer.from(seed).toString("hex"), lamports: amount.toString() });
        setNotice(signatureNotice("Shielded.", payload.result?.signature));
      } else {
        if (info.tokenProgram === null || asset.tokenAccount === null || asset.tokenProgram === null) {
          throw new Error("the mint has no token program");
        }
        if (info.tokenProgram !== asset.tokenProgram) throw new Error("The token program does not match the mint.");
        const mintKey = new PublicKey(asset.mint);
        const tokenProgram = new PublicKey(info.tokenProgram);
        const ringKey = Keypair.fromSeed(seed);
        const source = new PublicKey(asset.tokenAccount);
        const destination = getAssociatedTokenAddressSync(mintKey, ringKey.publicKey, false, tokenProgram);
        const move = new Transaction().add(
          createAssociatedTokenAccountIdempotentInstruction(publicKey, destination, ringKey.publicKey, mintKey, tokenProgram),
          createTransferCheckedInstruction(source, mintKey, destination, publicKey, amount, info.decimals, [], tokenProgram),
        );
        await signAndSend(move, publicKey, signTransaction);
        const payload = await post({
          action: "wallet-shield",
          seed: Buffer.from(seed).toString("hex"),
          lamports: amount.toString(),
          mint: asset.mint,
          tokenAccount: destination.toBase58(),
          tokenProgram: info.tokenProgram,
        });
        setNotice(signatureNotice("Shielded.", payload.result?.signature));
      }
      setAssets((current) => ({ ...current, [asset.mint]: info }));
      setShieldOpen(false);
      const next = await refreshNotes();
      if (next === null) throw new Error("The private balance could not be read after the shield.");
      return next;
    } catch (error) {
      const message = error instanceof Error ? error.message : "The shield failed.";
      setFailure(message);
      throw new Error(message);
    } finally {
      setBusy(null);
    }
  }

  async function openRedeem(row: Note): Promise<void> {
    setFailure(null);
    if (row.mint !== SOL_MINT && assets[row.mint] === undefined) {
      try {
        const info = await loadAsset({ kind: "token", mint: row.mint, amount: "1" });
        setAssets((current) => ({ ...current, [row.mint]: info }));
      } catch (error) {
        setFailure(error instanceof Error ? error.message : "The mint could not be read.");
        return;
      }
    }
    setRedeemNote(row);
  }

  async function redeem(amountText: string): Promise<void> {
    if (seed === null || publicKey === null || signTransaction === undefined || wallet === null || redeemNote === null) return;
    const row = redeemNote;
    setBusy("Redeeming");
    setNotice(null);
    setFailure(null);
    try {
      const info = row.mint === SOL_MINT ? solAssetInfo() : assets[row.mint];
      if (info === undefined) throw new Error("The mint could not be read.");
      if (!kindAgrees(info.kind, row.mint, info)) throw new Error("The asset kind does not match the mint.");
      const amount = parseBaseAmount(info.kind === "nft" ? "1" : amountText, info.decimals);
      if (amount === null || amount > BigInt(row.amount)) {
        setFailure("Enter an amount above zero, up to this note.");
        return;
      }
      if (row.mint !== SOL_MINT && info.tokenProgram === null) throw new Error("the mint has no token program");
      await fundRingKey(publicKey, seed, signTransaction);
      const payload = await post({
        action: "wallet-withdraw",
        seed: Buffer.from(seed).toString("hex"),
        wallet,
        mint: row.mint,
        amount: amount.toString(),
        ...(row.mint === SOL_MINT || info.tokenProgram === null ? {} : { tokenProgram: info.tokenProgram }),
      });
      setNotice(signatureNotice("Redeemed to your public balance.", payload.result?.signature));
      setRedeemNote(null);
      await refreshNotes();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "The redeem failed.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <WalletBar
        wallet={connected ? wallet : null}
        unlocked={seed !== null}
        busy={locked}
        onConnect={() => {
          if (!connected || seed === null) {
            if (!connected) setVisible(true);
            else void unlockRing();
            return;
          }
          setVisible(true);
        }}
        onAdd={() => {
          void openAdd();
        }}
        onDisconnect={() => {
          void disconnect()
            .then(() => {
              setSeed(null);
              setRing(null);
              setOwnerHashHex(null);
              setNote("");
            })
            .catch((error: unknown) => {
              setFailure(error instanceof Error ? error.message : "The wallet did not disconnect.");
            });
        }}
      />
      {busy !== null ? <p className="mt-8 text-sm">{busy}…</p> : null}
      {notice !== null ? <p className="mt-8 max-w-3xl break-all text-sm leading-6">{notice}</p> : null}
      {failure !== null && !shieldOpen && redeemNote === null ? (
        <p className="mt-8 max-w-3xl break-all text-sm leading-6 text-stamp">{failure}</p>
      ) : null}
      {ring === null ? (
        <section className="mt-12 border-t border-line pt-10">
          <Fold title="Private balance" className="font-serif text-3xl tracking-[-0.03em]">
            <p className="mt-2 text-sm text-muted">Connect and sign the ring key to see this wallet&apos;s private balance.</p>
          </Fold>
        </section>
      ) : (
        <PrivateBalance
          ring={ring}
          assets={assets}
          metadata={metadata}
          selected={note}
          busy={locked}
          onSelect={setNote}
          onAdd={() => {
            void openAdd();
          }}
          onRedeem={(row) => void openRedeem(row)}
        />
      )}
      <ShieldDialog
        open={shieldOpen}
        busy={locked}
        error={shieldOpen ? failure : null}
        holdings={holdings}
        loading={holdingsLoading}
        metadata={metadata}
        onClose={() => setShieldOpen(false)}
        onShield={(asset, amount) => {
          void shield(asset, amount).catch(() => {
            // The dialog shows the failure recorded above.
          });
        }}
      />
      <RedeemDialog
        key={redeemNote?.hash ?? "redeem"}
        note={redeemNote}
        info={redeemNote === null ? null : redeemNote.mint === SOL_MINT ? solAssetInfo() : (assets[redeemNote.mint] ?? null)}
        busy={locked}
        error={redeemNote === null ? null : failure}
        onClose={() => setRedeemNote(null)}
        onRedeem={(amount) => void redeem(amount)}
      />
    </div>
  );
}
