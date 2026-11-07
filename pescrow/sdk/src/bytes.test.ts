import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bytes32FromBase58 } from "./bytes.ts";

describe("bytes32FromBase58", () => {
  it("decodes a deposited note hash", () => {
    const bytes = bytes32FromBase58("drhZVxX33Td18MLS8f1ALeFCc6o5xACy6N2UgqRgJhH");
    assert.equal(bytes.byteLength, 32);
    assert.equal(
      Buffer.from(bytes).toString("hex"),
      "09711ab4e1b813a02679c9e187caad0f04bb52be22ee25dd35562131e2aec25c",
    );
  });

  it("rejects a short string", () => {
    assert.throws(() => bytes32FromBase58("1"), /32 bytes/);
  });
});
