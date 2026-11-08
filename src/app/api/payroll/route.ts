import { spawn } from "node:child_process";
import { join } from "node:path";
import { parsePreparedDeposit, scrubPayrollError, vaultDepositRefusal } from "@/lib/budget-deposit";
import { stripProverStderr } from "@/lib/prover-stderr";
import { BUDGET_HAS_NO_NOTE, BUDGET_KEY_NOT_IN_BROWSER, parsePreparedWithdraw, vaultWithdrawRefusal } from "@/lib/budget-close";
import { decodeBase58 } from "@/lib/escrow-account";
import { helius } from "@/lib/helius-rpc";
import {
  PAYROLL_ACCOUNT_LEN,
  PPROLL_PROGRAM_ID,
  STREAM_ACCOUNT_LEN,
  VAULT_ACCOUNT_LEN,
  decodePayroll,
  decodeVault,
  type PayrollView,
  type VaultView,
} from "@/lib/payroll-account";
import { parsePayrollRequest, type PayrollDepositRequest, type PayrollInitiateRequest, type PayrollOpenRequest, type PayrollPayRequest, type PayrollWithdrawRequest } from "@/lib/payroll-request";
import {
  BUDGET_NOTE_TOO_SMALL,
  MILESTONE_NOT_DUE,
  MISSING_PAYROLL_KEY,
  NOT_READY_TO_CRANK,
  NOT_READY_TO_FUND,
  PAYROLL_NOTE_MISSING,
  PAYROLL_NOT_FUNDED,
  PUT_NOTE_IN_BUDGET,
  WRONG_SHIELDED_OWNER,
  parsePreparedRoll,
} from "@/lib/payroll-roll";

export const maxDuration = 300;

const CONFIRM_ATTEMPTS = 30;
const CONFIRM_WAIT_MS = 1_000;
const PARTY_OFFSETS = [32, 64] as const;
const ACCOUNT_LENGTHS = [STREAM_ACCOUNT_LEN, PAYROLL_ACCOUNT_LEN] as const;
const VAULT_OWNER_OFFSET = 8;
const PREPARE_MS = 90_000;
const DEPOSIT_MS = 240_000;
const WITHDRAW_MS = 240_000;
const ROLL_MS = 240_000;
const PPROLL_DIR = join(process.cwd(), "pproll");
const CLIENT_ERRORS = new Set([
  "This browser does not have the budget viewing key.",
  "The budget already holds a note.",
  "That note is not in the private balance.",
  "The budget account is not a vault.",
  "The budget belongs to another wallet.",
  BUDGET_KEY_NOT_IN_BROWSER,
  BUDGET_HAS_NO_NOTE,
  MISSING_PAYROLL_KEY,
  PUT_NOTE_IN_BUDGET,
  MILESTONE_NOT_DUE,
  BUDGET_NOTE_TOO_SMALL,
  PAYROLL_NOTE_MISSING,
  WRONG_SHIELDED_OWNER,
  NOT_READY_TO_FUND,
  NOT_READY_TO_CRANK,
  PAYROLL_NOT_FUNDED,
]);

type ProgramAccount = { pubkey: string; account: { data: [string, string] } };

function scrub(text: string): string {
  return scrubPayrollError(text);
}

async function listPayrolls(wallet: string): Promise<{ payrolls: PayrollView[] }> {
  const walletBytes = decodeBase58(wallet);
  if (walletBytes === null) throw new Error("wallet address is not a public key");
  const calls = ACCOUNT_LENGTHS.flatMap((dataSize) =>
    PARTY_OFFSETS.map((offset) =>
      helius<ProgramAccount[]>("getProgramAccounts", [
        PPROLL_PROGRAM_ID,
        {
          encoding: "base64",
          commitment: "confirmed",
          filters: [
            { dataSize },
            { memcmp: { offset, bytes: wallet } },
          ],
        },
      ]),
    ),
  );
  const batches = await Promise.all(calls);
  const seen = new Set<string>();
  const payrolls: PayrollView[] = [];
  for (const batch of batches) {
    for (const row of batch) {
      if (seen.has(row.pubkey)) continue;
      seen.add(row.pubkey);
      const view = decodePayroll(row.pubkey, Buffer.from(row.account.data[0], "base64"), walletBytes);
      if (view !== null) payrolls.push(view);
    }
  }
  return { payrolls };
}

