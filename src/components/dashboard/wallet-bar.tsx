import { short } from "./format";

export function WalletBar({
  wallet,
  unlocked,
  busy,
  onConnect,
  onDisconnect,
}: {
  wallet: string | null;
  unlocked: boolean;
  busy: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  const label = wallet !== null && unlocked ? short(wallet) : "Connect";
  return (
    <div className="mt-8 flex flex-wrap gap-3">
      <button type="button" className="border border-foreground px-4 py-2 text-sm disabled:opacity-40" disabled={busy && !unlocked} onClick={onConnect}>
        {label}
      </button>
      {wallet === null ? null : (
        <button type="button" className="border border-line px-4 py-2 text-sm" onClick={onDisconnect}>
          Disconnect
        </button>
      )}
    </div>
  );
}
