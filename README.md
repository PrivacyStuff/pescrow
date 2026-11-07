# pescrow

## Where this is

Devnet program `7c3yarLtR2eUebLqYcms7GViXZ5SpQVWmmiqJTp3QtYG`. Lock, swap, and give-back verify the single-party keys in `src/verifier` before the privacy CPI. A bad proof returns 123 and does not seal.

One escrow, `3sRo9k225NXjQtF54kQc9tKDnb32WtLgD3XThYMAnhzo`, was created and both sides approved. Nobody deposited. The approval window passed, so lock would have returned 106. Close `4v3y773UbgPxWJnQFLSYjbLdULkPeQZBuZq8dKGoEuZLqdeRMcBWoCbb23CSush5DaNxW7T5Mm8QfPW6KqY2eusg` returned the rent to party A. That account is gone. No second escrow is open.

Two notes of 0.01 SOL each are in the permissionless pool `sppU489D7A4U1exNo1oeMGZtLEofq3a6o2fR7UeoWB6`, tree `33KVhbT4QtdQDrrrGwwThqD47Dh4Q6tA443t9jMNcWFN`. They belong to the wallets, not to an escrow.

| Side | Payer | Leaf | Note hash | Deposit |
| --- | --- | --- | --- | --- |
| A | `AoBDpQ9KRQ1GBtnu1QURmdDv7RgN4Qyr5EWSkQzgF1B8` | 160215 | `09711ab4e1b813a02679c9e187caad0f04bb52be22ee25dd35562131e2aec25c` | `2mYEhtdXSAHYnmCjfuvEmw1ZhPEQ2WhekHQQAsHcbjMuei1DdKRLFaj1d1Y5sSWEu3aDCsv1eSSP5J8aokRVnAUb` |
| B | `YrSYDo5dYGbnhGMASAAthdy3tgmXvgj8sF79WHwdDi5` | 160216 | `2b8ede155f42cc294be31a1806dc8182cdb3a05f5488bc41816cd362b8f2e2a6` | `4M63WdDWc4sa9QCP8xTArcMUyDouPi7MZUeohvYNkUg3rr453WV2KeHZKusMy4V1qQCiBWzVBtJUyDr1BdVvYGnJ` |

## The block

A lock spends a note. The spend needs a Merkle path. The tree account stores the frontier and the last 500 roots, not the siblings for leaf 160215 or 160216. `https://devnet.helius-rpc.com/v1/spr/get_merkle_proofs` returns 404. `https://d21d98xh5lgv3b.cloudfront.net` does not resolve. The Photon binary in the local v0.6 cache follows `ring1…`, so a path from it will not verify on `sppU489…`.

No new escrow is opened until those two paths exist. Create and accept can land, and the window would close again before a lock.

## Next

Get the live devnet indexer base URL that serves `get_merkle_proofs` for this tree, and the prover URL whose keys match `sppU489…`. Then create an escrow for the two payers above, both accept while the window is open, lock each note into the escrow PDA, and swap. The swap pays A's note to B and B's note to A.

## The deal

Two people exchange a token, or an NFT (a supply-1 token). Each side locks. As soon as both locks are in, either side can release and take the other side's asset. If the other side never locks, the first side takes theirs back after the deadline. A sealed side has no cancel.

The price is never stored on the account. Two choices are frozen at create. They do not have to match.

- **Ring.** Permissionless means the Helius Default ring, open to anyone. Custom means a ring Helius opens for one use, such as a company. A custom ring is its own program id. This program is not redeployed per ring.
- **Wallets.** Public means both addresses are on the account and on the transfer. Private means those addresses are hidden. The price stays hidden in both.

| | Public wallets | Private wallets |
| --- | --- | --- |
| Permissionless | Opens. A stranger sees who is swapping, not the price. This is the first path. | Rejected. The Default ring prints both addresses, so this program will not pretend they are hidden. |
| Custom | Accepted as a choice. Create waits until Helius sets that ring's program id. A stranger still sees who is swapping. The price stays hidden. | Accepted as a choice. Create waits until Helius sets an anonymous ring program id. A stranger does not see who is swapping. A relayer pays the fee. The ring program id stays visible. |

`fund_side`, `release`, and `reclaim` accept only the Solana Privacy Program `sppU489D7A4U1exNo1oeMGZtLEofq3a6o2fR7UeoWB6`. Each one reads its public inputs from this escrow account, verifies the matching circuit, then `SppTransactAccounts::invoke` moves the note. The output of a lock is owned by this program's PDA, derived from `escrow-lock` and the escrow address. The seal is written after that invoke returns. The call shape is the [Zolana program SDK](https://github.com/helius-labs/zolana/blob/main/sdk-libs/program/docs.md). The account is 160 bytes.

```bash
cargo test
```

The other products are `pproll`, `pesting`, and `pubscription`. They are not started.
