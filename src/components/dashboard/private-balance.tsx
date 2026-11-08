import { useEffect, useRef, useState } from "react";
import type { AssetInfo } from "@/lib/mint-account";
import { SOL_DECIMALS, SOL_MINT } from "@/lib/chunk-plan";
import { metadataLabel, type TokenMetadata } from "@/lib/token-metadata";
import { REDEEM_SELECT_COPY } from "./explain-copy";
import { Fold } from "./fold";
import { formatBase, short } from "./format";
import type { Note, RingState } from "./types";

const COPY_RESET_MS = 1600;
const REMOTE_IMAGE = /^https?:\/\//i;
const BASE_AMOUNT = /^\d+$/;

export function PrivateBalance({
  ring,
  assets,
  metadata,
  selected,
  busy,
  onToggle,
  onAdd,
  onRedeem,
}: {
  ring: RingState;
  assets: Readonly<Record<string, AssetInfo>>;
  metadata: Readonly<Record<string, TokenMetadata>>;
  selected: readonly string[];
  busy: boolean;
  onToggle: (hash: string) => void;
  onAdd: () => void;
  onRedeem: () => void;
}) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [showEmpty, setShowEmpty] = useState(false);
  const [closedEmpty, setClosedEmpty] = useState<ReadonlySet<string>>(() => new Set());
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const emptyNotes = ring.notes.filter((note) => isEmptyNote(note) && !closedEmpty.has(note.hash));
  const visibleNotes = ring.notes.filter((note) => !isEmptyNote(note) || (showEmpty && !closedEmpty.has(note.hash)));
  const groups = new Map<string, Note[]>();
  for (const note of visibleNotes) {
    const rows = groups.get(note.mint) ?? [];
    rows.push(note);
    groups.set(note.mint, rows);
  }

  function dismissEmpty(hash: string): void {
    setClosedEmpty((current) => {
      const next = new Set(current);
      next.add(hash);
      return next;
    });
  }

  useEffect(() => {
    return () => {
      if (copyTimer.current !== null) clearTimeout(copyTimer.current);
    };
  }, []);

  function showCopyState(next: "copied" | "failed"): void {
    setCopyState(next);
    if (copyTimer.current !== null) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopyState("idle"), COPY_RESET_MS);
  }

  async function copyRing(): Promise<void> {
    try {
      await navigator.clipboard.writeText(ring.ring);
      showCopyState("copied");
    } catch {
      showCopyState("failed");
    }
  }

  const ringLabel = short(ring.ring);
  const [redeemHint, setRedeemHint] = useState(false);
  const redeemReady = selected.some((hash) => {
    const row = ring.notes.find((note) => note.hash === hash);
    return row !== undefined && !isEmptyNote(row);
  });

  return (
    <section className="mt-6">
      <Fold title="Private balance" className="font-serif text-2xl tracking-[-0.03em]">
        <p className="mt-2 text-sm text-muted">
          <span>Ring key </span>
          <button
            type="button"
            className="underline-offset-4 hover:underline"
            aria-label={`Copy ring key ${ringLabel}`}
            onClick={() => {
              void copyRing();
            }}
          >
            {ringLabel}
          </button>
          <span> · public SOL {formatBase(ring.sol, SOL_DECIMALS)}</span>
          {copyState === "idle" ? null : (
            <span className="text-muted" role="status">
              {copyState === "copied" ? " · copied" : " · copy failed"}
            </span>
          )}
        </p>
        {visibleNotes.length === 0 && emptyNotes.length === 0 ? <p className="mt-3 text-sm text-muted">No private balance yet.</p> : null}
        {[...groups.entries()].map(([mint, notes]) => (
          <AssetLine
            key={mint}
            mint={mint}
            image={metadata[mint]?.image}
            name={mint === SOL_MINT ? "SOL" : (metadataLabel(metadata[mint]) ?? short(mint))}
            total={formatBase(sumAmounts(notes).toString(), noteDecimals(mint, assets))}
            notes={notes}
            assets={assets}
            selected={selected}
            onToggle={onToggle}
            onCloseEmpty={dismissEmpty}
          />
        ))}
        <div className="mt-3 flex flex-wrap items-center justify-start gap-3">
          <button
            type="button"
            className={`inline-flex h-8 items-center border border-line px-2 text-sm ${redeemReady && !busy ? "" : "opacity-40"}`}
            aria-disabled={!redeemReady || busy}
            onClick={() => {
              if (busy) return;
              if (!redeemReady) {
                setRedeemHint(true);
                return;
              }
              onRedeem();
            }}
          >
            Redeem
          </button>
          <button type="button" className="inline-flex h-8 items-center border border-line px-2 text-sm disabled:opacity-40" disabled={busy} onClick={onAdd}>
            Add to private balance
          </button>
          {emptyNotes.length === 0 ? null : (
            <button
              type="button"
              className="inline-flex h-8 items-center px-2 text-sm text-muted underline-offset-4 hover:underline"
              aria-expanded={showEmpty}
              onClick={() => setShowEmpty((current) => !current)}
            >
              {showEmpty ? "Hide empty" : `Show empty (${emptyNotes.length})`}
            </button>
          )}
        </div>
        {redeemHint && !redeemReady ? <p className="mt-2 max-w-xl text-sm leading-6 text-muted">{REDEEM_SELECT_COPY}</p> : null}
      </Fold>
    </section>
  );
}

