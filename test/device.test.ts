import { describe, it, expect, beforeEach } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import { harness, postRequest, approve, API, BASE, OWNER, FRIEND, TWO, STRANGER, T0, type Harness } from "./helpers";
import { scan } from "./phone-scan";
import { PING_SUBJECT, TAP_PING_TEXT } from "../src/device";

// iPhone delivery: DELIVERY=mac|shortcut queues each text for the owner's device, which claims it over
// POST /device/next with its own DEVICE_TOKEN and reports back on POST /device/result. Fake values only.
const DEVICE_TOKEN = "TEST-ONLY-device-token-0123456789abcdef";
const REQUEST_TOKEN = "TEST-ONLY-request-token";
const NTFY = "https://ntfy.example.test/relay-topic";
const MIN = 60_000;

let h: Harness;
let ntfyPosts: { body: string; title: string | null; click: string | null }[];
let emails: { from: string; to: string; mime: string }[];
let emailFails: boolean;
const runIn = runInDurableObject as unknown as (s: unknown, f: (i: any) => Promise<any>) => Promise<any>;
const sql = (q: string, ...a: unknown[]) => runIn(h.relay, async (i) => i.ctx.storage.sql.exec(q, ...a).toArray()) as Promise<any[]>;
const count = async (q: string, ...a: unknown[]) => (await sql(q, ...a))[0].c as number;
const events = async () => (await sql("SELECT event FROM log ORDER BY seq")).map((r) => r.event as string);
const logOf = async (event: string) => (await sql("SELECT request_id, detail FROM log WHERE event=? ORDER BY seq", event)) as { request_id: string | null; detail: string }[];
const gatewayCalls = () => h.calls.filter((c) => c.url.includes("sms-gate"));

const bearer = (t: string) => ({ Authorization: `Bearer ${t}`, "content-type": "application/json" });
const next = (token = DEVICE_TOKEN) => h.relay.fetch(`${API}/device/next`, { method: "POST", headers: bearer(token) });
const result = (body: unknown, token = DEVICE_TOKEN) => h.relay.fetch(`${API}/device/result`, { method: "POST", headers: bearer(token), body: JSON.stringify(body) });
const direct = (body: unknown, token = REQUEST_TOKEN) => h.relay.fetch(`${API}/send`, { method: "POST", headers: bearer(token), body: JSON.stringify(body) });
const sweep = () => runIn(h.relay, async (i) => i.deviceSweep());
const alarm = () => runIn(h.relay, async (i) => i.alarm());
async function claim(token = DEVICE_TOKEN): Promise<any> {
  const r = await next(token);
  expect(r.status).toBe(200);
  return ((await r.json()) as any).job;
}
async function expectError(r: Response, status: number, code: string) {
  expect(r.status).toBe(status);
  expect(await r.json()).toEqual({ error: code });
}

const NTFY_MODE = { NOTIFY_MODE: "ntfy", NTFY_URL: NTFY, NTFY_TOKEN: "TEST-ONLY-ntfy-token" };
// Device modes require an owner-notice channel that doesn't go through the device: ntfy.
const MAC = { DELIVERY: "mac", DEVICE_TOKEN, DIRECT_SEND: "1", RUNAWAY_PAUSE: "0", ...NTFY_MODE };

beforeEach(async () => {
  h = await harness();
  ntfyPosts = [];
  emails = [];
  emailFails = false;
  // The device's reply carries the number it must text, by design; every other response still may not.
  scan.allow.push(FRIEND, TWO, OWNER);
  await runIn(h.relay, async (i) => {
    const inner = i.net;
    i.net = async (req: Request) => {
      if (new URL(req.url).host === "ntfy.example.test") {
        ntfyPosts.push({ body: await req.clone().text(), title: req.headers.get("Title"), click: req.headers.get("Click") });
        return new Response("ok");
      }
      return inner(req);
    };
    i.pingEmail = async (m: { from: string; to: string; mime: string }) => {
      if (emailFails) throw new Error("ping_email_status_500");
      emails.push(m);
    };
  });
  await h.setEnv(MAC);
});

