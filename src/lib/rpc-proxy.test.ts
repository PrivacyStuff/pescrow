import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  RPC_PROXY_MAX_BATCH,
  allowsRpcCaller,
  encodeJsonRpcCalls,
  parseJsonRpcBody,
  scrubRpcText,
} from "./rpc-proxy.ts";

describe("parseJsonRpcBody", () => {
  it("accepts a single call and a batch, and drops fields that are not JSON-RPC", () => {
    const single = parseJsonRpcBody({
      jsonrpc: "2.0",
      id: "3f66e649-266b-40f1-9a34-e97ec78b497f",
      method: "getLatestBlockhash",
      params: [{ commitment: "confirmed" }],
      url: "http://127.0.0.1:9/",
    });
    assert.equal(
      single === null ? null : encodeJsonRpcCalls(single),
      '{"jsonrpc":"2.0","id":"3f66e649-266b-40f1-9a34-e97ec78b497f","method":"getLatestBlockhash","params":[{"commitment":"confirmed"}]}',
    );

    const batch = parseJsonRpcBody([
      { jsonrpc: "2.0", id: 1, method: "getSlot" },
      { jsonrpc: "2.0", id: 2, method: "getMinimumBalanceForRentExemption", params: [165] },
    ]);
    assert.equal(batch?.batched, true);
    assert.equal(batch?.calls.length, 2);
    assert.equal(
      batch === null ? null : encodeJsonRpcCalls(batch),
      '[{"jsonrpc":"2.0","id":1,"method":"getSlot"},{"jsonrpc":"2.0","id":2,"method":"getMinimumBalanceForRentExemption","params":[165]}]',
    );
  });

  it("rejects a URL fetch, a bad method, and an oversized batch", () => {
    assert.equal(parseJsonRpcBody({ url: "https://example.com" }), null);
    assert.equal(parseJsonRpcBody({ jsonrpc: "2.0", id: 1, method: "https://example.com" }), null);
    assert.equal(parseJsonRpcBody({ jsonrpc: "2.0", id: 1, method: "getSlot", params: "nope" }), null);
    assert.equal(parseJsonRpcBody({ jsonrpc: "1.0", id: 1, method: "getSlot" }), null);
    assert.equal(parseJsonRpcBody([]), null);
    const oversized = Array.from({ length: RPC_PROXY_MAX_BATCH + 1 }, (_, index) => ({
      jsonrpc: "2.0",
      id: index,
      method: "getSlot",
    }));
    assert.equal(parseJsonRpcBody(oversized), null);
  });
});

describe("scrubRpcText", () => {
  it("removes an api key from error text", () => {
    assert.equal(
      scrubRpcText("devnet RPC https://devnet.helius-rpc.com/?api-key=abcd-1234 failed"),
      "devnet RPC https://devnet.helius-rpc.com/?api-key=REDACTED failed",
    );
    assert.equal(scrubRpcText("api-key%3Dsecret-value"), "api-key%3DREDACTED");
    assert.equal(scrubRpcText("Connection rate limits exceeded"), "Connection rate limits exceeded");
  });
});

describe("allowsRpcCaller", () => {
  it("allows same-origin and non-browser calls, and rejects a cross-site browser", () => {
    assert.equal(
      allowsRpcCaller({ origin: "http://localhost:3000", host: "localhost:3000", secFetchSite: "same-origin" }),
      true,
    );
    assert.equal(allowsRpcCaller({ origin: null, host: "localhost:3000", secFetchSite: null }), true);
    assert.equal(
      allowsRpcCaller({ origin: "https://evil.example", host: "localhost:3000", secFetchSite: "cross-site" }),
      false,
    );
    assert.equal(
      allowsRpcCaller({ origin: "https://evil.example", host: "localhost:3000", secFetchSite: null }),
      false,
    );
  });
});
