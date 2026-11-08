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
import { useEffect, useRef, useState, type MutableRefObject, type ReactNode } from "react";
import { SOL_MINT } from "@/lib/chunk-plan";
import { RING_MESSAGE } from "@/lib/desk-request";
import { parseBaseAmount } from "@/lib/escrow-params";
import { kindAgrees, solAssetInfo, type AssetInfo } from "@/lib/mint-account";
import { notesForRedeem, redeemStopMessage } from "@/lib/note-selection";
import { type TokenMetadata } from "@/lib/token-metadata";
import { withoutSignatures } from "@/lib/tx-log";
import { readHeldAssetList, shieldBaseAmount, type HeldAsset } from "@/lib/wallet-holdings";
import {
  deskSignature,
  fundRingKey,
  loadAsset,
  post,
  readNotes,
  rememberAssets,
  rememberMetadata,
  rememberShielded,
  sendTracked,
  signatureNotice,
} from "./desk-client";
import { LinkedText } from "./chain-link";
import { DeskTabs, type DeskTab } from "./desk-tabs";
import { Fold } from "./fold";
import { formatAsset, formatBase, short } from "./format";
import { PrivateBalance } from "./private-balance";
import { ShieldDialog } from "./shield-dialog";
import { TX_COPY } from "./tx-copy";
import { useTxActivity, useTxLog } from "./tx-drawer";
import type { Note, RingState } from "./types";
import { WalletBar } from "./wallet-bar";

export type RingSession = {
  readonly seed: Uint8Array | null;
  readonly ring: RingState | null;
  readonly ownerHashHex: string | null;
  readonly wallet: string | null;
  readonly selectedHash: string;
  readonly selectedHashes: readonly string[];
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
  selectedHashes: [],
  busy: false,
  assets: { [SOL_MINT]: solAssetInfo() },
  metadata: {},
};

const METADATA_SCAN_LIMIT = 32;

type RingBalanceShared = {
  readonly apiRef?: MutableRefObject<RingApi | null>;
  readonly paused: boolean;
  readonly onSession: (session: RingSession) => void;
};

export type RingBalanceProps =
  | (RingBalanceShared & { readonly desk: "balance" })
  | (RingBalanceShared & {
      readonly desk: "escrow";
      readonly tab: DeskTab;
      readonly onTab: (tab: DeskTab) => void;
      readonly balance: ReactNode;
      readonly create: ReactNode;
    });

