"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { useState } from "react";
import { addressExplorerUrl, txExplorerUrl } from "@/lib/explorer-link";
import { FAUCET_LABEL, type FaucetAsset } from "@/lib/faucet";

const FAUCET_PATH = "/api/faucet";
const FIELD = "mt-2 w-full border border-line bg-transparent px-3 py-2 font-mono text-sm";
const BUTTON = "border border-foreground px-4 py-2 text-sm disabled:opacity-40";
const LINK = "underline decoration-line underline-offset-4 hover:decoration-foreground";
const ASSETS: readonly FaucetAsset[] = ["sol", "usdc"];

type Drop = { readonly signature: string; readonly amount: string; readonly recipient: string };
type FaucetReply = { ok: true; result: { signature: string; amount: string } } | { ok: false; error: string };

export function FaucetPanel() {
  const { publicKey, connected } = useWallet();
  const { setVisible } = useWalletModal();
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState<FaucetAsset | null>(null);
  const [drop, setDrop] = useState<Drop | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const recipient = draft ?? publicKey?.toBase58() ?? "";

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
      const reply = (await response.json()) as FaucetReply;
      if (reply.ok) setDrop({ signature: reply.result.signature, amount: reply.result.amount, recipient: target });
      else setFailure(reply.error);
    } catch {
      setFailure("The faucet could not be reached. Try again.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <p className="text-sm tracking-[0.18em] text-stamp uppercase">Devnet faucet</p>
      <h1 className="mt-4 max-w-3xl font-serif text-5xl tracking-[-0.035em] md:text-6xl">Fund a wallet for the demo.</h1>
      <p className="mt-6 max-w-2xl leading-7 text-muted">
        Drops {FAUCET_LABEL.sol} or {FAUCET_LABEL.usdc} on devnet. The USDC is a test mint with no value. One drop of each per wallet every ten minutes.
      </p>
      <div className="mt-10 max-w-2xl">
        <label className="block text-sm text-muted" htmlFor="faucet-recipient">
          Recipient wallet
        </label>
        <input
          id="faucet-recipient"
          className={FIELD}
          value={recipient}
          spellCheck={false}
          autoComplete="off"
          placeholder="Solana address"
          onChange={(event) => setDraft(event.target.value)}
        />
        {!connected ? (
          <button type="button" className="mt-3 text-sm text-muted underline underline-offset-4" onClick={() => setVisible(true)}>
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
      </div>
      {drop !== null ? (
        <p className="mt-8 max-w-3xl text-sm leading-6 break-all">
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
      {failure !== null ? <p className="mt-8 max-w-3xl text-sm leading-6 break-all text-stamp">{failure}</p> : null}
    </div>
  );
}
