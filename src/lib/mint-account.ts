import { SOL_DECIMALS, SOL_MINT, type AssetKind } from "./chunk-plan.ts";

export const SPL_TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const MINT_HEADER_LEN = 82;
const OFF_SUPPLY = 36;
const OFF_DECIMALS = 44;
const OFF_INITIALIZED = 45;
const INITIALIZED = 1;

export type AssetInfo = {
  readonly kind: AssetKind;
  readonly decimals: number;
  readonly supply: string | null;
  readonly tokenProgram: string | null;
};

export function solAssetInfo(): AssetInfo {
  return { kind: "sol", decimals: SOL_DECIMALS, supply: null, tokenProgram: null };
}

export function decodeMint(owner: string, data: Uint8Array): AssetInfo | null {
  const token2022 = owner === TOKEN_2022_PROGRAM_ID;
  const token = owner === SPL_TOKEN_PROGRAM_ID;
  if (!token && !token2022) return null;
  if (token && data.length !== MINT_HEADER_LEN) return null;
  if (token2022 && data.length < MINT_HEADER_LEN) return null;
  if (data[OFF_INITIALIZED] !== INITIALIZED) return null;
  const decimals = data[OFF_DECIMALS] ?? 0;
  const supply = readU64(data, OFF_SUPPLY);
  const kind: AssetKind = decimals === 0 && supply === BigInt(1) ? "nft" : "token";
  return {
    kind,
    decimals,
    supply: supply.toString(),
    tokenProgram: owner,
  };
}

export function kindAgrees(claimed: AssetKind, mint: string, info: AssetInfo): boolean {
  if (claimed === "sol") return mint === SOL_MINT && info.kind === "sol";
  if (mint === SOL_MINT) return false;
  return info.kind === claimed;
}

function readU64(data: Uint8Array, offset: number): bigint {
  let value = BigInt(0);
  for (let index = 0; index < 8; index += 1) {
    value += BigInt(data[offset + index] ?? 0) << BigInt(8 * index);
  }
  return value;
}
