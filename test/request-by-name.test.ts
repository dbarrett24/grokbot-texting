import { describe, it, expect, beforeEach } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import { harness, postRequest, approve, BASE, OWNER, FRIEND, STRANGER, T0, type Harness , enableAll } from "./helpers";

// Tap flow (POST /request) filed by contact name or candidate id instead of a number.
// Fake numbers only (555-01xx).
const JB = "+15555550111", JO = "+15555550112", CT = "+15555550115";
const SNAPSHOT = {
  generated_at: "2026-10-16T23:00:00Z",
  contacts: [
    { name: "Jordan Bauer", given: "Jordan", numbers: [{ e164: JB, label: "mobile" }] },
    { name: "Jordan Ortiz", given: "Jordan", numbers: [{ e164: JO, label: "mobile" }] },
    { name: "Coach Taylor", numbers: [{ e164: CT, label: "unlabeled" }] },
  ],
};

let h: Harness;
const runIn = runInDurableObject as unknown as (s: unknown, f: (i: any) => Promise<any>) => Promise<any>;
const sql = (q: string, ...a: unknown[]) => runIn(h.relay, async (i) => i.ctx.storage.sql.exec(q, ...a).toArray()) as Promise<any[]>;
const count = async (q: string, ...a: unknown[]) => (await sql(q, ...a))[0].c as number;
async function upload(...a: Parameters<typeof uploadRaw>) {
  const r = await uploadRaw(...a);
  if (r.ok) await enableAll(h);
  return r;
}
async function uploadRaw(snap: unknown = SNAPSHOT) {
  return h.relay.fetch(`${BASE}/contacts`, { method: "POST", headers: { "content-type": "application/json", "Cf-Access-Jwt-Assertion": await h.jwt() }, body: JSON.stringify(snap) });
}
/** Every /messages call that isn't a notice to the owner, decoded. */
async function outbound() {
  const all = await Promise.all(h.messagesPosted().map(async (m) => ({ to: await h.decrypt(m.phoneNumbers[0]), text: await h.decrypt(m.textMessage.text) })));
  return all.filter((m) => m.to !== OWNER);
}
async function expectNothingQueued(r: Response, status: number, body: Record<string, unknown>) {
  expect(r.status).toBe(status);
  expect(await r.json()).toEqual(body);
  expect(await count("SELECT COUNT(*) AS c FROM requests")).toBe(0);
  expect(h.messagesPosted()).toHaveLength(0);
}

beforeEach(async () => {
  h = await harness();
  await h.setEnv({ DIRECT_SEND: "0" });
  expect((await upload()).status).toBe(200);
  h.calls.length = 0;
});

