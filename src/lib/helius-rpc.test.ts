import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { heliusRpcUrl } from "./helius-rpc.ts";

const RPC_URL_ENV = "HELIUS_RPC_URL";
const API_KEY_ENV = "HELIUS_API_KEY";
const FIXTURE_KEY = "00000000-0000-4000-8000-000000000000";
const OTHER_KEY = "11111111-1111-4111-8111-111111111111";
const FIXTURE_URL = `https://devnet.helius-rpc.com/?api-key=${FIXTURE_KEY}`;
const FALLBACK_URL = `https://devnet.helius-rpc.com/?api-key=${OTHER_KEY}`;
const SELECTION_MISMATCH = "RPC URL selection did not match the fixture";

const previous = {
  url: process.env[RPC_URL_ENV],
  key: process.env[API_KEY_ENV],
};

afterEach(() => {
  restore(RPC_URL_ENV, previous.url);
  restore(API_KEY_ENV, previous.key);
});

describe("heliusRpcUrl", () => {
  it("uses the full HELIUS_RPC_URL and ignores HELIUS_API_KEY", () => {
    setEnv(RPC_URL_ENV, `  ${FIXTURE_URL}  `);
    setEnv(API_KEY_ENV, OTHER_KEY);
    assert.equal(heliusRpcUrl() === FIXTURE_URL, true, SELECTION_MISMATCH);
  });

  it("builds the devnet URL from HELIUS_API_KEY when HELIUS_RPC_URL is unset or empty", () => {
    setEnv(RPC_URL_ENV, undefined);
    setEnv(API_KEY_ENV, OTHER_KEY);
    assert.equal(heliusRpcUrl() === FALLBACK_URL, true, SELECTION_MISMATCH);

    setEnv(RPC_URL_ENV, "   ");
    assert.equal(heliusRpcUrl() === FALLBACK_URL, true, SELECTION_MISMATCH);
  });

  it("rejects a non-https URL without falling back or echoing the value", () => {
    setEnv(RPC_URL_ENV, `http://devnet.helius-rpc.com/?api-key=${FIXTURE_KEY}`);
    setEnv(API_KEY_ENV, OTHER_KEY);
    assert.throws(
      () => heliusRpcUrl(),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message.includes(FIXTURE_KEY), false);
        assert.equal(error.message.includes("api-key"), false);
        return true;
      },
    );
  });
});

function setEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function restore(name: string, value: string | undefined) {
  setEnv(name, value);
}
