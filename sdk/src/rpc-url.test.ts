import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { devnetRpcUrl } from "./rpc-url.ts";

describe("devnetRpcUrl", () => {
  it("puts the key only in the query", () => {
    const url = new URL(devnetRpcUrl("test-key"));
    assert.equal(url.origin, "https://devnet.helius-rpc.com");
    assert.equal(url.pathname, "/");
    assert.equal(url.searchParams.get("api-key"), "test-key");
  });

  it("rejects an empty key", () => {
    assert.throws(() => devnetRpcUrl(""), /empty/);
    assert.throws(() => devnetRpcUrl("test key"), /empty/);
  });
});
