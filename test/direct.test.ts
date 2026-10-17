import { describe, it, expect, beforeEach } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import { harness, postRequest, approve, API, BASE, OWNER, FRIEND, TWO, STRANGER, T0, type Harness } from "./helpers";
import { sha256Hex, hmacHex, importHmacKey } from "../src/e2e";

const TEST_KEY = "TEST-ONLY-log-hash-key-not-a-real-secret";
const hm = async (s: string, k = TEST_KEY) => hmacHex(await importHmacKey(k), s);

// Fake contacts only (555-01xx range). FRIEND is in contacts and on the tap list; TWO is on the tap list only.
// Direct flow: the bot gets the owner's yes in chat, so /send has no approval step. It texts anyone on the union of
// contacts and the tap ALLOWLIST, and refuses everything else (never a pending tap request).
const OTHER = "+15555550198";
const KB = "+15555550111", KO = "+15555550112", ZM = "+15555550113", ZU = "+15555550114", PM = "+15555550115", JN = "+15555550116";
const SNAPSHOT = {
  generated_at: "2026-10-16T23:00:00Z",
  contacts: [
    { name: "Test Friend", given: "Test", numbers: [{ e164: FRIEND, label: "mobile" }] },
    { name: "Jordan Bauer", given: "Jordan", numbers: [{ e164: KB, label: "mobile" }] },
    { name: "Jordan Ortiz", given: "Jordan", numbers: [{ e164: KO, label: "mobile" }] },
    { name: "Zoë Hall", given: "Zoë", numbers: [{ e164: ZM, label: "mobile" }, { e164: ZU, label: "unlabeled" }] },
    { name: "Coach Taylor", numbers: [{ e164: PM, label: "unlabeled" }] },
    { name: "José  Núñez", given: "José", numbers: [{ e164: JN, label: "mobile" }] },
  ],
};

let h: Harness;
const runIn = runInDurableObject as unknown as (s: unknown, f: (i: any) => Promise<any>) => Promise<any>;
const sql = (q: string, ...a: unknown[]) => runIn(h.relay, async (i) => i.ctx.storage.sql.exec(q, ...a).toArray()) as Promise<any[]>;
const count = async (q: string, ...a: unknown[]) => (await sql(q, ...a))[0].c as number;
const logRows = () => sql("SELECT event, request_id, recipient, sha256, detail FROM log ORDER BY seq");
const direct = (body: unknown, token = "TEST-ONLY-request-token") =>
  h.relay.fetch(`${API}/send`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
async function upload(snap: unknown = SNAPSHOT, opts: { jwt?: string | null; ct?: string; origin?: string } = {}) {
  const headers: Record<string, string> = { "content-type": opts.ct ?? "application/json" };
  const jwt = opts.jwt === undefined ? await h.jwt() : opts.jwt;
  if (jwt) headers["Cf-Access-Jwt-Assertion"] = jwt;
  if (opts.origin) headers.Origin = opts.origin;
  return h.relay.fetch(`${BASE}/contacts`, { method: "POST", headers, body: JSON.stringify(snap) });
}
async function posted() {
  return Promise.all(h.messagesPosted().map(async (m) => ({ to: await h.decrypt(m.phoneNumbers[0]), text: await h.decrypt(m.textMessage.text) })));
}
const sentTo = async () => (await posted()).filter((p) => p.to !== OWNER).map((p) => p.to);
const ownerTexts = async () => (await posted()).filter((p) => p.to === OWNER).map((p) => p.text);
const ON = { DIRECT_SEND: "1" };

/** A refused direct request: right status and code, nothing sent to anyone, nothing queued for approval. */
async function expectRefused(r: Response, status: number, code: string) {
  expect(r.status).toBe(status);
  expect(await r.json()).toEqual({ error: code });
  expect(await count("SELECT COUNT(*) AS c FROM requests")).toBe(0);
}

beforeEach(async () => {
  h = await harness();
  await h.setEnv(ON);
  expect((await upload()).status).toBe(200);
  h.calls.length = 0;
});

describe("flag", () => {
  it.each([undefined, "0", "true", "TRUE", "yes", " 1", "1 ", "01"])("DIRECT_SEND=%j → 403 direct_send_off, nothing sent or stored", async (flag) => {
    await h.setEnv({ DIRECT_SEND: flag as unknown as string });
    const r = await direct({ to: FRIEND, body: "hi" });
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: "direct_send_off" });
    expect(h.calls).toHaveLength(0);
    expect(await count("SELECT COUNT(*) AS c FROM requests")).toBe(0);
    expect(await count("SELECT COUNT(*) AS c FROM direct_sends")).toBe(0);
    // the tap flow is untouched
    expect((await postRequest(h, { to: FRIEND, text: "hi" })).status).toBe(202);
  });

  it("DISABLED kill switch stops direct sends", async () => {
    await h.setEnv({ DISABLED: "1" });
    const r = await direct({ to: FRIEND, body: "hi" });
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ error: "relay_disabled" });
    expect(h.calls).toHaveLength(0);
    expect(await count("SELECT COUNT(*) AS c FROM direct_sends")).toBe(0);
  });

  it("uses REQUEST_TOKEN: a wrong or missing token is refused before anything else", async () => {
    expect((await direct({ to: FRIEND, body: "hi" }, "TEST-ONLY-wrong")).status).toBe(401);
    const r = await h.relay.fetch(`${API}/send`, { method: "POST", body: JSON.stringify({ to: FRIEND, body: "hi" }) });
    expect(r.status).toBe(401);
    expect(h.calls).toHaveLength(0);
  });

  it("/send only exists on the request host", async () => {
    const r = await h.relay.fetch(`${BASE}/send`, { method: "POST", headers: { Authorization: "Bearer TEST-ONLY-request-token" }, body: "{}" });
    expect(r.status).toBe(404);
  });
});

