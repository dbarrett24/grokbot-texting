import { describe, it, expect, beforeEach } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import { harness, postRequest, approve, API, BASE, OWNER, FRIEND, TWO, type Harness , enableAll } from "./helpers";
import { scan } from "./phone-scan";

// Multi-send, group mode and tap requests by name alongside the iPhone delivery paths (DELIVERY=mac|shortcut).
// Group MMS is Android (SMS Gateway) only; separate copies and tap requests queue like any other text.
// Fake numbers only (555-01xx).
const DEVICE_TOKEN = "TEST-ONLY-device-token-0123456789abcdef";
const REQUEST_TOKEN = "TEST-ONLY-request-token";
const NTFY = "https://ntfy.example.test/relay-topic";
const JB = "+15555550121", JO = "+15555550122", CT = "+15555550123";
const SNAPSHOT = {
  generated_at: "2026-10-16T23:00:00Z",
  contacts: [
    { name: "Jordan Bauer", given: "Jordan", numbers: [{ e164: JB, label: "mobile" }] },
    { name: "Jordan Ortiz", given: "Jordan", numbers: [{ e164: JO, label: "mobile" }] },
    { name: "Coach Taylor", numbers: [{ e164: CT, label: "mobile" }] },
  ],
};
const NTFY_MODE = { NOTIFY_MODE: "ntfy", NTFY_URL: NTFY, NTFY_TOKEN: "TEST-ONLY-ntfy-token" };
const MAC = { DELIVERY: "mac", DEVICE_TOKEN, DIRECT_SEND: "1", RUNAWAY_PAUSE: "0", ...NTFY_MODE };
const SHORTCUT_TAP = { DELIVERY: "shortcut", SHORTCUT_PING: "tap" };

let h: Harness;
let ntfyPosts: { body: string; title: string | null }[];
const runIn = runInDurableObject as unknown as (s: unknown, f: (i: any) => Promise<any>) => Promise<any>;
const sql = (q: string, ...a: unknown[]) => runIn(h.relay, async (i) => i.ctx.storage.sql.exec(q, ...a).toArray()) as Promise<any[]>;
const count = async (q: string, ...a: unknown[]) => (await sql(q, ...a))[0].c as number;
const logOf = async (event: string) => (await sql("SELECT request_id, detail FROM log WHERE event=? ORDER BY seq", event)) as { request_id: string | null; detail: string }[];
const bearer = (t: string) => ({ Authorization: `Bearer ${t}`, "content-type": "application/json" });
const direct = (body: unknown) => h.relay.fetch(`${API}/send`, { method: "POST", headers: bearer(REQUEST_TOKEN), body: JSON.stringify(body) });
const next = () => h.relay.fetch(`${API}/device/next`, { method: "POST", headers: bearer(DEVICE_TOKEN) });
const result = (body: unknown) => h.relay.fetch(`${API}/device/result`, { method: "POST", headers: bearer(DEVICE_TOKEN), body: JSON.stringify(body) });
const gatewayCalls = () => h.calls.filter((c) => c.url.includes("sms-gate"));
async function claim(): Promise<any> {
  const r = await next();
  expect(r.status).toBe(200);
  return ((await r.json()) as any).job;
}
async function upload(...a: Parameters<typeof uploadRaw>) {
  const r = await uploadRaw(...a);
  if (r.ok) await enableAll(h);
  return r;
}
async function uploadRaw() {
  return h.relay.fetch(`${BASE}/contacts`, { method: "POST", headers: { "content-type": "application/json", "Cf-Access-Jwt-Assertion": await h.jwt() }, body: JSON.stringify(SNAPSHOT) });
}
/**
 * Nothing sent, queued or used: no device job, no gateway call, no cap row, no candidate used. Like every /send
 * refusal, each one adds exactly one row to the hourly lookup/refusal limit (DIRECT_LOOKUP_MAX_PER_HOUR); no lookups.
 */
async function expectNothingTouched(refusals = 1) {
  expect(gatewayCalls()).toHaveLength(0);
  expect(await count("SELECT COUNT(*) AS c FROM device_jobs")).toBe(0);
  expect(await count("SELECT COUNT(*) AS c FROM direct_sends")).toBe(0);
  expect(await count("SELECT COUNT(*) AS c FROM nonsend")).toBe(refusals);
  expect(await count("SELECT COUNT(*) AS c FROM candidates")).toBe(0);
}

beforeEach(async () => {
  h = await harness();
  ntfyPosts = [];
  // The device's reply carries the number it must text, by design.
  scan.allow.push(FRIEND, TWO, OWNER, JB, JO, CT);
  await runIn(h.relay, async (i) => {
    const inner = i.net;
    i.net = async (req: Request) => {
      if (new URL(req.url).host === "ntfy.example.test") {
        ntfyPosts.push({ body: await req.clone().text(), title: req.headers.get("Title") });
        return new Response("ok");
      }
      return inner(req);
    };
    i.pingEmail = async () => {};
  });
  await h.setEnv({ DIRECT_SEND: "1" });
  expect((await upload()).status).toBe(200);
  await h.setEnv(MAC);
  h.calls.length = 0;
});

