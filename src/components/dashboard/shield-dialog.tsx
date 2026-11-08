import { useEffect, useState } from "react";
import { metadataLabel, type TokenMetadata } from "@/lib/token-metadata";
import {
  clampShieldText,
  openingShieldText,
  shieldBaseAmount,
  type HeldAsset,
} from "@/lib/wallet-holdings";
import { formatAsset, short } from "./format";

const FIELD = "mt-2 w-full border border-line bg-transparent px-3 py-2";

export function ShieldDialog({
  open,
  busy,
  error,
  holdings,
  loading,
  metadata,
  onClose,
  onShield,
}: {
  open: boolean;
  busy: boolean;
  error: string | null;
  holdings: readonly HeldAsset[] | null;
  loading: boolean;
  metadata: Readonly<Record<string, TokenMetadata>>;
  onClose: () => void;
  onShield: (asset: HeldAsset, amount: string) => void;
}) {
  const [mint, setMint] = useState("");
  const [amountFor, setAmountFor] = useState("");
  const [amount, setAmount] = useState("");
  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent): void {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  const selected = holdings?.find((asset) => asset.mint === mint) ?? holdings?.[0] ?? null;
  const capKey = selected === null ? "" : `${selected.mint}:${selected.maxBase}`;
  if (selected !== null && amountFor !== capKey) {
    setAmountFor(capKey);
    setAmount(openingShieldText(selected));
  }
  const canShield = selected !== null && !busy && !loading && shieldBaseAmount(amount, selected) !== null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/40 px-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="shield-title"
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto border border-line bg-background p-6"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="shield-title" className="font-serif text-3xl tracking-[-0.03em]">
          Add to private balance
        </h2>
        {loading ? <p className="mt-4 text-sm text-muted">Reading this wallet…</p> : null}
        {holdings !== null && holdings.length === 0 && !loading && error === null ? (
          <p className="mt-4 text-sm leading-6 text-muted">
            Nothing in this wallet can be shielded. SOL has to sit above the fee reserve, and a token or NFT has to be in the wallet.
          </p>
        ) : null}
        {selected !== null && holdings !== null ? (
          <fieldset className="mt-4" disabled={busy}>
            <legend className="text-sm">Asset to shield</legend>
            <label className="mt-3 block text-sm">
              Wallet balance
              <select
                className={FIELD}
                value={selected.mint}
                onChange={(event) => {
                  const next = holdings.find((asset) => asset.mint === event.target.value);
                  if (next === undefined) return;
                  setMint(next.mint);
                  setAmountFor(`${next.mint}:${next.maxBase}`);
                  setAmount(openingShieldText(next));
                }}
              >
                {holdings.map((asset) => (
                  <option key={asset.mint} value={asset.mint}>
                    {assetLabel(asset, metadata[asset.mint])}
                  </option>
                ))}
              </select>
            </label>
            {selected.kind === "nft" ? (
              <p className="mt-3 text-sm text-muted">Amount is 1. You hold this NFT.</p>
            ) : (
              <label className="mt-3 block text-sm">
                Amount · max {formatAsset(selected.maxBase, selected.mint, selected.decimals, metadata[selected.mint])}
                <input
                  className={FIELD}
                  inputMode="decimal"
                  value={amount}
                  onChange={(event) => {
                    const next = clampShieldText(event.target.value, selected);
                    if (next !== null) setAmount(next);
                  }}
                />
              </label>
            )}
          </fieldset>
        ) : null}
        {error !== null ? <p className="mt-4 break-all text-sm leading-6 text-stamp">{error}</p> : null}
        <div className="mt-6 flex gap-3">
          <button
            type="button"
            className="border border-foreground px-4 py-2 text-sm disabled:opacity-40"
            disabled={!canShield}
            onClick={() => {
              if (selected !== null) onShield(selected, amount);
            }}
          >
            Shield
          </button>
          <button type="button" className="border border-line px-4 py-2 text-sm" disabled={busy} onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function assetLabel(asset: HeldAsset, meta: TokenMetadata | undefined): string {
  if (asset.kind === "sol") return `SOL · max ${formatAsset(asset.maxBase, asset.mint, asset.decimals, meta)}`;
  const name = metadataLabel(meta) ?? short(asset.mint);
  const kind = asset.kind === "nft" ? "NFT" : "Token";
  return `${kind} ${name} · max ${formatAsset(asset.maxBase, asset.mint, asset.decimals, meta)}`;
}
