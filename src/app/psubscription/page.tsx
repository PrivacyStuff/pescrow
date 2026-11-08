import type { Metadata } from "next";
import { ComingDashboard } from "@/components/coming-dashboard";
import { product } from "@/lib/products";

const tool = product("psubscription");

export const metadata: Metadata = {
  title: "Privacy — psubscription",
  description: tool.summary,
  robots: { index: false, follow: false },
};

export default function PsubscriptionPage() {
  return <ComingDashboard name={tool.id} summary={tool.summary} />;
}