describe("group:true on the iPhone paths: refused before anything is read, counted or sent", () => {
  it.each([
    ["mac", {}],
    ["shortcut (email ping)", { DELIVERY: "shortcut", PING_FROM: "relay@example.test", PING_TO: "owner@example.test" }],
    ["shortcut (tap ping)", SHORTCUT_TAP],
  ])("%s, GROUP_MMS=1, OWNER_NUMBER valid → 409 group_mms_unsupported_delivery", async (_, env) => {
    await h.setEnv({ ...env, GROUP_MMS: "1", OWNER_NUMBER: OWNER });
    const r = await direct({ to_names: ["Jordan Bauer", "Coach Taylor"], body: "hi all", group: true });
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: "group_mms_unsupported_delivery" });
    await expectNothingTouched();
    expect(ntfyPosts).toHaveLength(0);
    expect((await logOf("refused")).map((x) => x.detail)).toEqual(["group_mms_unsupported_delivery"]);
  });

  it("checked before the names are looked up: an unknown name still gets the delivery refusal, no lookup counted or candidate stored", async () => {
    await h.setEnv({ GROUP_MMS: "1", OWNER_NUMBER: OWNER });
    const r = await direct({ to_names: ["Nobody Here", "Coach Taylor"], body: "hi", group: true });
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: "group_mms_unsupported_delivery" });
    await expectNothingTouched();
  });

  it("candidate ids are not used up, and still work for separate copies afterwards", async () => {
    await h.setEnv({ GROUP_MMS: "1", OWNER_NUMBER: OWNER });
    const res = (await (await direct({ to_names: ["Jordan Bauer", "Coach Taylor"], resolve: true })).json()) as any;
    const ids = res.results.map((x: any) => x.candidates[0].candidate_id);
    const before = await count("SELECT COUNT(*) AS c FROM nonsend");
    const r = await direct({ candidate_ids: ids, body: "hi", group: true });
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: "group_mms_unsupported_delivery" });
    expect(await count("SELECT COUNT(*) AS c FROM candidates WHERE used=1")).toBe(0);
    expect(await count("SELECT COUNT(*) AS c FROM nonsend")).toBe(before + 1); // the refusal itself, no lookups
    expect(await count("SELECT COUNT(*) AS c FROM device_jobs")).toBe(0);
    const ok = await direct({ candidate_ids: ids, body: "hi" });
    expect(ok.status).toBe(202);
  });

  it("also with GROUP_MMS off or OWNER_NUMBER unset: the delivery refusal comes first", async () => {
    const envs: Record<string, string>[] = [{ GROUP_MMS: "0" }, { GROUP_MMS: "1", OWNER_NUMBER: undefined as unknown as string }];
    for (const env of envs) {
      await h.setEnv(env);
      const r = await direct({ to_names: ["Jordan Bauer", "Coach Taylor"], body: "hi", group: true });
      expect(r.status).toBe(409);
      expect(await r.json()).toEqual({ error: "group_mms_unsupported_delivery" });
    }
    await expectNothingTouched(2);
  });

  it("android (DELIVERY unset) with GROUP_MMS=1 still sends one group MMS", async () => {
    await h.setEnv({ DELIVERY: undefined as unknown as string, GROUP_MMS: "1", OWNER_NUMBER: OWNER });
    const r = await direct({ to_names: ["Jordan Bauer", "Coach Taylor"], body: "hi all", group: true });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ state: "sent", method: "group_mms" });
    expect(h.messagesPosted().filter((m) => m.mmsMessage)).toHaveLength(1);
    expect(await count("SELECT COUNT(*) AS c FROM device_jobs")).toBe(0);
  });
});