describe("POST /request with to_name", () => {
  it("one match in contacts (not on ALLOWLIST) → 202 pending with the name; the notice names them; approve sends to that number", async () => {
    const r = await postRequest(h, { to_name: "coach taylor", text: "Practice moved to 6" });
    expect(r.status).toBe(202);
    const j = (await r.json()) as any;
    expect(Object.keys(j).sort()).toEqual(["expires_ms", "id", "notified", "sha256", "state", "to"]);
    expect(j).toMatchObject({ state: "pending", notified: true, to: "Coach Taylor" });
    const row = (await sql("SELECT recipient, via, to_label FROM requests WHERE id=?", j.id))[0];
    expect(row).toEqual({ recipient: CT, via: "contacts", to_label: "Coach Taylor" });
    const notice = await h.decrypt(h.messagesPosted()[0].textMessage.text);
    expect(notice).toContain("Coach Taylor");
    const page = await (await h.relay.fetch(`${BASE}/approve/${j.id}`, { headers: { "Cf-Access-Jwt-Assertion": await h.jwt() } })).text();
    expect(page).toContain("<b>To:</b> Coach Taylor (");
    h.calls.length = 0;
    const a = await approve(h, j.id);
    expect(a.status).toBe(200);
    expect(await outbound()).toEqual([{ to: CT, text: "Practice moved to 6" }]);
    const created = (await sql("SELECT detail FROM log WHERE event='request_created'"))[0];
    expect(created.detail).toBe("via=name");
  });

  it("a name on ALLOWLIST works too", async () => {
    const j = (await (await postRequest(h, { to_name: "Test Friend", text: "hi" })).json()) as any;
    expect(j).toMatchObject({ state: "pending", to: "Test Friend" });
    expect((await sql("SELECT recipient FROM requests"))[0].recipient).toBe(FRIEND);
  });

  it("no match → 200 no_match, nothing filed, no notice", async () => {
    await expectNothingQueued(await postRequest(h, { to_name: "Nobody Here", text: "hi" }), 200, { state: "no_match", candidates: [] });
  });

  it("ambiguous → 200 with candidate ids and labels, nothing filed; then candidate_id files it and retires the sibling", async () => {
    const r = await postRequest(h, { to_name: "jordan", text: "hi" });
    expect(r.status).toBe(200);
    const j = (await r.json()) as any;
    expect(j.state).toBe("ambiguous");
    expect(j.candidates.map((c: any) => c.label).sort()).toEqual(["Jordan Bauer (mobile)", "Jordan Ortiz (mobile)"]);
    expect(await count("SELECT COUNT(*) AS c FROM requests")).toBe(0);
    expect(h.messagesPosted()).toHaveLength(0);
    const ortiz = j.candidates.find((c: any) => c.label.startsWith("Jordan Ortiz"));
    const bauer = j.candidates.find((c: any) => c !== ortiz);
    const f = (await (await postRequest(h, { candidate_id: ortiz.candidate_id, text: "hi" })).json()) as any;
    expect(f).toMatchObject({ state: "pending", to: "Jordan Ortiz" });
    expect((await sql("SELECT recipient FROM requests WHERE id=?", f.id))[0].recipient).toBe(JO);
    expect((await sql("SELECT detail FROM log WHERE event='request_created'"))[0].detail).toBe("via=candidate");
    h.calls.length = 0;
    const again = await postRequest(h, { candidate_id: bauer.candidate_id, text: "hi" });
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: "candidate_used" });
    expect(await count("SELECT COUNT(*) AS c FROM requests")).toBe(1);
  });

  it("candidate ids from /send work here too, and are single use", async () => {
    await h.setEnv({ DIRECT_SEND: "1" });
    const res = (await (await h.relay.fetch("https://api.example.test/send", { method: "POST", headers: { Authorization: "Bearer TEST-ONLY-request-token", "content-type": "application/json" }, body: JSON.stringify({ to_name: "Coach Taylor", resolve: true }) })).json()) as any;
    const id = res.candidates[0].candidate_id;
    expect((await postRequest(h, { candidate_id: id, text: "hi" })).status).toBe(202);
    expect((await postRequest(h, { candidate_id: id, text: "hi" })).status).toBe(409);
  });

  it.each([
    [{ candidate_id: "nope", text: "hi" }, 404, "candidate_unknown"],
    [{ candidate_id: "0".repeat(32), text: "hi" }, 404, "candidate_unknown"],
    [{ to_name: ["Coach Taylor", "Test Friend"], text: "hi" }, 400, "group_send_not_allowed"],
    [{ to_name: 5, text: "hi" }, 400, "to_name_invalid"],
    [{ to_name: "x".repeat(201), text: "hi" }, 400, "to_name_invalid"],
    [{ to_name: "Coach Taylor", body: "hi" }, 400, "unknown_fields"],
    [{ to_name: "Coach Taylor", text: "hi", resolve: true }, 400, "unknown_fields"],
    [{ to_name: "Coach Taylor", to: FRIEND, text: "hi" }, 400, "exactly_one_of_to_to_name_candidate_id"],
    [{ to_name: "Coach Taylor", candidate_id: "0".repeat(32), text: "hi" }, 400, "exactly_one_of_to_to_name_candidate_id"],
    [{ to_name: "Coach Taylor", text: "   " }, 400, "empty_text"],
    [{ to_name: "Coach Taylor" }, 400, "empty_text"],
    [{ to_name: "Coach Taylor", text: "x".repeat(641) }, 400, "text_too_long"],
  ])("%j → %i %s, nothing filed", async (b, status, code) => {
    await expectNothingQueued(await postRequest(h, b), status, { error: code });
  });

  it("an expired candidate is refused with 410", async () => {
    const j = (await (await postRequest(h, { to_name: "jordan", text: "hi" })).json()) as any;
    h.setNow(T0 + 15 * 60_000);
    await expectNothingQueued(await postRequest(h, { candidate_id: j.candidates[0].candidate_id, text: "hi" }), 410, { error: "candidate_expired" });
  });

  it("LOG_HASH_KEY missing or short → 503 config_invalid (the list is keyed by its HMAC); filing by number still works", async () => {
    for (const v of [undefined, "short"]) {
      await h.setEnv({ LOG_HASH_KEY: v as unknown as string });
      await expectNothingQueued(await postRequest(h, { to_name: "Coach Taylor", text: "hi" }), 503, { error: "config_invalid" });
    }
    expect((await postRequest(h, { to: FRIEND, text: "hi" })).status).toBe(202);
  });

  it("BLOCK_LINKS=1 refuses a link in a request filed by name", async () => {
    await h.setEnv({ BLOCK_LINKS: "1" });
    await expectNothingQueued(await postRequest(h, { to_name: "Coach Taylor", text: "see example.com" }), 400, { error: "links_not_allowed" });
  });

  it("the daily pending cap counts requests filed by name", async () => {
    await h.setEnv({ PENDING_CAP_PER_DAY: "1" });
    expect((await postRequest(h, { to_name: "Coach Taylor", text: "a" })).status).toBe(202);
    const r = await postRequest(h, { to_name: "Coach Taylor", text: "b" });
    expect(r.status).toBe(429);
    expect(await r.json()).toEqual({ error: "request_cap_reached" });
  });

  it("a stranger's number is never reachable by name, and filing by number keeps the ALLOWLIST rule", async () => {
    const r = await postRequest(h, { to: STRANGER, text: "hi" });
    expect(r.status).toBe(403);
    const by = await postRequest(h, { to: "+15555550115", text: "hi" }); // Coach Taylor's number, but not on ALLOWLIST
    expect(by.status).toBe(403);
    expect(await by.json()).toEqual({ error: "recipient_not_on_allowlist" });
  });
});

