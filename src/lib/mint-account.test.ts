import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { decodeMint, kindAgrees, MINT_HEADER_LEN, solAssetInfo, SPL_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID as TOKEN_2022 } from "./mint-account.ts";
import { SOL_MINT } from "./chunk-plan.ts";

function mint(decimals: number, supply: bigint): Uint8Array {
  const data = new Uint8Array(MINT_HEADER_LEN);
  data[45] = 1;
  data[44] = decimals;
  let rest = supply;
  for (let index = 0; index < 8; index += 1) {
    data[36 + index] = Number(rest & BigInt(0xff));
    rest >>= BigInt(8);
  }
  return data;
}

describe("decodeMint", () => {
  it("uses the same program ids as @solana/spl-token", () => {
    assert.equal(TOKEN_PROGRAM_ID.toBase58(), SPL_TOKEN_PROGRAM_ID);
    assert.equal(TOKEN_2022_PROGRAM_ID.toBase58(), TOKEN_2022);
  });

  it("treats a 0-decimal supply of 1 as an NFT and a longer Token-2022 mint as a token", () => {
    const nft = decodeMint(SPL_TOKEN_PROGRAM_ID, mint(0, BigInt(1)));
    assert.equal(nft?.kind, "nft");
    assert.equal(nft?.decimals, 0);
    const extended = new Uint8Array(MINT_HEADER_LEN + 40);
    extended.set(mint(6, BigInt(10_000_000)));
    const token = decodeMint(TOKEN_2022, extended);
    assert.equal(token?.kind, "token");
    assert.equal(token?.supply, "10000000");
    assert.equal(token?.tokenProgram, TOKEN_2022);
    assert.equal(decodeMint(SPL_TOKEN_PROGRAM_ID, extended), null);
    assert.equal(decodeMint("11111111111111111111111111111111", mint(6, BigInt(1))), null);
    const uninitialized = mint(6, BigInt(1));
    uninitialized[45] = 0;
    assert.equal(decodeMint(SPL_TOKEN_PROGRAM_ID, uninitialized), null);
  });

  it("checks a claimed kind against the mint that was read", () => {
    const info = decodeMint(SPL_TOKEN_PROGRAM_ID, mint(0, BigInt(1)));
    assert.equal(info === null, false);
    if (info === null) return;
    assert.equal(kindAgrees("nft", "9EmMw4C6ZUjacxM4rPQhNVGmxkPJNiUTiymrY1zJNSzX", info), true);
    assert.equal(kindAgrees("token", "9EmMw4C6ZUjacxM4rPQhNVGmxkPJNiUTiymrY1zJNSzX", info), false);
    assert.equal(kindAgrees("sol", SOL_MINT, solAssetInfo()), true);
  });
});
