# pescrow TypeScript SDK

Client for the devnet gatekeeper. The on-chain program is still Rust.

`@heliuslabs/spr@0.9.0-alpha` builds against pool `ring1GaLCuJnkUMVkX2JeZLTTX17wKsV4fZmPVzXANW` and tree `777pvSGe5LaBd9nCczvE2FXEauiwtfGJ5XRpjKyniGor`. A Helius RPC root is rewritten to `https://devnet.helius-rpc.com/v1/spr` for the indexer and the prover.

`npm run proofs` asks the indexer for the two ring1 notes on `777pvSGe5LaBd9nCczvE2FXEauiwtfGJ5XRpjKyniGor` (leaves 34448 and 34449, 0.01 SOL each). The older notes on `33KVhb…` stay in `DEPOSITED_NOTE_HASHES`; that tree is rejected as an invalid public key. The deployed program accepts `ring1…`. These proofs are the ones the open escrow can lock.

```bash
npm test
HELIUS_API_KEY=... npm run proofs
```
