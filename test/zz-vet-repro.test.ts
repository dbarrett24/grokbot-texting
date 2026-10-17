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

const MAC = { DELIVERY: "mac", DEVICE_TOKEN, DIRECT_SEND: "1", RUNAWAY_PAUSE: "0" };

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


// Review repros, kept as regression tests: each one failed before its fix.
describe("review repros", () => {
  const ntfyMode = { NOTIFY_MODE: "ntfy", NTFY_URL: NTFY, NTFY_TOKEN: "TEST-ONLY-ntfy-token" };
  const staleNotices = () => ntfyPosts.filter((p) => p.title === "SMS relay device offline");
  const SC = { NOTIFY_MODE: "ntfy", NTFY_URL: NTFY, NTFY_TOKEN: "TEST-ONLY-ntfy-token", DELIVERY: "shortcut", PING_FROM: "relay@example.test", PING_TO: "owner@example.test" };

  it("shortcut: an idle Shortcut is not stale; a text left unclaimed 10 min is, and gets the one notice", async () => {
    await h.setEnv({ ...SC, ...ntfyMode });
    // a text at T0, claimed and reported (healthy Shortcut)
    expect((await direct({ to: FRIEND, body: "one" })).status).toBe(202);
    const j = await claim();
    expect((await result({ id: j.id, lease: j.lease, outcome: "sent_unverified" })).status).toBe(200);
    // nobody texts for 11 minutes: no outage, the Shortcut only polls when pinged
    for (const m of [1, 5, 11]) { h.setNow(T0 + m * MIN); await alarm(); }
    const afterIdle = staleNotices().length;
    // now the automation is broken: a text is queued and never claimed
    h.setNow(T0 + 20 * MIN);
    expect((await direct({ to: FRIEND, body: "two" })).status).toBe(202);
    for (const m of [21, 30, 40, 51]) { h.setNow(T0 + m * MIN); await alarm(); }
    expect({ afterIdle, total: staleNotices().length, expired: (await logOf("device_job_expired")).length, dropped: ntfyPosts.filter((p) => p.title === "SMS relay text dropped").length }).toEqual({ afterIdle: 0, total: 1, expired: 1, dropped: 1 });
    expect(staleNotices()[0].body).toContain("a text has waited 10 min and your iPhone Shortcut hasn't picked it up");
    expect((await logOf("device_stale"))[0].detail).toBe("minutes_unclaimed=10 via=shortcut");
  });

  it("shortcut tap flow: a claim+result that lands during the ping is recorded on the request", async () => {
    await h.setEnv({ ...SC, ...ntfyMode });
    const id = ((await (await postRequest(h, { to: FRIEND, text: "pick up at 5?" })).json()) as any).id;
    await runIn(h.relay, async (i) => {
      i.pingEmail = async () => {
        // another request event (the Shortcut) runs while the email binding call is awaited
        const mk = (path: string, body?: unknown) => new Request(`${API}${path}`, { method: "POST", headers: bearer(DEVICE_TOKEN), body: body === undefined ? undefined : JSON.stringify(body) });
        const j = ((await (await i.deviceNext(mk("/device/next"))).json()) as any).job;
        if (j) await i.deviceResult(mk("/device/result", { id: j.id, lease: j.lease, outcome: "sent_unverified" }));
      };
    });
    await approve(h, id);
    const st = ((await (await h.relay.fetch(`${API}/request/${id}`, { headers: bearer(REQUEST_TOKEN) })).json()) as any).state;
    const jobs = await sql("SELECT state FROM device_jobs");
    expect({ st, jobs }).toEqual({ st: "sent", jobs: [{ state: "sent_unverified" }] });
  });

  it("mac: a check-in with no queued texts arms the minute sweep", async () => {
    await h.setEnv(ntfyMode);
    await claim(); // the Mac polls, nothing queued
    const at = await runIn(h.relay, async (i) => i.ctx.storage.getAlarm());
    expect({ minutesToAlarm: Math.round((at - Date.now()) / 60_000) }).toEqual({ minutesToAlarm: 1 });
  });

  it("direct: an error after the job is queued answers 202 queued (not 502), so the bot never retries; one device claim", async () => {
    await h.setEnv(ntfyMode);
    await runIn(h.relay, async (i) => { i.ensureDeviceAlarm = async () => { throw new Error("storage_hiccup"); }; });
    const r = await direct({ to: FRIEND, body: "hi" });
    const body = (await r.json()) as any;
    const jobs = await sql("SELECT state FROM device_jobs");
    await runIn(h.relay, async (i) => { delete i.ensureDeviceAlarm; });
    const j = await claim();
    expect({ status: r.status, state: body.state, method: body.method, jobs, claimable: !!j, failedLog: (await logOf("direct_send_failed")).length })
      .toEqual({ status: 202, state: "queued", method: "direct", jobs: [{ state: "queued" }], claimable: true, failedLog: 0 });
    expect(body.id).toBe((await logOf("device_queued"))[0].request_id);
    expect((await logOf("device_after_queue_error")).map((x) => x.detail)).toEqual([`job_id=${j.id.slice(0, 8)} reason=storage_hiccup`]);
    // Exactly one claim: the job is handed out once, and nothing else is queued behind it.
    await result({ id: j.id, lease: j.lease, outcome: "sent" });
    expect(await claim()).toBeNull();
    expect(await count("SELECT COUNT(*) AS c FROM device_jobs")).toBe(1);
    expect(await logOf("direct_sent")).toHaveLength(1);
  });
});
