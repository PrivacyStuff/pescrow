import { useState } from "react";
import type { AssetInfo } from "@/lib/mint-account";
import { SOL_MINT } from "@/lib/chunk-plan";
import { metadataLabel, type TokenMetadata } from "@/lib/token-metadata";
import { Fold } from "./fold";
import { formatAsset, short } from "./format";
import type { Note, RingState } from "./types";

export function PrivateBalance({
  ring,
  assets,
  metadata,
  selected,
  busy,
  onSelect,
  onAdd,
  onRedeem,
}: {
  ring: RingState;
  assets: Readonly<Record<string, AssetInfo>>;
  metadata: Readonly<Record<string, TokenMetadata>>;
  selected: string;
  busy: boolean;
  onSelect: (hash: string) => void;
  onAdd: () => void;
  onRedeem: (note: Note) => void;
}) {
  const groups = new Map<string, Note[]>();
  for (const note of ring.notes) {
    const rows = groups.get(note.mint) ?? [];
    rows.push(note);
    groups.set(note.mint, rows);
  }

  return (
    <section className="mt-12 border-t border-line pt-10">
      <Fold title="Private balance" className="font-serif text-3xl tracking-[-0.03em]">
      <p className="mt-2 text-sm text-muted">Ring key {short(ring.ring)} · public SOL on that key {formatAsset(ring.sol, SOL_MINT, 9)}</p>
      {ring.notes.length === 0 ? <p className="mt-4 text-sm text-muted">No private balance yet.</p> : null}
      {[...groups.entries()].map(([mint, notes]) => (
        <Fold
          key={mint}
          level="h3"
          className="text-sm"
          classNameForWrap="mt-6"
          title={mint === SOL_MINT ? "SOL" : (metadataLabel(metadata[mint]) ?? short(mint))}
        >
          <ul className="mt-2 space-y-2 text-sm">
            {notes.map((note) => {
              const spendable = note.amount !== "0";
              return (
                <li key={note.hash}>
                  <div className="flex items-start justify-between gap-3">
                    <label className="flex items-start gap-2">
                      <input
                        type="radio"
                        name="note"
                        disabled={!spendable}
                        checked={spendable && selected === note.hash}
                        onChange={() => onSelect(note.hash)}
                      />
                      <TokenMark uri={metadata[note.mint]?.image} />
                      <span>
                        {formatAsset(note.amount, note.mint, assets[note.mint]?.decimals, metadata[note.mint])}{" "}
                        {metadataLabel(metadata[note.mint]) !== null && note.mint !== SOL_MINT ? (
                          <span className="text-muted">{short(note.mint)} </span>
                        ) : null}
                        <span className="text-muted">
                          {short(note.hash)} · leaf {note.leaf}
                          {spendable ? "" : " · empty"}
                        </span>
                      </span>
                    </label>
                    {spendable ? (
                      <button
                        type="button"
                        className="border border-line px-2 py-0.5 text-sm disabled:opacity-40"
                        disabled={busy}
                        onClick={() => onRedeem(note)}
                      >
                        Redeem
                      </button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        </Fold>
      ))}
      <button type="button" className="mt-6 border border-foreground px-4 py-2 text-sm disabled:opacity-40" disabled={busy} onClick={onAdd}>
        Add to private balance
      </button>
      </Fold>
    </section>
  );
}

function TokenMark({ uri }: { uri: string | null | undefined }) {
  const [hidden, setHidden] = useState(false);
  if (uri === undefined || uri === null || hidden || !/^https?:\/\//i.test(uri)) return null;
  return <img src={uri} alt="" width={20} height={20} className="mt-0.5 h-5 w-5 shrink-0 object-cover" onError={() => setHidden(true)} />;
}
