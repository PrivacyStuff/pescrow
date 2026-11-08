import { parseBudgetKeyRecord, viewingKeyBelongsTo, type BudgetAction, type BudgetKeyChoice, type BudgetVaultListing } from "./budget-deposit.ts";

/** One budget per token. Each budget has its own viewing key, so every key this browser made is kept. */
export type BudgetKeyRecord = BudgetKeyChoice & {
  readonly vault: string;
  /** Mint of the note put in this budget. Null until a deposit from this browser records it. */
  readonly mint: string | null;
};

const MAX_BUDGET_KEYS = 32;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Reads the stored list. A single record from before several budgets is read as a list of one. */
export function parseBudgetKeyList(value: unknown): BudgetKeyRecord[] {
  const rows = Array.isArray(value) ? value.slice(0, MAX_BUDGET_KEYS) : [value];
  const out: BudgetKeyRecord[] = [];
  for (const row of rows) {
    const key = parseBudgetKeyRecord(row);
    if (key === null || key.vault === null) continue;
    if (out.some((entry) => entry.vault === key.vault)) continue;
    out.push({ ...key, vault: key.vault, mint: recordMint(row) });
  }
  return out;
}

/** Adds or replaces the key of one budget. The keys of the other budgets stay. */
export function rememberBudget(list: readonly BudgetKeyRecord[], record: BudgetKeyRecord): BudgetKeyRecord[] {
  return [...list.filter((entry) => entry.vault !== record.vault), record].slice(-MAX_BUDGET_KEYS);
}

export function withBudgetMint(list: readonly BudgetKeyRecord[], vault: string, mint: string): BudgetKeyRecord[] {
  return list.map((entry) => (entry.vault === vault ? { ...entry, mint } : entry));
}

export function budgetKeyFor(list: readonly BudgetKeyRecord[], vault: string): BudgetKeyRecord | null {
  return list.find((entry) => entry.vault === vault) ?? null;
}

/**
 * Deposit into an empty budget this browser holds the key for. A budget opened
 * but not yet listed by the RPC counts as empty. A key stored for another vault
 * is refused while a different empty budget is listed, and the message names
 * that vault. When every keyed budget already holds a note, another budget may
 * be opened for another token.
 */
export function chooseBudgetSlot(vaults: readonly BudgetVaultListing[], list: readonly BudgetKeyRecord[]): BudgetAction {
  let foreign: BudgetKeyRecord | null = null;
  for (const key of list) {
    const listed = vaults.find((vault) => vault.address === key.vault);
    if (listed !== undefined && !listed.funded) {
      return { action: "deposit", vault: key.vault, viewingSecretHex: key.viewingSecretHex, ownerHashHex: key.ownerHashHex };
    }
    if (listed !== undefined) continue;
    if (foreign === null) foreign = key;
  }
  const emptyListed = vaults.some((vault) => !vault.funded);
  if (foreign !== null && emptyListed) return { action: "refuse", message: viewingKeyBelongsTo(foreign.vault) };
  if (foreign !== null) {
    return {
      action: "deposit",
      vault: foreign.vault,
      viewingSecretHex: foreign.viewingSecretHex,
      ownerHashHex: foreign.ownerHashHex,
    };
  }
  return { action: "open" };
}

/**
 * The funded budget a payroll in `mint` draws from. The initiate proof does not
 * bind the mint, so a budget holding another token must not be picked.
 * A funded budget with no recorded mint is used only when it is the only one.
 */
export function fundingBudget(
  vaults: readonly BudgetVaultListing[],
  list: readonly BudgetKeyRecord[],
  mint: string | null,
): BudgetKeyRecord | null {
  const funded = list.filter((key) => vaults.some((vault) => vault.address === key.vault && vault.funded));
  if (mint !== null) {
    const matched = funded.find((key) => key.mint === mint);
    if (matched !== undefined) return matched;
  }
  const unknown = funded.filter((key) => key.mint === null);
  return funded.length === 1 && unknown.length === 1 ? (unknown[0] ?? null) : null;
}

function recordMint(row: unknown): string | null {
  if (typeof row !== "object" || row === null) return null;
  const mint = (row as Record<string, unknown>).mint;
  return typeof mint === "string" && BASE58.test(mint) ? mint : null;
}
