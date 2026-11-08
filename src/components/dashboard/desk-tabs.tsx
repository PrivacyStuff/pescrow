"use client";

import { useRef, type KeyboardEvent } from "react";

export type DeskTab = "balance" | "new";

const TABS: readonly { readonly id: DeskTab; readonly label: string }[] = [
  { id: "balance", label: "Balance" },
  { id: "new", label: "New escrow" },
];

export function DeskTabs({ tab, onTab }: { tab: DeskTab; onTab: (tab: DeskTab) => void }) {
  const refs = useRef<Partial<Record<DeskTab, HTMLButtonElement | null>>>({});

  function move(next: DeskTab): void {
    onTab(next);
    refs.current[next]?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const index = TABS.findIndex((item) => item.id === tab);
    const step = event.key === "ArrowRight" ? 1 : -1;
    const next = TABS[(index + step + TABS.length) % TABS.length];
    if (next === undefined) return;
    move(next.id);
  }

  return (
    <div role="tablist" aria-label="Desk" className="mt-6 flex gap-2" onKeyDown={onKeyDown}>
      {TABS.map((item) => {
        const selected = tab === item.id;
        return (
          <button
            key={item.id}
            ref={(node) => {
              refs.current[item.id] = node;
            }}
            id={`desk-tab-${item.id}`}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={`desk-panel-${item.id}`}
            tabIndex={selected ? 0 : -1}
            className={selected ? "border border-foreground px-3 py-1 text-sm" : "border border-line px-3 py-1 text-sm text-muted"}
            onClick={() => onTab(item.id)}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
