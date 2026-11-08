import type { AssetDraft } from "./types";

const FIELD = "mt-2 w-full border border-line bg-transparent px-3 py-2";

export function AssetFields({
  legend,
  value,
  disabled,
  onChange,
}: {
  legend: string;
  value: AssetDraft;
  disabled: boolean;
  onChange: (next: AssetDraft) => void;
}) {
  return (
    <fieldset className="mt-4 max-w-xl" disabled={disabled}>
      <legend className="text-sm">{legend}</legend>
      <label className="mt-3 block text-sm">
        Asset
        <select
          className={FIELD}
          value={value.kind}
          onChange={(event) => {
            const kind = event.target.value;
            if (kind !== "sol" && kind !== "token" && kind !== "nft") return;
            onChange({ ...value, kind, amount: kind === "nft" ? "1" : value.amount });
          }}
        >
          <option value="sol">SOL</option>
          <option value="token">Token</option>
          <option value="nft">NFT</option>
        </select>
      </label>
      {value.kind === "sol" ? null : (
        <label className="mt-3 block text-sm">
          Mint address
          <input className={FIELD} value={value.mint} onChange={(event) => onChange({ ...value, mint: event.target.value })} />
        </label>
      )}
      {value.kind === "nft" ? (
        <p className="mt-3 text-sm text-muted">Amount is 1. The mint has to be a supply of one with no decimals.</p>
      ) : (
        <label className="mt-3 block text-sm">
          Amount
          <input className={FIELD} value={value.amount} onChange={(event) => onChange({ ...value, amount: event.target.value })} />
        </label>
      )}
    </fieldset>
  );
}
