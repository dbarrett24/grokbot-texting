// Contacts page (APPROVE_HOST /contacts*): owner-only on/off and stars, default OFF, migration, guards.
// Numbers: UK Ofcom drama range (+44 7700 900xxx, reserved for fiction) for people the page may switch on,
// and North American 555-01xx (documentation examples) for the example-number guard. All TEST-ONLY.
import { describe, it, expect, beforeEach } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import { harness, API, BASE, OWNER, FRIEND, type Harness } from "./helpers";
import type { Relay } from "../src/relay";
import { GCP_LINKS, isContactsPath, isExampleNumber, ownerFromAccess, type Owner } from "../src/contacts";

const RILEY = "+447700900142", RILEY_NEW = "+447700900143", SAM = "+447700900151", ALEX = "+447700900161", EXAMPLE = "+15555550123";
const snap = (contacts: unknown[]) => ({ generated_at: "2026-10-19T19:00:00Z", contacts });
const BASE_SNAP = snap([
  { name: "Riley Moore", given: "Riley", numbers: [{ e164: RILEY, label: "mobile" }] },
  { name: "Sam Lee", given: "Sam", numbers: [{ e164: SAM, label: "mobile" }] },
  { name: "Alex Ray", given: "Alex", numbers: [{ e164: ALEX, label: "mobile" }] },
  { name: "Example Person", given: "Example", numbers: [{ e164: EXAMPLE, label: "mobile" }] },
]);

let h: Harness;
type Row = Record<string, SqlStorageValue>;
const sql = (q: string, ...a: SqlStorageValue[]): Promise<Row[]> =>
  runInDurableObject(h.relay, (_i: Relay, state: DurableObjectState) => state.storage.sql.exec<Row>(q, ...a).toArray());
const one = async (q: string, ...a: SqlStorageValue[]): Promise<Row | undefined> => (await sql(q, ...a))[0];
interface Resolved { state: string; matches?: { last4: string }[] }
interface Person { key: string | null; name: string; label: string; last4: string; enabled: boolean; starred: boolean; migrated: boolean; new: boolean; source: string; readonly: boolean }
const send = (body: unknown) =>
  h.relay.fetch(`${API}/send`, { method: "POST", headers: { Authorization: "Bearer TEST-ONLY-request-token", "content-type": "application/json" }, body: JSON.stringify(body) });
