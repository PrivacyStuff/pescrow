import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { readTerms, writeTerms } from "./escrow-terms.ts";

const ESCROW = "xUiK4RZz4JerbRzZjHVaBgaQM46A45eYhZ2uBMggNzY";

describe("escrow terms file", () => {
  it("stores both amounts for an escrow and keeps the file private", () => {
    const path = join(mkdtempSync(join(tmpdir(), "pescrow-terms-")), "escrow-terms.json");
    writeTerms(ESCROW, { lockLamports: "10000000", receiveLamports: "20000000" }, path);
    assert.deepEqual(readTerms(path)[ESCROW], { lockLamports: "10000000", receiveLamports: "20000000" });
    assert.equal(statSync(path).mode & 0o777, 0o600);
    chmodSync(path, 0o644);
    writeTerms(ESCROW, { lockLamports: "30000000", receiveLamports: "40000000" }, path);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const saved = JSON.parse(readFileSync(path, "utf8")) as { [key: string]: { lockLamports: string } };
    assert.equal(saved[ESCROW]?.lockLamports, "30000000");
  });

  it("rejects an amount above 1 SOL and ignores a corrupt row", () => {
    const path = join(mkdtempSync(join(tmpdir(), "pescrow-terms-")), "escrow-terms.json");
    assert.throws(() => writeTerms(ESCROW, { lockLamports: "2000000000", receiveLamports: "1" }, path));
    writeTerms(ESCROW, { lockLamports: "1", receiveLamports: "2" }, path);
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    raw.notanaddress = { lockLamports: "1", receiveLamports: "2" };
    raw[ESCROW] = { lockLamports: "nope", receiveLamports: "1" };
    writeFileSync(path, JSON.stringify(raw));
    assert.deepEqual(readTerms(path), {});
  });
});
