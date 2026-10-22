import { describe, it, expect, beforeEach } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import { harness, postRequest, API, BASE, OWNER, FRIEND, TWO, STRANGER, T0, type Harness , enableAll } from "./helpers";
import { hmacHex, importHmacKey } from "../src/e2e";

// Multi-send on POST /send: to_names / candidate_ids (2..3), separate 1:1 copies by default, or ONE group
// MMS with group:true behind GROUP_MMS. Fake numbers only (555-01xx).
const TEST_KEY = "TEST-ONLY-log-hash-key-not-a-real-secret";
const hm = async (s: string) => hmacHex(await importHmacKey(TEST_KEY), s);
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
    { name: "Owner Self", numbers: [{ e164: OWNER, label: "mobile" }] },
  ],
};

let h: Harness;
const runIn = runInDurableObject as unknown as (s: unknown, f: (i: any) => Promise<any>) => Promise<any>;
const sql = (q: string, ...a: unknown[]) => runIn(h.relay, async (i) => i.ctx.storage.sql.exec(q, ...a).toArray()) as Promise<any[]>;
const count = async (q: string, ...a: unknown[]) => (await sql(q, ...a))[0].c as number;
const logRows = () => sql("SELECT event, request_id, recipient, sha256, detail FROM log ORDER BY seq");
const events = async (ev: string) => (await logRows()).filter((x) => x.event === ev);
const direct = (body: unknown, token = "TEST-ONLY-request-token") =>
  h.relay.fetch(`${API}/send`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
async function upload(...a: Parameters<typeof uploadRaw>) {
  const r = await uploadRaw(...a);
  if (r.ok) await enableAll(h);
  return r;
}
async function uploadRaw(snap: unknown = SNAPSHOT) {
  return h.relay.fetch(`${BASE}/contacts`, { method: "POST", headers: { "content-type": "application/json", "Cf-Access-Jwt-Assertion": await h.jwt() }, body: JSON.stringify(snap) });
}
/** Every /messages call, decoded: kind (sms = textMessage, mms = mmsMessage), all recipients, text. */
async function posted() {
  return Promise.all(
    h.messagesPosted().map(async (m) => ({
      kind: m.mmsMessage ? "mms" : "sms",
      to: await Promise.all((m.phoneNumbers as string[]).map((p) => h.decrypt(p))),
      text: await h.decrypt((m.textMessage ?? m.mmsMessage).text),
    })),
  );
}
const outbound = async () => (await posted()).filter((p) => !(p.to.length === 1 && p.to[0] === OWNER));
async function expectNothingSent() {
  expect(h.messagesPosted()).toHaveLength(0);
  expect(await count("SELECT COUNT(*) AS c FROM direct_sends")).toBe(0);
  expect(await count("SELECT COUNT(*) AS c FROM requests")).toBe(0);
}
async function expectRefused(r: Response, status: number, body: Record<string, unknown>) {
  expect(r.status).toBe(status);
  expect(await r.json()).toEqual(body);
  await expectNothingSent();
}
/** Make the Nth /messages call (1-based) fail with a 500. */
const failMessageCall = (nth: number) =>
  runIn(h.relay, async (i) => {
    const base = i.net;
    let k = 0;
    i.net = async (req: Request) => {
      const r = await base(req); // still recorded in h.calls
      if (new URL(req.url).pathname === "/3rdparty/v1/messages" && ++k === nth) return new Response("TEST-ONLY down", { status: 500 });
      return r;
    };
  });
async function resolveNames(names: string[], extra: Record<string, unknown> = {}) {
  const r = await direct({ to_names: names, resolve: true, ...extra });
  expect(r.status).toBe(200);
  return (await r.json()) as { state: string; results: { index: number; name: string; state: string; candidates: { candidate_id: string; label: string }[] }[]; expires_in_s: number };
}

beforeEach(async () => {
  h = await harness();
  await h.setEnv({ DIRECT_SEND: "1" });
  expect((await upload()).status).toBe(200);
  h.calls.length = 0;
});

describe("multi-send: separate 1:1 copies", () => {
  it("to_names: each recipient gets its own textMessage copy; response lists names only; one log row pair per copy", async () => {
    const r = await direct({ to_names: ["Jordan Bauer", "Coach Taylor"], body: "Practice moved to 6" });
    expect(r.status).toBe(200);
    const j = (await r.json()) as any;
    expect(Object.keys(j).sort()).toEqual(["id", "method", "state", "to"]);
    expect(j).toMatchObject({ state: "sent", method: "direct", to: ["Jordan Bauer", "Coach Taylor"] });
    expect(await posted()).toEqual([
      { kind: "sms", to: [KB], text: "Practice moved to 6" },
      { kind: "sms", to: [PM], text: "Practice moved to 6" },
    ]);
    const sent = await events("direct_sent");
    expect(sent).toHaveLength(2);
    expect(sent[0].detail).toContain(`to_hmac=${await hm(`num:${KB}`)}`);
    expect(sent[1].detail).toContain(`to_hmac=${await hm(`num:${PM}`)}`);
    expect(sent[0].detail).toContain("via=names");
    expect(sent[0].detail).toContain("copy=1/2");
    expect(new Set(sent.map((x) => x.request_id)).size).toBe(2);
    expect(sent.every((x) => x.sha256 === sent[0].sha256 && x.sha256.startsWith("hmac:"))).toBe(true);
    expect(await events("direct_approved")).toHaveLength(2);
    expect(await count("SELECT COUNT(*) AS c FROM direct_sends")).toBe(2);
    expect(JSON.stringify(await logRows())).not.toContain("Practice moved");
  });

  it("three recipients, including the tap ALLOWLIST and diacritics", async () => {
    const j = (await (await direct({ to_names: ["jose nunez", "Test Two", "Coach Taylor"], body: "hi" })).json()) as any;
    expect(j.to).toEqual(["José  Núñez", "Test Two", "Coach Taylor"]);
    expect((await outbound()).map((p) => p.to[0])).toEqual([JN, TWO, PM]);
  });

  it("resolve:true with to_names: per-name state and digit-free candidates, nothing sent; then candidate_ids sends", async () => {
    const res = await resolveNames(["jordan", "Coach Taylor", "Nobody Here", "Room 12"].slice(0, 3));
    expect(res.state).toBe("resolved");
    expect(res.expires_in_s).toBe(900);
    expect(res.results.map((x) => [x.index, x.name, x.state, x.candidates.length])).toEqual([
      [0, "jordan", "ambiguous", 2],
      [1, "Coach Taylor", "one", 1],
      [2, "Nobody Here", "no_match", 0],
    ]);
    for (const x of res.results) for (const c of x.candidates) {
      expect(Object.keys(c).sort()).toEqual(["candidate_id", "label"]);
      expect(c.label).not.toMatch(/\d/);
    }
    await expectNothingSent();
    const ortiz = res.results[0].candidates.find((c) => c.label.startsWith("Jordan Ortiz"))!;
    const bauer = res.results[0].candidates.find((c) => c !== ortiz)!;
    const r = await direct({ candidate_ids: [ortiz.candidate_id, res.results[1].candidates[0].candidate_id], body: "See you Sunday" });
    expect(await r.json()).toMatchObject({ state: "sent", method: "direct", to: ["Jordan Ortiz", "Coach Taylor"] });
    expect((await outbound()).map((p) => p.to[0])).toEqual([KO, PM]);
    expect((await events("direct_sent"))[0].detail).toContain("via=candidates");
    // using Ortiz retired the Bauer sibling for that name
    const again = await direct({ candidate_id: bauer.candidate_id, body: "x" });
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: "candidate_used" });
  });

  it("a submitted name with digits is never echoed back", async () => {
    const res = await resolveNames(["Coach Taylor", "Room 12"]);
    expect(res.results[1]).toEqual({ index: 1, name: "(withheld)", state: "no_match", candidates: [] });
    const r = await direct({ to_names: ["Coach Taylor", "555 0101 guy"], body: "x" });
    expect(await r.json()).toEqual({ error: "multi_send_unresolved", failed: [{ index: 1, name: "(withheld)", reason: "no_match" }] });
  });
});

