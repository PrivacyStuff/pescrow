import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MAX_ATTEMPTS_PER_WINDOW,
  clientAddressFromHeaders,
  hashClientAddress,
  isHoneypotTripped,
  isRateLimited,
  isSameOriginSubmission,
  normalizeEmail,
} from "./waitlist-policy.ts";

const SALT = "test-salt-that-is-long-enough-for-hmac";

describe("normalizeEmail", () => {
  it("accepts a normal address and lowercases it", () => {
    assert.equal(normalizeEmail("  Ada@Example.com "), "ada@example.com");
  });

  it("rejects missing domains, spaces, and non-strings", () => {
    assert.equal(normalizeEmail("ada"), null);
    assert.equal(normalizeEmail("ada@localhost"), null);
    assert.equal(normalizeEmail("ada @example.com"), null);
    assert.equal(normalizeEmail("ada..x@example.com"), null);
    assert.equal(normalizeEmail(12), null);
  });
});

describe("isHoneypotTripped", () => {
  it("ignores empty values and trips on any text", () => {
    assert.equal(isHoneypotTripped(""), false);
    assert.equal(isHoneypotTripped("   "), false);
    assert.equal(isHoneypotTripped(null), false);
    assert.equal(isHoneypotTripped("https://spam.example"), true);
  });
});

describe("isRateLimited", () => {
  it("allows attempts below the cap and blocks at the cap", () => {
    assert.equal(isRateLimited(MAX_ATTEMPTS_PER_WINDOW - 1), false);
    assert.equal(isRateLimited(MAX_ATTEMPTS_PER_WINDOW), true);
  });
});

describe("clientAddressFromHeaders", () => {
  it("uses the first forwarded address and ignores junk", () => {
    assert.equal(
      clientAddressFromHeaders("203.0.113.5, 10.0.0.1", null),
      "203.0.113.5",
    );
    assert.equal(
      clientAddressFromHeaders("not an ip", "2001:db8::1"),
      "2001:db8::1",
    );
    assert.equal(clientAddressFromHeaders(null, null), "unknown");
  });
});

describe("hashClientAddress", () => {
  it("is stable and does not return the raw address", () => {
    const first = hashClientAddress("203.0.113.5", SALT);
    const second = hashClientAddress("203.0.113.5", SALT);
    assert.equal(first, second);
    assert.equal(first.includes("203.0.113.5"), false);
    assert.notEqual(hashClientAddress("203.0.113.5", `${SALT}-other`), first);
  });
});

describe("isSameOriginSubmission", () => {
  it("accepts a matching origin and rejects cross-site or missing origin", () => {
    assert.equal(
      isSameOriginSubmission({
        origin: "https://privacy.example",
        host: "privacy.example",
        secFetchSite: "same-origin",
      }),
      true,
    );
    assert.equal(
      isSameOriginSubmission({
        origin: "https://evil.example",
        host: "privacy.example",
        secFetchSite: "cross-site",
      }),
      false,
    );
    assert.equal(
      isSameOriginSubmission({
        origin: null,
        host: "privacy.example",
        secFetchSite: "same-origin",
      }),
      false,
    );
  });
});
