import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  afterSigning,
  errorText,
  pendingCount,
  reduceTxLog,
  signatureOf,
  toastEntry,
  TOAST_LINGER_MS,
  TX_LOG_LIMIT,
  withoutSignatures,
  type TxEntry,
} from "./tx-log.ts";

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const COPY = { step: "Approve", explanation: "Records your approval." };

function base58(length: number): string {
  let out = "";
  while (out.length < length) out += BASE58;
  return out.slice(0, length);
}

function started(origin: "wallet" | "desk", id = 1): readonly TxEntry[] {
  return reduceTxLog([], { kind: "start", id, copy: COPY, origin, at: 1000 });
}

describe("reduceTxLog", () => {
  it("starts a wallet transaction waiting for the signature and a desk one confirming", () => {
    assert.equal(started("wallet")[0]?.status, "signing");
    assert.equal(started("desk")[0]?.status, "confirming");
  });

  it("moves a signed wallet transaction to confirming, then confirmed with its signature", () => {
    const signature = base58(88);
    const signed = reduceTxLog(started("wallet"), { kind: "signed", id: 1 });
    assert.equal(signed[0]?.status, "confirming");
    const done = reduceTxLog(signed, { kind: "confirmed", id: 1, signature, at: 2000 });
    assert.equal(done[0]?.status, "confirmed");
    assert.equal(done[0]?.signature, signature);
  });

  it("keeps the signature named in a failure so the failed transaction can be opened", () => {
    const signature = base58(87);
    const failed = reduceTxLog(started("wallet"), { kind: "failed", id: 1, error: `transaction ${signature} failed`, at: 2000 });
    assert.equal(failed[0]?.status, "failed");
    assert.equal(failed[0]?.signature, signature);
  });

  it("does not reopen a settled transaction", () => {
    const failed = reduceTxLog(started("desk"), { kind: "failed", id: 1, error: "rejected", at: 2000 });
    const late = reduceTxLog(failed, { kind: "confirmed", id: 1, signature: base58(88), at: 3000 });
    assert.equal(late[0]?.status, "failed");
    assert.equal(late[0]?.signature, null);
  });

  it("puts the newest first and keeps the log bounded", () => {
    let log: readonly TxEntry[] = [];
    for (let id = 0; id < TX_LOG_LIMIT + 5; id += 1) {
      log = reduceTxLog(log, { kind: "start", id, copy: COPY, origin: "desk", at: id });
    }
    assert.equal(log.length, TX_LOG_LIMIT);
    assert.equal(log[0]?.id, TX_LOG_LIMIT + 4);
  });

  it("clears settled rows and keeps the pending ones", () => {
    const two = reduceTxLog(started("desk", 1), { kind: "start", id: 2, copy: COPY, origin: "wallet", at: 2 });
    const settled = reduceTxLog(two, { kind: "confirmed", id: 1, signature: null, at: 3 });
    assert.equal(pendingCount(settled), 1);
    const cleared = reduceTxLog(settled, { kind: "clear-settled" });
    assert.deepEqual(cleared.map((entry) => entry.id), [2]);
  });
});

describe("signatureOf", () => {
  it("accepts only a lone transaction signature", () => {
    const signature = base58(88);
    assert.equal(signatureOf(signature), signature);
    assert.equal(signatureOf(`Shielded. ${signature}`), null);
    assert.equal(signatureOf(base58(44)), null);
    assert.equal(signatureOf(42), null);
  });
});

describe("toastEntry", () => {
  it("shows a pending transaction before a newer settled one", () => {
    const first = started("wallet", 1);
    const second = reduceTxLog(first, { kind: "start", id: 2, copy: COPY, origin: "desk", at: 1500 });
    const settled = reduceTxLog(second, { kind: "confirmed", id: 2, signature: null, at: 1600 });
    assert.equal(toastEntry(settled, 1700, null)?.id, 1);
  });

  it("lets a confirmed transaction linger, then hides it", () => {
    const done = reduceTxLog(started("desk"), { kind: "confirmed", id: 1, signature: null, at: 2000 });
    assert.equal(toastEntry(done, 2000 + TOAST_LINGER_MS - 1, null)?.id, 1);
    assert.equal(toastEntry(done, 2000 + TOAST_LINGER_MS, null), null);
  });

  it("keeps a failure up until it is dismissed", () => {
    const failed = reduceTxLog(started("desk"), { kind: "failed", id: 1, error: "rejected", at: 2000 });
    assert.equal(toastEntry(failed, 2000 + TOAST_LINGER_MS * 10, null)?.status, "failed");
    assert.equal(toastEntry(failed, 2001, 1), null);
  });
});

describe("withoutSignatures", () => {
  it("drops signatures and keeps the sentence and escrow links", () => {
    const signature = base58(88);
    const address = base58(44);
    assert.equal(withoutSignatures(`Shielded. ${signature}`), "Shielded.");
    assert.equal(withoutSignatures(`Closed. ${signature}. Returned 0.1 SOL.`), "Closed. Returned 0.1 SOL.");
    assert.equal(withoutSignatures(`Escrow ${address} is open. ${signature}`), `Escrow ${address} is open.`);
  });
});

describe("errorText", () => {
  it("falls back when the error carries no message and trims long ones", () => {
    assert.equal(errorText("nope", "The transaction failed."), "The transaction failed.");
    assert.equal(errorText(new Error("x".repeat(500)), "fallback").length, 241);
  });
});

describe("afterSigning", () => {
  it("reports the signature only once the signer resolves", async () => {
    let signed = 0;
    const sign = afterSigning(async (value: number) => value + 1, () => {
      signed += 1;
    });
    assert.equal(await sign(1), 2);
    assert.equal(signed, 1);
    const refused = afterSigning(async () => {
      throw new Error("User rejected");
    }, () => {
      signed += 1;
    });
    await assert.rejects(refused(undefined), /User rejected/);
    assert.equal(signed, 1);
  });
});
