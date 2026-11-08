import type { EscrowView } from "@/lib/escrow-account";
import { Fold } from "./fold";
import { short } from "./format";

export function HistorySection({
  rows,
  busy,
  onClose,
}: {
  rows: readonly EscrowView[];
  busy: boolean;
  onClose: (row: EscrowView) => void;
}) {
  return (
    <section className="mt-12 border-t border-line pt-10">
      <Fold title="History" className="font-serif text-3xl tracking-[-0.03em]">
      <p className="mt-3 max-w-xl text-sm leading-6 text-muted">
        Void, exchanged, and reclaimed escrows that are still on chain. Accounts that are already closed do not appear here yet.
      </p>
      {rows.length === 0 ? <p className="mt-4 text-sm text-muted">Nothing finished is still on chain for this wallet.</p> : null}
      <ul className="mt-6 space-y-6 text-sm leading-7">
        {rows.map((row) => (
          <li key={row.address}>
            <p className="break-all">{row.address}</p>
            <p className="text-muted">
              {row.role === "a" ? "Issued" : "Received"} · {row.status} · counterparty {short(row.role === "a" ? row.partyB : row.partyA)}
            </p>
            <button type="button" className="mt-2 border border-foreground px-4 py-2 disabled:opacity-40" disabled={busy} onClick={() => onClose(row)}>
              Close
            </button>
          </li>
        ))}
      </ul>
      </Fold>
    </section>
  );
}
