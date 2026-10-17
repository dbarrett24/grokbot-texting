import { describe, it, expect, beforeEach } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import { harness, postRequest, approve, csrfOf, API, BASE, OWNER, FRIEND, TWO, T0, type Harness } from "./helpers";

// Template settings: required TIMEZONE, opt-in BLOCK_LINKS, configurable tap limits (garbage fails closed).
// Fake values only (555-01xx numbers, example.com links).
let h: Harness;
const runIn = runInDurableObject as unknown as (s: unknown, f: (i: any) => Promise<any>) => Promise<any>;
const sql = (q: string, ...a: unknown[]) => runIn(h.relay, async (i) => i.ctx.storage.sql.exec(q, ...a).toArray()) as Promise<any[]>;
const count = async (q: string, ...a: unknown[]) => (await sql(q, ...a))[0].c as number;
const direct = (body: unknown) =>
  h.relay.fetch(`${API}/send`, { method: "POST", headers: { Authorization: "Bearer TEST-ONLY-request-token", "content-type": "application/json" }, body: JSON.stringify(body) });
const posted = async () => Promise.all(h.messagesPosted().map(async (m) => ({ to: await h.decrypt(m.phoneNumbers[0]), text: await h.decrypt(m.textMessage.text) })));
const sentTo = async () => (await posted()).filter((p) => p.to !== OWNER).map((p) => p.to);
const ownerTexts = async () => (await posted()).filter((p) => p.to === OWNER).map((p) => p.text);
async function expectError(r: Response, status: number, code: string) {
  expect(r.status).toBe(status);
  expect(await r.json()).toEqual({ error: code });
}
const LINK = "Book a time:\n\nhttps://example.com/book/interview";

beforeEach(async () => {
  h = await harness();
  await h.setEnv({ DIRECT_SEND: "1", RUNAWAY_PAUSE: "0" });
});

describe("TIMEZONE is required (no default zone)", () => {
  it.each([
    [undefined, "timezone_not_configured"],
    ["", "timezone_not_configured"],
    ["   ", "timezone_not_configured"],
    ["REPLACE_WITH_IANA_TIMEZONE", "timezone_invalid"],
    ["Mars/Olympus_Mons", "timezone_invalid"],
    ["GMT+25", "timezone_invalid"],
  ])("TIMEZONE=%j → every route answers 503 %s and nothing is sent or stored", async (tz, code) => {
    await h.setEnv({ TIMEZONE: tz as unknown as string });
    await expectError(await direct({ to: FRIEND, body: "hi" }), 503, code);
    await expectError(await postRequest(h, { to: FRIEND, text: "hi" }), 503, code);
    await expectError(await h.relay.fetch(`${BASE}/direct`, { headers: { "Cf-Access-Jwt-Assertion": await h.jwt() } }), 503, code);
    expect(h.calls.filter((c) => c.url.includes("sms-gate"))).toHaveLength(0);
    expect(await count("SELECT COUNT(*) AS c FROM requests")).toBe(0);
    expect(await count("SELECT COUNT(*) AS c FROM direct_sends")).toBe(0);
    expect((await sql("SELECT detail FROM log WHERE event='refused'")).map((r) => r.detail)).toContain(code);
  });

  it("the console names the config error", async () => {
    await h.setEnv({ TIMEZONE: "" });
    const errs: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void errs.push(a.join(" "));
    try {
      await direct({ to: FRIEND, body: "hi" });
    } finally {
      console.error = orig;
    }
    expect(errs.join("\n")).toContain("CONFIG_ERROR reason=timezone_not_configured");
  });

  it("a valid zone is used for day boundaries (DIRECT_DAILY_CAP resets at that zone's midnight)", async () => {
    await h.setEnv({ TIMEZONE: "Asia/Tokyo", DIRECT_DAILY_CAP: "1" });
    h.setNow(Date.parse("2026-10-17T23:50:00+09:00"));
    expect((await direct({ to: FRIEND, body: "a" })).status).toBe(200);
    await expectError(await direct({ to: FRIEND, body: "b" }), 429, "direct_daily_cap_reached");
    h.setNow(Date.parse("2026-10-18T00:05:00+09:00")); // Tokyo midnight passed
    expect((await direct({ to: FRIEND, body: "c" })).status).toBe(200);
    expect(await sentTo()).toEqual([FRIEND, FRIEND]);
  });
});

