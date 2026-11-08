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
  titleInteractive = false,
  children,
}: {
  title: ReactNode;
  level?: HeadingLevel;
  className?: string;
  titleClassName?: string;
  classNameForWrap?: string;
  titleInteractive?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(true);
  const panelId = useId();
  const Heading = HEADING[level];

  const foldLabel = open ? "Fold" : "Unfold";

  return (
    <div className={classNameForWrap}>
      {titleInteractive ? (
        <div className="flex w-full items-center justify-between gap-4">
          <Heading className={`min-w-0 ${className ?? ""}`}>
            <span className={titleClassName}>{title}</span>
          </Heading>
          <button
            type="button"
            className="shrink-0 font-sans text-sm font-normal tracking-normal text-muted underline-offset-4 hover:underline"
            aria-expanded={open}
            aria-controls={panelId}
            onClick={() => setOpen((current) => !current)}
          >
            {foldLabel}
          </button>
        </div>
      ) : (
        <Heading className={className}>
          <button
            type="button"
            className="flex w-full items-center justify-between gap-4 text-left"
            aria-expanded={open}
            aria-controls={panelId}
            onClick={() => setOpen((current) => !current)}
          >
            <span className={`min-w-0 ${titleClassName ?? ""}`}>{title}</span>
            <span className="shrink-0 font-sans text-sm font-normal tracking-normal text-muted">{foldLabel}</span>
          </button>
        </Heading>
      )}
      <div id={panelId} hidden={!open}>
        {children}
      </div>
    </div>
  );
}