async function listBudgets(wallet: string): Promise<{ budgets: VaultView[] }> {
  const walletBytes = decodeBase58(wallet);
  if (walletBytes === null) throw new Error("wallet address is not a public key");
  const rows = await helius<ProgramAccount[]>("getProgramAccounts", [
    PPROLL_PROGRAM_ID,
    {
      encoding: "base64",
      commitment: "confirmed",
      filters: [
        { dataSize: VAULT_ACCOUNT_LEN },
        { memcmp: { offset: VAULT_OWNER_OFFSET, bytes: wallet } },
      ],
    },
  ]);
  const budgets: VaultView[] = [];
  for (const row of rows) {
    const view = decodeVault(row.pubkey, Buffer.from(row.account.data[0], "base64"), walletBytes);
    if (view !== null) budgets.push(view);
  }
  return { budgets };
}

function runScript(script: string, body: Record<string, string>, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--experimental-strip-types", script], {
      cwd: PPROLL_DIR,
      timeout: timeoutMs,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      const line = stripProverStderr(stdout).trim().split("\n").findLast((entry) => entry.startsWith("{"));
      const shown = scrub(stderr).trim();
      if (line !== undefined && (code === 0 || shown.length === 0)) {
        try {
          resolve(JSON.parse(line));
          return;
        } catch {
          reject(new Error("The payroll terms could not be prepared."));
          return;
        }
      }
      reject(new Error((shown.length > 0 ? shown : "The payroll terms could not be prepared.").slice(-500)));
    });
    child.stdin.end(JSON.stringify(body));
  });
}

function prepare(body: Record<string, string>): Promise<unknown> {
  return runScript("scripts/prepare-open.ts", body, PREPARE_MS);
}

async function prepareDeposit(request: PayrollDepositRequest): Promise<unknown> {
  const owner = decodeBase58(request.owner);
  if (owner === null) throw new Error("The budget belongs to another wallet.");
  const info = await helius<{ value: { data?: [string, string] } | null }>("getAccountInfo", [
    request.vault,
    { encoding: "base64", commitment: "confirmed" },
  ]);
  const encoded = info.value?.data?.[0];
  const data = typeof encoded === "string" ? Buffer.from(encoded, "base64") : new Uint8Array();
  const refusal = vaultDepositRefusal(data, owner, request.ownerHash);
  if (refusal !== null) throw new Error(refusal);
  const prepared = parsePreparedDeposit(
    await runScript(
    "scripts/prepare-deposit.ts",
    {
      owner: request.owner,
      vault: request.vault,
      note: request.note,
      seed: request.seed,
      viewingSecret: request.viewingSecret,
      ownerHash: request.ownerHash,
    },
    DEPOSIT_MS,
    ),
  );
  if (prepared === null) throw new Error("The budget deposit could not be prepared.");
  return prepared;
}

async function prepareWithdraw(request: PayrollWithdrawRequest): Promise<unknown> {
  const owner = decodeBase58(request.owner);
  if (owner === null) throw new Error("The budget belongs to another wallet.");
  const info = await helius<{ value: { data?: [string, string] } | null }>("getAccountInfo", [
    request.vault,
    { encoding: "base64", commitment: "confirmed" },
  ]);
  const encoded = info.value?.data?.[0];
  const data = typeof encoded === "string" ? Buffer.from(encoded, "base64") : new Uint8Array();
  const refusal = vaultWithdrawRefusal(data, owner, request.ownerHash);
  if (refusal !== null) throw new Error(refusal);
  const prepared = parsePreparedWithdraw(
    await runScript(
      "scripts/prepare-withdraw.ts",
      {
        owner: request.owner,
        vault: request.vault,
        seed: request.seed,
        viewingSecret: request.viewingSecret,
        ownerHash: request.ownerHash,
      },
      WITHDRAW_MS,
    ),
  );
  if (prepared === null) throw new Error("The budget withdraw could not be prepared.");
  return prepared;
}