describe("raw number", () => {
  it("on the direct list → sent at once; response and log carry no number", async () => {
    const r = await direct({ to: FRIEND, body: "On my way" });
    expect(r.status).toBe(200);
    const body = (await r.json()) as any;
    expect(body).toMatchObject({ state: "sent", method: "direct", to: "Test Friend" });
    expect(await posted()).toEqual([{ to: FRIEND, text: "On my way" }]); // no copy to the owner by default
    const row = (await logRows()).find((x) => x.event === "direct_sent");
    expect(row.recipient).toBeNull();
    expect(row.sha256).toBe(`hmac:${await hm("body:On my way")}`);
    expect(row.sha256).not.toContain(await sha256Hex("On my way"));
    expect(row.detail).toContain(`to_hmac=${await hm(`num:${FRIEND}`)}`);
    expect(row.detail).not.toContain(await sha256Hex(FRIEND));
    expect(row.detail).toContain("method=direct via=number");
    expect(row.detail).toContain("label=Test Friend");
    expect(JSON.stringify(await logRows())).not.toContain("On my way");
  });

  it("on the tap ALLOWLIST only → also sent directly (union), with no approval step", async () => {
    const r = await direct({ to: TWO, body: "hello" });
    expect(await r.json()).toMatchObject({ state: "sent", method: "direct", to: "Test Two" });
    expect(await sentTo()).toEqual([TWO]);
    expect(await ownerTexts()).toEqual([]);
    expect(await count("SELECT COUNT(*) AS c FROM requests")).toBe(0);
  });

  it("tap ALLOWLIST labels are searchable by name too", async () => {
    expect(await (await direct({ to_name: "test two", body: "hi" })).json()).toMatchObject({ state: "sent", to: "Test Two" });
    expect(await sentTo()).toEqual([TWO]);
  });

  it("on neither list → refused, nothing sent or queued, refusal logged with the hash", async () => {
    const r = await direct({ to: STRANGER, body: "hello" });
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: "recipient_not_on_allowlist" });
    expect(h.calls).toHaveLength(0);
    expect(await count("SELECT COUNT(*) AS c FROM requests")).toBe(0);
    expect((await logRows()).find((x) => x.event === "direct_refused").detail).toContain(`to_hmac=${await hm(`num:${STRANGER}`)}`);
  });

  it.each([
    [{ to: [FRIEND, KB], body: "hi" }, "group_send_not_allowed"],
    [{ to: `${FRIEND},${KB}`, body: "hi" }, "group_send_not_allowed"],
    [{ to_name: ["Jordan Bauer", "Coach Taylor"], body: "hi" }, "group_send_not_allowed"],
    [{ to: FRIEND, to_name: "Jordan Bauer", body: "hi" }, "exactly_one_of_to_to_name_candidate_id"],
    [{ body: "hi" }, "exactly_one_of_to_to_name_candidate_id"],
    [{ to: FRIEND, body: "hi", cc: KB }, "unknown_fields"],
    [{ to: FRIEND, body: "" }, "empty_text"],
    [{ to: "5555550111", body: "hi" }, "recipient_must_be_one_e164_number"],
  ])("%j → %s, nothing sent", async (req, code) => {
    const r = await direct(req);
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: code });
    expect(h.calls).toHaveLength(0);
    expect(await count("SELECT COUNT(*) AS c FROM requests")).toBe(0);
  });
});

describe("to_name", () => {
  it.each(["Jordan Bauer", "jordan bauer", "  JORDAN   Bauer "])("unique full-name match %j → sent", async (name) => {
    const r = await direct({ to_name: name, body: "hi" });
    expect(await r.json()).toMatchObject({ state: "sent", to: "Jordan Bauer" });
    expect(await sentTo()).toEqual([KB]);
    expect((await logRows()).find((x) => x.event === "direct_sent").detail).toContain("via=name");
  });

  it.each([["jose nunez", JN], ["José", JN], ["JOSE", JN], ["coach", PM], ["Coach Taylor", PM]])("diacritics, given name and first word: %j → sent", async (name, num) => {
    expect(await (await direct({ to_name: name, body: "hi" })).json()).toMatchObject({ state: "sent" });
    expect(await sentTo()).toEqual([num]);
  });

  it("ambiguous (two contacts) → candidates with name and label only, nothing sent", async () => {
    const r = await direct({ to_name: "jordan", body: "hi" });
    expect(r.status).toBe(200);
    const body = (await r.json()) as any;
    expect(body.state).toBe("ambiguous");
    expect(body.candidates.map((c: any) => c.label).sort()).toEqual(["Jordan Bauer (mobile)", "Jordan Ortiz (mobile)"]);
    for (const c of body.candidates) {
      expect(Object.keys(c).sort()).toEqual(["candidate_id", "label"]);
      expect(c.candidate_id).toMatch(/^[a-f0-9]{32}$/);
    }
    expect(h.calls).toHaveLength(0);
    expect(await count("SELECT COUNT(*) AS c FROM requests")).toBe(0);
    for (const c of body.candidates) expect(c.label).not.toMatch(/\d/); // ids are random hex and may contain any digits; labels never do
  });

  it("one contact with two kept numbers counts as two candidates", async () => {
    const body = (await (await direct({ to_name: "zoe hall", body: "hi" })).json()) as any;
    expect(body.state).toBe("ambiguous");
    expect(body.candidates.map((c: any) => c.label).sort()).toEqual(["Zoë Hall (mobile)", "Zoë Hall (unlabeled)"]);
    expect(h.calls).toHaveLength(0);
  });

  it.each(["Jor", "Bauer", "Jordan B", "", "   ", "Nobody"])("no match %j → none, nothing sent or queued", async (name) => {
    const r = await direct({ to_name: name, body: "hi" });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ state: "no_match", candidates: [] });
    expect(h.calls).toHaveLength(0);
    expect(await count("SELECT COUNT(*) AS c FROM requests")).toBe(0);
  });

  it("a name whose display text is a number is never echoed", async () => {
    await upload({ generated_at: "2026-10-16T23:00:00Z", contacts: [
      { name: "555-555-0117", given: "Plumber", numbers: [{ e164: "+15555550117", label: "mobile" }] },
      { name: "Plumber Two", numbers: [{ e164: "+15555550118", label: "mobile" }] },
    ] });
    const body = (await (await direct({ to_name: "plumber", body: "hi" })).json()) as any;
    expect(body.candidates.map((c: any) => c.label).sort()).toEqual(["(unnamed contact) (mobile)", "Plumber Two (mobile)"]);
  });
});

