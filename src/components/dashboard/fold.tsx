"use client";

import { useId, useState, type ReactNode } from "react";

const HEADING = {
  h2: "h2",
  h3: "h3",
  p: "p",
} as const;

type HeadingLevel = keyof typeof HEADING;

export function Fold({
  title,
  level = "h2",
  className,
  titleClassName,
  classNameForWrap,
  children,
}: {
  title: ReactNode;
  level?: HeadingLevel;
  className?: string;
  titleClassName?: string;
  classNameForWrap?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(true);
  const panelId = useId();
  const Heading = HEADING[level];

  return (
    <div className={classNameForWrap}>
      <Heading className={className}>
        <button
          type="button"
          className="flex w-full items-baseline justify-between gap-4 text-left"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((current) => !current)}
        >
          <span className={titleClassName}>{title}</span>
          <span className="shrink-0 font-sans text-sm font-normal tracking-normal text-muted">{open ? "Fold" : "Unfold"}</span>
        </button>
      </Heading>
      <div id={panelId} hidden={!open}>
        {children}
      </div>
    </div>
  );
}