async function prepareInitiate(request: PayrollInitiateRequest): Promise<unknown> {
  const prepared = parsePreparedRoll(
    await runScript(
      "scripts/prepare-initiate.ts",
      {
        owner: request.owner,
        payroll: request.payroll,
        vault: request.vault,
        viewingSecret: request.viewingSecret,
        budgetViewingSecret: request.budgetViewingSecret,
        budgetAmount: request.budgetAmount,
        budgetBlinding: request.budgetBlinding,
      },
      ROLL_MS,
    ),
  );
  if (prepared === null) throw new Error(NOT_READY_TO_FUND);
  return prepared;
}

async function preparePay(request: PayrollPayRequest): Promise<unknown> {
  const prepared = parsePreparedRoll(
    await runScript(
      "scripts/prepare-pay.ts",
      {
        owner: request.owner,
        payroll: request.payroll,
        seed: request.seed,
        viewingSecret: request.viewingSecret,
        installmentAmount: request.installmentAmount,
        installmentBlinding: request.installmentBlinding,
      },
      ROLL_MS,
    ),
  );
  if (prepared === null) throw new Error(NOT_READY_TO_CRANK);
  return prepared;
}

function openBody(request: PayrollOpenRequest): Record<string, string> {
  return {
    action: "payroll",
    payroll: request.payroll,
    payee: request.payee,
    payeeOwnerHash: request.payeeOwnerHash,
    installment: request.installment,
    budget: request.budget,
    startAt: request.startAt,
    periodSecs: request.periodSecs,
  };
}

async function submitTransaction(tx: string): Promise<{ signature: string }> {
  const signature = await helius<string>("sendTransaction", [
    tx,
    { encoding: "base64", preflightCommitment: "confirmed" },
  ]);
  for (let attempt = 0; attempt < CONFIRM_ATTEMPTS; attempt += 1) {
    const status = await helius<{ value: ({ err: unknown; confirmationStatus?: string } | null)[] }>("getSignatureStatuses", [
      [signature],
      { searchTransactionHistory: true },
    ]);
    const row = status.value[0];
    if (row?.err) throw new Error(`transaction ${signature} failed`);
    if (row?.confirmationStatus === "confirmed" || row?.confirmationStatus === "finalized") return { signature };
    await new Promise((resolve) => setTimeout(resolve, CONFIRM_WAIT_MS));
  }
  throw new Error(`transaction ${signature} was not confirmed`);
}

export async function POST(request: Request) {
  const headers = { "cache-control": "no-store" };
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: "The request could not be read." }, { status: 400, headers });
  }
  const parsed = parsePayrollRequest(body);
  if (parsed === null) {
    return Response.json({ ok: false, error: "The payroll request is incomplete." }, { status: 400, headers });
  }
  try {
    if (parsed.action === "wallet-payrolls") {
      return Response.json({ ok: true, result: await listPayrolls(parsed.wallet) }, { headers });
    }
    if (parsed.action === "wallet-budget") {
      return Response.json({ ok: true, result: await listBudgets(parsed.wallet) }, { headers });
    }
    if (parsed.action === "prepare-vault") {
      return Response.json({ ok: true, result: await prepare({ action: "vault", owner: parsed.owner }) }, { headers });
    }
    if (parsed.action === "prepare-payroll") {
      return Response.json({ ok: true, result: await prepare(openBody(parsed)) }, { headers });
    }
    if (parsed.action === "prepare-deposit") {
      return Response.json({ ok: true, result: await prepareDeposit(parsed) }, { headers });
    }
    if (parsed.action === "prepare-withdraw") {
      return Response.json({ ok: true, result: await prepareWithdraw(parsed) }, { headers });
    }
    if (parsed.action === "prepare-initiate") {
      return Response.json({ ok: true, result: await prepareInitiate(parsed) }, { headers });
    }
    if (parsed.action === "prepare-pay") {
      return Response.json({ ok: true, result: await preparePay(parsed) }, { headers });
    }
    if (parsed.action === "wallet-submit") {
      return Response.json({ ok: true, result: await submitTransaction(parsed.tx) }, { headers });
    }
    return Response.json({ ok: false, error: "The payroll request is incomplete." }, { status: 400, headers });
  } catch (error) {
    const message = scrub(error instanceof Error ? error.message : "The payroll request failed.");
    const status = CLIENT_ERRORS.has(message) ? 400 : 500;
    return Response.json({ ok: false, error: message }, { status, headers });
  }
}
