import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SOL_DECIMALS, SOL_MINT } from "./chunk-plan.ts";
import { MAX_DESK_LAMPORTS, RING_FEE_RESERVE } from "./desk-request.ts";
import { SPL_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "./mint-account.ts";
import {
  clampShieldText,
  NFT_SHIELD_TEXT,
  openingShieldText,
  readHeldAssetList,
  readTokenAccountList,
  rpcLamports,
  selectHeldAssets,
  shieldBaseAmount,
  solShieldMax,
  type HeldAsset,
  type MintClass,
  type TokenAccountSnapshot,
} from "./wallet-holdings.ts";

const WALLET = "xUiK4RZz4JerbRzZjHVaBgaQM46A45eYhZ2uBMggNzY";
const MINT = "9EmMw4C6ZUjacxM4rPQhNVGmxkPJNiUTiymrY1zJNSzX";
const OTHER_MINT = "So11111111111111111111111111111111111111112";
const ACCOUNT_A = "4Nd1mY5h1i6k3pQe3k3k3k3k3k3k3k3k3k3k3k3k3k3k";
const ACCOUNT_B = "5Nd1mY5h1i6k3pQe3k3k3k3k3k3k3k3k3k3k3k3k3k3k";
const NFT_ACCOUNT = "6Nd1mY5h1i6k3pQe3k3k3k3k3k3k3k3k3k3k3k3k3k3k";

describe("solShieldMax", () => {
  it("subtracts the ring fee reserve and stops at the desk cap", () => {
    assert.equal(solShieldMax(BigInt(RING_FEE_RESERVE)), BigInt(0));
    assert.equal(solShieldMax(BigInt(RING_FEE_RESERVE) - BigInt(1)), BigInt(0));
    assert.equal(solShieldMax(BigInt(RING_FEE_RESERVE) + BigInt(1)), BigInt(1));
    assert.equal(solShieldMax(MAX_DESK_LAMPORTS + BigInt(RING_FEE_RESERVE) + BigInt(5)), MAX_DESK_LAMPORTS);
  });
});

describe("rpcLamports", () => {
  it("accepts a safe non-negative balance and rejects a fractional one", () => {
    assert.equal(rpcLamports(0), BigInt(0));
    assert.equal(rpcLamports(RING_FEE_RESERVE), BigInt(RING_FEE_RESERVE));
    assert.equal(rpcLamports(-1), null);
    assert.equal(rpcLamports(1.5), null);
    assert.equal(rpcLamports(Number.MAX_SAFE_INTEGER + 1), null);
  });
});

describe("readTokenAccountList", () => {
  it("keeps initialized accounts for that program and drops a bad amount", () => {
    const rows = readTokenAccountList(SPL_TOKEN_PROGRAM_ID, {
      value: [
        tokenRow(ACCOUNT_A, MINT, WALLET, "15", 6, "initialized", SPL_TOKEN_PROGRAM_ID),
        tokenRow(ACCOUNT_B, MINT, WALLET, "1.5", 6, "initialized", SPL_TOKEN_PROGRAM_ID),
        tokenRow(NFT_ACCOUNT, OTHER_MINT, WALLET, "1", 0, "initialized", TOKEN_2022_PROGRAM_ID),
      ],
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.address, ACCOUNT_A);
    assert.equal(rows[0]?.amount, BigInt(15));
  });
});

describe("selectHeldAssets", () => {
  const mints: Record<string, MintClass> = {
    [MINT]: { kind: "token", decimals: 6, tokenProgram: SPL_TOKEN_PROGRAM_ID },
    [OTHER_MINT]: { kind: "nft", decimals: 0, tokenProgram: SPL_TOKEN_PROGRAM_ID },
  };

  it("shows SOL the wallet holds, the largest token account, and an NFT as one", () => {
    const rows = selectHeldAssets({
      wallet: WALLET,
      solLamports: BigInt(RING_FEE_RESERVE) + BigInt(2),
      accounts: [
        snapshot(ACCOUNT_A, MINT, WALLET, BigInt(4), 6, SPL_TOKEN_PROGRAM_ID, "initialized"),
        snapshot(ACCOUNT_B, MINT, WALLET, BigInt(9), 6, SPL_TOKEN_PROGRAM_ID, "initialized"),
        snapshot(NFT_ACCOUNT, OTHER_MINT, WALLET, BigInt(1), 0, SPL_TOKEN_PROGRAM_ID, "initialized"),
        snapshot(ACCOUNT_A, MINT, OTHER_MINT, BigInt(50), 6, SPL_TOKEN_PROGRAM_ID, "initialized"),
        snapshot(ACCOUNT_B, MINT, WALLET, BigInt(3), 6, SPL_TOKEN_PROGRAM_ID, "frozen"),
      ],
      mints,
    });
    assert.deepEqual(
      rows.map((row) => ({ kind: row.kind, mint: row.mint, maxBase: row.maxBase, tokenAccount: row.tokenAccount })),
      [
        { kind: "sol", mint: SOL_MINT, maxBase: "2", tokenAccount: null },
        { kind: "token", mint: MINT, maxBase: "9", tokenAccount: ACCOUNT_B },
        { kind: "nft", mint: OTHER_MINT, maxBase: "1", tokenAccount: NFT_ACCOUNT },
      ],
    );
  });

  it("omits SOL the wallet does not hold and a mint the scan could not classify", () => {
    const rows = selectHeldAssets({
      wallet: WALLET,
      solLamports: BigInt(0),
      accounts: [snapshot(ACCOUNT_A, MINT, WALLET, BigInt(1), 9, SPL_TOKEN_PROGRAM_ID, "initialized")],
      mints,
    });
    assert.deepEqual(rows, []);
  });
});

describe("shield amount limits", () => {
  const sol = holding("sol", SOL_MINT, "20000000", SOL_DECIMALS, null, null);
  const token = holding("token", MINT, "1500000", 6, ACCOUNT_A, SPL_TOKEN_PROGRAM_ID);
  const nft = holding("nft", OTHER_MINT, "1", 0, NFT_ACCOUNT, SPL_TOKEN_PROGRAM_ID);

  it("opens under the max and refuses a typed amount above it", () => {
    assert.equal(openingShieldText(sol), "0.01");
    assert.equal(openingShieldText(holding("sol", SOL_MINT, "1", SOL_DECIMALS, null, null)), "0.000000001");
    assert.equal(openingShieldText(token), "1");
    assert.equal(openingShieldText(nft), NFT_SHIELD_TEXT);
    assert.equal(clampShieldText("2", token), "1.5");
    assert.equal(clampShieldText("1.5", token), "1.5");
    assert.equal(clampShieldText("1.", token), "1.");
    assert.equal(clampShieldText("0", token), "0");
    assert.equal(clampShieldText("nope", token), null);
    assert.equal(clampShieldText("1.0000001", token), null);
    assert.equal(clampShieldText("9", nft), NFT_SHIELD_TEXT);
    assert.equal(shieldBaseAmount("2", token), null);
    assert.equal(shieldBaseAmount("1.5", token), BigInt(1_500_000));
    assert.equal(shieldBaseAmount("0.03", sol), null);
    assert.equal(shieldBaseAmount("0.02", sol), BigInt(20_000_000));
    assert.equal(shieldBaseAmount("0.01", sol), BigInt(10_000_000));
    assert.equal(shieldBaseAmount(NFT_SHIELD_TEXT, nft), BigInt(1));
    assert.equal(shieldBaseAmount("2", nft), null);
  });
});

describe("readHeldAssetList", () => {
  it("drops a row whose max is not a base-unit string", () => {
    const rows = readHeldAssetList([
      { kind: "sol", mint: SOL_MINT, maxBase: "1", decimals: SOL_DECIMALS, tokenAccount: null, tokenProgram: null },
      { kind: "token", mint: MINT, maxBase: "1.2", decimals: 6, tokenAccount: ACCOUNT_A, tokenProgram: SPL_TOKEN_PROGRAM_ID },
      { kind: "nft", mint: OTHER_MINT, maxBase: "2", decimals: 0, tokenAccount: NFT_ACCOUNT, tokenProgram: SPL_TOKEN_PROGRAM_ID },
    ]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.kind, "sol");
  });
});

function holding(
  kind: HeldAsset["kind"],
  mint: string,
  maxBase: string,
  decimals: number,
  tokenAccount: string | null,
  tokenProgram: string | null,
): HeldAsset {
  return { kind, mint, maxBase, decimals, tokenAccount, tokenProgram };
}

function snapshot(
  address: string,
  mint: string,
  owner: string,
  amount: bigint,
  decimals: number,
  tokenProgram: string,
  state: string,
): TokenAccountSnapshot {
  return { address, mint, owner, amount, decimals, tokenProgram, state };
}

function tokenRow(
  address: string,
  mint: string,
  owner: string,
  amount: string,
  decimals: number,
  state: string,
  program: string,
): unknown {
  return {
    pubkey: address,
    account: {
      owner: program,
      data: {
        parsed: {
          info: { mint, owner, state, tokenAmount: { amount, decimals } },
        },
      },
    },
  };
}
