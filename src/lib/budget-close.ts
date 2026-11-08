import {
  DEPOSIT_COMPUTE_UNIT_LIMIT,
  LOOKUP_ADDRESS_LIMIT,
  VAULT_NOT_FOUND,
  VAULT_WRONG_OWNER,
  parsePreparedVaultMove,
  type BudgetKeyChoice,
  type BudgetVaultListing,
  type PreparedDeposit,
} from "./budget-deposit.ts";
import { PPROLL_PROGRAM_ID } from "./payroll-account.ts";

export const WITHDRAW_IX = 9;
export const BUDGET_KEY_NOT_IN_BROWSER = "The viewing key is not in this browser.";
export const EMPTY_BUDGET_STAYS = "An empty budget stays on chain because the program has no close.";
export const BUDGET_HAS_NO_NOTE = "The budget has no shielded note.";

/**
 * Instruction 6 closes a stream account. Withdraw sets the vault live byte to empty
 * and leaves the 112-byte account in place. Nothing returns that rent.
 */
export const PROGRAM_CLOSES_EMPTY_VAULT = false;

const VAULT_LEN = 112;
const VAULT_TAG = 4;
const VAULT_LIVE_NOTE = 1;
const VAULT_OFF_LIVE = 1;
const VAULT_OFF_OWNER = 8;
const VAULT_OFF_HASH = 40;
const HASH_LEN = 32;
const VIEWING_SECRET = /^[0-9a-f]{64}$/i;

export type CloseBudgetChoice =
  | {
      readonly action: "withdraw";
      readonly vault: string;
      readonly viewingSecretHex: string;
      readonly ownerHashHex: string;
    }
  | { readonly action: "close"; readonly vault: string }
  | { readonly action: "stop"; readonly message: string }
  | { readonly action: "stay"; readonly message: string };

/**
 * A funded vault with this browser's viewing key withdraws the note.
 * A funded vault without that key stops.
 * An empty vault closes only when the program can return its rent.
 */
export function chooseCloseBudget(
  vault: BudgetVaultListing,
  key: BudgetKeyChoice | null,
  programClosesEmptyVault: boolean = PROGRAM_CLOSES_EMPTY_VAULT,
): CloseBudgetChoice {
  if (vault.funded) {
    const usable = keyForVault(vault.address, key);
    if (usable === null) return { action: "stop", message: BUDGET_KEY_NOT_IN_BROWSER };
    return {
      action: "withdraw",
      vault: vault.address,
      viewingSecretHex: usable.viewingSecretHex,
      ownerHashHex: usable.ownerHashHex,
    };
  }
  if (programClosesEmptyVault) return { action: "close", vault: vault.address };
  return { action: "stay", message: EMPTY_BUDGET_STAYS };
}

/** The desk offers the actions this build can send. An account close is not one of them. */
export function budgetCloseOffer(vault: BudgetVaultListing, key: BudgetKeyChoice | null): Exclude<CloseBudgetChoice, { action: "close" }> {
  const choice = chooseCloseBudget(vault, key, PROGRAM_CLOSES_EMPTY_VAULT);
  if (choice.action === "close") return { action: "stay", message: EMPTY_BUDGET_STAYS };
  return choice;
}

export function vaultWithdrawRefusal(data: Uint8Array, owner: Uint8Array, ownerHashHex: string): string | null {
  if (data.length !== VAULT_LEN || data[0] !== VAULT_TAG) return VAULT_NOT_FOUND;
  if (owner.length !== HASH_LEN || !equalAt(data, VAULT_OFF_OWNER, owner)) return VAULT_WRONG_OWNER;
  if (data[VAULT_OFF_LIVE] !== VAULT_LIVE_NOTE) return BUDGET_HAS_NO_NOTE;
  if (!VIEWING_SECRET.test(ownerHashHex) || readHex(data, VAULT_OFF_HASH, HASH_LEN) !== ownerHashHex.toLowerCase()) {
    return BUDGET_KEY_NOT_IN_BROWSER;
  }
  return null;
}

export function parsePreparedWithdraw(value: unknown): PreparedDeposit | null {
  const prepared = parsePreparedVaultMove(value, WITHDRAW_IX);
  if (prepared === null) return null;
  if (prepared.computeUnitLimit !== DEPOSIT_COMPUTE_UNIT_LIMIT) return null;
  if (prepared.programId !== PPROLL_PROGRAM_ID) return null;
  if (prepared.lookupAddresses.length === 0 || prepared.lookupAddresses.length > LOOKUP_ADDRESS_LIMIT) return null;
  return prepared;
}

function keyForVault(address: string, key: BudgetKeyChoice | null): BudgetKeyChoice | null {
  if (key === null || key.vault !== address) return null;
  if (!VIEWING_SECRET.test(key.viewingSecretHex) || !VIEWING_SECRET.test(key.ownerHashHex)) return null;
  return {
    viewingSecretHex: key.viewingSecretHex.toLowerCase(),
    ownerHashHex: key.ownerHashHex.toLowerCase(),
    vault: address,
  };
}

function equalAt(data: Uint8Array, offset: number, bytes: Uint8Array): boolean {
  if (offset < 0 || offset + bytes.length > data.length) return false;
  for (let index = 0; index < bytes.length; index += 1) {
    if (data[offset + index] !== bytes[index]) return false;
  }
  return true;
}

function readHex(data: Uint8Array, offset: number, length: number): string {
  let hex = "";
  for (let index = 0; index < length; index += 1) {
    hex += (data[offset + index] ?? 0).toString(16).padStart(2, "0");
  }
  return hex;
}