describe("multi-send guards", () => {
  it.each([
    [{ to_names: ["Jordan Bauer", "Coach Taylor"], to_name: "Coach Taylor", body: "x" }],
    [{ to_names: ["Jordan Bauer", "Coach Taylor"], candidate_ids: ["0".repeat(32), "f".repeat(32)], body: "x" }],
    [{ candidate_ids: ["0".repeat(32), "f".repeat(32)], to: FRIEND, body: "x" }],
    [{ to_names: ["Jordan Bauer", "Coach Taylor"], candidate_id: "0".repeat(32), body: "x" }],
    [{ to_names: ["Jordan Bauer", "Coach Taylor"], to: FRIEND, body: "x" }],
  ])("exactly one of the five forms: %j → 400, nothing sent", async (b) => {
    await expectRefused(await direct(b), 400, { error: "exactly_one_of_to_to_name_candidate_id" });
  });

  it.each([
    [{ to_names: [], body: "x" }, "multi_send_needs_2_to_3"],
    [{ to_names: ["Coach Taylor"], body: "x" }, "multi_send_needs_2_to_3"],
    [{ to_names: ["Coach Taylor", "Jordan Bauer", "Test Two", "Test Friend"], body: "x" }, "multi_send_needs_2_to_3"],
    [{ candidate_ids: ["0".repeat(32)], body: "x" }, "multi_send_needs_2_to_3"],
    [{ candidate_ids: ["0".repeat(32), "1".repeat(32), "2".repeat(32), "3".repeat(32)], body: "x" }, "multi_send_needs_2_to_3"],
    [{ to_names: "Coach Taylor", body: "x" }, "to_names_must_be_array"],
    [{ candidate_ids: "0".repeat(32), body: "x" }, "candidate_ids_must_be_array"],
  ])("array size and type %j → 400 %s", async (b, code) => {
    await expectRefused(await direct(b), 400, { error: code });
  });

  it("one recipient uses to_name; to_names with one entry is multi_send_needs_2_to_3", async () => {
    const named = await direct({ to_name: "Coach Taylor", resolve: true });
    expect(named.status).toBe(200);
    expect(await named.json()).toMatchObject({ state: "one" });
    await expectRefused(await direct({ to_names: ["Coach Taylor"], body: "x" }), 400, { error: "multi_send_needs_2_to_3" });
    await expectRefused(await direct({ to_names: ["Coach Taylor"], resolve: true }), 400, { error: "multi_send_needs_2_to_3" });
    expect(h.calls.filter((c) => c.url.endsWith("/messages"))).toHaveLength(0);
  });

  it.each([
    [{ to_names: ["Coach Taylor", 5], body: "x" }, 1],
    [{ to_names: [null, "Coach Taylor"], body: "x" }, 0],
    [{ to_names: ["Coach Taylor", ["Jordan Bauer"]], body: "x" }, 1],
    [{ candidate_ids: ["0".repeat(32), 42], body: "x" }, 1],
  ])("non-string entry %j → 400 naming index %i", async (b, index) => {
    await expectRefused(await direct(b), 400, { error: "multi_send_entry_not_string", failed: [{ index }] });
  });

  it("duplicate names (after normalization) → refused, naming the entry", async () => {
    await expectRefused(await direct({ to_names: ["Coach Taylor", "  coach   TAYLOR "], body: "x" }), 400, { error: "multi_send_duplicate", failed: [{ index: 1, name: "coach TAYLOR" }] });
    await expectRefused(await direct({ to_names: ["José Núñez", "jose nunez"], body: "x" }), 400, { error: "multi_send_duplicate", failed: [{ index: 1, name: "jose nunez" }] });
  });

  it("duplicate candidate ids, and two ids from one name's lookup, are refused", async () => {
    const res = await resolveNames(["jordan", "Coach Taylor"]);
    const [a, b] = res.results[0].candidates;
    await expectRefused(await direct({ candidate_ids: [a.candidate_id, a.candidate_id], body: "x" }), 400, { error: "multi_send_duplicate", failed: [{ index: 1 }] });
    await expectRefused(await direct({ candidate_ids: [a.candidate_id, b.candidate_id], body: "x" }), 400, { error: "multi_send_duplicate", failed: [{ index: 1 }] });
    // nothing was consumed by those refusals
    expect(await count("SELECT COUNT(*) AS c FROM candidates WHERE used=1")).toBe(0);
  });

  it("two names that resolve to the same number → duplicate refusal, nothing sent", async () => {
    await expectRefused(await direct({ to_names: ["Coach Taylor", "coach"], body: "x" }), 400, { error: "multi_send_duplicate_recipient", failed: [{ index: 1, name: "coach" }] });
    await expectRefused(await direct({ to_names: ["José Núñez", "jose"], body: "x" }), 400, { error: "multi_send_duplicate_recipient", failed: [{ index: 1, name: "jose" }] });
  });

  it("same number via candidate ids from two lookups → duplicate refusal", async () => {
    const a = (await resolveNames(["Coach Taylor", "Test Two"])).results[0].candidates[0];
    const b = (await resolveNames(["coach", "Test Two"])).results[0].candidates[0];
    await expectRefused(await direct({ candidate_ids: [a.candidate_id, b.candidate_id], body: "x" }), 400, { error: "multi_send_duplicate_recipient", failed: [{ index: 1 }] });
  });

  it("all or nothing: one miss sends nothing and names the entry", async () => {
    await expectRefused(await direct({ to_names: ["Jordan Bauer", "Nobody"], body: "x" }), 409, { error: "multi_send_unresolved", failed: [{ index: 1, name: "Nobody", reason: "no_match" }] });
    expect((await events("direct_refused")).at(-1).detail).toContain("reason=multi_send_unresolved failed_index=1");
  });

  it("all or nothing: one ambiguous name sends nothing, no candidates are issued", async () => {
    await expectRefused(await direct({ to_names: ["jordan", "Coach Taylor", "zoe hall"], body: "x" }), 409, {
      error: "multi_send_unresolved",
      failed: [{ index: 0, name: "jordan", reason: "ambiguous" }, { index: 2, name: "zoe hall", reason: "ambiguous" }],
    });
    expect(await count("SELECT COUNT(*) AS c FROM candidates")).toBe(0);
  });

  it("all or nothing on candidate ids: an unknown, used or expired entry sends nothing and leaves the good ids unused", async () => {
    const res = await resolveNames(["Coach Taylor", "Test Two"]);
    const pm = res.results[0].candidates[0].candidate_id, two = res.results[1].candidates[0].candidate_id;
    await expectRefused(await direct({ candidate_ids: [pm, "f".repeat(32)], body: "x" }), 404, { error: "candidate_unknown", failed: [{ index: 1 }] });
    await expectRefused(await direct({ candidate_ids: [pm, "not-an-id"], body: "x" }), 404, { error: "candidate_unknown", failed: [{ index: 1 }] });
    h.setNow(T0 + 15 * 60_000);
    await expectRefused(await direct({ candidate_ids: [pm, two], body: "x" }), 410, { error: "candidate_expired", failed: [{ index: 0 }] });
    h.setNow(T0 + 60_000);
    expect(await (await direct({ candidate_ids: [pm, two], body: "x" })).json()).toMatchObject({ state: "sent", to: ["Coach Taylor", "Test Two"] });
    h.calls.length = 0;
    const r = await direct({ candidate_ids: [two, pm], body: "x" });
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: "candidate_used", failed: [{ index: 0 }] });
    expect(h.messagesPosted()).toHaveLength(0);
  });

  it("a candidate whose number left the list refuses the whole batch", async () => {
    const res = await resolveNames(["Coach Taylor", "Test Two"]);
    await h.setEnv({ ALLOWLIST: JSON.stringify({ [FRIEND]: "Test Friend" }) }); // Test Two leaves the tap list
    await expectRefused(await direct({ candidate_ids: res.results.map((x) => x.candidates[0].candidate_id), body: "x" }), 404, { error: "candidate_unknown", failed: [{ index: 1 }] });
  });

  it("partial failure: stops at the failed copy, never retries, and reports sent and not sent by name", async () => {
    await failMessageCall(2);
    const r = await direct({ to_names: ["Jordan Bauer", "Coach Taylor", "Test Two"], body: "x" });
    expect(r.status).toBe(502);
    const j = (await r.json()) as any;
    expect(j).toMatchObject({ state: "partial", method: "direct", sent: ["Jordan Bauer"], not_sent: ["Coach Taylor", "Test Two"] });
    expect(j.to).toBeUndefined();
    expect(h.calls.filter((c) => c.url.endsWith("/messages"))).toHaveLength(2); // the 3rd copy was never tried, no retry
    expect(await events("direct_sent")).toHaveLength(1);
    expect(await events("direct_send_failed")).toHaveLength(1);
    expect((await events("direct_not_sent")).map((x) => x.detail.match(/copy=(\d\/\d)/)![1])).toEqual(["3/3"]);
  });

  it("first copy fails → send_failed, nothing else attempted", async () => {
    await failMessageCall(1);
    const r = await direct({ to_names: ["Jordan Bauer", "Coach Taylor"], body: "x" });
    expect(r.status).toBe(502);
    expect(await r.json()).toMatchObject({ state: "send_failed", sent: [], not_sent: ["Jordan Bauer", "Coach Taylor"] });
    expect(h.calls.filter((c) => c.url.endsWith("/messages"))).toHaveLength(1);
  });

  it("raw-number arrays are still group_send_not_allowed; DISABLED, the token and LOG_HASH_KEY gates are unchanged", async () => {
    await expectRefused(await direct({ to: [KB, PM], body: "x" }), 400, { error: "group_send_not_allowed" });
    await expectRefused(await direct({ to_name: ["Jordan Bauer", "Coach Taylor"], body: "x" }), 400, { error: "group_send_not_allowed" });
    const b = { to_names: ["Jordan Bauer", "Coach Taylor"], body: "x" };
    await expectRefused(await direct(b, "TEST-ONLY-wrong"), 401, { error: "bad_request_token" });
    await h.setEnv({ LOG_HASH_KEY: "TEST-ONLY-too-short" });
    await expectRefused(await direct(b), 503, { error: "direct_config_invalid" });
    await h.setEnv({ LOG_HASH_KEY: TEST_KEY, DIRECT_SEND: "0" });
    await expectRefused(await direct(b), 403, { error: "direct_send_off" });
    await h.setEnv({ DIRECT_SEND: "1", DISABLED: "1" });
    await expectRefused(await direct(b), 503, { error: "relay_disabled" });
  });
});