describe("candidate_id", () => {
  async function candidates(name = "jordan") {
    const body = (await (await direct({ to_name: name, body: "hi" })).json()) as any;
    return body.candidates as { candidate_id: string; label: string }[];
  }

  it("happy path sends to that number; the id and its siblings are then used up", async () => {
    const c = await candidates();
    const ortiz = c.find((x) => x.label.startsWith("Jordan Ortiz"))!;
    const other = c.find((x) => x !== ortiz)!;
    const r = await direct({ candidate_id: ortiz.candidate_id, body: "hey Jordan" });
    expect(await r.json()).toMatchObject({ state: "sent", to: "Jordan Ortiz" });
    expect(await sentTo()).toEqual([KO]);
    expect((await logRows()).find((x) => x.event === "direct_sent").detail).toContain("via=candidate");
    for (const id of [ortiz.candidate_id, other.candidate_id]) {
      const again = await direct({ candidate_id: id, body: "again" });
      expect(again.status).toBe(409);
      expect(await again.json()).toEqual({ error: "candidate_used" });
    }
    expect(await sentTo()).toEqual([KO]);
  });

  it("expired after 15 minutes", async () => {
    const [c] = await candidates();
    h.setNow(T0 + 15 * 60_000);
    const r = await direct({ candidate_id: c.candidate_id, body: "hi" });
    expect(r.status).toBe(410);
    expect(await r.json()).toEqual({ error: "candidate_expired" });
    expect(h.calls).toHaveLength(0);
  });

  it("still valid just before 15 minutes", async () => {
    const [c] = await candidates();
    h.setNow(T0 + 15 * 60_000 - 1);
    expect((await direct({ candidate_id: c.candidate_id, body: "hi" })).status).toBe(200);
  });

  it.each(["0".repeat(32), "f".repeat(32), "not-an-id", 42])("unknown %j → 404, nothing sent", async (id) => {
    const r = await direct({ candidate_id: id, body: "hi" });
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: "candidate_unknown" });
    expect(h.calls).toHaveLength(0);
  });

  it("a new contacts list retires outstanding ids", async () => {
    const [c] = await candidates();
    await upload();
    expect((await direct({ candidate_id: c.candidate_id, body: "hi" })).status).toBe(404);
  });

  it("live candidates are capped at 200; expired ones are cleared first", async () => {
    await h.setEnv({ DIRECT_LOOKUP_MAX_PER_HOUR: "off" }); // the cap is the backstop when the lookup limit is off or high
    for (let i = 0; i < 100; i++) expect(((await (await direct({ to_name: "jordan", body: "hi" })).json()) as any).state).toBe("ambiguous");
    const r = await direct({ to_name: "jordan", body: "hi" });
    expect(r.status).toBe(429);
    expect(await r.json()).toEqual({ error: "too_many_candidates" });
    expect(await count("SELECT COUNT(*) AS c FROM candidates")).toBe(200);
    h.setNow(T0 + 15 * 60_000);
    expect(((await (await direct({ to_name: "jordan", body: "hi" })).json()) as any).state).toBe("ambiguous");
    expect(await count("SELECT COUNT(*) AS c FROM candidates")).toBe(2);
    expect(h.calls).toHaveLength(0);
  });

  it("stores only the hash of the number for a candidate", async () => {
    await candidates();
    const rows = await sql("SELECT * FROM candidates");
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(JSON.stringify(r)).not.toMatch(/\+1555/);
      expect([await hm(`num:${KB}`), await hm(`num:${KO}`)]).toContain(r.to_sha);
    }
  });
});

describe("no default limits", () => {
  it("25 direct sends in the same second all go out when the runaway guard is off", async () => {
    await h.setEnv({ RUNAWAY_PAUSE: "0" });
    for (let i = 0; i < 25; i++) expect((await direct({ to: FRIEND, body: `n ${i}` })).status).toBe(200);
    expect(await sentTo()).toHaveLength(25);
  });

  it("direct sends don't use the tap send cap or spacing, and don't block tap approvals", async () => {
    await h.setEnv({ SEND_CAP_INITIAL: "1", SEND_CAP_AFTER: "1" });
    for (let i = 0; i < 3; i++) expect((await direct({ to: FRIEND, body: "x" })).status).toBe(200);
    expect(await count("SELECT COUNT(*) AS c FROM sends")).toBe(0);
    const { id } = (await (await postRequest(h, { to: TWO, text: "tap" })).json()) as any;
    expect((await approve(h, id)).status).toBe(200);
  });
});

