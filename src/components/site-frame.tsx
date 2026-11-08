import type { ReactNode } from "react";
import Link from "next/link";

export function SiteFrame({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="flex items-center justify-between border-b border-line px-6 py-5 md:px-10">
        <p className="text-sm tracking-[0.22em] uppercase">Privacy</p>
        <nav className="flex items-center gap-5 text-sm text-muted">
          <Link className="underline-offset-4 hover:underline" href="/app">
            Tools
          </Link>
        </nav>
      </header>
      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-6 py-16 md:px-10 md:py-24">
        {children}
      </main>
      <footer className="border-t border-line px-6 py-6 text-sm text-muted md:px-10">
        Private escrow, payroll, vesting, and subscriptions. On the list until the tools are ready.
      </footer>
    </div>
  );
}