export function RingBalance(props: RingBalanceProps) {
  const { apiRef, paused, onSession } = props;
  const escrow = props.desk === "escrow" ? props : null;
  const { publicKey, connected, disconnect, signMessage, signTransaction } = useWallet();
  const { setVisible } = useWalletModal();
  const seenWallet = useRef<string | null>(null);
  const unlockAttempt = useRef<string | null>(null);
  const [seed, setSeed] = useState<Uint8Array | null>(null);
  const [ring, setRing] = useState<RingState | null>(null);
  const [ownerHashHex, setOwnerHashHex] = useState<string | null>(null);
  const [assets, setAssets] = useState<Record<string, AssetInfo>>({ [SOL_MINT]: solAssetInfo() });
  const [metadata, setMetadata] = useState<Record<string, TokenMetadata>>({});
  const [note, setNote] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [shieldOpen, setShieldOpen] = useState(false);
  const [holdings, setHoldings] = useState<readonly HeldAsset[] | null>(null);
  const [holdingsLoading, setHoldingsLoading] = useState(false);
  const wallet = publicKey?.toBase58() ?? null;
  const locked = busy !== null || paused;
  const txLog = useTxLog();
  useTxActivity(busy);

  function chooseTab(next: DeskTab): void {
    if (escrow === null) return;
    escrow.onTab(next);
  }

  useEffect(() => {
    if (seenWallet.current === wallet) return;
    if (seenWallet.current !== null) {
      setSeed(null);
      setRing(null);
      setOwnerHashHex(null);
      setNote([]);
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
    setNote((current) => current.filter((hash) => spendable.some((item) => item.hash === hash)));
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
      selectNote: (hash) => setNote([hash]),
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
      selectedHash: note.length === 1 ? (note[0] ?? "") : "",
      selectedHashes: note,
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
      await fundRingKey(publicKey, seed, signTransaction, txLog, asset.kind === "sol" ? amount : BigInt(0));
      if (asset.kind === "sol") {
        const payload = await txLog.run(
          TX_COPY.shield,
          "desk",
          () => post({ action: "wallet-shield", seed: Buffer.from(seed).toString("hex"), lamports: amount.toString() }),
          deskSignature,
        );
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
        await sendTracked(txLog, TX_COPY.moveToken, move, publicKey, signTransaction);
        const tokenProgramId = info.tokenProgram;
        const payload = await txLog.run(
          TX_COPY.shield,
          "desk",
          () =>
            post({
              action: "wallet-shield",
              seed: Buffer.from(seed).toString("hex"),
              lamports: amount.toString(),
              mint: asset.mint,
              tokenAccount: destination.toBase58(),
              tokenProgram: tokenProgramId,
            }),
          deskSignature,
        );
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

  async function redeemSelected(): Promise<void> {
    if (seed === null || publicKey === null || signTransaction === undefined || wallet === null || ring === null) return;
    const catalog = notesForRedeem(
      ring.notes.flatMap((item) => (/^\d+$/.test(item.amount) ? [{ hash: item.hash, mint: item.mint, amount: BigInt(item.amount) }] : [])),
      note,
    );
    if (catalog.length === 0) return;
    const known = new Map<string, AssetInfo>(Object.entries(assets));
    const sent: string[] = [];
    let lastSignature: unknown;
    setBusy("Redeeming");
    setNotice(null);
    setFailure(null);
    try {
      for (let index = 0; index < catalog.length; index += 1) {
        const item = catalog[index];
        if (item === undefined) continue;
        const row = ring.notes.find((candidate) => candidate.hash === item.hash);
        const label = row === undefined ? short(item.hash) : formatAsset(row.amount, row.mint, known.get(row.mint)?.decimals, metadata[row.mint]);
        if (row === undefined) {
          setFailure(redeemStopMessage(label, sent, "That note is no longer in the private balance."));
          return;
        }
        setBusy(`Redeeming ${index + 1} of ${catalog.length}`);
        try {
          lastSignature = await withdrawNote(row, known);
          sent.push(label);
        } catch (error) {
          const reason = error instanceof Error ? error.message : "The redeem failed.";
          setFailure(redeemStopMessage(label, sent, reason));
          return;
        }
      }
      const done = sent.length === 1 ? "Redeemed to your public balance." : `Redeemed ${sent.length} notes to your public balance.`;
      setNotice(signatureNotice(done, lastSignature));
    } finally {
      setBusy(null);
      try {
        await refreshNotes();
      } catch (error) {
        const message = error instanceof Error ? error.message : "The private balance could not be read after the redeem.";
        setFailure((current) => (current === null ? message : current));
      }
    }
  }

  async function withdrawNote(row: Note, known: Map<string, AssetInfo>): Promise<unknown> {
    if (seed === null || publicKey === null || signTransaction === undefined || wallet === null) {
      throw new Error("Connect a wallet before redeeming.");
    }
    let info = row.mint === SOL_MINT ? solAssetInfo() : known.get(row.mint);
    if (info === undefined) {
      const loaded = await loadAsset({ kind: "token", mint: row.mint, amount: "1" });
      known.set(row.mint, loaded);
      setAssets((current) => ({ ...current, [row.mint]: loaded }));
      info = loaded;
    }
    if (!kindAgrees(info.kind, row.mint, info)) throw new Error("The asset kind does not match the mint.");
    const amountText = info.kind === "nft" ? "1" : formatBase(row.amount, info.decimals);
    const amount = parseBaseAmount(amountText, info.decimals);
    if (amount === null || amount > BigInt(row.amount)) throw new Error("Enter an amount above zero, up to this note.");
    if (row.mint !== SOL_MINT && info.tokenProgram === null) throw new Error("the mint has no token program");
    await fundRingKey(publicKey, seed, signTransaction, txLog);
    const payload = await txLog.run(
      TX_COPY.redeem,
      "desk",
      () =>
        post({
          action: "wallet-withdraw",
          seed: Buffer.from(seed).toString("hex"),
          wallet,
          mint: row.mint,
          amount: amount.toString(),
          ...(row.mint === SOL_MINT || info.tokenProgram === null ? {} : { tokenProgram: info.tokenProgram }),
        }),
      deskSignature,
    );
    return payload.result?.signature;
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
        onDisconnect={() => {
          void disconnect()
            .then(() => {
              setSeed(null);
              setRing(null);
              setOwnerHashHex(null);
              setNote([]);
            })
            .catch((error: unknown) => {
              setFailure(error instanceof Error ? error.message : "The wallet did not disconnect.");
            });
        }}
      />
      {escrow !== null ? <DeskTabs tab={escrow.tab} onTab={chooseTab} /> : null}
      {busy !== null ? <p className="mt-8 text-sm">{busy}…</p> : null}
      {notice !== null ? (
        <p className="mt-8 max-w-3xl text-sm leading-6 break-all">
          <LinkedText text={withoutSignatures(notice)} />
        </p>
      ) : null}
      {failure !== null && !shieldOpen ? (
        <p className="mt-8 max-w-3xl text-sm leading-6 break-all text-stamp">
          <LinkedText text={failure} />
        </p>
      ) : null}
      <div
        id={escrow !== null ? "desk-panel-balance" : undefined}
        role={escrow !== null ? "tabpanel" : undefined}
        aria-labelledby={escrow !== null ? "desk-tab-balance" : undefined}
        hidden={escrow !== null && escrow.tab !== "balance"}
      >
        {ring === null ? (
          <section className="mt-6">
            <Fold title="Private balance" className="font-serif text-2xl tracking-[-0.03em]">
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
            onToggle={(hash) =>
              setNote((current) => (current.includes(hash) ? current.filter((item) => item !== hash) : [...current, hash]))
            }
            onAdd={() => {
              void openAdd();
            }}
            onRedeem={() => {
              void redeemSelected();
            }}
          />
        )}
        {escrow?.balance}
      </div>
      {escrow !== null ? (
        <div id="desk-panel-new" role="tabpanel" aria-labelledby="desk-tab-new" hidden={escrow.tab !== "new"}>
          {escrow.create}
        </div>
      ) : null}
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
    </div>
  );
}
