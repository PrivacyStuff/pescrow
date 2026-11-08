import type { Metadata } from "next";
import { FaucetPanel } from "@/components/faucet-panel";
import { SiteFrame } from "@/components/site-frame";
import { WalletFrame } from "@/components/wallet-provider";

export const metadata: Metadata = {
  title: "Privacy — devnet faucet",
  description: "Drop devnet SOL and test USDC to a wallet for the demo.",
  robots: { index: false, follow: false },
};

export default function FaucetPage() {
  return (
    <SiteFrame>
      <WalletFrame>
        <FaucetPanel />
      </WalletFrame>
    </SiteFrame>
  );
}
