import { useEffect, useState } from "react";
import { SOL_DECIMALS, SOL_MINT, type AssetKind } from "@/lib/chunk-plan";
import { defaultWindow } from "@/lib/escrow-params";
import { parseBaseAmount } from "@/lib/escrow-params";
import { chooseShieldedNote } from "@/lib/funding-source";
import type { AssetInfo } from "@/lib/mint-account";
import { metadataLabel, type TokenMetadata } from "@/lib/token-metadata";
import type { HeldAsset } from "@/lib/wallet-holdings";
import { AssetFields } from "./asset-fields";
import { Fold } from "./fold";
import { formatAsset, fromLocalInput, toLocalInput } from "./format";
import type { AssetDraft, Note } from "./types";

export type FundingDraft = { readonly kind: "public" } | { readonly kind: "shielded"; readonly noteHash: string };

export type NewEscrowDraft = {
  readonly counterparty: string;
  readonly mine: AssetDraft;
  readonly theirs: AssetDraft;
  readonly approvalDeadline: number;
  readonly startAt: number;
  readonly funding: FundingDraft;
};

const FIELD = "mt-2 w-full border border-line bg-transparent px-3 py-2";

export function NewEscrowForm({
  busy,
  notes,
  holdings,
  assets,
  metadata,
  onCreate,
  onInvalid,
  onResolveMint,
}: {
  busy: boolean;
  notes: readonly Note[];
  holdings: readonly HeldAsset[] | null;
  assets: Readonly<Record<string, AssetInfo>>;
  metadata: Readonly<Record<string, TokenMetadata>>;
  onCreate: (draft: NewEscrowDraft) => void;
  onInvalid: (message: string) => void;
  onResolveMint: (kind: AssetKind, mint: string) => void;
}) {
  const [counterparty, setCounterparty] = useState("");
  const [mine, setMine] = useState<AssetDraft>({ kind: "sol", mint: "", amount: "0.01" });
  const [theirs, setTheirs] = useState<AssetDraft>({ kind: "sol", mint: "", amount: "0.02" });
  const [times, setTimes] = useState({ approval: "", start: "" });
  const [source, setSource] = useState<"shielded" | "public" | "">("");

  useEffect(() => {
    const timing = defaultWindow(Math.floor(Date.now() / 1000));
    // The clock is local. Filling this during render disagrees with the server HTML.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- local clock after mount
    setTimes({ approval: toLocalInput(timing.approvalDeadline), start: toLocalInput(timing.startAt) });
  }, []);

  const mint = mine.kind === "sol" ? SOL_MINT : mine.mint.trim();

  useEffect(() => {
    if (mine.kind === "sol" || mint.length < 32) return;
    onResolveMint(mine.kind, mint);
  }, [mine.kind, mint, onResolveMint]);

  const decimals = mine.kind === "sol" ? SOL_DECIMALS : mine.kind === "nft" ? 0 : assets[mint]?.decimals;
  const parsed = decimals === undefined ? null : parseBaseAmount(mine.kind === "nft" ? "1" : mine.amount, decimals);
  const shielded =
    parsed === null
      ? null
      : chooseShieldedNote(
          notes.filter((note) => note.amount !== "0").map((note) => ({ hash: note.hash, mint: note.mint, amount: BigInt(note.amount) })),
          mint,
          parsed,
        );
  const holding = holdings?.find((asset) => asset.mint === mint) ?? null;
  const publicPositive = holding !== null && BigInt(holding.maxBase) > BigInt(0);
  const shieldedKey = shielded === null ? "" : `${shielded.fit}:${shielded.hash}`;
  const holdingKey = holding === null ? "" : `${holding.mint}:${holding.maxBase}`;
  const amountKey = parsed === null ? "" : parsed.toString();

  function submit(): void {
    const approvalDeadline = fromLocalInput(times.approval);
    const startAt = fromLocalInput(times.start);
    if (approvalDeadline === null || startAt === null) {
      onInvalid("Set both the approval deadline and the reclaim time.");
      return;
    }
    if (source === "shielded" && shielded !== null) {
      onCreate({ counterparty, mine, theirs, approvalDeadline, startAt, funding: { kind: "shielded", noteHash: shielded.hash } });
      return;
    }
    if (source === "public" && holding !== null) {
      onCreate({ counterparty, mine, theirs, approvalDeadline, startAt, funding: { kind: "public" } });
      return;
    }
    onInvalid("Choose a shielded note of this asset, or its public balance. A different mint cannot fund this side.");
  }

  const shieldedAvailable = shielded !== null;
  const shieldedCovers = shielded !== null && shielded.fit !== "short";
  const publicCovers = publicPositive && parsed !== null && holding !== null && BigInt(holding.maxBase) >= parsed;

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the default follows the asset the user just picked
    setSource((current) => {
      if (current === "shielded" && shieldedAvailable) return current;
      if (current === "public" && publicPositive) return current;
      if (shieldedCovers) return "shielded";
      if (publicCovers) return "public";
      if (shieldedAvailable) return "shielded";
      if (publicPositive) return "public";
      return "";
    });
  }, [mint, shieldedKey, holdingKey, amountKey, publicPositive, shieldedAvailable, shieldedCovers, publicCovers]);

  const label = metadataLabel(metadata[mint]);
  const shownDecimals = decimals ?? assets[mint]?.decimals;

  return (
    <section className="mt-12 border-t border-line pt-10">
      <Fold title="New escrow" className="font-serif text-3xl tracking-[-0.03em]">
      <p className="mt-3 max-w-xl text-sm leading-6 text-muted">Ring: permissionless. Wallets: public. Those two are fixed until a custom ring exists.</p>
      <label className="mt-4 block max-w-xl text-sm">
        Counterparty wallet
        <input className={FIELD} value={counterparty} onChange={(event) => setCounterparty(event.target.value)} />
      </label>
      <AssetFields legend="What you lock" value={mine} disabled={busy} onChange={setMine} />
      <fieldset className="mt-4 max-w-xl" disabled={busy}>
        <legend className="text-sm">Funding source</legend>
        {holdings === null ? <p className="mt-3 text-sm text-muted">Reading the public balance…</p> : null}
        {shielded === null && !publicPositive && holdings !== null ? (
          <p className="mt-3 text-sm leading-6 text-muted">No shielded note and no public balance of this asset. A different mint is not offered.</p>
        ) : null}
        {shielded !== null ? (
          <label className="mt-3 flex items-start gap-2 text-sm">
            <input type="radio" name="funding-source" checked={source === "shielded"} onChange={() => setSource("shielded")} />
            <span>
              Shielded · {formatAsset(shielded.amount.toString(), mint, shownDecimals, metadata[mint])}
              {label !== null ? <span className="text-muted"> {label}</span> : null}
              <span className="mt-1 block text-muted">
                {shielded.fit === "exact"
                  ? "This note already equals the escrow amount, so it is spent whole."
                  : shielded.fit === "carve"
                    ? "This note is larger. Create carves it to the escrow amount and leaves the change spendable."
                    : "Every shielded note of this asset is smaller than the escrow amount."}
              </span>
            </span>
          </label>
        ) : null}
        {publicPositive && holding !== null ? (
          <label className="mt-3 flex items-start gap-2 text-sm">
            <input type="radio" name="funding-source" checked={source === "public"} onChange={() => setSource("public")} />
            <span>
              Not shielded · {formatAsset(holding.maxBase, holding.mint, holding.decimals, metadata[holding.mint])}
              <span className="mt-1 block text-muted">Public balance. Create shields this escrow amount into the private ring, then locks that note.</span>
            </span>
          </label>
        ) : null}
      </fieldset>
      <AssetFields legend="What you expect back" value={theirs} disabled={busy} onChange={setTheirs} />
      <label className="mt-4 block max-w-xs text-sm">
        Approval deadline
        <input className={FIELD} type="datetime-local" value={times.approval} onChange={(event) => setTimes((current) => ({ ...current, approval: event.target.value }))} />
      </label>
      <label className="mt-4 block max-w-xs text-sm">
        Reclaim time
        <input className={FIELD} type="datetime-local" value={times.start} onChange={(event) => setTimes((current) => ({ ...current, start: event.target.value }))} />
      </label>
      <p className="mt-3 max-w-xl text-sm leading-6 text-muted">
        This opens the escrow, approves you, prepares the note, and locks it. A public source is shielded for this amount. A larger shielded note is carved to this amount, and the change stays spendable. An exact note is spent as-is. The program does not store these amounts. They are saved on this machine. The recipient can accept once your asset is locked. Accept deposits their asset, swaps, and closes. Reject can void the proposal only while nothing is sealed.
      </p>
      <button type="button" className="mt-4 border border-foreground px-4 py-2 text-sm disabled:opacity-40" disabled={busy} onClick={submit}>
        Create and escrow
      </button>
      </Fold>
    </section>
  );
}
