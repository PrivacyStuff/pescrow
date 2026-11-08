import { useEffect, useState } from "react";
import { SOL_DECIMALS, SOL_MINT } from "@/lib/chunk-plan";
import type { AssetInfo } from "@/lib/mint-account";
import { formatAsset, formatBase, short } from "./format";
import type { Note } from "./types";

export function RedeemDialog({
  note,
  info,
  busy,
  error,
  onClose,
  onRedeem,
}: {
  note: Note | null;
  info: AssetInfo | null;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onRedeem: (amount: string) => void;
}) {
  const nft = info?.kind === "nft";
  const decimals = note === null ? 0 : note.mint === SOL_MINT ? SOL_DECIMALS : (info?.decimals ?? 0);
  const [amount, setAmount] = useState(note === null || nft ? "1" : formatBase(note.amount, decimals));

  useEffect(() => {
    if (note === null) return;
    function onKey(event: KeyboardEvent): void {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [note, onClose]);

  if (note === null) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/40 px-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="redeem-title"
        className="w-full max-w-lg border border-line bg-background p-6"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="redeem-title" className="font-serif text-3xl tracking-[-0.03em]">
          Redeem to public
        </h2>
        <p className="mt-3 text-sm leading-6 text-muted">
          {note.mint === SOL_MINT ? "SOL" : short(note.mint)} · max {formatAsset(note.amount, note.mint, decimals)}
        </p>
        <label className="mt-4 block text-sm">
          Amount
          <input
            className="mt-1 w-full border border-line bg-background px-3 py-2 text-sm"
            inputMode="decimal"
            value={nft ? "1" : amount}
            disabled={busy || nft}
            onChange={(event) => setAmount(event.target.value)}
          />
        </label>
        {error !== null ? <p className="mt-4 break-all text-sm leading-6 text-stamp">{error}</p> : null}
        <div className="mt-6 flex gap-3">
          <button
            type="button"
            className="border border-foreground px-4 py-2 text-sm disabled:opacity-40"
            disabled={busy}
            onClick={() => onRedeem(nft ? "1" : amount)}
          >
            Redeem
          </button>
          <button type="button" className="border border-line px-4 py-2 text-sm" disabled={busy} onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
