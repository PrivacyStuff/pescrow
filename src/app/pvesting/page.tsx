import type { Metadata } from "next";
import { ComingDashboard } from "@/components/coming-dashboard";
import { product } from "@/lib/products";

const tool = product("pvesting");

export const metadata: Metadata = {
  title: "Privacy — pvesting",
  description: tool.summary,
  robots: { index: false, follow: false },
};

export default function PvestingPage() {
  return <ComingDashboard name={tool.id} summary={tool.summary} />;
}