describe("multi-send: lookup rate limit counts each name", () => {
  it("resolve with 3 names uses 3 lookups", async () => {
    await h.setEnv({ DIRECT_LOOKUP_MAX_PER_HOUR: "4" });
    await resolveNames(["Coach Taylor", "Test Two", "jordan"]);
    expect(await count("SELECT COUNT(*) AS c FROM nonsend")).toBe(3);
    expect(((await (await direct({ to_name: "nobody", body: "x" })).json()) as any).state).toBe("no_match"); // the 4th
    await expectRefused(await direct({ to_name: "nobody", body: "x" }), 429, { error: "lookup_rate" });
  });

  it("a batch of names over the remaining budget is refused whole, before any candidate is stored", async () => {
    await h.setEnv({ DIRECT_LOOKUP_MAX_PER_HOUR: "2" });
    await expectRefused(await direct({ to_names: ["Coach Taylor", "Test Two", "jordan"], resolve: true }), 429, { error: "lookup_rate" });
    expect(await count("SELECT COUNT(*) AS c FROM candidates")).toBe(0);
    expect(await count("SELECT COUNT(*) AS c FROM nonsend")).toBe(0);
    await resolveNames(["Coach Taylor", "Test Two"]); // exactly 2 fits
  });

  it("an unresolved batch counts each name; a successful batch counts none", async () => {
    await h.setEnv({ DIRECT_LOOKUP_MAX_PER_HOUR: "4" });
    expect((await direct({ to_names: ["Nobody", "Coach Taylor", "jordan"], body: "x" })).status).toBe(409);
    expect(await count("SELECT COUNT(*) AS c FROM nonsend")).toBe(3);
    await expectRefused(await direct({ to_names: ["Nobody", "Coach Taylor"], body: "x" }), 429, { error: "lookup_rate" });
    expect(await (await direct({ to_names: ["Jordan Bauer", "Coach Taylor"], body: "x" })).json()).toMatchObject({ state: "sent" });
    expect(await count("SELECT COUNT(*) AS c FROM nonsend")).toBe(3);
  });
});