describe("DELIVERY switch", () => {
  it("unset = android: the device routes don't exist and sends go to the gateway", async () => {
    await h.setEnv({ DELIVERY: undefined as unknown as string });
    await expectError(await next(), 404, "not_found");
    await expectError(await result({ id: "0".repeat(32), lease: "0".repeat(32), outcome: "sent" }), 404, "not_found");
    expect((await direct({ to: FRIEND, body: "hi" })).status).toBe(200);
    expect(gatewayCalls().length).toBeGreaterThan(0);
    expect(await count("SELECT COUNT(*) AS c FROM device_jobs")).toBe(0);
  });

  it.each(["iphone", "Mac", " mac", "1"])("DELIVERY=%j → every route refuses 503 delivery_invalid, nothing queued or sent", async (v) => {
    await h.setEnv({ DELIVERY: v });
    await expectError(await direct({ to: FRIEND, body: "hi" }), 503, "delivery_invalid");
    await expectError(await postRequest(h, { to: FRIEND, text: "hi" }), 503, "delivery_invalid");
    await expectError(await next(), 503, "delivery_invalid");
    expect(h.calls).toHaveLength(0);
    expect(await count("SELECT COUNT(*) AS c FROM device_jobs")).toBe(0);
  });

  it("mac: a direct send is queued (202), never sent through the gateway", async () => {
    const r = await direct({ to: FRIEND, body: "see you at 6" });
    expect(r.status).toBe(202);
    expect(await r.json()).toMatchObject({ state: "queued", method: "direct" });
    expect(gatewayCalls()).toHaveLength(0);
    expect(await count("SELECT COUNT(*) AS c FROM device_jobs WHERE state='queued'")).toBe(1);
  });
});

describe("token split: DEVICE_TOKEN and REQUEST_TOKEN never stand in for each other", () => {
  it("REQUEST_TOKEN can't claim or report", async () => {
    await direct({ to: FRIEND, body: "hi" });
    await expectError(await next(REQUEST_TOKEN), 401, "bad_device_token");
    await expectError(await result({ id: "0".repeat(32), lease: "0".repeat(32), outcome: "sent" }, REQUEST_TOKEN), 401, "bad_device_token");
    expect(await count("SELECT COUNT(*) AS c FROM device_jobs WHERE state='queued'")).toBe(1);
  });

  it("DEVICE_TOKEN can't create a send or a request, or read a request", async () => {
    await expectError(await direct({ to: FRIEND, body: "hi" }, DEVICE_TOKEN), 401, "bad_request_token");
    await expectError(await postRequest(h, { to: FRIEND, text: "hi" }, DEVICE_TOKEN), 401, "bad_request_token");
    const id = ((await (await postRequest(h, { to: FRIEND, text: "hi" })).json()) as any).id;
    await expectError(await h.relay.fetch(`${API}/request/${id}`, { headers: bearer(DEVICE_TOKEN) }), 401, "bad_request_token");
    expect(await count("SELECT COUNT(*) AS c FROM device_jobs")).toBe(0);
  });

  it("a wrong device token is refused without a log row (no log flooding)", async () => {
    const before = await count("SELECT COUNT(*) AS c FROM log");
    for (let n = 0; n < 5; n++) await expectError(await next("TEST-ONLY-wrong-token-0123456789abcdefgh"), 401, "bad_device_token");
    await expectError(await h.relay.fetch(`${API}/device/next`, { method: "POST" }), 401, "bad_device_token");
    expect(await count("SELECT COUNT(*) AS c FROM log")).toBe(before);
  });

  it.each([
    [undefined, "device_token_missing_or_short"],
    ["short-token", "device_token_missing_or_short"],
    [REQUEST_TOKEN.padEnd(32, "x"), "device_token_reuses_request_token"],
  ])("DEVICE_TOKEN=%j → every route refuses 503 %s", async (tok, code) => {
    const patch: Record<string, string> = { DEVICE_TOKEN: tok as unknown as string };
    if (code === "device_token_reuses_request_token") patch.REQUEST_TOKEN = tok as string;
    await h.setEnv(patch);
    await expectError(await next(tok ?? DEVICE_TOKEN), 503, code);
    await expectError(await direct({ to: FRIEND, body: "hi" }, patch.REQUEST_TOKEN ?? REQUEST_TOKEN), 503, code);
    expect(await count("SELECT COUNT(*) AS c FROM device_jobs")).toBe(0);
  });
});

