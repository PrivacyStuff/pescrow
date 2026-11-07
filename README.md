# pescrow

## Where this is

Devnet program `7c3yarLtR2eUebLqYcms7GViXZ5SpQVWmmiqJTp3QtYG`. Lock, swap, and give-back verify the single-party keys in `src/verifier` before the privacy CPI. A bad proof returns 123 and does not seal.

Upgrade `3HN2sqPGNbdHhPdWjZvYMxuG4Wj8XtRUCgi3dgoFYsWktC76v1cJ5deEtLGL27FVaAaKCS9YDJTghwpjAanXhVqu` makes lock, swap, and give-back accept only `ring1GaLCuJnkUMVkX2JeZLTTX17wKsV4fZmPVzXANW`. The open escrow is `FN4yqDixHBi84WUZBqTg2rm6m1Rrvvm46Pum55nU99KF`. Both sides approved. Neither side is sealed. Locks must land before `2026-11-14T14:10:23Z`. The notes it can lock are the ring1 notes on tree `777pvSGe5LaBd9nCczvE2FXEauiwtfGJ5XRpjKyniGor`.

`AgeABASQR4NyFYKHxN2d24cDJnRujSwxiM194dW3781u` was closed by `5GATWfNuqogtQsGneJE5rsk2PdQaDMtsrRb7Ftv4fqPRAT7hzbd8H3X6Gn43jSvYEgpm8WC6Df2V9M8UEtQgUQGZ`. The rent went back to party A. The earlier account `3sRo9k225NXjQtF54kQc9tKDnb32WtLgD3XThYMAnhzo` is already gone.

| Side | Payer | Leaf | Note hash |
| --- | --- | --- | --- |
| A | `AoBDpQ9KRQ1GBtnu1QURmdDv7RgN4Qyr5EWSkQzgF1B8` | 34448 | `xUiK4RZz4JerbRzZjHVaBgaQM46A45eYhZ2uBMggNzY` |
| B | `YrSYDo5dYGbnhGMASAAthdy3tgmXvgj8sF79WHwdDi5` | 34449 | `3UyqNELpp375h2oTWZwEP5y2McYaZiG6gS3KkCNmo3ey` |

The earlier 0.01 SOL notes on `33KVhb…` stay in that tree. This program no longer locks them.

## Next

Lock each ring1 note into the escrow PDA, then swap. The swap pays A's note to B and B's note to A. A lock still needs the Merkle path from an indexer of `777pv…`, the pool proof, and the escrow circuit proof.

## The deal

Two people exchange a token, or an NFT (a supply-1 token). Each side locks. As soon as both locks are in, either side can release and take the other side's asset. If the other side never locks, the first side takes theirs back after the deadline. A sealed side has no cancel.

The price is never stored on the account. Two choices are frozen at create. They do not have to match.

- **Ring.** Permissionless means the Helius Default ring, open to anyone. Custom means a ring Helius opens for one use, such as a company. A custom ring is its own program id. This program is not redeployed per ring.
- **Wallets.** Public means both addresses are on the account and on the transfer. Private means those addresses are hidden. The price stays hidden in both.

| | Public wallets | Private wallets |
| --- | --- | --- |
| Permissionless | Opens. A stranger sees who is swapping, not the price. This is the first path. | Rejected. The Default ring prints both addresses, so this program will not pretend they are hidden. |
| Custom | Accepted as a choice. Create waits until Helius sets that ring's program id. A stranger still sees who is swapping. The price stays hidden. | Accepted as a choice. Create waits until Helius sets an anonymous ring program id. A stranger does not see who is swapping. A relayer pays the fee. The ring program id stays visible. |

`fund_side`, `release`, and `reclaim` accept only the Solana Privacy Program `ring1GaLCuJnkUMVkX2JeZLTTX17wKsV4fZmPVzXANW`. Each one reads its public inputs from this escrow account, verifies the matching circuit, then `SppTransactAccounts::invoke` moves the note. The output of a lock is owned by this program's PDA, derived from `escrow-lock` and the escrow address. The seal is written after that invoke returns. The call shape is the [Zolana program SDK](https://github.com/helius-labs/zolana/blob/main/sdk-libs/program/docs.md). The account is 160 bytes.

```bash
cargo test
```

The other products are `pproll`, `pesting`, and `pubscription`. They are not started.
