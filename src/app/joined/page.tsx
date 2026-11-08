import type { Metadata } from "next";
import Link from "next/link";
import { SiteFrame } from "@/components/site-frame";

export const metadata: Metadata = {
  title: "You're on the list — Privacy",
  robots: { index: false, follow: false },
};

export default function JoinedPage() {
  return (
    <SiteFrame>
      <p className="text-sm tracking-[0.18em] text-stamp uppercase">Waitlist</p>
      <h1 className="mt-6 max-w-3xl font-serif text-[clamp(3rem,7vw,5.5rem)] leading-[0.95] tracking-[-0.035em]">
        You are on the list.
      </h1>
      <p className="mt-8 max-w-xl text-lg leading-8 text-muted">
        We will write when it opens. Nothing else happens with the address you sent.
      </p>
      <Link
        href="/"
        className="mt-10 inline-flex h-12 items-center border border-foreground px-5"
      >
        Back
      </Link>
    </SiteFrame>
  );
}