describe("every existing guard runs before a job is queued", () => {
  it("a number off the list is refused, not queued", async () => {
    await expectError(await direct({ to: STRANGER, body: "hi" }), 403, "recipient_not_on_allowlist");
    expect(await count("SELECT COUNT(*) AS c FROM device_jobs")).toBe(0);
  });

  it("the kill switch refuses before anything is queued or claimed", async () => {
    await direct({ to: FRIEND, body: "hi" });
    await h.setEnv({ DISABLED: "1" });
    await expectError(await direct({ to: FRIEND, body: "again" }), 503, "relay_disabled");
    await expectError(await next(), 503, "relay_disabled");
    expect(await count("SELECT COUNT(*) AS c FROM device_jobs")).toBe(1);
    expect(await count("SELECT COUNT(*) AS c FROM device_jobs WHERE state='queued'")).toBe(1);
  });

  it("BLOCK_LINKS, the per-minute limit and quiet hours refuse before queueing", async () => {
    await h.setEnv({ BLOCK_LINKS: "1" });
    await expectError(await direct({ to: FRIEND, body: "go to example.com" }), 400, "links_not_allowed");
    await h.setEnv({ BLOCK_LINKS: "0", DIRECT_PER_MINUTE_MAX: "1" });
    expect((await direct({ to: FRIEND, body: "one" })).status).toBe(202);
    await expectError(await direct({ to: FRIEND, body: "two" }), 429, "direct_per_minute_reached");
    await h.setEnv({ DIRECT_PER_MINUTE_MAX: "off", DIRECT_HOURS: "08:00-09:00" });
    await expectError(await direct({ to: FRIEND, body: "three" }), 429, "direct_outside_hours");
    expect(await count("SELECT COUNT(*) AS c FROM device_jobs")).toBe(1);
  });

  it("tap flow: nothing is queued until the owner approves; approval queues exactly one job", async () => {
    const id = ((await (await postRequest(h, { to: FRIEND, text: "pick up at 5?" })).json()) as any).id;
    // The approval notice goes to the owner over ntfy, never through the device.
    expect(await count("SELECT COUNT(*) AS c FROM device_jobs")).toBe(0);
    expect(ntfyPosts.filter((p) => p.title === "SMS relay approval")).toHaveLength(1);
    const r = await approve(h, id);
    expect(r.status).toBe(202);
    expect(await r.json()).toEqual({ id, state: "queued" });
    expect(await count("SELECT COUNT(*) AS c FROM device_jobs WHERE kind='tap' AND ref=?", id)).toBe(1);
    expect(gatewayCalls()).toHaveLength(0);
  });

  it("tap flow: if something fails after the job is queued, the request stays queued_device (never send_failed)", async () => {
    const id = ((await (await postRequest(h, { to: FRIEND, text: "pick up at 5?" })).json()) as any).id;
    await runIn(h.relay, async (i) => {
      i.ensureDeviceAlarm = async () => {
        throw new Error("storage_hiccup");
      };
    });
    const r = await approve(h, id);
    expect(r.status).toBe(202);
    expect(await r.json()).toEqual({ id, state: "queued" });
    expect((await sql("SELECT state FROM requests WHERE id=?", id))[0].state).toBe("queued_device");
    expect((await sql("SELECT state FROM device_jobs WHERE ref=?", id)).map((x) => x.state)).toEqual(["queued"]);
    expect(await logOf("send_failed")).toHaveLength(0);
    expect((await logOf("device_after_queue_error"))[0].detail).toMatch(/^job_id=[a-f0-9]{8} reason=storage_hiccup$/);
  });
});

