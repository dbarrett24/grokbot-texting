import { describe, it, expect, beforeEach } from "vitest";
import { SELF, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { harness, postRequest, approve, csrfOf, lastAccessReason, tamperSig, BASE, API, FRIEND, TWO, OWNER, STRANGER, T0, T_EARLY, type Harness } from "./helpers";
import { LINK, sendCap, validateRequestBody, parseAllowlist } from "../src/rules";

// Loose alias: the generic DO typing recurses too deep for tsc on this stub.
const runIn = runInDurableObject as unknown as (s: unknown, f: (i: any) => Promise<any>) => Promise<any>;
let h: Harness;
beforeEach(async () => { h = await harness(); });

async function create(text = "Running 10 min late, see you soon", to = FRIEND) {
  const r = await postRequest(h, { to, text });
  expect(r.status).toBe(202);
  return (await r.json()) as { id: string; sha256: string; notified: boolean };
}
const sendsTo = (n: string) => h.messagesPosted().length && Promise.all(h.messagesPosted().map((m) => h.decrypt(m.phoneNumbers[0]))).then((a) => a.filter((x) => x === n).length);

describe("request side does nothing but queue", () => {
  it("POST /request creates pending, notifies the owner only, sends nothing to the recipient", async () => {
    const { id, notified } = await create();
    expect(notified).toBe(true);
    const posted = h.messagesPosted();
    expect(posted).toHaveLength(1); // the notification
    expect(await h.decrypt(posted[0].phoneNumbers[0])).toBe(OWNER);
    expect(await h.decrypt(posted[0].textMessage.text)).not.toContain("Running 10 min late"); // body not leaked to notification
    expect(await sendsTo(FRIEND)).toBe(0);
    const s = await h.relay.fetch(`${API}/request/${id}`, { headers: { Authorization: "Bearer TEST-ONLY-request-token" } });
    expect(await s.json()).toMatchObject({ state: "pending" });
  });

  it("nothing reaches the recipient after expiry without approval", async () => {
    const { id } = await create();
    h.setNow(T0 + 16 * 60_000);
    const s = await h.relay.fetch(`${API}/request/${id}`, { headers: { Authorization: "Bearer TEST-ONLY-request-token" } });
    expect(await s.json()).toMatchObject({ state: "expired" });
    expect(await sendsTo(FRIEND)).toBe(0);
  });

  it("routes through the Worker entrypoint (SELF) and rejects a bad token", async () => {
    const r = await SELF.fetch(`${API}/request`, { method: "POST", headers: { Authorization: "Bearer wrong" }, body: "{}" });
    expect(r.status).toBe(401);
  });
});

describe("token split", () => {
  it("rejects missing or wrong request token", async () => {
    expect((await postRequest(h, { to: FRIEND, text: "hi" }, "nope")).status).toBe(401);
    const r = await h.relay.fetch(`${API}/request`, { method: "POST", body: JSON.stringify({ to: FRIEND, text: "hi" }) });
    expect(r.status).toBe(401);
  });
  it("request token cannot view or approve", async () => {
    const { id } = await create();
    const page = await h.relay.fetch(`${BASE}/approve/${id}`, { headers: { Authorization: "Bearer TEST-ONLY-request-token" } });
    expect(page.status).toBe(403);
    const r = await approve(h, id, "approve", { auth: "Bearer TEST-ONLY-request-token" });
    expect(r.status).toBe(403);
    const log = await h.relay.fetch(`${BASE}/log`, { headers: { Authorization: "Bearer TEST-ONLY-request-token" } });
    expect(log.status).toBe(403);
    expect(await sendsTo(FRIEND)).toBe(0);
  });
  it("approval requires a valid Access JWT for the approver with the passkey amr", async () => {
    const { id } = await create();
    // Real CSRF + same origin, so the ONLY thing wrong in each case is the token.
    const csrf = await csrfOf(h, id);
    const cases: [string, string][] = [
      [await h.jwt({ email: "someone@example.test" }), "access_wrong_identity"],
      [await h.jwt({ aud: ["other"] }), "access_jwt_aud"],
      [await h.jwt({ iss: "https://evil.cloudflareaccess.com" }), "access_jwt_iss"],
      [await h.jwt({ amr: ["pwd"] }), "access_amr_not_passkey"],
      [await h.jwt({ exp: Math.floor(T0 / 1000) - 5 }), "access_jwt_expired"],
      [tamperSig(await h.jwt()), "access_jwt_signature"],
      ["not.a-jwt", "access_jwt_malformed"],
    ];
    for (const [jwt, code] of cases) {
      expect((await approve(h, id, "approve", { jwt, csrf })).status, code).toBe(403);
      expect(await lastAccessReason(h), code).toBe(code);
    }
    expect((await h.relay.fetch(`${BASE}/approve/${id}`)).status).toBe(401); // no JWT at all
    expect(await lastAccessReason(h)).toBe("access_jwt_missing");
    expect(await sendsTo(FRIEND)).toBe(0);
    // Control: the same request with a valid token succeeds, so the refusals above came from the token checks.
    expect(await (await approve(h, id, "approve", { csrf })).json()).toMatchObject({ state: "sent" });
  });
  it.each([
    ["payload is JSON null", "null"],
    ["payload is a number", "123"],
    ["payload is an array", "[]"],
    ["payload is not JSON", "{not json"],
  ])("malformed token (%s) → 403 access_jwt_malformed, not 500", async (_n, payloadJson) => {
    const { id } = await create();
    const enc = (t: string) => btoa(t).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const jwt = `${enc(JSON.stringify({ alg: "RS256", kid: "test-kid" }))}.${enc(payloadJson)}.${enc("sig")}`;
    expect((await approve(h, id, "approve", { jwt, csrf: await csrfOf(h, id) })).status).toBe(403);
    expect(await lastAccessReason(h)).toBe("access_jwt_malformed");
  });
  it("malformed token (bad base64) → 403 access_jwt_malformed", async () => {
    const { id } = await create();
    expect((await approve(h, id, "approve", { jwt: "a.%%%.b", csrf: await csrfOf(h, id) })).status).toBe(403);
    expect(await lastAccessReason(h)).toBe("access_jwt_malformed");
  });
  it("rejects cross-origin and bad CSRF posts", async () => {
    const { id } = await create();
    expect((await approve(h, id, "approve", { origin: "https://evil.example.test" })).status).toBe(403);
    expect((await approve(h, id, "approve", { csrf: "0".repeat(32) })).status).toBe(403);
    expect(await sendsTo(FRIEND)).toBe(0);
  });
});

describe("approval flow", () => {
  it("approve page shows the relay's stored copy, escaped, and approve sends it E2E to the one recipient", async () => {
    const { id } = await create("Dinner <b>at 7</b>?");
    const page = await h.relay.fetch(`${BASE}/approve/${id}?to=%2B15555550199&text=evil`, { headers: { "Cf-Access-Jwt-Assertion": await h.jwt() } });
    const html = await page.text();
    expect(html).not.toContain(FRIEND); // full number is split across spans, so the source has no contiguous E.164
    expect(html).toContain("Test Friend (");
    expect(html).toContain('class=e164');
    expect(html).toContain(">Copy</button>");
    expect(html).toContain("Dinner &lt;b&gt;at 7&lt;/b&gt;?");
    expect(html).not.toContain("evil");
    expect(html).not.toContain(STRANGER);
    const r = await approve(h, id);
    expect(await r.json()).toMatchObject({ state: "sent" });
    const last = h.messagesPosted().at(-1);
    expect(last.isEncrypted).toBe(true);
    expect(last.phoneNumbers).toHaveLength(1);
    expect(await h.decrypt(last.phoneNumbers[0])).toBe(FRIEND);
    expect(await h.decrypt(last.textMessage.text)).toBe("Dinner <b>at 7</b>?");
    const gw = h.calls.find((c) => c.url.endsWith("/messages"))!;
    expect(gw.auth).toBe("Basic " + btoa("TEST-ONLY-user:TEST-ONLY-pass"));
  });
  it("deny never sends", async () => {
    const { id } = await create();
    expect(await (await approve(h, id, "deny")).json()).toMatchObject({ state: "denied" });
    expect(await sendsTo(FRIEND)).toBe(0);
  });
  it("is single use", async () => {
    const { id } = await create();
    const jwt = await h.jwt();
    const page = await h.relay.fetch(`${BASE}/approve/${id}`, { headers: { "Cf-Access-Jwt-Assertion": jwt } });
    const csrf = (await page.text()).match(/value="([a-f0-9]+)"/)![1];
    expect((await approve(h, id, "approve", { jwt, csrf })).status).toBe(200);
    h.setNow(T0 + 120_000);
    expect((await approve(h, id, "approve", { jwt: await h.jwt(), csrf })).status).toBe(409);
    expect(await sendsTo(FRIEND)).toBe(1);
  });
  it("a failed gateway send still consumes the request (no retry)", async () => {
    const { id } = await create();
    const jwt = await h.jwt();
    const csrf = (await (await h.relay.fetch(`${BASE}/approve/${id}`, { headers: { "Cf-Access-Jwt-Assertion": jwt } })).text()).match(/value="([a-f0-9]+)"/)![1];
    h.gatewayFails.value = true;
    expect((await approve(h, id, "approve", { jwt, csrf })).status).toBe(502);
    h.gatewayFails.value = false;
    expect((await approve(h, id, "approve", { jwt, csrf })).status).toBe(409);
  });
  it("expires after 15 minutes", async () => {
    const { id } = await create();
    const jwt = await h.jwt();
    const csrf = (await (await h.relay.fetch(`${BASE}/approve/${id}`, { headers: { "Cf-Access-Jwt-Assertion": jwt } })).text()).match(/value="([a-f0-9]+)"/)![1];
    h.setNow(T0 + 15 * 60_000);
    expect((await approve(h, id, "approve", { jwt: await h.jwt(), csrf })).status).toBe(410);
    expect(await sendsTo(FRIEND)).toBe(0);
  });
  it("still approvable at 14m59s", async () => {
    const { id } = await create();
    const jwt = await h.jwt();
    const csrf = (await (await h.relay.fetch(`${BASE}/approve/${id}`, { headers: { "Cf-Access-Jwt-Assertion": jwt } })).text()).match(/value="([a-f0-9]+)"/)![1];
    h.setNow(T0 + 15 * 60_000 - 1000);
    expect((await approve(h, id, "approve", { jwt: await h.jwt(), csrf })).status).toBe(200);
  });
  it("re-checks the allowlist at approve time", async () => {
    const { id } = await create();
    await h.setEnv({ ALLOWLIST: JSON.stringify({ [TWO]: "Test Two" }) });
    expect((await approve(h, id)).status).toBe(403);
    expect(await sendsTo(FRIEND)).toBe(0);
  });
  it("refuses to send if the device key pin does not match", async () => {
    const { id } = await create();
    await h.setEnv({ GATEWAY_PINNED_FINGERPRINT: "0000:0000" });
    const before = h.messagesPosted().length; // the notification, sent before the pin changed
    expect((await approve(h, id)).status).toBe(502);
    expect(h.messagesPosted().length).toBe(before);
  });
});

describe("content rules", () => {
  it.each([
    "Book here: https://example.com/book/interview",
    "Senior youth: https://example.com/book/semiannual-check-in",
  ])("links are allowed in the tap text (queued, then sent as-is on approval): %s", async (text) => {
    const r = await postRequest(h, { to: FRIEND, text });
    expect(r.status).toBe(202);
    const { id } = (await r.json()) as any;
    expect((await approve(h, id)).status).toBe(200);
    const sent = h.messagesPosted().filter((m: any) => m.textMessage);
    expect(await h.decrypt(sent.at(-1)!.textMessage.text)).toBe(text);
  });
  it.each([
    [{ to: [FRIEND, TWO], text: "hi" }, "group_send_not_allowed"],
    [{ to: `${FRIEND},${TWO}`, text: "hi" }, "group_send_not_allowed"],
    [{ to: `${FRIEND} ${TWO}`, text: "hi" }, "group_send_not_allowed"],
    [{ to: FRIEND, text: "hi", phoneNumbers: [TWO] }, "unknown_fields"],
    [{ to: FRIEND, text: "hi", cc: TWO }, "unknown_fields"],
  ])("rejects group send %j", async (body, code) => {
    const r = await postRequest(h, body);
    expect(r.status).toBe(400);
    expect(await r.json()).toMatchObject({ error: code });
  });
  it("rejects numbers not on the allowlist", async () => {
    const r = await postRequest(h, { to: STRANGER, text: "hi" });
    expect(r.status).toBe(403);
    expect(await r.json()).toMatchObject({ error: "recipient_not_on_allowlist" });
    expect(h.messagesPosted()).toHaveLength(0);
  });
  it("rejects malformed numbers, empty and too-long text", async () => {
    expect((await postRequest(h, { to: "5555550101", text: "hi" })).status).toBe(400);
    expect((await postRequest(h, { to: FRIEND, text: "  " })).status).toBe(400);
    expect((await postRequest(h, { to: FRIEND, text: "a".repeat(641) })).status).toBe(400);
  });
  it("allows ordinary punctuation", () => {
    expect(LINK.test("Ok. See you at 5.30, bring snacks!")).toBe(false);
  });
});

describe("caps", () => {
  it("about 20 pending requests a day, resets next local day", async () => {
    for (let i = 0; i < 20; i++) await create(`note ${i}`);
    const r = await postRequest(h, { to: FRIEND, text: "one more" });
    expect(r.status).toBe(429);
    expect(await r.json()).toMatchObject({ error: "request_cap_reached" });
    h.setNow(Date.parse("2026-10-17T00:01:00-06:00"));
    expect((await postRequest(h, { to: FRIEND, text: "new day" })).status).toBe(202);
  });

  async function approveN(n: number, start: number) {
    const results: number[] = [];
    for (let i = 0; i < n; i++) {
      h.setNow(start + i * 60_000);
      const { id } = await create(`msg ${i}`);
      results.push((await approve(h, id)).status);
    }
    return results;
  }
  it("5 sends a day in the first 14 days", async () => {
    const res = await approveN(6, T_EARLY);
    expect(res.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(res[5]).toBe(429);
    expect(await sendsTo(FRIEND)).toBe(5);
  });
  it("10 sends a day after 14 days", async () => {
    const res = await approveN(11, Date.parse("2026-10-16T08:00:00-06:00"));
    expect(res.filter((s) => s === 200)).toHaveLength(10);
    expect(res[10]).toBe(429);
  });
  it("cap schedule boundaries and fail-closed start date", () => {
    expect(sendCap("2026-10-14", "2026-10-01", 5, 10, 14)).toBe(5);
    expect(sendCap("2026-10-15", "2026-10-01", 5, 10, 14)).toBe(10);
    expect(sendCap("2026-10-15", "REPLACE_WITH_GO_LIVE_DATE_YYYY-MM-DD", 5, 10, 14)).toBe(5);
  });
  it("30 s minimum between sends", async () => {
    const a = await create("first");
    expect((await approve(h, a.id)).status).toBe(200);
    h.setNow(T0 + 10_000);
    const b = await create("second");
    expect((await approve(h, b.id)).status).toBe(429);
  });
});

describe("log and kill switch", () => {
  it("keeps its own log without message text", async () => {
    const { id } = await create("secret plans");
    await approve(h, id);
    const r = await h.relay.fetch(`${BASE}/log`, { headers: { "Cf-Access-Jwt-Assertion": await h.jwt() } });
    const rows = (await r.json()) as any[];
    const events = rows.map((x) => x.event);
    for (const e of ["request_created", "notified", "approve_page_viewed", "approved", "sent"]) expect(events).toContain(e);
    expect(JSON.stringify(rows)).not.toContain("secret plans");
    expect(JSON.stringify(rows)).not.toContain(FRIEND);
  });
  it("DISABLED=1 refuses everything", async () => {
    await h.setEnv({ DISABLED: "1" });
    expect((await postRequest(h, { to: FRIEND, text: "hi" })).status).toBe(503);
  });
});

describe("notification", () => {
  it("ntfy mode requires a token (never a public topic)", async () => {
    await h.setEnv({ NOTIFY_MODE: "ntfy", NTFY_URL: "https://ntfy.example.test/private-topic", NTFY_TOKEN: "" });
    const { notified } = await create();
    expect(notified).toBe(false);
    expect(h.calls.some((c) => c.url.includes("ntfy"))).toBe(false);
  });
  it("ntfy mode sends with bearer auth", async () => {
    await h.setEnv({ NOTIFY_MODE: "ntfy", NTFY_URL: "https://ntfy.example.test/private-topic", NTFY_TOKEN: "TEST-ONLY-ntfy" });
    await create();
    const c = h.calls.find((x) => x.url.includes("ntfy"))!;
    expect(c.auth).toBe("Bearer TEST-ONLY-ntfy");
    expect(h.messagesPosted()).toHaveLength(0);
  });
});

describe("pure rules", () => {
  it("allowlist parse fails closed", () => {
    expect(() => parseAllowlist(undefined)).toThrow();
    expect(() => parseAllowlist("[]")).toThrow();
    expect(() => parseAllowlist('{"555":"x"}')).toThrow();
  });
  it("validateRequestBody rejects non-objects", () => {
    expect(() => validateRequestBody("x", new Map(), 640)).toThrow();
  });
});

describe("review fixes", () => {
  it.each(["", "  ", "REPLACE_AFTER_SMOKE_TEST", " , "])("REQUIRED_AMR=%j refuses every approval", async (v) => {
    await h.setEnv({ REQUIRED_AMR: v });
    const { id } = await create();
    const jwt = await h.jwt({ amr: ["swk", "hwk", "REPLACE_AFTER_SMOKE_TEST", ""] });
    expect((await h.relay.fetch(`${BASE}/approve/${id}`, { headers: { "Cf-Access-Jwt-Assertion": jwt } })).status).toBe(403);
    expect((await approve(h, id, "approve", { jwt, csrf: await csrfOf(h, id) })).status).toBe(403);
    expect(await lastAccessReason(h)).toBe("access_amr_not_configured");
    expect(await sendsTo(FRIEND)).toBe(0);
  });
  it("REQUIRED_AMR missing entirely refuses every approval", async () => {
    await h.setEnv({ REQUIRED_AMR: undefined as unknown as string });
    const { id } = await create();
    expect((await approve(h, id, "approve", { csrf: await csrfOf(h, id) })).status).toBe(403);
    expect(await lastAccessReason(h)).toBe("access_amr_not_configured");
    expect(await sendsTo(FRIEND)).toBe(0);
  });
  it("request host rejects approve and log routes", async () => {
    const { id } = await create();
    const jwt = await h.jwt();
    expect((await h.relay.fetch(`${API}/approve/${id}`, { headers: { "Cf-Access-Jwt-Assertion": jwt } })).status).toBe(404);
    expect((await h.relay.fetch(`${API}/approve/${id}`, { method: "POST", headers: { "Cf-Access-Jwt-Assertion": jwt, Origin: API } })).status).toBe(404);
    expect((await h.relay.fetch(`${API}/log`, { headers: { "Cf-Access-Jwt-Assertion": jwt } })).status).toBe(404);
    expect(await sendsTo(FRIEND)).toBe(0);
  });
  it("approve host rejects /request", async () => {
    const r = await h.relay.fetch(`${BASE}/request`, { method: "POST", headers: { Authorization: "Bearer TEST-ONLY-request-token" }, body: JSON.stringify({ to: FRIEND, text: "hi" }) });
    expect(r.status).toBe(404);
    const { id } = await create();
    expect((await h.relay.fetch(`${BASE}/request/${id}`, { headers: { Authorization: "Bearer TEST-ONLY-request-token" } })).status).toBe(404);
  });
  it("unknown host and unconfigured hosts are refused", async () => {
    expect((await h.relay.fetch("https://other.example.test/request", { method: "POST" })).status).toBe(404);
    await h.setEnv({ APPROVE_HOST: "" });
    expect((await postRequest(h, { to: FRIEND, text: "hi" })).status).toBe(503);
  });
  it("purges request text after 7 days and log rows after 12 months", async () => {
    const { id } = await create("old secret");
    h.setNow(T0 + 8 * 86_400_000); // Oct 24 2026
    await create("newer");
    const jwt = await h.jwt();
    expect((await h.relay.fetch(`${BASE}/approve/${id}`, { headers: { "Cf-Access-Jwt-Assertion": jwt } })).status).toBe(404);
    let rows = (await (await h.relay.fetch(`${BASE}/log`, { headers: { "Cf-Access-Jwt-Assertion": jwt } })).json()) as any[];
    expect(rows.some((r) => r.request_id === id)).toBe(true); // log outlives the request text
    h.setNow(Date.parse("2027-10-17T12:00:00-06:00")); // >12 months after T0, <12 months after Oct 24
    await create("year later");
    rows = (await (await h.relay.fetch(`${BASE}/log`, { headers: { "Cf-Access-Jwt-Assertion": await h.jwt() } })).json()) as any[];
    expect(rows.some((r) => r.request_id === id)).toBe(false);
    expect(rows.some((r) => r.ms < Date.parse("2026-10-17T12:00:00-06:00"))).toBe(false);
    expect(rows.some((r) => r.ms === T0 + 8 * 86_400_000)).toBe(true);
  });
  it("the daily alarm runs the purge", async () => {
    await create();
    h.setNow(T0 + 400 * 86_400_000);
    await runIn(h.relay, async (inst: any) => { await inst.ctx.storage.setAlarm(Date.now() + 1000); });
    expect(await runDurableObjectAlarm(h.relay)).toBe(true);
    const n = await runIn(h.relay, async (inst: any) => inst.ctx.storage.sql.exec("SELECT COUNT(*) AS c FROM log").one().c);
    expect(n).toBe(0);
  });
});