describe("approve-time re-check for requests filed by name", () => {
  it("the contact left the list after filing → approve refused 403, nothing sent", async () => {
    const j = (await (await postRequest(h, { to_name: "Coach Taylor", text: "hi" })).json()) as any;
    expect((await upload({ ...SNAPSHOT, contacts: SNAPSHOT.contacts.filter((c) => c.name !== "Coach Taylor") })).status).toBe(200);
    h.calls.length = 0;
    const a = await approve(h, j.id);
    expect(a.status).toBe(403);
    expect(await a.json()).toEqual({ error: "recipient_not_on_allowlist" });
    expect(h.messagesPosted()).toHaveLength(0);
    expect((await sql("SELECT state FROM requests WHERE id=?", j.id))[0].state).toBe("pending");
  });

  it("LOG_HASH_KEY removed after filing → approve refused 503 config_invalid; deny still works", async () => {
    const j = (await (await postRequest(h, { to_name: "Coach Taylor", text: "hi" })).json()) as any;
    await h.setEnv({ LOG_HASH_KEY: "" });
    h.calls.length = 0;
    const a = await approve(h, j.id);
    expect(a.status).toBe(503);
    expect(await a.json()).toEqual({ error: "config_invalid" });
    expect(h.messagesPosted()).toHaveLength(0);
    expect((await approve(h, j.id, "deny")).status).toBe(200);
  });

  it("a request filed by number still needs ALLOWLIST at approve time, even if the number is also a contact", async () => {
    await upload({ ...SNAPSHOT, contacts: [...SNAPSHOT.contacts, { name: "Test Friend", numbers: [{ e164: FRIEND, label: "mobile" }] }] });
    const j = (await (await postRequest(h, { to: FRIEND, text: "hi" })).json()) as any;
    await h.setEnv({ ALLOWLIST: JSON.stringify({ "+15555550102": "Test Two" }) });
    h.calls.length = 0;
    const a = await approve(h, j.id);
    expect(a.status).toBe(403);
    expect(h.messagesPosted()).toHaveLength(0);
  });
});