describe("BLOCK_LINKS (opt-in; off by default)", () => {
  it.each([undefined, "", "0"])("BLOCK_LINKS=%j: links go through on tap and direct", async (v) => {
    await h.setEnv({ BLOCK_LINKS: v as unknown as string });
    expect((await direct({ to: FRIEND, body: LINK })).status).toBe(200);
    const r = await postRequest(h, { to: FRIEND, text: LINK });
    expect(r.status).toBe(202);
    expect((await approve(h, ((await r.json()) as any).id)).status).toBe(200);
    expect(await sentTo()).toEqual([FRIEND, FRIEND]);
  });

  it.each([LINK, "see example.com", "ex\u200Bample.com", "go to 192.168.1.1/x"])('BLOCK_LINKS="1": direct body %j → 400 links_not_allowed, nothing sent', async (body) => {
    await h.setEnv({ BLOCK_LINKS: "1" });
    await expectError(await direct({ to: FRIEND, body }), 400, "links_not_allowed");
    await expectError(await direct({ to_name: "Test Friend", body }), 400, "links_not_allowed");
    await expectError(await direct({ to_name: "Test Friend", body, resolve: true }), 400, "links_not_allowed");
    expect(h.messagesPosted()).toHaveLength(0);
    expect(await count("SELECT COUNT(*) AS c FROM direct_sends")).toBe(0);
    expect(await count("SELECT COUNT(*) AS c FROM candidates")).toBe(0);
  });

  it('BLOCK_LINKS="1": a candidate_id send with a link is refused and the candidate stays unused', async () => {
    const res = (await (await direct({ to_name: "Test Friend", resolve: true })).json()) as any;
    await h.setEnv({ BLOCK_LINKS: "1" });
    const id = res.candidates[0].candidate_id;
    await expectError(await direct({ candidate_id: id, body: LINK }), 400, "links_not_allowed");
    expect(await count("SELECT COUNT(*) AS c FROM candidates WHERE used=1")).toBe(0);
    expect((await direct({ candidate_id: id, body: "no link here" })).status).toBe(200);
  });

  it('BLOCK_LINKS="1": tap request with a link → 400 links_not_allowed, nothing queued, owner not notified', async () => {
    await h.setEnv({ BLOCK_LINKS: "1" });
    await expectError(await postRequest(h, { to: FRIEND, text: LINK }), 400, "links_not_allowed");
    expect(await count("SELECT COUNT(*) AS c FROM requests")).toBe(0);
    expect(h.messagesPosted()).toHaveLength(0);
    expect((await postRequest(h, { to: FRIEND, text: "plain text" })).status).toBe(202);
  });

  it.each(["yes", "true", "on", "1 ", "01", "2"])("BLOCK_LINKS=%j (garbage) fails closed on both flows", async (v) => {
    await h.setEnv({ BLOCK_LINKS: v });
    await expectError(await direct({ to: FRIEND, body: "plain" }), 503, "direct_config_invalid");
    await expectError(await postRequest(h, { to: FRIEND, text: "plain" }), 503, "config_invalid");
    expect(h.messagesPosted()).toHaveLength(0);
  });

  it("the notice-name link check stays on whatever BLOCK_LINKS says", async () => {
    await h.setEnv({ BLOCK_LINKS: "0", ALLOWLIST: JSON.stringify({ [FRIEND]: "visit example.com", [TWO]: "Test Two" }) });
    expect((await postRequest(h, { to: FRIEND, text: "hi" })).status).toBe(202);
    const [notice] = await ownerTexts();
    expect(notice).not.toContain("example.com");
  });
});