describe("multi-send: caps count each copy and are checked before any copy", () => {
  it("DIRECT_DAILY_CAP: a batch that would go over sends nothing; a batch that fits exactly sends", async () => {
    await h.setEnv({ DIRECT_DAILY_CAP: "3" });
    expect((await direct({ to: FRIEND, body: "a" })).status).toBe(200);
    h.calls.length = 0;
    const r = await direct({ to_names: ["Jordan Bauer", "Coach Taylor", "Test Two"], body: "b" });
    expect(r.status).toBe(429);
    expect(await r.json()).toEqual({ error: "direct_daily_cap_reached" });
    expect(h.messagesPosted()).toHaveLength(0);
    expect(await count("SELECT COUNT(*) AS c FROM direct_sends")).toBe(1);
    expect(await (await direct({ to_names: ["Jordan Bauer", "Coach Taylor"], body: "c" })).json()).toMatchObject({ state: "sent" });
    expect(await count("SELECT COUNT(*) AS c FROM direct_sends")).toBe(3);
    expect((await direct({ to: FRIEND, body: "d" })).status).toBe(429);
  });

  it("a cap-refused batch sends nothing and retires its candidate ids (same rule as a single candidate_id)", async () => {
    await h.setEnv({ DIRECT_DAILY_CAP: "1" });
    const res = await resolveNames(["Coach Taylor", "Test Two"]);
    const ids = res.results.map((x) => x.candidates[0].candidate_id);
    await expectRefused(await direct({ candidate_ids: ids, body: "x" }), 429, { error: "direct_daily_cap_reached" });
    expect(await count("SELECT COUNT(*) AS c FROM candidates WHERE used=1")).toBe(2);
  });

  it("DIRECT_PER_MINUTE_MAX counts each copy", async () => {
    await h.setEnv({ DIRECT_PER_MINUTE_MAX: "3" });
    expect((await direct({ to_names: ["Jordan Bauer", "Coach Taylor", "Test Two"], body: "a" })).status).toBe(200);
    h.calls.length = 0;
    expect(await (await direct({ to: FRIEND, body: "b" })).json()).toEqual({ error: "direct_per_minute_reached" });
    h.setNow(T0 + 60_001);
    expect((await direct({ to_names: ["Jordan Bauer", "Coach Taylor"], body: "c" })).status).toBe(200);
  });

  it("DIRECT_PER_MINUTE_MAX: a batch that would go over is refused whole, before any copy", async () => {
    await h.setEnv({ DIRECT_PER_MINUTE_MAX: "2" });
    expect((await direct({ to: FRIEND, body: "a" })).status).toBe(200);
    h.calls.length = 0;
    const r = await direct({ to_names: ["Jordan Bauer", "Coach Taylor"], body: "b" });
    expect(r.status).toBe(429);
    expect(await r.json()).toEqual({ error: "direct_per_minute_reached" });
    expect(h.messagesPosted()).toHaveLength(0);
    expect(await count("SELECT COUNT(*) AS c FROM direct_sends")).toBe(1);
  });

  it("runaway guard counts each copy: a batch that would cross RUNAWAY_MAX pauses and sends nothing", async () => {
    await h.setEnv({ RUNAWAY_MAX: "2" });
    expect((await direct({ to_names: ["Jordan Bauer", "Coach Taylor"], body: "a" })).status).toBe(200);
    await runIn(h.relay, async (i) => i.ctx.storage.sql.exec("DELETE FROM direct_sends"));
    h.calls.length = 0;
    const r = await direct({ to_names: ["Jordan Bauer", "Coach Taylor", "Test Two"], body: "b" });
    expect(await r.json()).toEqual({ error: "direct_paused" });
    expect((await outbound())).toHaveLength(0);
  });
});