describe("claim and result", () => {
  it("the device gets the number and text once; storage forgets the text at the claim; sent is recorded", async () => {
    const sent = (await (await direct({ to: FRIEND, body: "see you at 6" })).json()) as any;
    const job = await claim();
    expect(job).toMatchObject({ to: FRIEND, text: "see you at 6", result_by_ms: T0 + 2 * MIN });
    expect(job.id).toMatch(/^[a-f0-9]{32}$/);
    expect(job.lease).toMatch(/^[a-f0-9]{32}$/);
    expect((await sql("SELECT state, text FROM device_jobs WHERE id=?", job.id))[0]).toEqual({ state: "claimed", text: null });
    const r = await result({ id: job.id, lease: job.lease, outcome: "sent" });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ id: job.id, state: "sent" });
    const row = (await logOf("direct_sent"))[0];
    expect(row.request_id).toBe(sent.id);
    expect(row.detail).toContain("outcome=sent");
    expect(gatewayCalls()).toHaveLength(0);
  });

  it("tap flow end to end: the bot's status call sees queued_device, then sent", async () => {
    const id = ((await (await postRequest(h, { to: FRIEND, text: "pick up at 5?" })).json()) as any).id;
    await approve(h, id);
    const status = async () => ((await (await h.relay.fetch(`${API}/request/${id}`, { headers: bearer(REQUEST_TOKEN) })).json()) as any).state;
    expect(await status()).toBe("queued_device");
    const job = await claim();
    expect(job).toMatchObject({ to: FRIEND, text: "pick up at 5?" });
    await result({ id: job.id, lease: job.lease, outcome: "sent" });
    expect(await status()).toBe("sent");
  });

  it("atomic claim: ten concurrent polls over three queued jobs hand out exactly one job", async () => {
    for (const body of ["a", "b", "c"]) expect((await direct({ to: FRIEND, body })).status).toBe(202);
    const replies = await Promise.all(Array.from({ length: 10 }, () => next().then((r) => r.json() as Promise<any>)));
    const jobs = replies.map((r) => r.job).filter(Boolean);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].text).toBe("a");
    expect(replies.filter((r) => r.reason === "busy")).toHaveLength(9);
    expect(await count("SELECT COUNT(*) AS c FROM device_jobs WHERE state='claimed'")).toBe(1);
  });

  it("single use: a job id is handed out once over the whole run, in order", async () => {
    for (const body of ["a", "b", "c"]) await direct({ to: FRIEND, body });
    const seen: string[] = [];
    for (let n = 0; n < 3; n++) {
      const job = await claim();
      seen.push(job.text);
      expect(await claim()).toBeNull(); // still in flight: nothing else is handed out
      await result({ id: job.id, lease: job.lease, outcome: "sent" });
    }
    expect(seen).toEqual(["a", "b", "c"]);
    expect(await claim()).toBeNull();
    expect((await events()).filter((e) => e === "device_claimed")).toHaveLength(3);
  });

  it("one result per claim: a repeat is 409 and a wrong lease is 403, and neither changes the record", async () => {
    await direct({ to: FRIEND, body: "hi" });
    const job = await claim();
    await expectError(await result({ id: job.id, lease: "f".repeat(32), outcome: "sent" }), 403, "bad_lease");
    expect((await result({ id: job.id, lease: job.lease, outcome: "not_started" })).status).toBe(200);
    await expectError(await result({ id: job.id, lease: job.lease, outcome: "sent" }), 409, "result_already_recorded");
    expect((await sql("SELECT state FROM device_jobs WHERE id=?", job.id))[0].state).toBe("not_started");
    await expectError(await result({ id: "0".repeat(32), lease: job.lease, outcome: "sent" }), 404, "job_unknown");
    await expectError(await result({ id: job.id, lease: job.lease, outcome: "delivered" }), 400, "outcome_invalid");
  });

  it("a detail that isn't a short code (it could quote a message) is dropped, never logged", async () => {
    await direct({ to: FRIEND, body: "hi" });
    const job = await claim();
    await result({ id: job.id, lease: job.lease, outcome: "uncertain", detail: "Messages said: see you at 6" });
    expect((await logOf("direct_send_uncertain"))[0].detail).not.toContain("detail=");
  });
});

describe("no retry", () => {
  it.each([
    ["not_started", "direct_send_failed"],
    ["uncertain", "direct_send_uncertain"],
  ])("outcome %s is final: the job is never handed out again", async (outcome, event) => {
    await direct({ to: FRIEND, body: "hi" });
    const job = await claim();
    await result({ id: job.id, lease: job.lease, outcome });
    expect(await claim()).toBeNull();
    h.setNow(T0 + 60 * MIN);
    await sweep();
    expect(await claim()).toBeNull();
    expect(await count("SELECT COUNT(*) AS c FROM device_jobs WHERE state IN ('queued','claimed')")).toBe(0);
    expect((await events()).filter((e) => e === "device_claimed")).toHaveLength(1);
    expect(await logOf(event)).toHaveLength(1);
  });

  it("a failed tap send leaves the request failed, not pending or queued", async () => {
    const id = ((await (await postRequest(h, { to: FRIEND, text: "hi" })).json()) as any).id;
    await approve(h, id);
    const job = await claim();
    await result({ id: job.id, lease: job.lease, outcome: "not_started" });
    expect((await sql("SELECT state FROM requests WHERE id=?", id))[0].state).toBe("send_failed");
    expect(await claim()).toBeNull();
  });
});

