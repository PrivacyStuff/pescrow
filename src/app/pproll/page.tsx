import type { Metadata } from "next";
import { TxLogProvider } from "@/components/dashboard/tx-drawer";
import { PayrollDesk } from "@/components/payroll-desk";
import { SiteFrame } from "@/components/site-frame";
import { WalletFrame } from "@/components/wallet-provider";

export const metadata: Metadata = {
  title: "Privacy — pproll",
  description: "Open a salary for a destinataire and load the payrolls this wallet issued or received.",
  robots: { index: false, follow: false },
};

export default function PprollPage() {
  return (
    <SiteFrame>
      <WalletFrame>
        <TxLogProvider>
          <PayrollDesk />
        </TxLogProvider>
      </WalletFrame>
    </SiteFrame>
  );
}
