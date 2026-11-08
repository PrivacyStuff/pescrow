import Link from "next/link";
import { SiteFrame } from "@/components/site-frame";

export function ComingDashboard({ name, summary }: { name: string; summary: string }) {
  return (
    <SiteFrame>
      <p className="text-sm tracking-[0.18em] text-stamp uppercase">To come</p>
      <h1 className="mt-4 max-w-3xl font-serif text-5xl tracking-[-0.035em] md:text-6xl">{name}</h1>
      <p className="mt-6 max-w-xl text-lg leading-8 text-muted">{summary}</p>
      <p className="mt-4 max-w-xl leading-7 text-muted">This dashboard is not open yet.</p>
      <Link href="/app" className="mt-10 inline-flex h-12 items-center border border-foreground px-5">
        All tools
      </Link>
    </SiteFrame>
  );
}
