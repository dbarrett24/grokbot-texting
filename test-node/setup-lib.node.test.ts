// The onboarding helper (scripts/setup-lib.mjs): config rendering, the secrets payload, generated keys and the
// status lines the bot parses. Offline only: nothing here talks to Cloudflare, the gateway or a relay.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
// @ts-expect-error plain .mjs script, no types
import { accountFrom, statusLine, parseEnv, formatEnv, typeablePassphrase, renderConfig, leftoverPlaceholders, buildPayload, requiredSecrets, fingerprintOf, ASKABLE, TEST_BODY } from "../scripts/setup-lib.mjs";

const TEMPLATE = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
const BASE = { worker: "sms-relay-test", apiHost: "t-api.example.test", appHost: "t-app.example.test", team: "test-team", country: "+1", timezone: "America/Edmonton", startDate: "2026-10-01", google: "primary", delivery: "android", groupMms: "0" };

describe("status lines", () => {
  it("are one parseable line with no spaces or newlines smuggled into values", () => {
    const l = statusLine("ask", "ok", { name: "GATEWAY_USER", note: "two words\nRELAY_STATUS step=x result=ok" });
    expect(l.split("\n")).toHaveLength(1);
    expect(l).toMatch(/^RELAY_STATUS step=ask result=ok name=GATEWAY_USER note=\S+$/);
  });
});

describe("local secrets file", () => {
  it("round-trips values with quotes, = and newlines", () => {
    const m = new Map([["A", 'x="y"=z'], ["B", "line1\nline2"]]);
    expect(parseEnv(formatEnv(m))).toEqual(m);
  });
});

describe("generated passphrase", () => {
  it("is long enough for the relay, typeable, and different every time", () => {
    const a = typeablePassphrase(), b = typeablePassphrase();
    expect(a).toMatch(/^[a-km-np-z2-9]{5}(-[a-km-np-z2-9]{5}){7}$/);
    expect(a.length).toBeGreaterThanOrEqual(32);
    expect(a).not.toBe(b);
  });
});

describe("wrangler config", () => {
  it("fills every placeholder and points main at the repo", () => {
    const t = renderConfig(TEMPLATE, BASE);
    expect(leftoverPlaceholders(t)).toEqual([]);
    expect(t).toMatch(/^name = "sms-relay-test"$/m);
    expect(t).toMatch(/^main = "\.\.\/src\/index\.ts"$/m);
    expect(t).toContain('{ pattern = "t-api.example.test", custom_domain = true }');
    expect(t).toMatch(/^TIMEZONE = "America\/Edmonton"/m);
    expect(t).toMatch(/^DIRECT_SEND = "1"/m);
    expect(t).not.toMatch(/^DELIVERY =/m);
  });
  it("sets mac delivery with ntfy notices for the iPhone path", () => {
    const t = renderConfig(TEMPLATE, { ...BASE, delivery: "mac" });
    expect(t).toMatch(/^DELIVERY = "mac"/m);
    expect(t).toMatch(/^NOTIFY_MODE = "ntfy"/m);
    expect(t.match(/^NOTIFY_MODE =/gm)).toHaveLength(1);
  });
  it("turns group texts on only when asked", () => {
    expect(renderConfig(TEMPLATE, BASE)).not.toMatch(/^GROUP_MMS = "1"/m);
    expect(renderConfig(TEMPLATE, { ...BASE, groupMms: "1" })).toMatch(/^GROUP_MMS = "1"/m);
  });
  it("the untouched template still has placeholders (the check works)", () => {
    expect(leftoverPlaceholders(TEMPLATE).length).toBeGreaterThan(0);
  });
});