describe("optional limits (off by default)", () => {
  it.each([
    ["DIRECT_DAILY_CAP", "0"], ["DIRECT_DAILY_CAP", "-1"], ["DIRECT_DAILY_CAP", "ten"], ["DIRECT_DAILY_CAP", " 5"], ["DIRECT_DAILY_CAP", "2.5"],
    ["DIRECT_PER_MINUTE_MAX", "0"], ["DIRECT_PER_MINUTE_MAX", "1e2"],
    ["DIRECT_HOURS", "8-21"], ["DIRECT_HOURS", "08:00-08:00"], ["DIRECT_HOURS", "25:00-26:00"],
    ["DIRECT_NOTIFY_EACH", "yes"], ["DIRECT_NOTIFY_EACH", "true"],
    ["RUNAWAY_MAX", "off"], ["RUNAWAY_MAX", "0"], ["RUNAWAY_MAX", "abc"],
  ])("%s=%j is garbage → 503 direct_config_invalid, nothing sent or stored (fail closed)", async (k, v) => {
    await h.setEnv({ [k]: v });
    const r = await direct({ to: FRIEND, body: "hi" });
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ error: "direct_config_invalid" });
    expect(h.calls).toHaveLength(0);
    expect(await count("SELECT COUNT(*) AS c FROM requests")).toBe(0);
  });

  it.each([["DIRECT_DAILY_CAP", "off"], ["DIRECT_DAILY_CAP", "OFF"], ["DIRECT_DAILY_CAP", ""], ["DIRECT_HOURS", "off"], ["DIRECT_NOTIFY_EACH", "0"]])("%s=%j means no limit", async (k, v) => {
    await h.setEnv({ [k]: v });
    for (let i = 0; i < 3; i++) expect((await direct({ to: FRIEND, body: "x" })).status).toBe(200);
  });

  it("DIRECT_DAILY_CAP: over the cap is refused, and resets at local (TIMEZONE) midnight", async () => {
    await h.setEnv({ DIRECT_DAILY_CAP: "2" });
    h.setNow(Date.parse("2026-10-16T17:00:00-06:00"));
    expect((await direct({ to: FRIEND, body: "a" })).status).toBe(200);
    expect((await direct({ to: FRIEND, body: "b" })).status).toBe(200);
    h.setNow(Date.parse("2026-10-16T18:30:00-06:00")); // UTC day changed, local day didn't
    await expectRefused(await direct({ to: FRIEND, body: "c" }), 429, "direct_daily_cap_reached");
    h.setNow(Date.parse("2026-10-17T00:01:00-06:00"));
    expect((await direct({ to: FRIEND, body: "d" })).status).toBe(200);
    expect(await sentTo()).toHaveLength(3);
  });

  it("DIRECT_PER_MINUTE_MAX: the 2nd within 60 s is refused; after 60 s it sends", async () => {
    await h.setEnv({ DIRECT_PER_MINUTE_MAX: "1" });
    expect((await direct({ to: FRIEND, body: "a" })).status).toBe(200);
    h.setNow(T0 + 59_000);
    await expectRefused(await direct({ to: FRIEND, body: "b" }), 429, "direct_per_minute_reached");
    h.setNow(T0 + 60_001);
    expect((await direct({ to: FRIEND, body: "c" })).status).toBe(200);
  });

  it("DIRECT_HOURS: outside the window is refused (window may wrap midnight)", async () => {
    await h.setEnv({ DIRECT_HOURS: "08:00-21:00" });
    expect((await direct({ to: FRIEND, body: "a" })).status).toBe(200); // 6 PM
    h.setNow(Date.parse("2026-10-16T21:00:00-06:00"));
    await expectRefused(await direct({ to: FRIEND, body: "b" }), 429, "direct_outside_hours");
    await h.setEnv({ DIRECT_HOURS: "20:00-02:00" });
    h.setNow(Date.parse("2026-10-17T01:30:00-06:00"));
    expect((await direct({ to: FRIEND, body: "c" })).status).toBe(200);
  });

  it("a limit applies to every way in (name and candidate too) and is logged", async () => {
    await h.setEnv({ DIRECT_DAILY_CAP: "1" });
    expect((await direct({ to: FRIEND, body: "a" })).status).toBe(200);
    await expectRefused(await direct({ to_name: "Jordan Bauer", body: "b" }), 429, "direct_daily_cap_reached");
    const c = ((await (await direct({ to_name: "jordan", body: "b" })).json()) as any).candidates[0];
    await expectRefused(await direct({ candidate_id: c.candidate_id, body: "b" }), 429, "direct_daily_cap_reached");
    expect(await sentTo()).toEqual([FRIEND]);
    expect((await logRows()).filter((x) => x.event === "direct_refused").map((x) => x.detail.match(/reason=(\w+)/)![1])).toEqual(["direct_daily_cap_reached", "direct_daily_cap_reached"]);
  });

  it("DIRECT_NOTIFY_EACH=1 texts the owner a copy (label, 80-char preview, local time, log link)", async () => {
    await h.setEnv({ DIRECT_NOTIFY_EACH: "1" });
    const text = "b".repeat(80) + "TAIL";
    expect(await (await direct({ to_name: "Jordan Bauer", body: text })).json()).toMatchObject({ state: "sent", notified: true });
    const [note] = await ownerTexts();
    expect(note).toContain("Jordan Bauer");
    expect(note).toContain('"' + "b".repeat(80) + "…\"");
    expect(note).not.toContain("TAIL");
    expect(note).toContain("6:00 PM MDT");
    expect(note).toContain("https://approve.example.test/log");
  });

  it("DIRECT_NOTIFY_EACH failure: the send stands, the failure is logged loudly", async () => {
    await h.setEnv({ DIRECT_NOTIFY_EACH: "1", OWNER_NUMBER: "bad" });
    expect(await (await direct({ to: FRIEND, body: "x" })).json()).toMatchObject({ state: "sent", notified: false });
    expect((await logRows()).find((x) => x.event === "direct_notify_failed").detail).toBe("owner_number_not_configured");
  });

  it.each([undefined, "", "bad", "5555550100"])("OWNER_NUMBER=%j is not E.164: notices fail with owner_number_not_configured, never sent", async (v) => {
    await h.setEnv({ OWNER_NUMBER: v as unknown as string });
    const r = await postRequest(h, { to: FRIEND, text: "hi" });
    expect(await r.json()).toMatchObject({ state: "pending", notified: false });
    expect((await logRows()).find((x) => x.event === "notify_failed").detail).toBe("owner_number_not_configured");
    expect(h.messagesPosted()).toHaveLength(0);
  });
});