function AssetLine({
  mint,
  image,
  name,
  total,
  notes,
  assets,
  selected,
  onToggle,
  onCloseEmpty,
}: {
  mint: string;
  image: string | null | undefined;
  name: string;
  total: string;
  notes: readonly Note[];
  assets: Readonly<Record<string, AssetInfo>>;
  selected: readonly string[];
  onToggle: (hash: string) => void;
  onCloseEmpty: (hash: string) => void;
}) {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className="inline-flex min-w-0 items-center gap-1.5 text-sm">
        <TokenMark uri={image} />
        <span className="truncate">{name}</span>
        <span className="shrink-0 tabular-nums text-muted">{total}</span>
        <span className="max-w-28 truncate text-xs text-muted">{short(mint)}</span>
      </span>
      <ul className="contents">
        {notes.map((note) => (
          <NoteChip
            key={note.hash}
            note={note}
            amountText={formatBase(note.amount, noteDecimals(mint, assets))}
            pressed={selected.includes(note.hash)}
            onToggle={onToggle}
            onCloseEmpty={onCloseEmpty}
          />
        ))}
      </ul>
    </div>
  );
}

function NoteChip({
  note,
  amountText,
  pressed,
  onToggle,
  onCloseEmpty,
}: {
  note: Note;
  amountText: string;
  pressed: boolean;
  onToggle: (hash: string) => void;
  onCloseEmpty: (hash: string) => void;
}) {
  const spendable = !isEmptyNote(note);

  function toggle(): void {
    if (!spendable) return;
    onToggle(note.hash);
  }

  return (
    <li
      className={`inline-flex items-center gap-1 border px-1.5 py-0.5 ${pressed ? "border-foreground bg-foreground/[0.06]" : "border-line"}`}
      title={`leaf ${note.leaf}`}
    >
      {spendable ? (
        <button type="button" className="text-sm tabular-nums tracking-tight" aria-pressed={pressed} onClick={toggle}>
          {amountText}
        </button>
      ) : (
        <span className="text-sm tabular-nums tracking-tight">{amountText}</span>
      )}
      {spendable ? null : (
        <button
          type="button"
          className="shrink-0 px-1.5 py-0 text-xs text-muted underline-offset-4 hover:underline"
          aria-label={`Hide empty note leaf ${note.leaf} for this session`}
          onClick={(event) => {
            event.stopPropagation();
            onCloseEmpty(note.hash);
          }}
        >
          Close
        </button>
      )}
    </li>
  );
}

function TokenMark({ uri }: { uri: string | null | undefined }) {
  const [hidden, setHidden] = useState(false);
  if (uri === undefined || uri === null || hidden || !REMOTE_IMAGE.test(uri)) return null;
  return <img src={uri} alt="" width={16} height={16} className="h-4 w-4 shrink-0 object-cover" onError={() => setHidden(true)} />;
}

function isEmptyNote(note: Note): boolean {
  return BASE_AMOUNT.test(note.amount) && BigInt(note.amount) === 0n;
}

function noteDecimals(mint: string, assets: Readonly<Record<string, AssetInfo>>): number {
  if (mint === SOL_MINT) return SOL_DECIMALS;
  return assets[mint]?.decimals ?? 0;
}

function sumAmounts(notes: readonly Note[]): bigint {
  let total = BigInt(0);
  for (const note of notes) {
    if (BASE_AMOUNT.test(note.amount)) total += BigInt(note.amount);
  }
  return total;
}
