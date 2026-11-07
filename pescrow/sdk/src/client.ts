import { createSprClient } from "@heliuslabs/spr";
import type { Address } from "@solana/kit";
import { bytes32FromBase58 } from "./bytes.ts";
import { devnetRpcUrl } from "./rpc-url.ts";

export type PescrowClient = Awaited<ReturnType<typeof createSprClient>>;

/**
 * Devnet client. A Helius RPC root makes the SDK call the indexer and the
 * prover at `/v1/spr` on that same host. A remote `proveTransact` still needs
 * `proverTee`; this factory does not set one.
 */
export function createDevnetClient(apiKey: string): Promise<PescrowClient> {
  return createSprClient({ solanaRpcUrl: devnetRpcUrl(apiKey) });
}

/** Inclusion paths for note hashes. `tree` is the account that appended them. */
export function noteProofs(client: PescrowClient, tree: Address, noteHashes: readonly string[]) {
  return client.getMerkleProofs(tree, noteHashes.map(bytes32FromBase58));
}
