export const APP_HOST = "app.privacy-stuff.vercel.app";

export const PRODUCTS = [
  {
    id: "pescrow",
    title: "private - escrow (pescrow)",
    href: "/pescrow",
    ready: true,
    summary: "Two wallets, one private exchange. Connect and open an escrow.",
  },
  {
    id: "pproll",
    title: "private - payroll (pproll)",
    href: "/pproll",
    ready: true,
    summary: "One salary, one destinataire. See what you issued and what you receive.",
  },
  {
    id: "psubscription",
    title: "private - subscription (psub)",
    href: "/psubscription",
    ready: false,
    summary: "A charge that opens again each period.",
  },
  {
    id: "pvesting",
    title: "private vesting (pesting)",
    href: "/pvesting",
    ready: false,
    summary: "A grant that unlocks on a schedule.",
  },
] as const;

export type ProductId = (typeof PRODUCTS)[number]["id"];

export function product(id: ProductId) {
  const found = PRODUCTS.find((item) => item.id === id);
  if (found === undefined) throw new Error(`missing product ${id}`);
  return found;
}
