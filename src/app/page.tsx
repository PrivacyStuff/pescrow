import Link from "next/link";
import { SiteFrame } from "@/components/site-frame";
import { WaitlistForm } from "@/components/waitlist-form";

const PRODUCTS = [
  {
    name: "private - escrow (pescrow)",
    pitch:
      "Hold funds until a condition is met. You do not need the amount, or who is on either side, sitting in a public feed.",
  },
  {
    name: "private - payroll (pproll)",
    pitch:
      "Pay one salary on a cadence. You do not need the amount sitting in a public feed.",
  },
  {
    name: "private vesting (pesting)",
    pitch:
      "Unlock a grant on a schedule. You do not need the cliff, the size, or the recipient on a page anyone can open.",
  },
  {
    name: "private - subscription (psub)",
    pitch:
      "Charge on a cadence. You do not need a public list of who pays, how much, or how often.",
  },
] as const;

export default function Home() {
  return (
    <SiteFrame>
      <p className="text-sm tracking-[0.18em] text-stamp uppercase">Waitlist</p>
      <h1 className="mt-6 max-w-4xl font-serif text-[clamp(3.1rem,8vw,6.5rem)] leading-[0.92] tracking-[-0.035em]">
        Your life is not a dataset.
      </h1>
      <p className="mt-8 max-w-xl text-lg leading-8 text-muted">
        Privacy is in progress. Leave an address and we will write once, when
        there is something you can actually use.
      </p>
      <WaitlistForm />
      <Link
        href="/app"
        className="mt-4 inline-flex h-12 items-center self-start border border-foreground px-5 text-foreground transition-colors hover:bg-foreground hover:text-background focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
      >
        Test the app
      </Link>
      <section className="mt-20 border-t border-line pt-10">
        <h2 className="max-w-xl font-serif text-3xl tracking-[-0.03em] md:text-4xl">
          Settle the deal. Keep the terms quiet.
        </h2>
        <p className="mt-4 max-w-xl leading-7 text-muted">
          Escrow, payroll, vesting, and subscriptions still have to settle. The size, the
          schedule, and both sides do not have to be public for that to happen.
        </p>
        <ul className="mt-8 border-t border-line">
          {PRODUCTS.map((product) => (
            <li
              key={product.name}
              className="grid gap-3 border-b border-line py-8 md:grid-cols-[24rem_1fr] md:gap-12"
            >
              <h3 className="font-serif text-3xl tracking-[-0.03em]">{product.name}</h3>
              <p className="max-w-xl self-center leading-7 text-muted">{product.pitch}</p>
            </li>
          ))}
        </ul>
      </section>
    </SiteFrame>
  );
}
