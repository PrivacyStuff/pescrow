import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  METADATA_HEADER_LEN,
  METADATA_KEY_V1,
  TOKEN_2022_ACCOUNT_TYPE_OFFSET,
  TOKEN_2022_METADATA_TYPE,
  TOKEN_2022_MINT_ACCOUNT_TYPE,
  TOKEN_2022_TLV_START,
  metadataLabel,
  parseDasAsset,
  parseMetaplexMetadata,
  parseToken2022Metadata,
} from "./token-metadata.ts";

describe("token metadata", () => {
  it("reads a DAS asset name, symbol, and image", () => {
    const parsed = parseDasAsset({
      content: {
        metadata: { name: "USD Coin", symbol: "USDC" },
        links: { image: "https://cdn.example/usdc.png" },
      },
    });
    assert.deepEqual(parsed, { name: "USD Coin", symbol: "USDC", image: "https://cdn.example/usdc.png" });
    assert.equal(metadataLabel(parsed), "USDC · USD Coin");
  });

  it("ignores a DAS payload with no display fields", () => {
    assert.equal(parseDasAsset({ id: "mint", content: { metadata: {} } }), null);
    assert.equal(parseDasAsset({ content: { links: { image: "ipfs://usdc" } } }), null);
  });

  it("parses the Metaplex name, symbol, and an image uri", () => {
    const data = metaplex("USD Coin", "USDC", "https://cdn.example/usdc.png");
    assert.deepEqual(parseMetaplexMetadata(data), {
      name: "USD Coin",
      symbol: "USDC",
      image: "https://cdn.example/usdc.png",
    });
  });

  it("keeps a Metaplex name when the uri is json", () => {
    const parsed = parseMetaplexMetadata(metaplex("USD Coin", "USDC", "https://cdn.example/usdc.json"));
    assert.deepEqual(parsed, { name: "USD Coin", symbol: "USDC", image: null });
  });

  it("rejects a short or wrong Metaplex account", () => {
    assert.equal(parseMetaplexMetadata(new Uint8Array(10)), null);
    const data = metaplex("USD Coin", "USDC", "");
    data[0] = 0;
    assert.equal(parseMetaplexMetadata(data), null);
  });

  it("reads a Token-2022 metadata extension", () => {
    const body = new Uint8Array(64);
    const packed = Buffer.concat([body, borsh("USD Coin", 200), borsh("USDC", 200), borsh("https://cdn.example/usdc.webp", 200)]);
    const data = new Uint8Array(TOKEN_2022_TLV_START + 4 + packed.length);
    data[TOKEN_2022_ACCOUNT_TYPE_OFFSET] = TOKEN_2022_MINT_ACCOUNT_TYPE;
    data[TOKEN_2022_TLV_START] = TOKEN_2022_METADATA_TYPE;
    data[TOKEN_2022_TLV_START + 2] = packed.length;
    data.set(packed, TOKEN_2022_TLV_START + 4);
    assert.deepEqual(parseToken2022Metadata(data), {
      name: "USD Coin",
      symbol: "USDC",
      image: "https://cdn.example/usdc.webp",
    });
  });
});

function metaplex(name: string, symbol: string, uri: string): Uint8Array {
  const data = Buffer.alloc(METADATA_HEADER_LEN);
  data[0] = METADATA_KEY_V1;
  return Buffer.concat([data, borsh(name, 32), borsh(symbol, 10), borsh(uri, 200)]);
}

function borsh(value: string, maxLen: number): Buffer {
  const bytes = Buffer.from(value);
  assert.ok(bytes.length <= maxLen);
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32LE(bytes.length);
  return Buffer.concat([prefix, bytes]);
}
