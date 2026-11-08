import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { SOL_MINT } from "./chunk-plan.ts";
import { readTerms, writeTerms } from "./escrow-terms.ts";

const ESCROW = "xUiK4RZz4JerbRzZjHVaBgaQM46A45eYhZ2uBMggNzY";
const TOKEN = "9EmMw4C6ZUjacxM4rPQhNVGmxkPJNiUTiymrY1zJNSzX";

const SOL_SIDE = { kind: "sol" as const, mint: SOL_MINT, amount: "10000000" };
const TOKEN_SIDE = { kind: "token" as const, mint: TOKEN, amount: "2000000000" };

describe("escrow terms file", () => {
  it("stores both sides for an escrow and keeps the file private", () => {
    const path = join(mkdtempSync(join(tmpdir(), "pescrow-terms-")), "escrow-terms.json");
    writeTerms(ESCROW, { a: SOL_SIDE, b: TOKEN_SIDE }, path);
    assert.deepEqual(readTerms(path)[ESCROW], { a: SOL_SIDE, b: TOKEN_SIDE });
    assert.equal(statSync(path).mode & 0o777, 0o600);
    chmodSync(path, 0o644);
    writeTerms(ESCROW, { a: { ...SOL_SIDE, amount: "30000000" }, b: TOKEN_SIDE }, path);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const saved = JSON.parse(readFileSync(path, "utf8")) as { [key: string]: { a: { amount: string } } };
    assert.equal(saved[ESCROW]?.a.amount, "30000000");
  });

  it("reads an older lamports row as SOL on both sides", () => {
    const path = join(mkdtempSync(join(tmpdir(), "pescrow-terms-")), "escrow-terms.json");
    writeFileSync(
      path,
      JSON.stringify({ [ESCROW]: { lockLamports: "10000000", receiveLamports: "20000000" } }),
    );
    assert.deepEqual(readTerms(path)[ESCROW], {
      a: { kind: "sol", mint: SOL_MINT, amount: "10000000" },
      b: { kind: "sol", mint: SOL_MINT, amount: "20000000" },
    });
  });

  it("keeps the opener shielded address and drops a corrupt one", () => {
    const path = join(mkdtempSync(join(tmpdir(), "pescrow-terms-")), "escrow-terms.json");
    const openerShield = "ab".repeat(32);
    writeTerms(ESCROW, { a: SOL_SIDE, b: TOKEN_SIDE, openerShield }, path);
    assert.equal(readTerms(path)[ESCROW]?.openerShield, openerShield);
    writeTerms(ESCROW, { a: { ...SOL_SIDE, amount: "30000000" }, b: TOKEN_SIDE }, path);
    assert.equal(readTerms(path)[ESCROW]?.openerShield, openerShield);
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    raw[ESCROW] = { a: SOL_SIDE, b: TOKEN_SIDE, openerShield: "zz" };
    writeFileSync(path, JSON.stringify(raw));
    assert.equal(readTerms(path)[ESCROW], undefined);
  });

  it("rejects a SOL amount above 1 SOL and ignores a corrupt row", () => {
    const path = join(mkdtempSync(join(tmpdir(), "pescrow-terms-")), "escrow-terms.json");
    assert.throws(() =>
      writeTerms(ESCROW, { a: { kind: "sol", mint: SOL_MINT, amount: "2000000000" }, b: SOL_SIDE }, path),
    );
    writeTerms(ESCROW, { a: { ...SOL_SIDE, amount: "1" }, b: { ...SOL_SIDE, amount: "2" } }, path);
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    raw.notanaddress = { a: SOL_SIDE, b: SOL_SIDE };
    raw[ESCROW] = { a: { kind: "sol", mint: SOL_MINT, amount: "nope" }, b: SOL_SIDE };
    writeFileSync(path, JSON.stringify(raw));
    assert.deepEqual(readTerms(path), {});
  });
});
