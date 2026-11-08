import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addressExplorerUrl, splitChainText, txExplorerUrl } from "./explorer-link.ts";

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58(length: number): string {
  let out = "";
  while (out.length < length) out += BASE58;
  return out.slice(0, length);
}

describe("explorer urls", () => {
  it("points signatures and escrow accounts at devnet", () => {
    const signature = base58(88);
    const address = base58(44);
    assert.equal(txExplorerUrl(signature), `https://explorer.solana.com/tx/${signature}?cluster=devnet`);
    assert.equal(addressExplorerUrl(address), `https://explorer.solana.com/address/${address}?cluster=devnet`);
  });
});

describe("splitChainText", () => {
  it("links a signature and an escrow address already present in the sentence", () => {
    const signature = base58(87);
    const address = base58(44);
    const text = `Escrow ${address} is open. Locked. ${signature}.`;
    assert.deepEqual(splitChainText(text), [
      { kind: "text", text: "Escrow " },
      { kind: "address", text: address },
      { kind: "text", text: " is open. Locked. " },
      { kind: "tx", text: signature },
      { kind: "text", text: "." },
    ]);
  });

  it("leaves note leaves, short keys, and hashes alone", () => {
    const hash = base58(64);
    const text = `leaf 300120 · ${hash} · Dog1abcd`;
    assert.deepEqual(splitChainText(text), [{ kind: "text", text }]);
  });
});
