import { useState } from "react";
import { acceptReason, planRecipientAccept, publicBalanceMax } from "@/lib/accept-plan";
import type { AssetInfo } from "@/lib/mint-account";
import { sideView, type SwapTerms } from "@/lib/chunk-plan";
import { openerCanLock, type EscrowView } from "@/lib/escrow-account";
import { type TokenMetadata } from "@/lib/token-metadata";
import type { HeldAsset } from "@/lib/wallet-holdings";
import { AddressLink } from "./chain-link";
import { AssetFields } from "./asset-fields";
import { formatAsset, short } from "./format";
import type { AssetDraft, Note } from "./types";

export function EscrowCard({
  row,
  terms,
  assets,
  metadata,
  selectedNotes,
  notes,
  holdings,
  seedReady,
  busy,
  onLock,
  onAccept,
  onReject,
  onSaveTerms,
}: {
  row: EscrowView;
  terms: SwapTerms | undefined;
  assets: Readonly<Record<string, AssetInfo>>;
  metadata: Readonly<Record<string, TokenMetadata>>;
  selectedNotes: readonly Note[];
  notes: readonly Note[];
  holdings: readonly HeldAsset[] | null;
  seedReady: boolean;
  busy: boolean;
  onLock: (row: EscrowView, amount: string) => void;
  onAccept: (row: EscrowView, amount: string) => void;
  onReject: (row: EscrowView) => void;
  onSaveTerms: (address: string, role: "a" | "b", mine: AssetDraft, theirs: AssetDraft) => void;
}) {
  const [mine, setMine] = useState<AssetDraft>({ kind: "sol", mint: "", amount: "0.01" });
  const [theirs, setTheirs] = useState<AssetDraft>({ kind: "sol", mint: "", amount: "0.02" });
  const [edited, setEdited] = useState<string | null>(null);
  const view = terms === undefined ? null : sideView(row.role, terms);
  const decimals = view === null ? 0 : (assets[view.lock.mint]?.decimals ?? (view.lock.kind === "sol" ? 9 : 0));
  const agreed = view === null ? "" : formatAssetAmount(view.lock.amount, decimals);
  const open = row.status === "Proposed";
  const issued = row.role === "a";
  const canLock = openerCanLock(row);
  const counterparty = issued ? row.partyB : row.partyA;
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
    notes,
    publicMax: publicBalanceMax(holdings, view?.lock.mint ?? null),
  });
  const lockLabel = view === null ? null : formatAsset(view.lock.amount, view.lock.mint, assets[view.lock.mint]?.decimals, metadata[view.lock.mint]);
  const receiveLabel =
    view === null ? null : formatAsset(view.receive.amount, view.receive.mint, assets[view.receive.mint]?.decimals, metadata[view.receive.mint]);
  const coverLabel =
    gate.noteAmount === null || view === null
      ? null
      : formatAsset(gate.noteAmount.toString(), view.lock.mint, assets[view.lock.mint]?.decimals, metadata[view.lock.mint]);
  const acceptMessage = acceptReason({ gate, aSealed: row.aSealed, lockLabel, receiveLabel, coverLabel });
  const acceptDisabled = busy || !gate.enabled || (gate.canLock && !gate.canApprove && !seedReady);

  const blocker = escrowBlocker({
    waiting: open && issued && row.aSealed,
    needUnlock: canLock && !seedReady,
    needShield: canLock && seedReady && view !== null && !selectedNotes.some((item) => item.mint === view.lock.mint),
    acceptMessage: open && !issued ? acceptMessage : null,
    needUnlockBeforeLock: open && !issued && row.aSealed && !seedReady && (gate.canLock || gate.canApprove),
  });

  return (
    <li className="text-sm leading-7">
      <p className="min-w-0 break-all">
        <AddressLink address={row.address} className="break-all" />
      </p>
      <p className="text-muted">
        {row.role === "a" ? "Issued" : "Received"} · counterparty {short(counterparty)} · {row.status}
      </p>
      <p className="text-muted">
        Approvals {row.aApproved ? "1" : "0"}/{row.bApproved ? "1" : "0"} · seals {row.aSealed ? "1" : "0"}/{row.bSealed ? "1" : "0"}
      </p>
      <p className="text-muted">Approve by {stamp(row.approvalDeadline)} · reclaim after {stamp(row.startAt)}</p>
      {view === null ? (
        <div className="mt-3">
          <AssetFields legend="What you lock" value={mine} disabled={busy} onChange={setMine} />
          <AssetFields legend="What you expect back" value={theirs} disabled={busy} onChange={setTheirs} />
          <button
            type="button"
            className="mt-3 border border-foreground px-4 py-2 disabled:opacity-40"
            disabled={busy}
            onClick={() => onSaveTerms(row.address, row.role, mine, theirs)}
          >
            Save swap terms
          </button>
        </div>
      ) : (
        <p>
          You lock {formatAsset(view.lock.amount, view.lock.mint, assets[view.lock.mint]?.decimals, metadata[view.lock.mint])}. You receive{" "}
          {formatAsset(view.receive.amount, view.receive.mint, assets[view.receive.mint]?.decimals, metadata[view.receive.mint])}.
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-end gap-3">
        {canLock ? (
          <label>
            Amount
            <input
              className="mt-2 block w-40 border border-line bg-transparent px-3 py-2"
              value={edited ?? agreed}
              onChange={(event) => setEdited(event.target.value)}
            />
          </label>
        ) : null}
        {canLock ? (
          <button
            type="button"
            className="border border-foreground px-4 py-2 disabled:opacity-40"
            disabled={busy}
            onClick={() => onLock(row, edited ?? agreed)}
          >
            Lock into escrow
          </button>
        ) : null}
        {open && !issued ? (
          <button
            type="button"
            className="border border-foreground px-4 py-2 disabled:opacity-40"
            disabled={acceptDisabled}
            onClick={() => onAccept(row, agreed)}
          >
            Accept
          </button>
        ) : null}
        {open && !issued ? (
          <button type="button" className="border border-foreground px-4 py-2 disabled:opacity-40" disabled={busy} onClick={() => onReject(row)}>
            Reject
          </button>
        ) : null}
      </div>
      {blocker !== null ? <p className="mt-2 max-w-xl leading-6 text-muted">{blocker}</p> : null}
    </li>
  );
}

function escrowBlocker(input: {
  waiting: boolean;
  needUnlock: boolean;
  needShield: boolean;
  acceptMessage: string | null;
  needUnlockBeforeLock: boolean;
}): string | null {
  const parts: string[] = [];
  if (input.waiting) parts.push("Waiting for the recipient to accept or reject.");
  if (input.needUnlock) parts.push("Unlock private balance before this lock.");
  if (input.needShield) parts.push("Shield the asset you are locking, then select that note.");
  if (input.acceptMessage !== null) parts.push(input.acceptMessage);
  if (input.needUnlockBeforeLock) parts.push("Unlock private balance before the lock.");
  return parts.length === 0 ? null : parts.join(" ");
}

function formatAssetAmount(amount: string, decimals: number): string {
  if (decimals <= 0) return amount;
  const value = BigInt(amount);
  const scale = BigInt(10) ** BigInt(decimals);
  const whole = value / scale;
  const fraction = (value % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction.length === 0 ? whole.toString() : `${whole}.${fraction}`;
}

function stamp(unix: number): string {
  if (!Number.isFinite(unix) || unix === 0) return "unset";
  return new Date(unix * 1000).toLocaleString();
}
