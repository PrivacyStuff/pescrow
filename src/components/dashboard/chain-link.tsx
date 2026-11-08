import type { ReactNode } from "react";
import { addressExplorerUrl, splitChainText, txExplorerUrl } from "@/lib/explorer-link";

const LINK = "underline decoration-line underline-offset-4 hover:decoration-foreground";

export function TxLink({ signature, children }: { signature: string; children?: ReactNode }) {
  return (
    <a className={LINK} href={txExplorerUrl(signature)} target="_blank" rel="noopener noreferrer">
      {children ?? signature}
    </a>
  );
}

export function AddressLink({ address, children, className }: { address: string; children?: ReactNode; className?: string }) {
  return (
    <a className={className === undefined ? LINK : `${LINK} ${className}`} href={addressExplorerUrl(address)} target="_blank" rel="noopener noreferrer">
      {children ?? address}
    </a>
  );
}

export function LinkedText({ text }: { text: string }) {
  return splitChainText(text).map((span, index) => {
    if (span.kind === "tx") return <TxLink key={`${span.kind}-${index}`} signature={span.text} />;
    if (span.kind === "address") return <AddressLink key={`${span.kind}-${index}`} address={span.text} />;
    return <span key={`${span.kind}-${index}`}>{span.text}</span>;
  });
}
