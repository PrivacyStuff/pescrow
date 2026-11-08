"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { useState } from "react";
import { addressExplorerUrl, txExplorerUrl } from "@/lib/explorer-link";
import {
  FAUCET_COOLDOWN_MINUTES,
  FAUCET_LABEL,
  FAUCET_UNREACHABLE_MESSAGE,
  faucetOutcome,
  type FaucetAsset,
} from "@/lib/faucet";

const FAUCET_PATH = "/api/faucet";
const FIELD = "mt-2 w-full border border-line bg-transparent px-3 py-2 font-mono text-sm";
const BUTTON = "border border-foreground px-4 py-2 text-sm disabled:opacity-40";
const LINK = "underline decoration-line underline-offset-4 hover:decoration-foreground";
const ASSETS: readonly FaucetAsset[] = ["sol", "usdc"];
const INTRO = `Drops ${FAUCET_LABEL.sol} or ${FAUCET_LABEL.usdc} on devnet. The USDC is a test mint with no value. One drop of each per wallet every ${FAUCET_COOLDOWN_MINUTES} minutes.`;

type Drop = { readonly signature: string; readonly amount: string; readonly recipient: string };
type FaucetLayout = "page" | "card";

export function FaucetPanel({ layout = "page" }: { readonly layout?: FaucetLayout }) {
  const { publicKey, connected } = useWallet();
  const { setVisible } = useWalletModal();
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState<FaucetAsset | null>(null);
  const [drop, setDrop] = useState<Drop | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const recipient = draft ?? publicKey?.toBase58() ?? "";
  const noteClass = layout === "card" ? "mt-6 min-w-0 text-sm leading-6 break-all" : "mt-8 max-w-3xl text-sm leading-6 break-all";

  async function request(asset: FaucetAsset) {
    const target = recipient.trim();
    setBusy(asset);
    setDrop(null);
    setFailure(null);
    try {
      const response = await fetch(FAUCET_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ recipient: target, asset }),
      });
      const body: unknown = await response.json();
      const outcome = faucetOutcome(response.status, body);
      if (outcome.ok) setDrop({ signature: outcome.drop.signature, amount: outcome.drop.amount, recipient: target });
      else setFailure(outcome.error);
    } catch (error: unknown) {
      console.error(error instanceof Error ? error.message : FAUCET_UNREACHABLE_MESSAGE);
      setFailure(FAUCET_UNREACHABLE_MESSAGE);
    } finally {
      setBusy(null);
    }
  }

  const fields = (
    <>
      <label className="block text-sm text-muted" htmlFor="faucet-recipient">
        Recipient wallet
      </label>
      <input
        id="faucet-recipient"
        className={layout === "card" ? `${FIELD} min-w-0` : FIELD}
        value={recipient}
        spellCheck={false}
        autoComplete="off"
        placeholder="Solana address"
        onChange={(event) => setDraft(event.target.value)}
      />
      {!connected ? (
        <button type="button" className="mt-3 text-left text-sm text-muted underline underline-offset-4" onClick={() => setVisible(true)}>
          Connect a wallet to fill this in
        </button>
      ) : null}
      <div className="mt-6 flex flex-wrap gap-3">
        {ASSETS.map((asset) => (
          <button key={asset} type="button" className={BUTTON} disabled={busy !== null || recipient.trim().length === 0} onClick={() => void request(asset)}>
            {busy === asset ? "Dropping…" : `Drop ${FAUCET_LABEL[asset]}`}
          </button>
        ))}
      </div>
      {drop !== null ? (
        <p className={noteClass} role="status">
          Sent {drop.amount} to{" "}
          <a className={LINK} href={addressExplorerUrl(drop.recipient)} target="_blank" rel="noopener noreferrer">
            {drop.recipient}
          </a>
          .{" "}
          <a className={LINK} href={txExplorerUrl(drop.signature)} target="_blank" rel="noopener noreferrer">
            View the transaction
          </a>
        </p>
      ) : null}
      {failure !== null ? (
        <p className={`${noteClass} text-stamp`} role="status">
          {failure}
        </p>
      ) : null}
    </>
  );

  if (layout === "card") {
    return (
      <article className="flex h-full min-w-0 flex-col border border-line p-6">
        <p className="text-sm tracking-[0.18em] text-stamp uppercase">Devnet</p>
        <h2 className="mt-8 font-serif text-4xl tracking-[-0.03em]">Faucet</h2>
        <p className="mt-4 leading-7 text-muted">{INTRO}</p>
        <div className="mt-6 min-w-0">{fields}</div>
      </article>
    );
  }

  return (
    <div>
      <p className="text-sm tracking-[0.18em] text-stamp uppercase">Devnet faucet</p>
      <h1 className="mt-4 max-w-3xl font-serif text-5xl tracking-[-0.035em] md:text-6xl">Fund a wallet for the demo.</h1>
      <p className="mt-6 max-w-2xl leading-7 text-muted">{INTRO}</p>
      <div className="mt-10 max-w-2xl">{fields}</div>
    </div>
  );
}
