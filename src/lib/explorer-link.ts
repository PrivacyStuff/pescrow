const BASE58_RUN = /[1-9A-HJ-NP-Za-km-z]+/g;
const ESCROW_PREFIX = /Escrow\s+$/;
const SIGNATURE_MIN = 86;
const SIGNATURE_MAX = 88;
const ADDRESS_MIN = 32;
const ADDRESS_MAX = 44;
const CLUSTER = "devnet";

export type ChainSpan =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "tx"; readonly text: string }
  | { readonly kind: "address"; readonly text: string };

export function txExplorerUrl(signature: string): string {
  return `https://explorer.solana.com/tx/${encodeURIComponent(signature)}?cluster=${CLUSTER}`;
}

export function addressExplorerUrl(address: string): string {
  return `https://explorer.solana.com/address/${encodeURIComponent(address)}?cluster=${CLUSTER}`;
}

export function splitChainText(text: string): readonly ChainSpan[] {
  const spans: ChainSpan[] = [];
  let cursor = 0;
  for (const match of text.matchAll(BASE58_RUN)) {
    const value = match[0];
    const index = match.index;
    if (index === undefined) continue;
    const kind = classifyChainToken(value, text.slice(0, index));
    if (kind === null) continue;
    if (index > cursor) spans.push({ kind: "text", text: text.slice(cursor, index) });
    spans.push({ kind, text: value });
    cursor = index + value.length;
  }
  if (cursor < text.length) spans.push({ kind: "text", text: text.slice(cursor) });
  if (spans.length === 0) spans.push({ kind: "text", text });
  return spans;
}

function classifyChainToken(value: string, before: string): "tx" | "address" | null {
  if (value.length >= SIGNATURE_MIN && value.length <= SIGNATURE_MAX) return "tx";
  if (value.length >= ADDRESS_MIN && value.length <= ADDRESS_MAX && ESCROW_PREFIX.test(before)) return "address";
  return null;
}
