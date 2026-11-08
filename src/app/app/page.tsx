import type { Metadata } from "next";
import Link from "next/link";
import { SiteFrame } from "@/components/site-frame";
import { PRODUCTS } from "@/lib/products";

export const metadata: Metadata = {
  title: "Privacy — tools",
  description: "Open the escrow desk or the payroll desk. Subscription and vesting are still closed.",
  robots: { index: false, follow: false },
};

const PESCREW_DEMO_VIDEO_ID = "HJSxfTVivUc";
const PPROLL_DEMO_VIDEO_ID = "6hG4TzfDCzI";

/** Matches the allow list YouTube puts on a normal embed. The src does not autoplay. */
const YOUTUBE_EMBED_ALLOW =
  "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share";

const DEMO_VIDEOS = [
  {
    id: "pescrow",
    videoId: PESCREW_DEMO_VIDEO_ID,
    description: "Swap two notes. The price stays hidden. Both wallets and the deadline stay public.",
  },
  {
    id: "pproll",
    videoId: PPROLL_DEMO_VIDEO_ID,
    description: "One salary, one period at a time. The installment stays hidden. The wallets, the start, and the period stay public.",
  },
] as const;

export default function ToolsPage() {
  return (
    <SiteFrame>
      <p className="text-sm tracking-[0.18em] text-stamp uppercase">Tools</p>
      <h1 className="mt-6 max-w-4xl font-serif text-[clamp(3.1rem,8vw,6.5rem)] leading-[0.92] tracking-[-0.035em]">
        Pick the one you want to test.
      </h1>
      <p className="mt-8 max-w-xl text-lg leading-8 text-muted">
        Escrow and payroll open. Subscription and vesting are not ready yet.
      </p>
      <ul className="mt-16 grid gap-4 sm:grid-cols-2">
        {PRODUCTS.map((item) => (
          <li key={item.id} className="min-h-56">
            {item.ready ? (
              <Link
                href={item.href}
                className="flex h-full flex-col border border-line p-6 transition-colors hover:border-foreground"
              >
                <p className="text-sm tracking-[0.18em] text-muted uppercase">Open</p>
                <h2 className="mt-8 font-serif text-3xl tracking-[-0.03em]">{item.title}</h2>
                <p className="mt-4 max-w-md leading-7 text-muted">{item.summary}</p>
              </Link>
            ) : (
              <div
                aria-disabled="true"
                className="flex h-full cursor-not-allowed flex-col border border-line p-6 opacity-60 select-none"
              >
                <p className="text-sm tracking-[0.18em] text-stamp uppercase">Coming soon</p>
                <h2 className="mt-8 font-serif text-3xl tracking-[-0.03em] text-muted">{item.title}</h2>
                <p className="mt-4 max-w-md leading-7 text-muted">{item.summary}</p>
              </div>
            )}
          </li>
        ))}
        {DEMO_VIDEOS.map((demo) => (
          <li key={demo.id} className="min-w-0">
            <DemoCard demo={demo} />
          </li>
        ))}
      </ul>
    </SiteFrame>
  );
}

function DemoCard({ demo }: { demo: (typeof DEMO_VIDEOS)[number] }) {
  return (
    <article className="flex h-full min-w-0 flex-col border border-line p-6">
      <p className="text-sm tracking-[0.18em] text-stamp uppercase">Demo</p>
      <h2 className="mt-8 font-serif text-4xl tracking-[-0.03em]">{demo.id}</h2>
      <p className="mt-4 leading-7 text-muted">{demo.description}</p>
      <div className="mt-6 aspect-video overflow-hidden border border-line bg-background">
        <iframe
          className="h-full w-full"
          src={`https://www.youtube-nocookie.com/embed/${demo.videoId}`}
          title={`${demo.id} demo. ${demo.description}`}
          loading="lazy"
          allow={YOUTUBE_EMBED_ALLOW}
          referrerPolicy="strict-origin-when-cross-origin"
          allowFullScreen
        />
      </div>
    </article>
  );
}