describe("tap /request stays single-recipient", () => {
  it.each([
    [{ to: [FRIEND, TWO], text: "hi" }, "group_send_not_allowed"],
    [{ to_names: ["Test Friend", "Test Two"], text: "hi" }, "unknown_fields"],
    [{ candidate_ids: ["0".repeat(32), "f".repeat(32)], text: "hi" }, "unknown_fields"],
    [{ to: FRIEND, text: "hi", group: true }, "unknown_fields"],
  ])("%j → 400 %s, nothing queued or sent", async (b, code) => {
    await h.setEnv({ GROUP_MMS: "1" });
    const r = await postRequest(h, b);
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: code });
    await expectNothingSent();
  });
});

describe("group MMS (group:true, behind GROUP_MMS)", () => {
  const G = { to_names: ["Jordan Bauer", "Coach Taylor"], body: "Dinner at 6?", group: true };

  it.each([undefined, "", "0"])("GROUP_MMS=%j (off) → 403 group_mms_off, nothing sent", async (v) => {
    await h.setEnv({ GROUP_MMS: v as unknown as string });
    await expectRefused(await direct(G), 403, { error: "group_mms_off" });
    // multi-send without group still works while it's off
    expect(await (await direct({ to_names: G.to_names, body: "x" })).json()).toMatchObject({ state: "sent", method: "direct" });
  });

  it.each(["yes", "true", "on", "1 ", " 1", "01", "off"])("GROUP_MMS=%j is garbage → 503 direct_config_invalid for every /send (fail closed)", async (v) => {
    await h.setEnv({ GROUP_MMS: v });
    await expectRefused(await direct(G), 503, { error: "direct_config_invalid" });
    await expectRefused(await direct({ to: FRIEND, body: "x" }), 503, { error: "direct_config_invalid" });
  });

  it("sends exactly ONE gateway call: mmsMessage, encrypted, every recipient in phoneNumbers", async () => {
    await h.setEnv({ GROUP_MMS: "1" });
    const r = await direct(G);
    expect(r.status).toBe(200);
    const j = (await r.json()) as any;
    expect(Object.keys(j).sort()).toEqual(["id", "method", "state", "to"]);
    expect(j).toMatchObject({ state: "sent", method: "group_mms", to: ["Jordan Bauer", "Coach Taylor"] });
    const msgs = h.messagesPosted();
    expect(msgs).toHaveLength(1);
    expect(Object.keys(msgs[0]).sort()).toEqual(["deviceId", "isEncrypted", "mmsMessage", "phoneNumbers"]);
    expect(msgs[0]).toMatchObject({ deviceId: "test-device", isEncrypted: true });
    expect(Object.keys(msgs[0].mmsMessage)).toEqual(["text"]);
    expect(msgs[0].mmsMessage.text.startsWith("$rsa-oaep-aes-256-gcm$v=1$k=1$")).toBe(true);
    expect(await posted()).toEqual([{ kind: "mms", to: [KB, PM], text: "Dinner at 6?" }]);
  });

  it("logs ONE approved and ONE sent row carrying every recipient's HMAC; caps count it as N", async () => {
    await h.setEnv({ GROUP_MMS: "1" });
    await direct({ ...G, to_names: ["Jordan Bauer", "Coach Taylor", "Test Two"] });
    const sent = await events("direct_sent");
    expect(sent).toHaveLength(1);
    expect(await events("direct_approved")).toHaveLength(1);
    for (const n of [KB, PM, TWO]) expect(sent[0].detail).toContain(`to_hmac=${await hm(`num:${n}`)}`);
    expect(sent[0].detail).toContain("method=group_mms via=names recipients=3");
    expect(await count("SELECT COUNT(*) AS c FROM direct_sends")).toBe(3);
    expect((await posted())[0].to).toEqual([KB, PM, TWO]);
    expect((await events("gateway_mode"))[0].detail).toBe("rsa mms");
  });

  it("caps: DIRECT_DAILY_CAP=2 refuses a group of 3 before sending, allows a group of 2", async () => {
    await h.setEnv({ GROUP_MMS: "1", DIRECT_DAILY_CAP: "2" });
    await expectRefused(await direct({ ...G, to_names: ["Jordan Bauer", "Coach Taylor", "Test Two"] }), 429, { error: "direct_daily_cap_reached" });
    expect(await (await direct(G)).json()).toMatchObject({ method: "group_mms", state: "sent" });
    expect((await direct({ to: FRIEND, body: "x" })).status).toBe(429);
  });

  it.each([
    [{ to_names: ["Coach Taylor"], body: "x", group: true }, 400, "multi_send_needs_2_to_3"],
    [{ to_name: "Coach Taylor", body: "x", group: true }, 400, "group_needs_to_names_or_candidate_ids"],
    [{ to: PM, body: "x", group: true }, 400, "group_needs_to_names_or_candidate_ids"],
    [{ candidate_id: "0".repeat(32), body: "x", group: true }, 400, "group_needs_to_names_or_candidate_ids"],
    [{ to_names: ["Jordan Bauer", "Coach Taylor"], body: "x", group: "true" }, 400, "group_must_be_true"],
    [{ to_names: ["Jordan Bauer", "Coach Taylor"], body: "x", group: false }, 400, "group_must_be_true"],
    [{ to: [KB, PM], body: "x", group: true }, 400, "group_needs_to_names_or_candidate_ids"],
  ])("%j → %i %s, nothing sent", async (b, status, code) => {
    await h.setEnv({ GROUP_MMS: "1" });
    await expectRefused(await direct(b), status, { error: code });
  });

  it("every recipient must be on the list: one miss, ambiguity or duplicate sends nothing", async () => {
    await h.setEnv({ GROUP_MMS: "1" });
    await expectRefused(await direct({ ...G, to_names: ["Jordan Bauer", "Stranger Danger"] }), 409, { error: "multi_send_unresolved", failed: [{ index: 1, name: "Stranger Danger", reason: "no_match" }] });
    await expectRefused(await direct({ ...G, to_names: ["jordan", "Coach Taylor"] }), 409, { error: "multi_send_unresolved", failed: [{ index: 0, name: "jordan", reason: "ambiguous" }] });
    await expectRefused(await direct({ ...G, to_names: ["Coach Taylor", "coach"] }), 400, { error: "multi_send_duplicate_recipient", failed: [{ index: 1, name: "coach" }] });
    await expectRefused(await direct({ ...G, to_names: undefined, candidate_ids: ["0".repeat(32), "f".repeat(32)] }), 404, { error: "candidate_unknown", failed: [{ index: 0 }] });
  });

  it("never includes the owner's own number (refused digit-free, by index and name)", async () => {
    await h.setEnv({ GROUP_MMS: "1" });
    await expectRefused(await direct({ ...G, to_names: ["Coach Taylor", "Owner Self"] }), 400, { error: "group_includes_owner", failed: [{ index: 1, name: "Owner Self" }] });
    const res = await resolveNames(["Owner Self", "Coach Taylor"], { group: true });
    await expectRefused(await direct({ candidate_ids: res.results.map((x) => x.candidates[0].candidate_id), body: "x", group: true }), 400, { error: "group_includes_owner", failed: [{ index: 0 }] });
    expect(await count("SELECT COUNT(*) AS c FROM candidates WHERE used=1")).toBe(0);
  });

  it("resolve then candidate_ids with group:true → one MMS", async () => {
    await h.setEnv({ GROUP_MMS: "1" });
    const res = await resolveNames(["jordan", "Coach Taylor"], { group: true });
    await expectNothingSent();
    const ortiz = res.results[0].candidates.find((c) => c.label.startsWith("Jordan Ortiz"))!;
    const j = (await (await direct({ candidate_ids: [ortiz.candidate_id, res.results[1].candidates[0].candidate_id], body: "hi both", group: true })).json()) as any;
    expect(j).toMatchObject({ state: "sent", method: "group_mms", to: ["Jordan Ortiz", "Coach Taylor"] });
    expect(await posted()).toEqual([{ kind: "mms", to: [KO, PM], text: "hi both" }]);
    expect((await events("direct_sent"))[0].detail).toContain("via=candidates");
  });

  it("gateway failure → 502 send_failed, one call only, no retry, no fallback to copies", async () => {
    await h.setEnv({ GROUP_MMS: "1" });
    await failMessageCall(1);
    const r = await direct(G);
    expect(r.status).toBe(502);
    expect(await r.json()).toMatchObject({ state: "send_failed", method: "group_mms" });
    expect(h.calls.filter((c) => c.url.endsWith("/messages"))).toHaveLength(1);
    expect(await events("direct_send_failed")).toHaveLength(1);
  });

  it("single sends keep textMessage even with GROUP_MMS on", async () => {
    await h.setEnv({ GROUP_MMS: "1" });
    expect(await (await direct({ to_name: "Coach Taylor", body: "x" })).json()).toMatchObject({ state: "sent", method: "direct", to: "Coach Taylor" });
    expect(await posted()).toEqual([{ kind: "sms", to: [PM], text: "x" }]);
  });

  it("gatewaySendGroup refuses fewer than two recipients; gatewaySend refuses more than one", async () => {
    await runIn(h.relay, async (i) => {
      await expect(i.gatewaySendGroup([PM], "x")).rejects.toThrow("group_needs_two_recipients");
      await expect(i.gatewayPost([PM, KB], "x", "sms")).rejects.toThrow("bad_recipient");
    });
    expect(h.messagesPosted()).toHaveLength(0);
  });
});