describe("tap limits are configurable; garbage fails closed", () => {
  const VARS = ["PENDING_CAP_PER_DAY", "SEND_CAP_INITIAL", "SEND_CAP_AFTER", "CAP_RAISE_AFTER_DAYS", "REQUEST_TTL_SECONDS", "MIN_SECONDS_BETWEEN_SENDS", "MAX_TEXT_CHARS"];
  const GARBAGE = ["abc", "-1", "1.5", " 5", "5 ", "1e3", "99999999"];
  it.each(VARS.flatMap((k) => GARBAGE.map((g) => [k, g])))("%s=%j → POST /request 503 config_invalid, nothing queued", async (k, g) => {
    await h.setEnv({ [k]: g });
    await expectError(await postRequest(h, { to: FRIEND, text: "hi" }), 503, "config_invalid");
    expect(await count("SELECT COUNT(*) AS c FROM requests")).toBe(0);
    expect(h.messagesPosted()).toHaveLength(0);
  });

  it.each(VARS)("%s garbage at approve time → 503 config_invalid, nothing sent; deny still works", async (k) => {
    const id = (await (await postRequest(h, { to: FRIEND, text: "hi" })).json() as any).id;
    await h.setEnv({ [k]: "garbage" });
    await expectError(await approve(h, id), 503, "config_invalid");
    expect(await sentTo()).toEqual([]);
    expect(await (await approve(h, id, "deny")).json()).toMatchObject({ state: "denied" });
  });

  it.each([
    ["PENDING_CAP_PER_DAY", "0"], ["SEND_CAP_INITIAL", "0"], ["SEND_CAP_AFTER", "0"], ["REQUEST_TTL_SECONDS", "59"],
    ["MAX_TEXT_CHARS", "0"], ["MAX_TEXT_CHARS", "10001"], ["CAP_RAISE_AFTER_DAYS", "3651"], ["MIN_SECONDS_BETWEEN_SENDS", "86401"],
  ])("%s=%j is out of range → config_invalid", async (k, v) => {
    await h.setEnv({ [k]: v });
    await expectError(await postRequest(h, { to: FRIEND, text: "hi" }), 503, "config_invalid");
  });

  it("MAX_TEXT_CHARS garbage also refuses direct sends", async () => {
    await h.setEnv({ MAX_TEXT_CHARS: "lots" });
    await expectError(await direct({ to: FRIEND, body: "hi" }), 503, "config_invalid");
    expect(h.messagesPosted()).toHaveLength(0);
  });

  it("unset = the built-in defaults (20 pending, 15 min, 640 chars)", async () => {
    for (const k of VARS) await h.setEnv({ [k]: undefined as unknown as string });
    const r = (await (await postRequest(h, { to: FRIEND, text: "x".repeat(640) })).json()) as any;
    expect(r.expires_ms).toBe(T0 + 900_000);
    await expectError(await postRequest(h, { to: FRIEND, text: "x".repeat(641) }), 400, "text_too_long");
    for (let i = 1; i < 20; i++) expect((await postRequest(h, { to: FRIEND, text: `n${i}` })).status).toBe(202);
    await expectError(await postRequest(h, { to: FRIEND, text: "21st" }), 429, "request_cap_reached");
  });

  it("PENDING_CAP_PER_DAY=2: the 3rd request that day is refused", async () => {
    await h.setEnv({ PENDING_CAP_PER_DAY: "2" });
    expect((await postRequest(h, { to: FRIEND, text: "1" })).status).toBe(202);
    expect((await postRequest(h, { to: FRIEND, text: "2" })).status).toBe(202);
    await expectError(await postRequest(h, { to: FRIEND, text: "3" }), 429, "request_cap_reached");
  });

  it("REQUEST_TTL_SECONDS=120: expires after 2 minutes, and the notice says so", async () => {
    await h.setEnv({ REQUEST_TTL_SECONDS: "120" });
    const r = (await (await postRequest(h, { to: FRIEND, text: "hi" })).json()) as any;
    expect(r.expires_ms).toBe(T0 + 120_000);
    expect((await ownerTexts())[0]).toContain("Expires in 2 min.");
    h.setNow(T0 + 121_000);
    await expectError(await approve(h, r.id, "approve", { csrf: await csrfOf(h, r.id) }), 410, "expired");
  });

  it("MAX_TEXT_CHARS=10 applies to both flows", async () => {
    await h.setEnv({ MAX_TEXT_CHARS: "10" });
    await expectError(await postRequest(h, { to: FRIEND, text: "x".repeat(11) }), 400, "text_too_long");
    expect((await postRequest(h, { to: FRIEND, text: "x".repeat(10) })).status).toBe(202);
    await expectError(await direct({ to: FRIEND, body: "y".repeat(11) }), 400, "text_too_long");
    expect((await direct({ to: FRIEND, body: "y".repeat(10) })).status).toBe(200);
  });

  async function approvedSends(n: number, stepMs: number) {
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      h.setNow(T0 + i * stepMs);
      const id = (await (await postRequest(h, { to: FRIEND, text: `m${i}` })).json() as any).id;
      out.push((await approve(h, id)).status);
    }
    return out;
  }

  it("SEND_CAP_AFTER=2 (day 15, past the raise): the 3rd approval that day is refused", async () => {
    await h.setEnv({ SEND_CAP_AFTER: "2" });
    expect(await approvedSends(3, 60_000)).toEqual([200, 200, 429]);
  });

  it("SEND_CAP_INITIAL=2 with CAP_RAISE_AFTER_DAYS=30 (day 15 is still early): the 3rd is refused", async () => {
    await h.setEnv({ SEND_CAP_INITIAL: "2", CAP_RAISE_AFTER_DAYS: "30" });
    expect(await approvedSends(3, 60_000)).toEqual([200, 200, 429]);
  });

  it("CAP_RAISE_AFTER_DAYS=0: the higher cap applies from the start date", async () => {
    await h.setEnv({ SEND_CAP_INITIAL: "1", SEND_CAP_AFTER: "3", CAP_RAISE_AFTER_DAYS: "0" });
    expect(await approvedSends(4, 60_000)).toEqual([200, 200, 200, 429]);
  });

  it("MIN_SECONDS_BETWEEN_SENDS=0 allows back-to-back approvals; =120 refuses one 60 s later", async () => {
    await h.setEnv({ MIN_SECONDS_BETWEEN_SENDS: "0" });
    expect(await approvedSends(2, 0)).toEqual([200, 200]);
    const h2 = h;
    h = await harness();
    await h.setEnv({ MIN_SECONDS_BETWEEN_SENDS: "120" });
    const res = await approvedSends(2, 60_000);
    expect(res).toEqual([200, 429]);
    h = h2;
  });
});
