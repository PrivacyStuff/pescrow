const DEVNET_RPC_ORIGIN = "https://devnet.helius-rpc.com/";

/** Helius devnet gatekeeper URL. The query carries the API key and nothing else. */
export function devnetRpcUrl(apiKey: string): string {
  if (apiKey.length === 0 || /\s/u.test(apiKey)) {
    throw new Error("Helius API key is empty");
  }
  const url = new URL(DEVNET_RPC_ORIGIN);
  url.searchParams.set("api-key", apiKey);
  return url.toString();
}