describe("claim timeout (2 minutes, fails closed)", () => {
  it("at 1:59 the claim still stands and its result is accepted", async () => {
    await direct({ to: FRIEND, body: "hi" });
    const job = await claim();
    h.setNow(T0 + 2 * MIN - 1000);
    await sweep();
    expect((await result({ id: job.id, lease: job.lease, outcome: "sent" })).status).toBe(200);
  });

  it("at 2:00 the claim times out: logged, console line, never re-queued, a late result is refused, the queue moves on", async () => {
    await direct({ to: FRIEND, body: "first" });
    await direct({ to: FRIEND, body: "second" });
    const job = await claim();
    const errs: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void errs.push(a.join(" "));
    try {
      h.setNow(T0 + 2 * MIN);
      await alarm(); // the real scheduled path
    } finally {
      console.error = orig;
    }
    expect(errs.join("\n")).toContain(`DEVICE_CLAIM_TIMEOUT job_id=${job.id.slice(0, 8)}`);
    expect((await logOf("device_claim_timeout"))[0].detail).toContain(`job_id=${job.id.slice(0, 8)}`);
    expect((await sql("SELECT state FROM device_jobs WHERE id=?", job.id))[0].state).toBe("claim_timeout");
    // The device may have sent it before going quiet: uncertain, not failed, and never retried.
    expect(await logOf("direct_send_uncertain")).toHaveLength(1);
    await expectError(await result({ id: job.id, lease: job.lease, outcome: "sent" }), 409, "claim_timed_out");
    expect(await logOf("device_result_late")).toHaveLength(1);
    const nextJob = await claim();
    expect(nextJob.text).toBe("second");
    expect(nextJob.id).not.toBe(job.id);
  });

  it("a tap request whose claim timed out reads send_uncertain", async () => {
    const id = ((await (await postRequest(h, { to: FRIEND, text: "hi" })).json()) as any).id;
    await approve(h, id);
    await claim();
    h.setNow(T0 + 3 * MIN);
    await sweep();
    expect((await sql("SELECT state FROM requests WHERE id=?", id))[0].state).toBe("send_uncertain");
  });

});

describe("a notice channel that doesn't go through the device is required", () => {
  it.each([undefined, "sms", "", "NTFY"])("DELIVERY=mac with NOTIFY_MODE=%j → every route answers 503 config_invalid with the reason", async (mode) => {
    await h.setEnv({ NOTIFY_MODE: mode as unknown as string });
    const errs: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void errs.push(a.join(" "));
    try {
      for (const r of [await direct({ to: FRIEND, body: "hi" }), await postRequest(h, { to: FRIEND, text: "hi" }), await next()]) {
        expect(r.status).toBe(503);
        expect(await r.json()).toEqual({ error: "config_invalid", reason: "notify_mode_must_be_ntfy_for_device_delivery" });
      }
    } finally {
      console.error = orig;
    }
    expect(errs.join("\n")).toContain("CONFIG_ERROR reason=notify_mode_must_be_ntfy_for_device_delivery");
    expect((await logOf("refused"))[0].detail).toBe("config_invalid reason=notify_mode_must_be_ntfy_for_device_delivery");
    expect(await count("SELECT COUNT(*) AS c FROM device_jobs")).toBe(0);
    expect(h.calls.filter((c) => !c.url.includes("ntfy"))).toHaveLength(0);
  });

  it("android keeps NOTIFY_MODE=sms", async () => {
    await h.setEnv({ DELIVERY: "android", NOTIFY_MODE: "sms" });
    expect((await postRequest(h, { to: FRIEND, text: "hi" })).status).toBe(202);
  });
});

