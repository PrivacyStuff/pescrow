import { scrubPayrollError } from "../../src/lib/budget-deposit.ts";
import { prepareBudgetWithdraw } from "./pool/withdraw-note.ts";

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));

try {
  const input: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const result = await prepareBudgetWithdraw(input);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : "The budget withdraw could not be prepared.";
  console.error(scrubPayrollError(message));
  process.exit(1);
}
