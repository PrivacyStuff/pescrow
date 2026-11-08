import { scrubPayrollError } from "../../src/lib/budget-deposit.ts";
import { NOT_READY_TO_CRANK } from "../../src/lib/payroll-roll.ts";
import { preparePay } from "./pool/payroll-move.ts";

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));

try {
  const input: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const result = await preparePay(input);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : NOT_READY_TO_CRANK;
  console.error(scrubPayrollError(message));
  process.exit(1);
}