describe("runaway pause", () => {
  async function pausePage() {
    const r = await h.relay.fetch(`${BASE}/direct`, { headers: { "Cf-Access-Jwt-Assertion": await h.jwt() } });
    const html = await r.text();
    return { html, csrf: html.match(/name=csrf value="([a-f0-9]+)"/)?.[1] ?? "" };
  }
  const resume = async (csrf: string, origin: string | null = BASE, extra: Record<string, string> = {}) =>
    h.relay.fetch(`${BASE}/direct/resume`, {
      method: "POST",
      headers: { "Cf-Access-Jwt-Assertion": await h.jwt(), "content-type": "application/x-www-form-urlencoded", ...(origin ? { Origin: origin } : {}), ...extra },
      body: new URLSearchParams({ csrf }).toString(),
    });

  it("default max 10: the 11th direct send in 60 min pauses, texts the owner once, is refused; stays paused until the owner resumes", async () => {
    for (let i = 0; i < 10; i++) expect((await direct({ to: FRIEND, body: `n${i}` })).status).toBe(200);
    const r = await direct({ to: FRIEND, body: "eleven" });
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ error: "direct_paused" });
    expect(await sentTo()).toHaveLength(10);
    expect(await count("SELECT COUNT(*) AS c FROM requests")).toBe(0); // no tap fallback
    const pauseTexts = () => ownerTexts().then((t) => t.filter((x) => x.includes("PAUSED")));
    expect(await pauseTexts()).toHaveLength(1);
    expect((await pauseTexts())[0]).toContain("https://approve.example.test/direct");
    expect(await sql("SELECT v FROM meta WHERE k='direct_paused'")).toEqual([{ v: "1" }]);
    // later requests still fall back, no second pause text, even 2 hours later
    h.setNow(T0 + 2 * 3_600_000);
    expect(await (await direct({ to: FRIEND, body: "later" })).json()).toEqual({ error: "direct_paused" });
    expect(await (await direct({ to_name: "Jordan Bauer", body: "x" })).json()).toEqual({ error: "direct_paused" });
    expect(await pauseTexts()).toHaveLength(1);
    expect(await sentTo()).toHaveLength(10);
    // The owner resumes from the approve page
    const page = await pausePage();
    expect(page.html).toContain("PAUSED");
    expect((await resume(page.csrf)).status).toBe(200);
    expect((await logRows()).find((x) => x.event === "direct_resumed").detail).toContain("by=approver@example.test");
    expect((await direct({ to: FRIEND, body: "back" })).status).toBe(200);
  });

  it("RUNAWAY_MAX counts a rolling 60 minutes", async () => {
    await h.setEnv({ RUNAWAY_MAX: "2" });
    expect((await direct({ to: FRIEND, body: "a" })).status).toBe(200);
    expect((await direct({ to: FRIEND, body: "b" })).status).toBe(200);
    h.setNow(T0 + 60 * 60_000 + 1);
    expect((await direct({ to: FRIEND, body: "c" })).status).toBe(200);
  });

  it("after a resume the window restarts, so the next send doesn't re-pause at once", async () => {
    await h.setEnv({ RUNAWAY_MAX: "1" });
    expect((await direct({ to: FRIEND, body: "a" })).status).toBe(200);
    expect((await direct({ to: FRIEND, body: "b" })).status).toBe(503);
    h.setNow(T0 + 60_000);
    expect((await resume((await pausePage()).csrf)).status).toBe(200);
    h.setNow(T0 + 61_000);
    expect((await direct({ to: FRIEND, body: "c" })).status).toBe(200);
  });

  it("RUNAWAY_PAUSE=0 turns the guard off", async () => {
    await h.setEnv({ RUNAWAY_PAUSE: "0", RUNAWAY_MAX: "1" });
    for (let i = 0; i < 4; i++) expect((await direct({ to: FRIEND, body: "x" })).status).toBe(200);
  });

  it.each([undefined, "1", "yes", "off"])("RUNAWAY_PAUSE=%j keeps the guard on (only exact \"0\" turns it off)", async (v) => {
    await h.setEnv({ RUNAWAY_PAUSE: v as unknown as string, RUNAWAY_MAX: "1" });
    expect((await direct({ to: FRIEND, body: "a" })).status).toBe(200);
    expect(await (await direct({ to: FRIEND, body: "b" })).json()).toEqual({ error: "direct_paused" });
  });

  it("concurrent requests can't both slip under the max", async () => {
    await h.setEnv({ RUNAWAY_MAX: "1" });
    const rs = await Promise.all([direct({ to: FRIEND, body: "a" }), direct({ to: FRIEND, body: "b" })]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 503]);
    expect(await sentTo()).toHaveLength(1);
  });

  it("resume needs Access, same Origin, and the page's single-use CSRF; refuses when not paused", async () => {
    await h.setEnv({ RUNAWAY_MAX: "1" });
    await direct({ to: FRIEND, body: "a" });
    await direct({ to: FRIEND, body: "b" });
    const { csrf } = await pausePage();
    expect((await resume("0".repeat(32))).status).toBe(403);
    expect((await resume(csrf, null)).status).toBe(403);
    expect((await resume(csrf, "https://evil.example.test")).status).toBe(403);
    const noJwt = await h.relay.fetch(`${BASE}/direct/resume`, { method: "POST", headers: { Origin: BASE, "content-type": "application/x-www-form-urlencoded" }, body: `csrf=${csrf}` });
    expect(noJwt.status).toBe(403);
    expect((await resume(csrf, BASE, { Authorization: "Bearer TEST-ONLY-request-token" })).status).toBe(403);
    expect(await sql("SELECT v FROM meta WHERE k='direct_paused'")).toEqual([{ v: "1" }]);
    const fresh = (await pausePage()).csrf;
    expect((await resume(fresh)).status).toBe(200);
    expect((await resume(fresh)).status).toBe(403); // used
    await pausePage(); // not paused: no form is shown, but the page still issues a token
    const again = await resume((await sql("SELECT v FROM meta WHERE k='direct_csrf'"))[0].v);
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: "not_paused" });
  });

  it("the request token can't resume (wrong host)", async () => {
    const r = await h.relay.fetch(`${API}/direct/resume`, { method: "POST", headers: { Authorization: "Bearer TEST-ONLY-request-token" } });
    expect(r.status).toBe(404);
  });
});

describe("contacts snapshot upload", () => {
  it("needs Access, JSON, and same or no Origin", async () => {
    expect((await upload(SNAPSHOT, { jwt: null })).status).toBe(403);
    expect((await upload(SNAPSHOT, { ct: "text/plain" })).status).toBe(415);
    expect((await upload(SNAPSHOT, { origin: "https://evil.example.test" })).status).toBe(403);
    expect((await upload(SNAPSHOT, { origin: BASE })).status).toBe(200);
    const viaToken = await h.relay.fetch(`${API}/contacts`, { method: "POST", headers: { Authorization: "Bearer TEST-ONLY-request-token", "content-type": "application/json" }, body: JSON.stringify(SNAPSHOT) });
    expect(viaToken.status).toBe(404);
  });

  it.each([
    [{ ...SNAPSHOT, extra: 1 }, "unknown_field"],
    [{ generated_at: "2026-10-16T23:00:00Z", contacts: [{ name: "A", email: "a@x.test", numbers: [] }] }, "unknown_field"],
    [{ generated_at: "2026-10-16T23:00:00Z", contacts: [{ name: "A", numbers: [{ e164: KB, label: "mobile", note: "x" }] }] }, "unknown_field"],
    [{ generated_at: "2026-10-16T23:00:00Z", contacts: [{ name: "A", numbers: [{ e164: KB, label: "home fax" }] }] }, "label"],
    [{ generated_at: "2026-10-16T23:00:00Z", contacts: [{ name: "A", numbers: [{ e164: KB, label: "pager" }] }] }, "label"],
    [{ generated_at: "2026-10-16T23:00:00Z", contacts: [{ name: "A", numbers: [{ e164: KB, label: "Home" }] }] }, "label"],
    [{ generated_at: "2026-10-16T23:00:00Z", contacts: [{ name: "A", numbers: [{ e164: KB, label: "ext 5550101" }] }] }, "label"],
    [{ generated_at: "2026-10-16T23:00:00Z", contacts: [{ name: "A", numbers: [{ e164: "5555550111", label: "mobile" }] }] }, "e164"],
    [{ generated_at: "yesterday", contacts: [] }, "generated_at"],
    [{ generated_at: "2026-10-16T23:00:00Z", contacts: [] }, "empty"],
    [{ generated_at: "2026-10-16T23:00:00Z", contacts: [{ name: "A", numbers: [] }] }, "empty"],
  ])("refuses %j (%s), keeps the old list", async (snap, why) => {
    const r = await upload(snap);
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: `contacts_snapshot_invalid_${why}` });
    expect(await count("SELECT COUNT(*) AS c FROM contacts")).toBe(7);
  });

  it("dedupes numbers, logs time and count, and /direct shows them", async () => {
    const r = await upload({ generated_at: "2026-10-17T05:00:00Z", contacts: [
      { name: "A Person", numbers: [{ e164: KB, label: "mobile" }, { e164: KB, label: "unlabeled" }] },
      { name: "B Person", numbers: [{ e164: KB, label: "mobile" }, { e164: KO, label: "mobile" }] },
    ] });
    expect(await r.json()).toEqual({ contacts: 2, numbers: 2, generated_at: "2026-10-17T05:00:00Z" });
    expect((await logRows()).filter((x) => x.event === "contacts_snapshot").at(-1).detail).toContain("contacts=2 numbers=2 generated_at=2026-10-17T05:00:00Z");
    const page = await (await h.relay.fetch(`${BASE}/direct`, { headers: { "Cf-Access-Jwt-Assertion": await h.jwt() } })).text();
    expect(page).toContain("2 numbers under 2 distinct names");
    expect(page).toContain("UPLOAD: 2 numbers, last good");
    // the old list is gone (Coach Taylor was only in the old snapshot)
    expect((await direct({ to: PM, body: "x" })).status).toBe(403);
  });
});