describe("UNCLAIMED_EXPIRY_MINUTES (default 30): dropped, not sent late, and the owner is told", () => {
  const dropNotices = () => ntfyPosts.filter((p) => p.title === "SMS relay text dropped");

  it("default 30: kept at 29:59, dropped at 30:00 with one owner notice per text (masked number, no text)", async () => {
    const a = ((await (await direct({ to: FRIEND, body: "secret plans one" })).json()) as any).id;
    await direct({ to: TWO, body: "secret plans two" });
    h.setNow(T0 + 30 * MIN - 1000);
    await sweep();
    expect(dropNotices()).toHaveLength(0);
    h.setNow(T0 + 30 * MIN);
    await alarm();
    expect(await claim()).toBeNull();
    expect(await logOf("device_job_expired")).toHaveLength(2);
    expect(await logOf("direct_send_failed")).toHaveLength(2);
    const n = dropNotices();
    expect(n).toHaveLength(2);
    expect(n[0].body).toContain("…0101");
    expect(n[0].body).toContain("NOT sent");
    expect(n[0].body).toContain(`ref ${a.slice(0, 8)}`);
    expect(n[0].body).toContain("within 30 min");
    expect(n.map((x) => x.body).join(" ")).not.toContain("secret");
    expect(await logOf("device_expired_notified")).toHaveLength(2);
    await sweep(); // already expired: no repeat notice
    expect(dropNotices()).toHaveLength(2);
  });

  it("a claimed text never expires (it times out instead) and gets no drop notice", async () => {
    await direct({ to: FRIEND, body: "hi" });
    await claim();
    h.setNow(T0 + 60 * MIN);
    await sweep();
    expect(dropNotices()).toHaveLength(0);
    expect(await logOf("device_claim_timeout")).toHaveLength(1);
  });

  it("UNCLAIMED_EXPIRY_MINUTES=5 drops at 5 minutes", async () => {
    await h.setEnv({ UNCLAIMED_EXPIRY_MINUTES: "5" });
    await direct({ to: FRIEND, body: "hi" });
    h.setNow(T0 + 5 * MIN - 1000);
    await sweep();
    expect(dropNotices()).toHaveLength(0);
    h.setNow(T0 + 5 * MIN);
    await sweep();
    expect(dropNotices()).toHaveLength(1);
    expect(dropNotices()[0].body).toContain("within 5 min");
  });

  it("UNCLAIMED_EXPIRY_MINUTES=120 keeps a text past 30 minutes", async () => {
    await h.setEnv({ UNCLAIMED_EXPIRY_MINUTES: "120" });
    await direct({ to: FRIEND, body: "late but wanted" });
    h.setNow(T0 + 31 * MIN);
    await sweep();
    expect((await claim()).text).toBe("late but wanted");
  });

  it.each(["0", "1441", "off", "10.5", " 30", "abc"])("UNCLAIMED_EXPIRY_MINUTES=%j → 503 config_invalid (unclaimed_expiry_minutes_invalid)", async (v) => {
    await h.setEnv({ UNCLAIMED_EXPIRY_MINUTES: v });
    const r = await direct({ to: FRIEND, body: "hi" });
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ error: "config_invalid", reason: "unclaimed_expiry_minutes_invalid" });
    expect(await count("SELECT COUNT(*) AS c FROM device_jobs")).toBe(0);
  });

  it("a failed drop notice is logged and doesn't stop the sweep", async () => {
    await direct({ to: FRIEND, body: "hi" });
    await h.setEnv({ NTFY_URL: "https://down.example.test/x" });
    h.setNow(T0 + 30 * MIN);
    await sweep();
    expect(await logOf("device_job_expired")).toHaveLength(1);
    expect((await logOf("device_expired_notify_failed"))[0].detail).toContain("reason=ntfy_status_599");
  });
});

describe("DIRECT_DAILY_CAP default for mac and shortcut", { timeout: 30_000 }, () => {
  async function sendMany(n: number) {
    const codes: number[] = [];
    for (let i = 0; i < n; i++) codes.push((await direct({ to: FRIEND, body: `msg ${i}` })).status);
    return codes;
  }
  it.each(["mac", "shortcut"])("DELIVERY=%s, cap unset: 25 a day, the 26th is refused and not queued", async (mode) => {
    await h.setEnv({ DELIVERY: mode, PING_FROM: "relay@example.test", PING_TO: "owner@example.test" });
    const codes = await sendMany(26);
    expect(codes.slice(0, 25).every((c) => c === 202)).toBe(true);
    expect(codes[25]).toBe(429);
    expect(await count("SELECT COUNT(*) AS c FROM device_jobs")).toBe(25);
    expect((await logOf("direct_refused")).at(-1)!.detail).toContain("reason=direct_daily_cap_reached");
  });

  it('"off" switches it off', async () => {
    await h.setEnv({ DIRECT_DAILY_CAP: "off" });
    expect((await sendMany(26)).every((c) => c === 202)).toBe(true);
  });

  it("an explicit number still wins", async () => {
    await h.setEnv({ DIRECT_DAILY_CAP: "2" });
    expect(await sendMany(3)).toEqual([202, 202, 429]);
  });

  it("android keeps no default cap", async () => {
    await h.setEnv({ DELIVERY: "android" });
    expect((await sendMany(26)).every((c) => c === 200)).toBe(true);
  });
});

