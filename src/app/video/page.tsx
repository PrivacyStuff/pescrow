import type { Metadata } from "next";
import { Suspense } from "react";
import { SiteFrame } from "@/components/site-frame";
import { demoVideoId } from "@/lib/youtube-id";

export const metadata: Metadata = {
  title: "Privacy — video",
  description: "Watch the privacy walkthrough.",
  robots: { index: false, follow: false },
};

export default function VideoPage(props: PageProps<"/video">) {
  return (
    <SiteFrame>
      <p className="text-sm tracking-[0.18em] text-stamp uppercase">Demo</p>
      <h1 className="mt-6 max-w-4xl font-serif text-[clamp(3.1rem,8vw,6.5rem)] leading-[0.92] tracking-[-0.035em]">
        Watch the walkthrough.
      </h1>
      <p className="mt-8 max-w-xl text-lg leading-8 text-muted">
        The film plays in the frame below when a YouTube id is set.
      </p>
      <div className="mt-16">
        <Suspense fallback={<Walkthrough videoId={null} />}>
          <VideoSlot searchParams={props.searchParams} />
        </Suspense>
      </div>
    </SiteFrame>
  );
}

async function VideoSlot({ searchParams }: { searchParams: PageProps<"/video">["searchParams"] }) {
  const params = await searchParams;
  return <Walkthrough videoId={demoVideoId(params.v, process.env.DEMO_YOUTUBE_ID)} />;
}

function Walkthrough({ videoId }: { videoId: string | null }) {
  return (
    <div className="aspect-video border border-line bg-background">
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
  );
}
