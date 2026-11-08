import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { SiteFrame } from "@/components/site-frame";
import { PRODUCTS } from "@/lib/products";
import { demoVideoId } from "@/lib/youtube-id";

export const metadata: Metadata = {
  title: "Privacy — tools",
  description: "Open the escrow desk or the payroll desk. Subscription and vesting are still closed.",
  robots: { index: false, follow: false },
};

export default function ToolsPage(props: PageProps<"/app">) {
  return (
    <SiteFrame>
      <p className="text-sm tracking-[0.18em] text-stamp uppercase">Tools</p>
      <h1 className="mt-6 max-w-4xl font-serif text-[clamp(3.1rem,8vw,6.5rem)] leading-[0.92] tracking-[-0.035em]">
        Pick the one you want to test.
      </h1>
      <p className="mt-8 max-w-xl text-lg leading-8 text-muted">
        Each card opens that product. Subscription and vesting say they are not ready.
      </p>
      <ul className="mt-16 grid gap-4 sm:grid-cols-2">
        {PRODUCTS.map((item) => (
          <li key={item.id} className="min-h-56">
            <Link
              href={item.href}
              className="flex h-full flex-col border border-line p-6 transition-colors hover:border-foreground"
            >
              <p className={`text-sm tracking-[0.18em] uppercase ${item.ready ? "text-muted" : "text-stamp"}`}>
                {item.ready ? "Open" : "To come"}
              </p>
              <h2 className="mt-8 font-serif text-4xl tracking-[-0.03em]">{item.id}</h2>
              <p className="mt-4 max-w-md leading-7 text-muted">{item.summary}</p>
            </Link>
          </li>
        ))}
        <li className="sm:col-span-2">
          <Suspense fallback={<DemoCard videoId={null} />}>
            <DemoSlot searchParams={props.searchParams} />
          </Suspense>
        </li>
      </ul>
    </SiteFrame>
  );
}

async function DemoSlot({ searchParams }: { searchParams: PageProps<"/app">["searchParams"] }) {
  const params = await searchParams;
  return <DemoCard videoId={demoVideoId(params.v, process.env.DEMO_YOUTUBE_ID)} />;
}

function DemoCard({ videoId }: { videoId: string | null }) {
  return (
    <article className="border border-line p-6">
      <p className="text-sm tracking-[0.18em] text-stamp uppercase">Demo</p>
      <h2 className="mt-8 font-serif text-4xl tracking-[-0.03em]">Watch the walkthrough</h2>
      <div className="mt-6 aspect-video border border-line bg-background">
        {videoId === null ? (
          <p className="flex h-full items-center px-6 text-muted">The walkthrough will play in this frame.</p>
        ) : (
          <iframe
            className="h-full w-full"
            src={`https://www.youtube-nocookie.com/embed/${videoId}`}
            title="Privacy walkthrough"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            referrerPolicy="strict-origin-when-cross-origin"
            allowFullScreen
          />
        )}
      </div>
    </article>
  );
}