describe("stale device alert (10 minutes, one notice per outage)", () => {
  const staleNotices = () => ntfyPosts.filter((p) => p.title === "SMS relay device offline");

  it("fires once at 10 minutes without a poll, stays quiet for the rest of the outage, and re-arms after a poll", async () => {
    await claim(); // the device polls at T0
    for (const m of [5, 9.9]) {
      h.setNow(T0 + m * MIN);
      await alarm();
    }
    expect(staleNotices()).toHaveLength(0);
    for (const m of [10, 11, 25, 120, 600]) {
      h.setNow(T0 + m * MIN);
      await alarm();
    }
    expect(staleNotices()).toHaveLength(1);
    expect(staleNotices()[0].body).toContain("Mac hasn't checked in for 10 min");
    expect(await logOf("device_stale")).toHaveLength(1);
    expect((await logOf("device_stale"))[0].detail).toBe("minutes_since_poll=10 ever_polled=1");

    h.setNow(T0 + 601 * MIN);
    await claim(); // back
    expect(await logOf("device_back")).toHaveLength(1);
    h.setNow(T0 + 611 * MIN);
    await alarm();
    expect(staleNotices()).toHaveLength(2); // a new outage gets its own notice
  });

  it("a device that never polls is caught too (the watch starts with the first sweep)", async () => {
    await sweep();
    h.setNow(T0 + 10 * MIN);
    await sweep();
    expect(staleNotices()).toHaveLength(1);
    expect((await logOf("device_stale"))[0].detail).toBe("minutes_since_poll=10 ever_polled=0");
  });

  it("if the alarm still runs with NOTIFY_MODE=sms (routes refuse it), the notice is logged as failed, never queued for the device", async () => {
    await claim();
    await h.setEnv({ NOTIFY_MODE: "sms" });
    h.setNow(T0 + 10 * MIN);
    await alarm();
    expect(await logOf("device_stale")).toHaveLength(1);
    expect((await logOf("device_stale_notify_failed"))[0].detail).toBe("owner_notice_needs_ntfy_in_device_mode");
    expect(await count("SELECT COUNT(*) AS c FROM device_jobs")).toBe(0);
    expect(gatewayCalls()).toHaveLength(0);
  });

  describe("shortcut: stale means a text left unclaimed, not a poll gap", () => {
    const SC = { DELIVERY: "shortcut", PING_FROM: "relay@example.test", PING_TO: "owner@example.test" };
    beforeEach(async () => h.setEnv(SC));

    it("a Shortcut that never polls, with nothing queued, is never stale", async () => {
      for (const m of [0, 10, 60, 600]) {
        h.setNow(T0 + m * MIN);
        await alarm();
      }
      expect(await logOf("device_stale")).toHaveLength(0);
      expect(staleNotices()).toHaveLength(0);
    });

    it("idle after a healthy poll is not stale", async () => {
      expect((await direct({ to: FRIEND, body: "hi" })).status).toBe(202);
      const j = await claim();
      expect((await result({ id: j.id, lease: j.lease, outcome: "sent_unverified" })).status).toBe(200);
      for (const m of [11, 30, 120]) {
        h.setNow(T0 + m * MIN);
        await alarm();
      }
      expect(await logOf("device_stale")).toHaveLength(0);
    });

    it("fires once when the oldest queued text has waited 10 min, stays quiet, and re-arms after the next poll", async () => {
      expect((await direct({ to: FRIEND, body: "one" })).status).toBe(202);
      h.setNow(T0 + 9.9 * MIN);
      await alarm();
      expect(staleNotices()).toHaveLength(0);
      for (const m of [10, 11, 15]) {
        h.setNow(T0 + m * MIN);
        await alarm();
      }
      expect(staleNotices()).toHaveLength(1);
      expect((await logOf("device_stale"))[0].detail).toBe("minutes_unclaimed=10 via=shortcut");
      expect(staleNotices()[0].body).not.toContain("5555");
      h.setNow(T0 + 16 * MIN);
      const j = await claim(); // the Shortcut runs again
      expect(await logOf("device_back")).toHaveLength(1);
      await result({ id: j.id, lease: j.lease, outcome: "sent_unverified" });
      h.setNow(T0 + 20 * MIN);
      expect((await direct({ to: FRIEND, body: "two" })).status).toBe(202);
      h.setNow(T0 + 30 * MIN);
      await alarm();
      expect(staleNotices()).toHaveLength(2); // a new outage gets its own notice
    });

    it("the wait counts from the oldest queued text, not the newest", async () => {
      expect((await direct({ to: FRIEND, body: "one" })).status).toBe(202);
      h.setNow(T0 + 8 * MIN);
      expect((await direct({ to: TWO, body: "two" })).status).toBe(202);
      h.setNow(T0 + 10 * MIN);
      await alarm();
      expect((await logOf("device_stale"))[0]?.detail).toBe("minutes_unclaimed=10 via=shortcut");
    });
  });

  it("mac: a check-in arms the minute sweep even with an empty queue", async () => {
    expect(await claim()).toBeNull();
    const at = await runIn(h.relay, async (i) => i.ctx.storage.getAlarm());
    expect(at - Date.now()).toBeLessThanOrEqual(60_000);
  });

  it("android mode never watches a device", async () => {
    await h.setEnv({ DELIVERY: "android" });
    h.setNow(T0 + 120 * MIN);
    await alarm();
    expect(await logOf("device_stale")).toHaveLength(0);
  });

  it("in a device mode the alarm stays within a minute; on android it stays daily", async () => {
    await direct({ to: FRIEND, body: "hi" });
    const at = await runIn(h.relay, async (i) => i.ctx.storage.getAlarm());
    expect(at - Date.now()).toBeLessThanOrEqual(60_000);
    await alarm();
    expect((await runIn(h.relay, async (i) => i.ctx.storage.getAlarm())) - Date.now()).toBeLessThanOrEqual(60_000);
    await h.setEnv({ DELIVERY: "android" });
    await alarm();
    expect((await runIn(h.relay, async (i) => i.ctx.storage.getAlarm())) - Date.now()).toBeGreaterThan(3_600_000);
  });
});

