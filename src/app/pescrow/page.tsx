import type { Metadata } from "next";
import { Dashboard } from "@/components/dashboard/dashboard";
import { SiteFrame } from "@/components/site-frame";
import { WalletFrame } from "@/components/wallet-provider";

export const metadata: Metadata = {
  title: "Privacy — pescrow",
  description: "Open a pescrow for SOL, a token, or an NFT, and see the ones you issued and the ones you received.",
  robots: { index: false, follow: false },
};

export default function PescrowPage() {
  return (
    <SiteFrame>
      <WalletFrame>
        <Dashboard />
      </WalletFrame>
    </SiteFrame>
  );
}