describe("CONTACTS_SNAPSHOT_ONLY", () => {
  it.each([undefined, "1", "yes"])("%j (on): the DIRECT_ALLOWLIST secret is ignored", async (v) => {
    await h.setEnv({ CONTACTS_SNAPSHOT_ONLY: v as unknown as string, DIRECT_ALLOWLIST: JSON.stringify({ [OTHER]: "Other Person" }) });
    await expectRefused(await direct({ to: OTHER, body: "x" }), 403, "recipient_not_on_allowlist");
    expect(await (await direct({ to_name: "Other Person", body: "x" })).json()).toEqual({ state: "no_match", candidates: [] });
  });

  it("\"0\" (off): DIRECT_ALLOWLIST numbers are also direct", async () => {
    await h.setEnv({ CONTACTS_SNAPSHOT_ONLY: "0", DIRECT_ALLOWLIST: JSON.stringify({ [OTHER]: "Other Person" }) });
    expect(await (await direct({ to: OTHER, body: "x" })).json()).toMatchObject({ state: "sent", to: "Other Person" });
    expect(await sentTo()).toEqual([OTHER]);
  });
});

describe("retention", () => {
  it("direct_sends and old candidates are purged", async () => {
    await direct({ to: FRIEND, body: "x" });
    await direct({ to_name: "jordan", body: "x" });
    await runIn(h.relay, async (i) => i.purge(T0 + 8 * 86_400_000));
    expect(await count("SELECT COUNT(*) AS c FROM direct_sends")).toBe(0);
    expect(await count("SELECT COUNT(*) AS c FROM candidates")).toBe(0);
  });
});

describe("LOG_HASH_KEY (HMAC for number and body hashes)", () => {
  it.each([undefined, "", "TEST-ONLY-too-short"])("LOG_HASH_KEY=%j with DIRECT_SEND=1 → 503 direct_config_invalid, nothing sent", async (k) => {
    await h.setEnv({ LOG_HASH_KEY: k as unknown as string });
    for (const b of [{ to: FRIEND, body: "hi" }, { to_name: "jordan", body: "hi" }, { to: STRANGER, body: "hi" }]) {
      await expectRefused(await direct(b), 503, "direct_config_invalid");
    }
    expect(h.calls).toHaveLength(0);
    expect(await count("SELECT COUNT(*) AS c FROM direct_sends")).toBe(0);
    expect(await count("SELECT COUNT(*) AS c FROM candidates")).toBe(0);
  });

  it("without the key the tap flow still works; its log rows keep the plain SHA-256", async () => {
    await h.setEnv({ LOG_HASH_KEY: undefined as unknown as string });
    const r = await postRequest(h, { to: FRIEND, text: "tap no key" });
    expect(r.status).toBe(202);
    const { id, sha256 } = (await r.json()) as any;
    expect(sha256).toBe(await sha256Hex("tap no key"));
    expect((await approve(h, id)).status).toBe(200);
    for (const ev of ["request_created", "approved", "sent"]) expect((await logRows()).find((x) => x.event === ev).sha256).toBe(sha256);
  });

  it("with the key the tap API still returns the plain SHA-256, but its log rows carry the HMAC", async () => {
    const r = await postRequest(h, { to: FRIEND, text: "tap with key" });
    const { id, sha256 } = (await r.json()) as any;
    expect(sha256).toBe(await sha256Hex("tap with key"));
    expect((await approve(h, id)).status).toBe(200);
    const want = `hmac:${await hm("body:tap with key")}`;
    for (const ev of ["request_created", "approved", "sent"]) expect((await logRows()).find((x) => x.event === ev).sha256).toBe(want);
    expect(JSON.stringify(await logRows())).not.toContain(sha256);
  });

  it("stored contact hashes are HMACs; a key rotation re-hashes them before the next lookup", async () => {
    expect((await direct({ to_name: "jordan", body: "x" })).status).toBe(200);
    const rows = await sql("SELECT e164, e164_sha FROM contacts");
    for (const r of rows) expect(r.e164_sha).toBe(await hm(`num:${r.e164}`));
    const NEW = "TEST-ONLY-rotated-log-hash-key-000000";
    await h.setEnv({ LOG_HASH_KEY: NEW });
    const amb = (await (await direct({ to_name: "jordan", body: "x" })).json()) as any;
    expect(amb.state).toBe("ambiguous");
    for (const r of await sql("SELECT e164, e164_sha FROM contacts")) expect(r.e164_sha).toBe(await hm(`num:${r.e164}`, NEW));
    expect(await (await direct({ candidate_id: amb.candidates[0].candidate_id, body: "x" })).json()).toMatchObject({ state: "sent" });
    expect((await logRows()).find((x) => x.event === "direct_sent").detail).toMatch(new RegExp(`to_hmac=(${await hm(`num:${KB}`, NEW)}|${await hm(`num:${KO}`, NEW)})`));
  });

  it("a fresh upload stores no hashes until the next direct request", async () => {
    expect((await upload()).status).toBe(200);
    expect(await count("SELECT COUNT(*) AS c FROM contact_sources WHERE e164_sha IS NOT NULL")).toBe(0);
    await direct({ to: FRIEND, body: "x" });
    expect(await count("SELECT COUNT(*) AS c FROM contact_sources WHERE e164_sha IS NULL")).toBe(0);
  });
});

