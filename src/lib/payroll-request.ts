const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const TX_MIN = 32;
const TX_MAX = 20_000;

const HASH = /^[0-9a-f]{64}$/i;
const AMOUNT = /^\d{1,20}$/;
const ZERO_OWNER = "00".repeat(32);

export type PayrollOpenRequest = {
  readonly action: "prepare-payroll";
  readonly payroll: string;
  readonly payee: string;
  readonly payeeOwnerHash: string;
  readonly installment: string;
  readonly budget: string;
  readonly startAt: string;
  readonly periodSecs: string;
};

export type PayrollInitiateRequest = {
  readonly action: "prepare-initiate";
  readonly owner: string;
  readonly payroll: string;
  readonly vault: string;
  readonly viewingSecret: string;
  readonly budgetViewingSecret: string;
  readonly budgetAmount: string;
  readonly budgetBlinding: string;
};

export type PayrollPayRequest = {
  readonly action: "prepare-pay";
  readonly owner: string;
  readonly payroll: string;
  readonly seed: string;
  readonly viewingSecret: string;
  readonly installmentAmount: string;
  readonly installmentBlinding: string;
};

export type PayrollDepositRequest = {
  readonly action: "prepare-deposit";
  readonly owner: string;
  readonly vault: string;
  readonly note: string;
  readonly seed: string;
  readonly viewingSecret: string;
  readonly ownerHash: string;
};

export type PayrollWithdrawRequest = {
  readonly action: "prepare-withdraw";
  readonly owner: string;
  readonly vault: string;
  readonly seed: string;
  readonly viewingSecret: string;
  readonly ownerHash: string;
};

export type PayrollRequest =
  | { readonly action: "wallet-payrolls" | "wallet-budget"; readonly wallet: string }
  | { readonly action: "wallet-submit"; readonly tx: string }
  | { readonly action: "prepare-vault"; readonly owner: string }
  | PayrollDepositRequest
  | PayrollWithdrawRequest
  | PayrollInitiateRequest
  | PayrollPayRequest
  | PayrollOpenRequest;

export function parsePayrollRequest(value: unknown): PayrollRequest | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record.action === "wallet-payrolls" || record.action === "wallet-budget") {
    return typeof record.wallet === "string" && BASE58.test(record.wallet)
      ? { action: record.action, wallet: record.wallet }
      : null;
  }
  if (record.action === "prepare-vault") {
    return pubkey(record.owner) ? { action: record.action, owner: record.owner } : null;
  }
  if (record.action === "prepare-payroll") return parseOpen(record);
  if (record.action === "prepare-deposit") return parseDeposit(record);
  if (record.action === "prepare-initiate") return parseInitiate(record);
  if (record.action === "prepare-pay") return parsePay(record);
  if (record.action === "prepare-withdraw") return parseWithdraw(record);
  if (record.action === "wallet-submit") {
    if (typeof record.tx !== "string" || record.tx.length < TX_MIN || record.tx.length > TX_MAX) return null;
    if (!/^[A-Za-z0-9+/=]+$/.test(record.tx)) return null;
    return { action: record.action, tx: record.tx };
  }
  return null;
}

function parseOpen(record: Record<string, unknown>): PayrollOpenRequest | null {
  if (!pubkey(record.payroll) || !pubkey(record.payee)) return null;
  const payeeOwnerHash = ownerHash(record.payeeOwnerHash);
  if (payeeOwnerHash === null) return null;
  if (!amount(record.installment) || !amount(record.budget)) return null;
  if (!amount(record.startAt) || !amount(record.periodSecs)) return null;
  if (record.installment === "0" || record.budget === "0" || record.periodSecs === "0" || record.startAt === "0") return null;
  return {
    action: "prepare-payroll",
    payroll: record.payroll,
    payee: record.payee,
    payeeOwnerHash,
    installment: record.installment,
    budget: record.budget,
    startAt: record.startAt,
    periodSecs: record.periodSecs,
  };
}

function parseWithdraw(record: Record<string, unknown>): PayrollWithdrawRequest | null {
  if (!pubkey(record.owner) || !pubkey(record.vault)) return null;
  const seed = hex32(record.seed);
  const viewingSecret = hex32(record.viewingSecret);
  const ownerHashHex = hex32(record.ownerHash);
  if (seed === null || viewingSecret === null || ownerHashHex === null) return null;
  return {
    action: "prepare-withdraw",
    owner: record.owner,
    vault: record.vault,
    seed,
    viewingSecret,
    ownerHash: ownerHashHex,
  };
}

function parseDeposit(record: Record<string, unknown>): PayrollDepositRequest | null {
  if (!pubkey(record.owner) || !pubkey(record.vault) || !pubkey(record.note)) return null;
  const seed = hex32(record.seed);
  const viewingSecret = hex32(record.viewingSecret);
  const ownerHashHex = hex32(record.ownerHash);
  if (seed === null || viewingSecret === null || ownerHashHex === null) return null;
  return {
    action: "prepare-deposit",
    owner: record.owner,
    vault: record.vault,
    note: record.note,
    seed,
    viewingSecret,
    ownerHash: ownerHashHex,
  };
}

function parseInitiate(record: Record<string, unknown>): PayrollInitiateRequest | null {
  if (!pubkey(record.owner) || !pubkey(record.payroll) || !pubkey(record.vault)) return null;
  const viewingSecret = hex32(record.viewingSecret);
  const budgetViewingSecret = hex32(record.budgetViewingSecret);
  const budgetBlinding = hex32(record.budgetBlinding);
  if (viewingSecret === null || budgetViewingSecret === null || budgetBlinding === null) return null;
  if (!amount(record.budgetAmount) || record.budgetAmount === "0") return null;
  return {
    action: "prepare-initiate",
    owner: record.owner,
    payroll: record.payroll,
    vault: record.vault,
    viewingSecret,
    budgetViewingSecret,
    budgetAmount: record.budgetAmount,
    budgetBlinding,
  };
}

function parsePay(record: Record<string, unknown>): PayrollPayRequest | null {
  if (!pubkey(record.owner) || !pubkey(record.payroll)) return null;
  const seed = hex32(record.seed);
  const viewingSecret = hex32(record.viewingSecret);
  const installmentBlinding = hex32(record.installmentBlinding);
  if (seed === null || viewingSecret === null || installmentBlinding === null) return null;
  if (!amount(record.installmentAmount) || record.installmentAmount === "0") return null;
  return {
    action: "prepare-pay",
    owner: record.owner,
    payroll: record.payroll,
    seed,
    viewingSecret,
    installmentAmount: record.installmentAmount,
    installmentBlinding,
  };
}

function hex32(value: unknown): string | null {
  if (typeof value !== "string" || !HASH.test(value)) return null;
  return value.toLowerCase();
}

function ownerHash(value: unknown): string | null {
  if (value === undefined || value === "") return ZERO_OWNER;
  if (typeof value !== "string" || !HASH.test(value)) return null;
  return value.toLowerCase();
}

function pubkey(value: unknown): value is string {
  return typeof value === "string" && BASE58.test(value);
}

function amount(value: unknown): value is string {
  return typeof value === "string" && AMOUNT.test(value);
}