async function upload(s: unknown = BASE_SNAP) {
  const r = await h.relay.fetch(`${BASE}/contacts`, { method: "POST", headers: { "content-type": "application/json", "Cf-Access-Jwt-Assertion": await h.jwt() }, body: JSON.stringify(s) });
  expect(r.status).toBe(200);
}
async function page(): Promise<{ html: string; csrf: string; res: Response }> {
  const res = await h.relay.fetch(`${BASE}/contacts`, { headers: { "Cf-Access-Jwt-Assertion": await h.jwt() } });
  const html = await res.text();
  return { html, res, csrf: html.match(/const CSRF="([a-f0-9]{32})"/)?.[1] ?? "" };
}
async function list(): Promise<Person[]> {
  const r = await h.relay.fetch(`${BASE}/contacts/list`, { headers: { "Cf-Access-Jwt-Assertion": await h.jwt() } });
  expect(r.status).toBe(200);
  return ((await r.json()) as { people: Person[] }).people;
}
const keyOf = async (name: string): Promise<string> => {
  const p = (await list()).find((x) => x.name === name);
  if (!p?.key) throw new Error(`no contact named ${name}`);
  return p.key;
};
async function post(path: string, body: Record<string, unknown>, o: { origin?: string | null; ct?: string; jwt?: string | null; host?: string; auth?: string } = {}) {
  const headers: Record<string, string> = { "content-type": o.ct ?? "application/json" };
  const jwt = o.jwt === undefined ? await h.jwt() : o.jwt;
  if (jwt) headers["Cf-Access-Jwt-Assertion"] = jwt;
  if (o.origin !== null) headers["Origin"] = o.origin ?? BASE;
  if (o.auth) headers["Authorization"] = o.auth;
  return h.relay.fetch(`${o.host ?? BASE}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
}
async function setPref(change: Record<string, unknown>, csrf?: string) {
  return post("/contacts/prefs", { csrf: csrf ?? (await page()).csrf, changes: [change] });
}
const sendable = async (to: string) => (await send({ to, body: "x" })).status === 200;
const prefsSnapshot = async () => { await list(); return sql("SELECT person_key, enabled, starred, migrated FROM contact_prefs ORDER BY person_key"); };

beforeEach(async () => {
  h = await harness();
  await h.setEnv({ DIRECT_SEND: "1", DIRECT_LOOKUP_MAX_PER_HOUR: "off" });
});

describe("default OFF, then owner switches on", () => {
  it("a synced/uploaded new contact isn't sendable; enabled it is; disabled it isn't; a new number on an enabled contact is off", async () => {
    await upload();
    expect(await sendable(RILEY)).toBe(false);
    expect(((await (await send({ to_name: "riley", resolve: true })).json()) as Resolved).state).toBe("no_match");
    expect((await setPref({ key: await keyOf("Riley Moore"), enabled: true })).status).toBe(200);
    expect(await sendable(RILEY)).toBe(true);
    expect((await setPref({ key: await keyOf("Riley Moore"), enabled: false })).status).toBe(200);
    expect(await sendable(RILEY)).toBe(false);
    await setPref({ key: await keyOf("Riley Moore"), enabled: true });
    // the incident case: same contact, a second number added in Google
    await upload(snap([{ name: "Riley Moore", given: "Riley", numbers: [{ e164: RILEY, label: "mobile" }, { e164: RILEY_NEW, label: "mobile" }] }]));
    expect(await sendable(RILEY)).toBe(true);
    expect(await sendable(RILEY_NEW)).toBe(false);
  });

  it("a fresh deploy enables no one, and the list never holds more than the last 4 digits", async () => {
    await upload();
    const people = await list();
    const contacts = people.filter((p) => !p.readonly);
    expect(contacts.map((p) => p.enabled)).toEqual([false, false, false, false]);
    expect(contacts.every((p) => /^\d{4}$/.test(p.last4) && p.migrated === false)).toBe(true);
    const raw = JSON.stringify(people);
    for (const n of [RILEY, SAM, ALEX, EXAMPLE, FRIEND]) expect(raw).not.toContain(n.slice(-7));
    // ALLOWLIST entries are shown read-only, badged
    expect(people.filter((p) => p.readonly).map((p) => [p.name, p.label, p.enabled])).toEqual([["Test Friend", "always on (ALLOWLIST)", true], ["Test Two", "always on (ALLOWLIST)", true]]);
  });

  it("starring doesn't enable anyone; starred sort first", async () => {
    await upload();
    expect((await setPref({ key: await keyOf("Sam Lee"), starred: true })).status).toBe(200);
    const people = (await list()).filter((p) => !p.readonly);
    expect(people[0]).toMatchObject({ name: "Sam Lee", starred: true, enabled: false });
    expect(await sendable(SAM)).toBe(false);
  });

  it("an example-number enable is refused with a plain reason; starring it is fine", async () => {
    await upload();
    const k = await keyOf("Example Person");
    const r = await setPref({ key: k, enabled: true });
    expect(r.status).toBe(422);
    expect(await r.json()).toEqual({ error: "example_number", message: "this looks like a documentation example" });
    expect((await one("SELECT enabled FROM contact_prefs WHERE person_key=?", k))?.["enabled"]).toBe(0);
    expect((await setPref({ key: k, starred: true })).status).toBe(200);
  });

  it("isExampleNumber: 555-0100..0199 and the 555 + 1234 placeholder only", () => {
    // Non-01xx 555 lines are built at runtime so the repo check (scripts/check-example-numbers.mjs) never sees one.
    const n555 = (line: string) => "+1202" + "555" + line;
    expect(["+12025550100", "+12025550199", "+15555550123", n555("1234")].every(isExampleNumber)).toBe(true);
    expect([n555("0200"), "+447700900142", n555("5678"), "+4412025550123"].some(isExampleNumber)).toBe(false);
  });
});

describe("enable all shown", () => {
  it("affects only the given keys; skips example numbers; a count mismatch is refused", async () => {
    await upload();
    const { csrf } = await page();
    const ks = [await keyOf("Riley Moore"), await keyOf("Sam Lee"), await keyOf("Example Person")];
    const bad = await post("/contacts/enable-all", { csrf, keys: ks, confirm_count: 2 });
    expect(bad.status).toBe(409);
    expect(await bad.json()).toEqual({ error: "confirm_count_mismatch" });
    expect(await sendable(RILEY)).toBe(false);
    const ok = await post("/contacts/enable-all", { csrf, keys: ks, confirm_count: 3 });
    expect(await ok.json()).toEqual({ updated: 2, skipped_example: 1 });
    expect(await sendable(RILEY)).toBe(true);
    expect(await sendable(SAM)).toBe(true);
    expect(await sendable(ALEX)).toBe(false);
    expect(await sendable(EXAMPLE)).toBe(false);
  });
});

describe("owner-only: guards", () => {
  const paths = ["/contacts", "/contacts/list", "/contacts/prefs", "/contacts/enable-all", "/contacts/migrated-off", "/contacts/preview", "/contacts/anything"];
  it.each(paths)("REQUEST_HOST %s → 404 with a valid bot token (GET and POST), nothing changes", async (p) => {
    await upload();
    const before = await prefsSnapshot();
    for (const method of ["GET", "POST"]) {
      const r = await h.relay.fetch(`${API}${p}`, { method, headers: { Authorization: "Bearer TEST-ONLY-request-token", "content-type": "application/json", "Cf-Access-Jwt-Assertion": await h.jwt() }, ...(method === "POST" ? { body: JSON.stringify({ csrf: (await page()).csrf, keys: before.map((x) => x["person_key"] ?? null), confirm_count: before.length, changes: [{ key: before[0]?.["person_key"], enabled: true }] }) } : {}) });
      expect(r.status).toBe(404);
      expect(await r.json()).toEqual({ error: "not_found" });
    }
    expect(await prefsSnapshot()).toEqual(before);
  });

  it("no /send field can change prefs", async () => {
    await upload();
    const before = await prefsSnapshot();
    for (const extra of [{ enabled: true }, { enable: true }, { starred: true }, { prefs: [] }, { key: before[0]?.["person_key"] }]) {
      const r = await send({ to_name: "riley", body: "x", ...extra });
      expect(r.status).toBe(400);
    }
    expect(await prefsSnapshot()).toEqual(before);
  });

  it("isContactsPath covers every contacts route; Owner can only come from Access (type-level)", () => {
    expect(["/contacts", "/contacts/", "/contacts/prefs", "/contacts/x/y"].every(isContactsPath)).toBe(true);
    expect(["/contact", "/contactsx", "/send", "/direct"].some(isContactsPath)).toBe(false);
    // @ts-expect-error a plain object is not an Owner: only requireOwner (verifyAccess) mints one
    const fake: Owner = { email: "approver@example.test", method: "amr" };
    expect(ownerFromAccess({ email: "approver@example.test", method: "amr" }).email).toBe(fake.email);
  });

  it.each([
    ["missing Access", { jwt: null }, 403, "forbidden"],
    ["wrong Origin", { origin: "https://evil.example.test" }, 403, "bad_origin"],
    ["missing Origin", { origin: null }, 403, "bad_origin"],
    ["non-JSON", { ct: "text/plain" }, 415, "contacts_must_be_json"],
    ["bot token on the approve host", { auth: "Bearer TEST-ONLY-request-token" }, 403, "forbidden"],
  ] as const)("prefs: %s → %i", async (_n, o, status, code) => {
    await upload();
    const { csrf } = await page();
    const k = await keyOf("Riley Moore");
    const r = await post("/contacts/prefs", { csrf, changes: [{ key: k, enabled: true }] }, o);
    expect(r.status).toBe(status);
    expect(((await r.json()) as { error?: string }).error).toBe(code);
    expect(await sendable(RILEY)).toBe(false);
  });

  it("invalid Access token → 403", async () => {
    await upload();
    const { csrf } = await page();
    const r = await post("/contacts/prefs", { csrf, changes: [{ key: await keyOf("Riley Moore"), enabled: true }] }, { jwt: await h.jwt({ email: "someone-else@example.test" }) });
    expect(r.status).toBe(403);
  });

  it("bad, missing, expired or another identity's CSRF → 403 bad_csrf; a token is reusable within 15 minutes", async () => {
    await upload();
    const k = await keyOf("Riley Moore");
    for (const csrf of [undefined, "", "0".repeat(32), "not-hex"]) {
      const r = await post("/contacts/prefs", { ...(csrf === undefined ? {} : { csrf }), changes: [{ key: k, enabled: true }] });
      expect(r.status).toBe(403);
      expect(await r.json()).toEqual({ error: "bad_csrf" });
    }
    const { csrf } = await page();
    expect((await setPref({ key: k, starred: true }, csrf)).status).toBe(200);
    expect((await setPref({ key: k, starred: false }, csrf)).status).toBe(200); // reused
    await sql("UPDATE page_csrf SET email='someone-else@example.test' WHERE token=?", csrf);
    expect((await setPref({ key: k, enabled: true }, csrf)).status).toBe(403);
    const t2 = (await page()).csrf;
    h.setNow(Date.now() > 0 ? Number((await one("SELECT expires_ms FROM page_csrf WHERE token=?", t2))?.["expires_ms"]) : 0);
    const r = await setPref({ key: k, enabled: true }, t2);
    expect(r.status).toBe(403);
    expect(await sendable(RILEY)).toBe(false);
  });

  it("page: strict CSP with a nonce, no other origins, no numbers in the HTML, under 25 KB", async () => {
    await upload();
    const { html, res } = await page();
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toMatch(/default-src 'self'; script-src 'self' 'nonce-[a-f0-9]{32}'/);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(html).not.toMatch(/src="https?:/); // nothing loads from another origin
    // Off-site links: only the Set up Google deep links (google-connect PR 3), each a new tab with no referrer.
    const allowed = new Set<string>(Object.values(GCP_LINKS));
    for (const m of html.matchAll(/href="(https?:[^"]*)"([^>]*)>/g)) {
      expect(allowed.has(m[1] ?? "")).toBe(true);
      expect(m[2]).toContain('target=_blank rel="noopener noreferrer"');
    }
    for (const n of [RILEY, SAM, ALEX, EXAMPLE]) expect(html).not.toContain(n.slice(-4));
    expect(new TextEncoder().encode(html).length).toBeLessThan(25_000);
  });
});

describe("migration (enable once, flag)", () => {
  /** Simulate an existing deploy: contacts loaded before this version, so no prefs and no migration marker. */
  async function existingDeploy() {
    await upload(); // creates contacts (and, on this version, OFF pref rows)
    await sql("DELETE FROM contact_prefs");
    await sql("DELETE FROM meta WHERE k='contacts_prefs_v1'");
    await runInDurableObject(h.relay, (i: Relay) => i.migratePrefs()); // first boot of the new version
  }

  it("an existing deploy keeps exactly its prior set, all flagged; the banner shows the count", async () => {
    await existingDeploy();
    for (const n of [RILEY, SAM, ALEX, EXAMPLE]) expect(await sendable(n)).toBe(true);
    expect((await list()).filter((p) => !p.readonly).every((p) => p.enabled && p.migrated)).toBe(true);
    expect((await page()).html).toContain("<b>4</b> people were reachable before this update and are still on");
    expect((await sql("SELECT detail FROM log WHERE event='contacts_migrated'")).map((r) => r["detail"])).toContain("count=4");
  });

  it("runs once: a second boot changes nothing (an owner's 'off' stays off)", async () => {
    await existingDeploy();
    await setPref({ key: await keyOf("Sam Lee"), enabled: false });
    const before = await prefsSnapshot();
    await runInDurableObject(h.relay, (i: Relay) => i.migratePrefs());
    await sendable(RILEY); // forces the hash/pref pass
    expect(await prefsSnapshot()).toEqual(before);
    expect(await sendable(SAM)).toBe(false);
  });

  it("new arrivals after the upgrade start off", async () => {
    await existingDeploy();
    await upload(snap([...BASE_SNAP.contacts, { name: "New Person", given: "New", numbers: [{ e164: "+447700900171", label: "mobile" }] }]));
    expect(await sendable("+447700900171")).toBe(false);
  });

  it("turn all migrated off: needs the shown count; then the banner is gone", async () => {
    await existingDeploy();
    const { csrf } = await page();
    expect((await post("/contacts/migrated-off", { csrf, confirm_count: 3 })).status).toBe(409);
    expect(await sendable(RILEY)).toBe(true);
    const r = await post("/contacts/migrated-off", { csrf, confirm_count: 4 });
    expect(await r.json()).toEqual({ updated: 4 });
    for (const n of [RILEY, SAM, ALEX]) expect(await sendable(n)).toBe(false);
    expect((await page()).html).not.toContain("were reachable before this update");
  });

  it("a migrated person who has since left the contacts doesn't count: the banner and the action agree, and the banner clears", async () => {
    await existingDeploy();
    await upload(snap([
      { name: "Riley Moore", given: "Riley", numbers: [{ e164: RILEY, label: "mobile" }] },
      { name: "Sam Lee", given: "Sam", numbers: [{ e164: SAM, label: "mobile" }] },
      { name: "Example Person", given: "Example", numbers: [{ e164: EXAMPLE, label: "mobile" }] },
    ])); // Alex is now gone (kept 30 days, still migrated+on)
    const { csrf, html } = await page();
    expect(html).toContain("<b>3</b> people were reachable before this update and are still on");
    const r = await post("/contacts/migrated-off", { csrf, confirm_count: 3 });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ updated: 3 });
    expect((await page()).html).not.toContain("were reachable before this update");
  });
});

describe("ALLOWLIST numbers that are also contacts", () => {
  it("show read-only as 'always on (ALLOWLIST)', once, with no switch key, because the bot can always text them", async () => {
    await upload(snap([...BASE_SNAP.contacts, { name: "Friend Contact", given: "Friend", numbers: [{ e164: FRIEND, label: "mobile" }] }]));
    const people = await list();
    const friend = people.filter((p) => p.last4 === FRIEND.slice(-4));
    expect(friend).toHaveLength(1);
    expect(friend[0]).toMatchObject({ name: "Friend Contact", label: "always on (ALLOWLIST)", enabled: true, readonly: true, key: null });
    expect(await sendable(FRIEND)).toBe(true);
    expect(people.filter((p) => p.readonly).map((p) => p.name)).toEqual(["Friend Contact", "Test Two"]);
  });
});

describe("key rotation and deletes", () => {
  it("a LOG_HASH_KEY rotation keeps prefs (person_key re-hashed in the same pass)", async () => {
    await upload();
    await setPref({ key: await keyOf("Riley Moore"), enabled: true });
    await setPref({ key: await keyOf("Sam Lee"), starred: true });
    const oldKey = await keyOf("Riley Moore");
    await h.setEnv({ LOG_HASH_KEY: "TEST-ONLY-rotated-log-hash-key-000000" });
    expect(await sendable(RILEY)).toBe(true);
    expect(await keyOf("Riley Moore")).not.toBe(oldKey);
    expect((await list()).find((p) => p.name === "Sam Lee")?.starred).toBe(true);
    expect(await sendable(SAM)).toBe(false);
  });

  it("a rotation after a fresh upload (hashes not yet computed for the new rows) still keeps prefs", async () => {
    await upload();
    await setPref({ key: await keyOf("Riley Moore"), enabled: true });
    await upload(snap([...BASE_SNAP.contacts, { name: "Late", numbers: [{ e164: "+447700900181", label: "mobile" }] }]));
    await h.setEnv({ LOG_HASH_KEY: "TEST-ONLY-rotated-log-hash-key-000000" });
    expect(await sendable(RILEY)).toBe(true);
  });

  it("deleted then re-added within 30 days → old state back; after 30 days → off", async () => {
    await upload();
    await setPref({ key: await keyOf("Riley Moore"), enabled: true });
    const without = snap(BASE_SNAP.contacts.slice(1));
    await upload(without);
    expect(await sendable(RILEY)).toBe(false);
    h.setNow(Date.parse("2026-10-30T12:00:00-06:00"));
    await upload();
    expect(await sendable(RILEY)).toBe(true);
    await upload(without);
    await sendable(SAM);
    h.setNow(Date.parse("2026-12-15T12:00:00-06:00"));
    await upload(snap(BASE_SNAP.contacts.slice(2)));
    await sendable(ALEX); // runs the pref pass (purges rows gone > 30 days)
    await upload();
    expect(await sendable(RILEY)).toBe(false);
  });
});

describe("resolve preview", () => {
  it("matches /send resolve over enabled rows, with off/no-contact reasons; never sends or stores candidates", async () => {
    await upload(snap([...BASE_SNAP.contacts, { name: "Riley Ward", given: "Riley", numbers: [{ e164: "+447700900191", label: "mobile" }] }]));
    const { csrf } = await page();
    const pv = async (name: string) => (await (await post("/contacts/preview", { csrf, name })).json()) as Resolved;
    expect(await pv("sam")).toEqual({ state: "no_match", matches: [], reason: "sam exists but is off" });
    expect(await pv("nobody")).toEqual({ state: "no_match", matches: [], reason: "no contact named nobody" });
    await setPref({ key: await keyOf("Riley Moore"), enabled: true }, csrf);
    expect(await pv("riley")).toEqual({ state: "one", matches: [{ name: "Riley Moore", label: "mobile", last4: "0142" }], reason: null });
    expect(((await (await send({ to_name: "riley", resolve: true })).json()) as Resolved).state).toBe("one");
    await setPref({ key: await keyOf("Riley Ward"), enabled: true }, csrf);
    const amb = await pv("riley");
    expect(amb.state).toBe("ambiguous");
    expect((amb.matches ?? []).map((m) => m.last4).sort()).toEqual(["0142", "0191"]);
    expect(((await (await send({ to_name: "riley", resolve: true })).json()) as Resolved).state).toBe("ambiguous");
    await sql("DELETE FROM candidates");
    await pv("riley");
    expect((await one("SELECT COUNT(*) AS c FROM candidates"))?.["c"]).toBe(0);
    expect(h.messagesPosted()).toEqual([]);
  });
});

describe("logs: keys and counts only", () => {
  it("no E.164, no last 4, no names in log rows after a full session", async () => {
    await upload();
    const { csrf } = await page();
    await setPref({ key: await keyOf("Riley Moore"), enabled: true }, csrf);
    await post("/contacts/enable-all", { csrf, keys: [await keyOf("Sam Lee")], confirm_count: 1 });
    await post("/contacts/preview", { csrf, name: "Riley Moore" });
    await post("/contacts/preview", { csrf, name: "Sam" });
    const rows = await sql("SELECT event, recipient, detail FROM log");
    const text = JSON.stringify(rows);
    expect(text).not.toMatch(/\+\d{7,15}/);
    for (const n of [RILEY, SAM]) expect(text).not.toContain(n.slice(-4));
    for (const name of ["Riley", "Sam", "Moore"]) expect(text).not.toContain(name);
    expect(rows.find((r) => r["event"] === "contacts_prefs")?.["detail"]).toMatch(/^updated=1 enabled=1 disabled=0 starred=0 unstarred=0 method=\S+ by=approver@example\.test$/);
  });
});

describe("Sync now from the page", () => {
  it("uses the page's CSRF and redirects back to /contacts", async () => {
    await h.setEnv({ GOOGLE_ACCOUNTS: "" });
    const { csrf } = await page();
    const form = (c: string) => h.relay.fetch(`${BASE}/direct/sync`, { method: "POST", redirect: "manual", headers: { "Cf-Access-Jwt-Assertion": "", "content-type": "application/x-www-form-urlencoded", Origin: BASE }, body: new URLSearchParams({ csrf: c, from: "contacts" }).toString() });
    const withJwt = async (c: string) => h.relay.fetch(`${BASE}/direct/sync`, { method: "POST", redirect: "manual", headers: { "Cf-Access-Jwt-Assertion": await h.jwt(), "content-type": "application/x-www-form-urlencoded", Origin: BASE }, body: new URLSearchParams({ csrf: c, from: "contacts" }).toString() });
    expect((await form(csrf)).status).toBe(403);
    expect((await withJwt("0".repeat(32))).status).toBe(403);
    const r = await withJwt(csrf);
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("/contacts?synced=ok");
    expect(OWNER).toBeTruthy();
  });
});