describe("gateway errors are fixed codes, never response snippets", () => {
  const breakGateway = (mode: "html" | "throw" | "status") =>
    runIn(h.relay, async (i) => {
      const base = i.net;
      i.net = async (req: Request) => {
        if (new URL(req.url).pathname === "/3rdparty/v1/messages") {
          if (mode === "html") return new Response("<html>TEST-ONLY upstream page</html>", { status: 200 });
          if (mode === "throw") throw new Error("TEST-ONLY upstream said: bad thing at /x");
          return new Response("TEST-ONLY body", { status: 502 });
        }
        return base(req);
      };
    });
  it.each([["html", "gateway_bad_json"], ["throw", "unexpected_error"], ["status", "gateway_status_502"]] as const)("%s → %s in direct and tap log rows", async (mode, code) => {
    await breakGateway(mode);
    expect((await direct({ to: FRIEND, body: "x" })).status).toBe(502);
    const { id } = (await (await postRequest(h, { to: FRIEND, text: "y" })).json()) as any;
    expect((await approve(h, id)).status).toBe(502);
    const rows = await logRows();
    expect(rows.find((x) => x.event === "direct_send_failed").detail).toMatch(new RegExp(` error=${code}$`));
    expect(rows.find((x) => x.event === "send_failed").detail).toBe(code);
    expect(JSON.stringify(rows)).not.toContain("TEST-ONLY");
  });
  it("an unexpected crash in a route logs a code, not the message", async () => {
    await runIn(h.relay, async (i) => {
      i.directList = async () => {
        throw new Error("TEST-ONLY crash text +15555550101");
      };
    });
    expect((await direct({ to: FRIEND, body: "x" })).status).toBe(500);
    expect((await logRows()).find((x) => x.event === "error").detail).toBe("unexpected_error");
  });
});

describe("link rule on names and the tap flow", () => {
  it("a contact whose name looks like a link is shown as (unnamed contact) everywhere", async () => {
    expect((await upload({ generated_at: "2026-10-17T05:00:00Z", contacts: [{ name: "evil\u200B\u3002com", numbers: [{ e164: KB, label: "mobile" }] }] })).status).toBe(200);
    await h.setEnv({ DIRECT_NOTIFY_EACH: "1" });
    expect(await (await direct({ to: KB, body: "x" })).json()).toMatchObject({ state: "sent", to: "(unnamed contact)" });
    expect((await ownerTexts())[0]).toContain("(unnamed contact)");
    expect(JSON.stringify(await logRows())).not.toContain("evil");
  });
  it("a link-like ALLOWLIST label is still kept out of the tap notice, while the text may carry a link", async () => {
    await h.setEnv({ ALLOWLIST: JSON.stringify({ [FRIEND]: "evil\u200B.com", [TWO]: "Test Two" }) });
    const r = await postRequest(h, { to: FRIEND, text: "Book: https://example.com/book/interview" });
    expect(r.status).toBe(202);
    const notice = (await ownerTexts()).at(-1)!;
    expect(notice).toContain("approval needed");
    expect(notice).not.toContain("evil");
  });
});

describe("phone labels", () => {
  it("home, work, main and custom labels are kept and shown in candidates", async () => {
    expect((await upload({ generated_at: "2026-10-17T05:00:00Z", contacts: [
      { name: "Jordan Bauer", given: "Jordan", numbers: [{ e164: KB, label: "home" }, { e164: KO, label: "work mobile" }] },
    ] })).status).toBe(200);
    const r = (await (await direct({ to_name: "jordan", body: "x" })).json()) as any;
    expect(r.candidates.map((c: any) => c.label).sort()).toEqual(["Jordan Bauer (home)", "Jordan Bauer (work mobile)"]);
  });
});

describe("resolve: true (read the name back before sending)", () => {
  it("one match → {state:'one', candidates:[{candidate_id,label}]}, nothing sent; then send by candidate_id", async () => {
    const r = await direct({ to_name: "Coach Taylor", resolve: true });
    expect(r.status).toBe(200);
    const j = (await r.json()) as any;
    expect(j.state).toBe("one");
    expect(j.candidates).toHaveLength(1);
    expect(j.candidates[0]).toEqual({ candidate_id: expect.stringMatching(/^[a-f0-9]{32}$/), label: "Coach Taylor (unlabeled)" });
    expect(h.calls).toHaveLength(0);
    expect(await count("SELECT COUNT(*) AS c FROM direct_sends")).toBe(0);
    expect(await (await direct({ candidate_id: j.candidates[0].candidate_id, body: "See you Sunday" })).json()).toMatchObject({ state: "sent", to: "Coach Taylor" });
    expect(await sentTo()).toEqual([PM]);
    expect((await direct({ candidate_id: j.candidates[0].candidate_id, body: "again" })).status).toBe(409);
  });

  it("several matches → ambiguous as usual; none → no_match; nothing sent", async () => {
    expect(((await (await direct({ to_name: "jordan", resolve: true, body: "hi" })).json()) as any).state).toBe("ambiguous");
    expect(await (await direct({ to_name: "nobody here", resolve: true })).json()).toEqual({ state: "no_match", candidates: [] });
    expect(h.calls).toHaveLength(0);
  });

  it.each([
    [{ to: FRIEND, resolve: true, body: "x" }, "resolve_needs_to_name"],
    [{ candidate_id: "0".repeat(32), resolve: true, body: "x" }, "resolve_needs_to_name"],
    [{ to_name: "Coach Taylor", resolve: "true", body: "x" }, "resolve_must_be_true"],
    [{ to_name: "Coach Taylor", resolve: false, body: "x" }, "resolve_must_be_true"],
  ])("%j → 400 %s", async (b, code) => {
    await expectRefused(await direct(b), 400, code);
    expect(h.calls).toHaveLength(0);
  });

  it("without resolve a single match still sends at once (unchanged)", async () => {
    expect(await (await direct({ to_name: "Coach Taylor", body: "x" })).json()).toMatchObject({ state: "sent" });
  });
});

