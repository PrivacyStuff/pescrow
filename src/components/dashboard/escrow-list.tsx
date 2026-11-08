import type { AssetInfo } from "@/lib/mint-account";
import type { SwapTerms } from "@/lib/chunk-plan";
import type { EscrowView } from "@/lib/escrow-account";
import type { TokenMetadata } from "@/lib/token-metadata";
import type { HeldAsset } from "@/lib/wallet-holdings";
import { EscrowCard } from "./escrow-card";
import { Fold } from "./fold";
import type { AssetDraft, Note } from "./types";

export function EscrowList({
  title,
  empty,
  rows,
  terms,
  assets,
  metadata,
  selected,
  notes,
  holdings,
  seedReady,
  busy,
  onLock,
  onAccept,
  onReject,
  onSaveTerms,
}: {
  title: string;
  empty: string;
  rows: readonly EscrowView[];
  terms: Readonly<Record<string, SwapTerms>>;
  assets: Readonly<Record<string, AssetInfo>>;
  metadata: Readonly<Record<string, TokenMetadata>>;
  selected: Note | undefined;
  notes: readonly Note[];
  holdings: readonly HeldAsset[] | null;
  seedReady: boolean;
  busy: boolean;
  onLock: (row: EscrowView, amount: string) => void;
  onAccept: (row: EscrowView, amount: string) => void;
  onReject: (row: EscrowView) => void;
  onSaveTerms: (address: string, role: "a" | "b", mine: AssetDraft, theirs: AssetDraft) => void;
}) {
  return (
    <section className="mt-12 border-t border-line pt-10">
      <Fold title={title} className="font-serif text-3xl tracking-[-0.03em]">
      {rows.length === 0 ? <p className="mt-4 text-sm text-muted">{empty}</p> : null}
      <ul className="mt-6 space-y-8">
        {rows.map((row) => (
          <EscrowCard
            key={row.address}
            row={row}
            terms={terms[row.address]}
            assets={assets}
            metadata={metadata}
            selected={selected}
            notes={notes}
            holdings={holdings}
            seedReady={seedReady}
            busy={busy}
            onLock={onLock}
            onAccept={onAccept}
            onReject={onReject}
            onSaveTerms={onSaveTerms}
          />
        ))}
      </ul>
      </Fold>
    </section>
  );
}