describe("multi-send separate copies on the iPhone paths", () => {
  it("mac: each copy is its own queued job, in order; 202 queued with the names; never the gateway", async () => {
    const r = await direct({ to_names: ["Jordan Bauer", "Coach Taylor"], body: "Practice moved to 6" });
    expect(r.status).toBe(202);
    const j = (await r.json()) as any;
    expect(Object.keys(j).sort()).toEqual(["id", "method", "state", "to"]);
    expect(j).toMatchObject({ state: "queued", method: "direct", to: ["Jordan Bauer", "Coach Taylor"] });
    expect(gatewayCalls()).toHaveLength(0);
    expect(await count("SELECT COUNT(*) AS c FROM direct_sends")).toBe(2); // caps count each copy
    const jobs = await sql("SELECT ref, kind, recipient FROM device_jobs ORDER BY created_ms, rowid");
    expect(jobs.map((x) => [x.kind, x.recipient])).toEqual([["direct", JB], ["direct", CT]]);
    // one ref per copy, matching that copy's direct_approved row
    const approved = (await logOf("direct_approved")).map((x) => x.request_id);
    expect(jobs.map((x) => x.ref)).toEqual(approved);
    expect(new Set(approved).size).toBe(2);
    expect(approved[0]).toBe(j.id);
    // the device claims them one at a time, oldest first, and each outcome is logged on its own copy
    const a = await claim();
    expect(a).toMatchObject({ to: JB, text: "Practice moved to 6" });
    expect(((await (await next()).json()) as any)).toMatchObject({ job: null, reason: "busy" });
    expect((await result({ id: a.id, lease: a.lease, outcome: "sent" })).status).toBe(200);
    const b = await claim();
    expect(b).toMatchObject({ to: CT });
    expect((await result({ id: b.id, lease: b.lease, outcome: "not_started" })).status).toBe(200);
    const sent = await logOf("direct_sent");
    expect(sent).toHaveLength(1);
    expect(sent[0].request_id).toBe(approved[0]);
    expect(sent[0].detail).not.toMatch(/label=|Jordan Bauer/); // names stay out of direct_sent lines
    expect(sent[0].detail).toContain("copy=1/2");
    const failed = await logOf("direct_send_failed");
    expect(failed.map((x) => x.request_id)).toEqual([approved[1]]);
    expect(failed[0].detail).toContain("copy=2/2");
  });

  it("shortcut with the tap ping: one ping per copy, never the text or a number", async () => {
    await h.setEnv(SHORTCUT_TAP);
    const r = await direct({ to_names: ["Jordan Bauer", "Coach Taylor"], body: "secret plans" });
    expect(r.status).toBe(202);
    const pings = ntfyPosts.filter((p) => p.title === "SMS relay");
    expect(pings).toHaveLength(2);
    for (const p of pings) {
      expect(p.body).not.toContain("secret");
      expect(p.body).not.toContain(JB.slice(2));
    }
    expect(await count("SELECT COUNT(*) AS c FROM device_jobs WHERE state='queued'")).toBe(2);
  });

  it("DIRECT_NOTIFY_EACH=1: one 'queued' notice per copy, not 'direct send'", async () => {
    await h.setEnv({ DIRECT_NOTIFY_EACH: "1" });
    const r = await direct({ to_names: ["Jordan Bauer", "Coach Taylor"], body: "hi" });
    expect(r.status).toBe(202);
    expect(await r.json()).toMatchObject({ state: "queued", notified: true });
    const n = ntfyPosts.filter((p) => p.title === "SMS relay text queued");
    expect(n).toHaveLength(2);
    expect(n[0].body).toContain("SMS relay text queued for your Mac to send to Jordan Bauer");
    expect(n[1].body).toContain("to send to Coach Taylor");
    expect(ntfyPosts.some((p) => p.body.includes("direct send to"))).toBe(false);
  });

  it("the device-mode daily cap (25 by default) counts each copy and refuses a batch that would go over, queueing nothing", async () => {
    await h.setEnv({ DIRECT_DAILY_CAP: "3" });
    expect((await direct({ to_names: ["Jordan Bauer", "Coach Taylor"], body: "one" })).status).toBe(202);
    const r = await direct({ to_names: ["Jordan Ortiz", "Coach Taylor"], body: "two" });
    expect(r.status).toBe(429);
    expect(await r.json()).toEqual({ error: "direct_daily_cap_reached" });
    expect(await count("SELECT COUNT(*) AS c FROM device_jobs")).toBe(2);
  });

  it("a single send in a device mode still answers like #2 did: 202 queued with one name", async () => {
    const r = await direct({ to_name: "Coach Taylor", body: "hi" });
    expect(r.status).toBe(202);
    expect(await r.json()).toMatchObject({ state: "queued", method: "direct", to: "Coach Taylor" });
    expect(await count("SELECT COUNT(*) AS c FROM device_jobs")).toBe(1);
  });
});

describe("tap requests by name on the iPhone paths", () => {
  it("mac, DIRECT_SEND=0: filed by name, approved by tap, queued for the device, outcome recorded on the request", async () => {
    await h.setEnv({ DIRECT_SEND: "0" });
    const f = await postRequest(h, { to_name: "coach taylor", text: "Practice moved to 6" });
    expect(f.status).toBe(202);
    const j = (await f.json()) as any;
    expect(j).toMatchObject({ state: "pending", to: "Coach Taylor" });
    const a = await approve(h, j.id);
    expect(a.status).toBe(202);
    expect(gatewayCalls()).toHaveLength(0);
    expect((await sql("SELECT state FROM requests WHERE id=?", j.id))[0].state).toBe("queued_device");
    const job = await claim();
    expect(job).toMatchObject({ to: CT, text: "Practice moved to 6" });
    expect((await result({ id: job.id, lease: job.lease, outcome: "sent" })).status).toBe(200);
    expect((await sql("SELECT state FROM requests WHERE id=?", j.id))[0].state).toBe("sent");
  });
});
