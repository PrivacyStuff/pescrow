export type Note = {
  readonly hash: string;
  readonly amount: string;
  readonly mint: string;
  readonly leaf: string;
};

export type RingState = {
  readonly ring: string;
  readonly shieldedAddressHex: string;
  readonly sol: string;
  readonly notes: Note[];
};

export type AssetDraft = {
  readonly kind: "sol" | "token" | "nft";
  readonly mint: string;
  readonly amount: string;
};