describe("copy log rows survive the phone-number scan whatever the random batch ref is", () => {
  it("an all-digit batch ref is labelled so it isn't read as a number", async () => {
    const { looksLikePhone } = await import("../src/direct");
    expect(looksLikePhone("method=direct via=names to_hmac=" + "a".repeat(64) + " label=Coach Taylor batch_ref=12345678 copy=1/2")).toBe(false);
    expect(looksLikePhone("label=Coach Taylor batch=12345678 copy=1/2")).toBe(true); // the old label would have tripped it
  });
});

describe("group MMS needs a valid OWNER_NUMBER (the owner-exclusion check never silently turns off)", () => {
  const G = { to_names: ["Jordan Bauer", "Coach Taylor"], body: "Dinner at 6?", group: true };

  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["no plus", "15555550100"],
    ["spaces", "+1 555 555 0100"],
    ["letters", "owner"],
    ["too long", "+1555555010000000"],
  ])("OWNER_NUMBER %s + GROUP_MMS=1 → 503 config_invalid for group sends, nothing sent", async (_label, v) => {
    await h.setEnv({ GROUP_MMS: "1", OWNER_NUMBER: v as unknown as string });
    await expectRefused(await direct(G), 503, { error: "config_invalid" });
    // a group lookup is refused the same way, and stores no candidates
    await expectRefused(await direct({ to_names: G.to_names, resolve: true, group: true }), 503, { error: "config_invalid" });
    expect(await count("SELECT COUNT(*) AS c FROM candidates")).toBe(0);
    // non-group sends don't depend on it
    expect(await (await direct({ to_names: G.to_names, body: "x" })).json()).toMatchObject({ state: "sent", method: "direct" });
  });

  it("with GROUP_MMS off, a bad OWNER_NUMBER still answers group_mms_off (the gate comes first)", async () => {
    await h.setEnv({ GROUP_MMS: "0", OWNER_NUMBER: "" });
    await expectRefused(await direct(G), 403, { error: "group_mms_off" });
  });

  it("a valid OWNER_NUMBER keeps working, and the owner is still refused", async () => {
    await h.setEnv({ GROUP_MMS: "1" });
    expect(await (await direct(G)).json()).toMatchObject({ state: "sent", method: "group_mms" });
    h.calls.length = 0;
    const r = await direct({ ...G, to_names: ["Coach Taylor", "Owner Self"] });
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: "group_includes_owner", failed: [{ index: 1, name: "Owner Self" }] });
    expect(h.messagesPosted()).toHaveLength(0);
  });
});
