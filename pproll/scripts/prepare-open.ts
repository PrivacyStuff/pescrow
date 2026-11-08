import { PublicKey } from "@solana/web3.js";
import { preparePayroll, prepareVaultFor } from "./pool/prepare.ts";

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
const input: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
if (typeof input !== "object" || input === null) throw new Error("the prepare request is incomplete");
const record = input as Record<string, unknown>;
const result =
  record.action === "vault"
    ? await prepareVaultFor(new PublicKey(String(record.owner)))
    : await preparePayroll({
        payroll: String(record.payroll),
        payee: String(record.payee),
        payeeOwnerHash: String(record.payeeOwnerHash),
        installment: String(record.installment),
        budget: String(record.budget),
        startAt: String(record.startAt),
        periodSecs: String(record.periodSecs),
      });
process.stdout.write(`${JSON.stringify(result)}\n`);