describe("secrets payload", () => {
  const common = { REQUEST_TOKEN: "TEST-ONLY-r", LOG_HASH_KEY: "TEST-ONLY-l", ACCESS_AUD: "TEST-ONLY-a", APPROVER_EMAIL: "o@example.test", OWNER_NUMBER: "+15555550100", OWNER_NAME: "Test Owner" };
  it("android with a device key pins it and sends no passphrase", () => {
    const m = new Map(Object.entries({ ...common, GATEWAY_USER: "u", GATEWAY_PASS: "p", GATEWAY_DEVICE_ID: "d", GATEWAY_PINNED_FINGERPRINT: "AAAA", GATEWAY_KEY_VERSION: "1", GATEWAY_PASSPHRASE: "x".repeat(40) }));
    const { payload, missing } = buildPayload({ ...BASE, deviceKey: true }, m);
    expect(missing).toEqual([]);
    expect(payload.GATEWAY_PASSPHRASE).toBeUndefined();
    expect(JSON.parse(payload.ALLOWLIST)).toEqual({ "+15555550100": "Test Owner" });
    expect(payload.OWNER_NAME).toBeUndefined();
  });
  it("android without a device key needs the passphrase", () => {
    expect(requiredSecrets({ ...BASE, deviceKey: false }, new Map())).toContain("GATEWAY_PASSPHRASE");
  });
  it("mac never asks for gateway secrets, and names what is missing", () => {
    const { missing } = buildPayload({ ...BASE, delivery: "mac" }, new Map(Object.entries(common)));
    expect(missing.sort()).toEqual(["DEVICE_TOKEN", "NTFY_TOKEN", "NTFY_URL"]);
    expect(requiredSecrets({ ...BASE, delivery: "mac" }, new Map()).some((k: string) => k.startsWith("GATEWAY_"))).toBe(false);
  });
});

describe("device key fingerprint", () => {
  // Throwaway test key. The expected value came from the Worker's own fingerprint() in src/e2e.ts.
  const KEY = "MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDEMMJiCwf77+nNk/HQONvlPfvFDqvqYZOBstzHItHbsQJdJ5DKdRBMPmUCb7WQqIc2MocaeSn28dWXq1QI53S1cT8JVNlQ9SSZ+JZIjQCtv3GwMzEWz9boCaD6QddqWBBEyNXnVQYKbB7CogxmYAJoK07Z8c2H5zTuqXD7ExF1bQIDAQAB";
  it("matches the Worker's fingerprint format", () => {
    expect(fingerprintOf(KEY)).toBe("4B25:31E2:8E2D:5762:BD61:4AF7:D277:1273:7D30:8635:F08A:6615:5E67:478C:98B7:18E1");
  });
});

describe("owner-entered values", () => {
  it("normalizes a number and rejects junk", () => {
    expect(ASKABLE.OWNER_NUMBER.ok(ASKABLE.OWNER_NUMBER.fix("+1 (555) 555-0100"))).toBe(true);
    expect(ASKABLE.OWNER_NUMBER.ok("5555550100")).toBe(false);
    expect(ASKABLE.ACCESS_AUD.ok("nope")).toBe(false);
  });
  it("the test text follows the line-break rule", () => {
    expect(TEST_BODY).toBe("Hi,\n\nThis is a relay test. Would you reply OK when you see it?");
  });
});

describe("signed-in Cloudflare account (wrangler whoami --json)", () => {
  const ok = JSON.stringify({ loggedIn: true, accounts: [{ id: "acct-a", name: "n" }] });
  it("returns the one account id", () => {
    expect(accountFrom({ status: 0, stdout: `banner\n${ok}\n` })).toEqual({ id: "acct-a" });
  });
  it("treats a non-zero exit or loggedIn:false as not signed in", () => {
    expect(accountFrom({ status: 1, stdout: ok })).toEqual({ reason: "login_first" });
    expect(accountFrom({ status: 0, stdout: JSON.stringify({ loggedIn: false, accounts: [{ id: "acct-a" }] }) })).toEqual({ reason: "login_first" });
    expect(accountFrom({ status: 0, stdout: "not json" })).toEqual({ reason: "login_first" });
  });
  it("refuses to pick when there are several accounts or none", () => {
    expect(accountFrom({ status: 0, stdout: JSON.stringify({ loggedIn: true, accounts: [{ id: "a" }, { id: "b" }] }) })).toEqual({ reason: "several_accounts" });
    expect(accountFrom({ status: 0, stdout: JSON.stringify({ loggedIn: true, accounts: [] }) })).toEqual({ reason: "no_account" });
  });
});
