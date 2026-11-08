import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stripProverStderr } from "./prover-stderr.ts";

const MODULE_WARNING = [
  "(node:4242) [MODULE_TYPELESS_PACKAGE_JSON] Warning: Module type of file:///home/biboux-esmail/privacy_stuff/src/lib/budget-deposit.ts is not specified and it doesn't parse as CommonJS.",
  'Reparsing as ES module because module syntax was detected. This incurs a performance overhead. To eliminate this warning, add "type": "module" to /home/biboux-esmail/privacy_stuff/package.json. (Use `node --trace-warnings ...` to show where the warning was created)',
].join(" ");

describe("stripProverStderr", () => {
  it("drops the module-type warning and TRANSACTION_PROGRAM_BUILD and keeps a program error", () => {
    const stderr = [
      MODULE_WARNING,
      "using deprecated parameters for the initialization function; pass a single object instead",
      "TRANSACTION_PROGRAM_BUILD",
      "custom program error: 0x1b60",
    ].join("\n");
    assert.equal(stripProverStderr(stderr), "custom program error: 0x1b60");
  });

  it("drops the warning when Node's prefix was sliced off the same line as the deprecation", () => {
    const sliced =
      'file:///home/biboux-esmail/privacy_stuff/src/lib/budget-deposit.ts is not specified and it doesn\'t parse as CommonJS. Reparsing as ES module because module syntax was detected. To eliminate this warning, add "type": "module" to /home/biboux-esmail/privacy_stuff/package.json. (Use `node --trace-warnings ...` to show where the warning was created) using deprecated parameters for the initialization function; pass a single object instead TRANSACTION_PROGRAM_BUILD';
    assert.equal(stripProverStderr(sliced), "");
    assert.equal(stripProverStderr(`${sliced} custom program error: 0x1b60`), "custom program error: 0x1b60");
  });
});
