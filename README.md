# pescrow

Two people exchange a token, or an NFT (a supply-1 token). Each side locks. As soon as both locks are in, either side can release and take the other side's asset. If the other side never locks, the first side takes theirs back after the deadline. A sealed side has no cancel.

The price is never stored on the account. Two choices are frozen at create. They do not have to match.

- **Ring.** Permissionless means the Helius Default ring, open to anyone. Custom means a ring Helius opens for one use, such as a company. A custom ring is its own program id. This program is not redeployed per ring.
- **Wallets.** Public means both addresses are on the account and on the transfer. Private means those addresses are hidden. The price stays hidden in both.

| | Public wallets | Private wallets |
| --- | --- | --- |
| Permissionless | Opens. A stranger sees who is swapping, not the price. This is the first path. | Rejected. The Default ring prints both addresses, so this program will not pretend they are hidden. |
| Custom | Accepted as a choice. Create waits until Helius sets that ring's program id. A stranger still sees who is swapping. The price stays hidden. | Accepted as a choice. Create waits until Helius sets an anonymous ring program id. A stranger does not see who is swapping. A relayer pays the fee. The ring program id stays visible. |

`fund_side` accepts only the Solana Privacy Program `sppU489D7A4U1exNo1oeMGZtLEofq3a6o2fR7UeoWB6`, then fails closed. The shielded-pool call is specified in the [Zolana program SDK](https://github.com/helius-labs/zolana/blob/main/sdk-libs/program/docs.md). Until that call is wired, a fund cannot mark a side sealed.

```bash
cargo test
```

The other products are `pproll`, `pesting`, and `pubscription`. They are not started.
