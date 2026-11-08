import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEVNET_GENESIS_HASH,
  FAUCET_COOLDOWN_MS,
  FAUCET_LABEL,
  FAUCET_SOL_LAMPORTS,
  FAUCET_USDC_BASE_UNITS,
  FaucetLimiter,
  cooldownRemaining,
  faucetEnabled,
  faucetKeypairPath,
  isDevnetGenesis,
  parseFaucetRequest,
  parseSecretKey,
  rateLimitMessage,
} from "./faucet.ts";

const WALLET = "4xE4z8yHak9a7NA44gFTtJXDYE4jdnyb7f8rdfMWQmye";
const OTHER = "BUMkpvWFPwh2AKpAEJCbJDrU6QbYPhJwgQZig7iK9cBy";
const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

describe("faucet amounts", () => {
  it("drops half a SOL and one thousand six-decimal USDC", () => {
    assert.equal(FAUCET_SOL_LAMPORTS, BigInt(500_000_000));
    assert.equal(FAUCET_USDC_BASE_UNITS, BigInt(1_000_000_000));
    assert.equal(FAUCET_LABEL.sol, "0.5 SOL");
    assert.equal(FAUCET_LABEL.usdc, "1000 USDC");
  });
});

describe("faucetEnabled", () => {
  it("is on outside production and off in production without the flag", () => {
    assert.equal(faucetEnabled({ NODE_ENV: "development" }), true);
    assert.equal(faucetEnabled({}), true);
    assert.equal(faucetEnabled({ NODE_ENV: "production" }), false);
    assert.equal(faucetEnabled({ NODE_ENV: "production", FAUCET_ENABLED: "true" }), false);
    assert.equal(faucetEnabled({ NODE_ENV: "production", FAUCET_ENABLED: "1" }), true);
  });
});

describe("isDevnetGenesis", () => {
  it("accepts only the devnet genesis hash", () => {
    assert.equal(isDevnetGenesis(DEVNET_GENESIS_HASH), true);
    assert.equal(isDevnetGenesis(MAINNET_GENESIS), false);
    assert.equal(isDevnetGenesis(undefined), false);
  });
});

describe("parseFaucetRequest", () => {
  it("accepts a 32-byte base58 key and a known asset", () => {
    assert.deepEqual(parseFaucetRequest({ recipient: ` ${WALLET} `, asset: "sol" }), { recipient: WALLET, asset: "sol" });
    assert.deepEqual(parseFaucetRequest({ recipient: WALLET, asset: "usdc" }), { recipient: WALLET, asset: "usdc" });
  });

  it("rejects bad keys, unknown assets, extra fields, and non-objects", () => {
    assert.equal(parseFaucetRequest({ recipient: "not-a-key", asset: "sol" }), null);
    assert.equal(parseFaucetRequest({ recipient: "1111", asset: "sol" }), null);
    assert.equal(parseFaucetRequest({ recipient: `${WALLET}0`, asset: "sol" }), null);
    assert.equal(parseFaucetRequest({ recipient: WALLET, asset: "bonk" }), null);
    assert.equal(parseFaucetRequest({ recipient: WALLET, asset: "sol", amount: 100 }), null);
    assert.equal(parseFaucetRequest({ recipient: 42, asset: "sol" }), null);
    assert.equal(parseFaucetRequest([WALLET, "sol"]), null);
    assert.equal(parseFaucetRequest(null), null);
    assert.equal(parseFaucetRequest("sol"), null);
  });
});

describe("faucetKeypairPath", () => {
  it("prefers the env path and falls back to the admin key only outside production", () => {
    assert.equal(faucetKeypairPath({ FAUCET_KEYPAIR_PATH: " /srv/faucet.json " }, "/home/x"), "/srv/faucet.json");
    assert.equal(faucetKeypairPath({ NODE_ENV: "production", FAUCET_KEYPAIR_PATH: "/srv/faucet.json" }, "/home/x"), "/srv/faucet.json");
    assert.equal(faucetKeypairPath({ NODE_ENV: "production" }, "/home/x"), null);
    assert.equal(faucetKeypairPath({ NODE_ENV: "production", FAUCET_KEYPAIR_PATH: "  " }, "/home/x"), null);
    assert.match(faucetKeypairPath({ NODE_ENV: "development" }, "/home/x") ?? "", /^\/home\/x\/\.config\/solana\/.+\.json$/);
  });
});

describe("parseSecretKey", () => {
  it("accepts a 64-byte JSON array and rejects anything else", () => {
    const bytes = Array.from({ length: 64 }, (_, index) => index);
    assert.deepEqual(parseSecretKey(JSON.stringify(bytes)), Uint8Array.from(bytes));
    assert.equal(parseSecretKey(JSON.stringify(bytes.slice(1))), null);
    assert.equal(parseSecretKey(JSON.stringify([...bytes.slice(1), 256])), null);
    assert.equal(parseSecretKey(JSON.stringify([...bytes.slice(1), 1.5])), null);
    assert.equal(parseSecretKey("not json"), null);
    assert.equal(parseSecretKey("{}"), null);
  });
});

describe("cooldownRemaining and rateLimitMessage", () => {
  it("counts down from the last drop", () => {
    assert.equal(cooldownRemaining(undefined, 1_000), 0);
    assert.equal(cooldownRemaining(1_000, 1_000), FAUCET_COOLDOWN_MS);
    assert.equal(cooldownRemaining(1_000, 1_000 + FAUCET_COOLDOWN_MS), 0);
  });

  it("rounds the wait up to whole minutes", () => {
    assert.equal(rateLimitMessage("sol", 1), "This wallet or network already got 0.5 SOL. Try again in 1 minute.");
    assert.equal(rateLimitMessage("usdc", 9 * 60_000 + 1), "This wallet or network already got 1000 USDC. Try again in 10 minutes.");
  });
});

describe("FaucetLimiter", () => {
  it("allows one drop per asset per wallet and per IP inside the window", () => {
    const limiter = new FaucetLimiter(1_000);
    assert.equal(limiter.reserve("sol", WALLET, "1.1.1.1", 0).ok, true);
    assert.deepEqual(limiter.reserve("sol", WALLET, "2.2.2.2", 10), { ok: false, retryAfterMs: 990 });
    assert.deepEqual(limiter.reserve("sol", OTHER, "1.1.1.1", 10), { ok: false, retryAfterMs: 990 });
    assert.equal(limiter.reserve("usdc", WALLET, "1.1.1.1", 10).ok, true);
    assert.equal(limiter.reserve("sol", WALLET, "1.1.1.1", 1_000).ok, true);
  });

  it("frees the slot when a drop is released after a failure", () => {
    const limiter = new FaucetLimiter(1_000);
    const first = limiter.reserve("sol", WALLET, "1.1.1.1", 0);
    assert.equal(first.ok, true);
    if (first.ok) limiter.release(first.keys);
    assert.equal(limiter.reserve("sol", WALLET, "1.1.1.1", 1).ok, true);
  });

  it("fails closed when the table is full of live entries", () => {
    const limiter = new FaucetLimiter(1_000, 2);
    assert.equal(limiter.reserve("sol", WALLET, "1.1.1.1", 0).ok, true);
    assert.deepEqual(limiter.reserve("sol", OTHER, "2.2.2.2", 1), { ok: false, retryAfterMs: 1_000 });
    assert.equal(limiter.reserve("sol", OTHER, "2.2.2.2", 1_000).ok, true);
  });
});
