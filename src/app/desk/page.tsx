import { Desk } from "@/components/desk";
import { SiteFrame } from "@/components/site-frame";
import { WalletFrame } from "@/components/wallet-provider";

export const metadata = {
  title: "Privacy — desk",
  description: "Shield SOL onto ring1, open an escrow, and withdraw back to the funding wallet.",
};

export default function DeskPage() {
  return (
    <SiteFrame>
      <WalletFrame>
        <Desk />
      </WalletFrame>
    </SiteFrame>
  );
}