describe("lookup/refusal rate limit", () => {
  const LOOKUP_ROWS = () => count("SELECT COUNT(*) AS c FROM log WHERE event IN ('direct_lookup','direct_refused','refused')");

  it("default 30 lookups an hour; the 31st is 429 lookup_rate with no log row; sends are never limited", async () => {
    for (let i = 0; i < 30; i++) expect(((await (await direct({ to_name: "jordan", body: "hi" })).json()) as any).state).toBe("ambiguous");
    const rows = await LOOKUP_ROWS();
    const candidatesBefore = await count("SELECT COUNT(*) AS c FROM candidates");
    for (const b of [{ to_name: "jordan", body: "hi" }, { to_name: "nobody", body: "x" }, { to: STRANGER, body: "x" }, { to: FRIEND, body: "" }, { to_name: "Coach Taylor", resolve: true }]) {
      await expectRefused(await direct(b), 429, "lookup_rate");
    }
    expect(await LOOKUP_ROWS()).toBe(rows); // no log rows while over the limit
    expect(await count("SELECT COUNT(*) AS c FROM candidates")).toBe(candidatesBefore);
    // successful sends still go out and don't count
    for (let i = 0; i < 5; i++) expect(await (await direct({ to: FRIEND, body: `ok ${i}` })).json()).toMatchObject({ state: "sent" });
    expect(await (await direct({ to_name: "Coach Taylor", body: "x" })).json()).toMatchObject({ state: "sent" });
    // a rolling hour later the budget is back
    h.setNow(T0 + 61 * 60_000);
    expect(((await (await direct({ to_name: "jordan", body: "hi" })).json()) as any).state).toBe("ambiguous");
  });

  it("refusals count too (not on list, bad body, limits)", async () => {
    await h.setEnv({ DIRECT_LOOKUP_MAX_PER_HOUR: "3" });
    expect((await direct({ to: STRANGER, body: "x" })).status).toBe(403);
    expect((await direct({ to: FRIEND, body: "" })).status).toBe(400);
    expect((await direct({ to_name: "nobody", body: "x" })).status).toBe(200);
    await expectRefused(await direct({ to: STRANGER, body: "x" }), 429, "lookup_rate");
    expect(await (await direct({ to: FRIEND, body: "still sends" })).json()).toMatchObject({ state: "sent" });
  });

  it("bad-token refusals have their own bucket and can't use up the bot's lookups", async () => {
    await h.setEnv({ DIRECT_LOOKUP_MAX_PER_HOUR: "2" });
    for (let i = 0; i < 2; i++) expect((await direct({ to: FRIEND, body: "x" }, "TEST-ONLY-wrong")).status).toBe(401);
    const before = await count("SELECT COUNT(*) AS c FROM log");
    await expectRefused(await direct({ to: FRIEND, body: "x" }, "TEST-ONLY-wrong"), 429, "lookup_rate");
    expect(await count("SELECT COUNT(*) AS c FROM log")).toBe(before);
    expect(((await (await direct({ to_name: "jordan", body: "hi" })).json()) as any).state).toBe("ambiguous");
  });

  it("\"off\" = no limit; garbage = 503 direct_config_invalid", async () => {
    await h.setEnv({ DIRECT_LOOKUP_MAX_PER_HOUR: "lots" });
    await expectRefused(await direct({ to: FRIEND, body: "x" }), 503, "direct_config_invalid");
    expect(await sentTo()).toEqual([]);
    await h.setEnv({ DIRECT_LOOKUP_MAX_PER_HOUR: "off" });
    for (let i = 0; i < 40; i++) expect((await direct({ to_name: "nobody", body: "x" })).status).toBe(200);
  });

  it("a runaway pause still texts the owner even when refusals are over the limit", async () => {
    await h.setEnv({ RUNAWAY_MAX: "1", DIRECT_LOOKUP_MAX_PER_HOUR: "1" });
    await direct({ to_name: "nobody", body: "x" }); // uses the 1 allowed lookup
    expect((await direct({ to: FRIEND, body: "a" })).status).toBe(200);
    await expectRefused(await direct({ to: FRIEND, body: "b" }), 429, "lookup_rate");
    expect((await ownerTexts()).filter((t) => t.includes("PAUSED"))).toHaveLength(1);
    expect(await sql("SELECT v FROM meta WHERE k='direct_paused'")).toEqual([{ v: "1" }]);
  });
});

describe("links in the message text are allowed by default (BLOCK_LINKS unset)", () => {
  const LINKS = ["https://example.com/book/interview", "https://example.com/book/semiannual-check-in"];
  it.each(LINKS)("to_name: %s is sent as-is", async (url) => {
    const body = `Please book your interview: ${url}`;
    expect(await (await direct({ to_name: "Coach Taylor", body })).json()).toMatchObject({ state: "sent", to: "Coach Taylor" });
    expect(await posted()).toEqual([{ to: PM, text: body }]);
  });
  it.each(LINKS)("candidate_id (resolve first): %s is sent as-is", async (url) => {
    const body = `Interview sign-up: ${url}`;
    const one = (await (await direct({ to_name: "Coach Taylor", resolve: true, body })).json()) as any;
    expect(one.state).toBe("one");
    expect(h.calls.filter((c) => c.url.endsWith("/messages"))).toHaveLength(0);
    expect(await (await direct({ candidate_id: one.candidates[0].candidate_id, body })).json()).toMatchObject({ state: "sent" });
    expect(await posted()).toEqual([{ to: PM, text: body }]);
  });
  it("every other guard still holds with a link in the body", async () => {
    const body = "https://example.com/book/interview";
    await expectRefused(await direct({ to: STRANGER, body }), 403, "recipient_not_on_allowlist");
    await expectRefused(await direct({ to: [FRIEND, KB], body }), 400, "group_send_not_allowed");
    await expectRefused(await direct({ to: FRIEND, body: body + "x".repeat(700) }), 400, "text_too_long");
    await expectRefused(await direct({ to: FRIEND, body }, "TEST-ONLY-wrong"), 401, "bad_request_token");
    expect(await sentTo()).toEqual([]);
    const row = (await logRows()).find((x) => x.event === "direct_refused");
    expect(JSON.stringify(await logRows())).not.toContain("example.com/book"); // the HMAC log never holds the text
    expect(row).toBeTruthy();
  });
});