describe("per-send notice (DIRECT_NOTIFY_EACH) in a device mode", () => {
  it.each([["mac", "Mac"], ["shortcut", "iPhone Shortcut"]])("DELIVERY=%s: says the text is queued, not sent", async (mode, what) => {
    await h.setEnv({ DELIVERY: mode, DIRECT_NOTIFY_EACH: "1", PING_FROM: "relay@example.test", PING_TO: "owner@example.test" });
    expect((await direct({ to: FRIEND, body: "see you at 6" })).status).toBe(202);
    const n = ntfyPosts.filter((p) => p.title === "SMS relay text queued");
    expect(n).toHaveLength(1);
    expect(n[0].body).toContain(`SMS relay text queued for your ${what} to send to`);
    expect(n[0].body).not.toContain("direct send to");
  });
});

describe("shortcut path (best-effort)", () => {
  const SC = { DELIVERY: "shortcut", PING_FROM: "relay@example.test", PING_TO: "owner@example.test" };

  it("email ping: fixed subject, empty body, no number and no text", async () => {
    await h.setEnv(SC);
    expect((await direct({ to: FRIEND, body: "secret plans at 6" })).status).toBe(202);
    expect(emails).toHaveLength(1);
    const m = emails[0];
    expect(m).toMatchObject({ from: "relay@example.test", to: "owner@example.test" });
    expect(m.mime).toContain(`Subject: ${PING_SUBJECT}`);
    expect(m.mime.split("\r\n\r\n")[1]).toBe("");
    expect(m.mime).not.toContain("secret");
    expect(m.mime).not.toContain(FRIEND.slice(2));
    expect(await logOf("device_pinged")).toEqual([{ request_id: null, detail: "via=email" }]);
  });

  it("a failed ping is logged and the job stays queued for the next trigger", async () => {
    await h.setEnv(SC);
    emailFails = true;
    expect((await direct({ to: FRIEND, body: "hi" })).status).toBe(202);
    expect((await logOf("device_ping_failed"))[0].detail).toBe("via=email reason=ping_email_status_500");
    expect((await claim()).text).toBe("hi");
  });

  it("missing PING_FROM/PING_TO: logged, job still queued", async () => {
    await h.setEnv({ DELIVERY: "shortcut" });
    expect((await direct({ to: FRIEND, body: "hi" })).status).toBe(202);
    expect((await logOf("device_ping_failed"))[0].detail).toBe("via=email reason=ping_email_not_configured");
  });

  it("tap-once variant: an ntfy notification that opens the Shortcut, with no number or text", async () => {
    await h.setEnv({ DELIVERY: "shortcut", SHORTCUT_PING: "tap", NTFY_URL: NTFY, NTFY_TOKEN: "TEST-ONLY-ntfy-token", SHORTCUT_NAME: "Relay Send" });
    await direct({ to: FRIEND, body: "secret plans" });
    expect(ntfyPosts).toEqual([{ body: TAP_PING_TEXT, title: "SMS relay", click: "shortcuts://run-shortcut?name=Relay%20Send" }]);
    expect(emails).toHaveLength(0);
  });

  it.each(["push", "EMAIL"])("SHORTCUT_PING=%j → every route refuses 503 shortcut_ping_invalid", async (v) => {
    await h.setEnv({ ...SC, SHORTCUT_PING: v });
    await expectError(await direct({ to: FRIEND, body: "hi" }), 503, "shortcut_ping_invalid");
    expect(await count("SELECT COUNT(*) AS c FROM device_jobs")).toBe(0);
  });
});

describe("owner page", () => {
  it("GET /direct shows the delivery mode, last poll and queue", async () => {
    await direct({ to: FRIEND, body: "hi" });
    const page = await (await h.relay.fetch(`${BASE}/direct`, { headers: { "Cf-Access-Jwt-Assertion": await h.jwt() } })).text();
    expect(page).toContain("<b>Delivery:</b> mac");
    expect(page).toContain("<b>last poll:</b> never");
    expect(page).toContain("<b>queued:</b> 1");
  });
});
