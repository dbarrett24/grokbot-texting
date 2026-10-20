import { describe, it, expect, beforeEach } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import type { Relay } from "../src/relay";
import { harness, API, BASE, OWNER, type Harness, enableAll } from "./helpers";

// Fake Google: each refresh token maps to one account's People API pages. All values are TEST-ONLY.
type Person = { names?: { displayName?: string; givenName?: string }[]; phoneNumbers?: { value?: string; canonicalForm?: string; type?: string }[] };
const person = (name: string, ...nums: [string, string?][]): Person => ({
  names: [{ displayName: name, givenName: name.split(" ")[0] }],
  phoneNumbers: nums.map(([v, type]) => ({ value: v, canonicalForm: v.startsWith("+") ? v : undefined, ...(type === undefined ? {} : { type }) })),
});

let h: Harness;
let google: Record<string, { pages?: Person[][]; tokenStatus?: number; peopleStatus?: number }>;
const runIn = runInDurableObject as unknown as (s: unknown, f: (i: any) => Promise<any>) => Promise<any>;
const sql = (q: string, ...a: unknown[]) => runIn(h.relay, async (i) => i.ctx.storage.sql.exec(q, ...a).toArray()) as Promise<any[]>;
const merged = async () => Object.fromEntries((await sql("SELECT e164, name FROM contacts ORDER BY e164")).map((r) => [r.e164, r.name]));
const sync = async () => { const r = await runInDurableObject(h.relay, (i: Relay) => i.syncContacts()); await enableAll(h); return r; };
const logRows = () => sql("SELECT event, detail FROM log ORDER BY seq");
const ownerTexts = async () => Promise.all(h.messagesPosted().map(async (m) => ({ to: await h.decrypt(m.phoneNumbers[0]), text: await h.decrypt(m.textMessage.text) }))).then((p) => p.filter((x) => x.to === OWNER).map((x) => x.text));

beforeEach(async () => {
  h = await harness();
  google = {};
  await runIn(h.relay, async (inst) => {
    const base = inst.net;
    inst.net = async (req: Request) => {
      const u = new URL(req.url);
      if (u.host === "oauth2.googleapis.com") {
        const form = new URLSearchParams(await req.text());
        h.calls.push({ url: req.url, method: req.method, body: "", auth: null });
        const acct = google[form.get("refresh_token") ?? ""];
        if (!acct || form.get("client_id") !== "TEST-ONLY-client" || form.get("client_secret") !== "TEST-ONLY-client-secret") return new Response("bad", { status: 400 });
        if (acct.tokenStatus) return new Response("bad", { status: acct.tokenStatus });
        return Response.json({ access_token: "TEST-ONLY-at:" + form.get("refresh_token") });
      }
      if (u.host === "people.googleapis.com") {
        h.calls.push({ url: req.url, method: req.method, body: "", auth: null });
        expect(u.searchParams.get("personFields")).toBe("names,phoneNumbers");
        const rt = (req.headers.get("Authorization") ?? "").replace("Bearer TEST-ONLY-at:", "");
        const acct = google[rt];
        if (!acct) return new Response("no", { status: 401 });
        if (acct.peopleStatus) return new Response("no", { status: acct.peopleStatus });
        const i = Number(u.searchParams.get("pageToken") ?? "0");
        const pages = acct.pages ?? [[]];
        return Response.json({ connections: pages[i], ...(i + 1 < pages.length ? { nextPageToken: String(i + 1) } : {}) });
      }
      return base(req);
    };
  });
  await h.setEnv({
    GOOGLE_ACCOUNTS: "primary,work,club",
    GOOGLE_CLIENT_ID: "TEST-ONLY-client",
    GOOGLE_CLIENT_SECRET: "TEST-ONLY-client-secret",
    GOOGLE_RT_PRIMARY: "TEST-ONLY-rt-primary",
    GOOGLE_RT_WORK: "TEST-ONLY-rt-work",
    GOOGLE_RT_CLUB: "TEST-ONLY-rt-club",
    DIRECT_SEND: "1",
  });
  google["TEST-ONLY-rt-primary"] = { pages: [[person("Ann Lee", ["+15555550121", "mobile"]), person("Shared Primary", ["+15555550124", "mobile"])]] };
  google["TEST-ONLY-rt-work"] = { pages: [[person("Coach Ann", ["+15555550124", "mobile"]), person("Neighbor Bo", ["+15555550122"])]] };
  google["TEST-ONLY-rt-club"] = { pages: [[person("Mom", ["(555) 555-0123", "mobile"]), person("Shared Club", ["+15555550124"])]] };
});

describe("GOOGLE_ACCOUNTS sync", () => {
  it("merges 3 accounts, dedupes by E.164, first listed account names a shared number", async () => {
    const r = await sync();
    expect(r).toEqual({ updated: ["PRIMARY", "WORK", "CLUB"], failed: [] });
    expect(await merged()).toEqual({
      "+15555550121": "Ann Lee",
      "+15555550122": "Neighbor Bo",
      "+15555550123": "Mom", // "(555) 555-0123" normalized
      "+15555550124": "Shared Primary", // primary listed first
    });
    for (const a of ["PRIMARY", "WORK", "CLUB"]) expect((await logRows()).some((x) => x.event === "contacts_sync" && x.detail.startsWith(`account=${a} `))).toBe(true);
    expect(await ownerTexts()).toEqual([]); // no alert when all succeed
  });

  it("name precedence follows GOOGLE_ACCOUNTS order", async () => {
    await h.setEnv({ GOOGLE_ACCOUNTS: "work,primary,club" });
    await sync();
    expect((await merged())["+15555550124"]).toBe("Coach Ann");
    const send = (to_name: string) => h.relay.fetch(`${API}/send`, { method: "POST", headers: { Authorization: "Bearer TEST-ONLY-request-token" }, body: JSON.stringify({ to_name, body: "hi" }) });
    expect(await (await send("Coach Ann")).json()).toMatchObject({ state: "sent", to: "Coach Ann" });
    expect(await (await send("Shared Primary")).json()).toEqual({ state: "no_match", candidates: [] });
    await h.setEnv({ GOOGLE_ACCOUNTS: "club,work,primary" });
    await sync();
    expect((await merged())["+15555550124"]).toBe("Shared Club");
  });

  it("one account failing keeps its previous list and alerts; the others still refresh", async () => {
    await sync();
    google["TEST-ONLY-rt-work"] = { pages: [[person("Neighbor Bo", ["+15555550125", "mobile"])]] }; // work changed
    google["TEST-ONLY-rt-club"].tokenStatus = 400; // club broken
    google["TEST-ONLY-rt-primary"] = { pages: [[person("Ann Lee", ["+15555550121", "mobile"])]] }; // primary dropped the shared number
    const r = await sync();
    expect(r.updated).toEqual(["PRIMARY", "WORK"]);
    expect(r.failed).toEqual([{ account: "CLUB", reason: "google_token_status_400" }]);
    expect(await merged()).toEqual({
      "+15555550121": "Ann Lee",
      "+15555550123": "Mom", // club's previous list kept
      "+15555550124": "Shared Club", // still there via club's kept list
      "+15555550125": "Neighbor Bo", // work refreshed (old +…0122 gone)
    });
    expect((await logRows()).find((x) => x.event === "contacts_sync_failed").detail).toBe("account=CLUB reason=google_token_status_400 kept_previous=1");
    const alerts = await ownerTexts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain("CLUB (google_token_status_400)");
    expect(alerts[0]).toContain("Updated: PRIMARY, WORK");
  });

  it.each([
    ["People API error", { peopleStatus: 403 }, "google_people_status_403"],
    ["empty result", { pages: [[]] }, "empty_result"],
    ["only fax/pager numbers", { pages: [[person("Office", ["+15555550129", "workFax"], ["+15555550128", "pager"])]] }, "empty_result"],
  ])("%s keeps the previous list", async (_n, next, reason) => {
    await sync();
    google["TEST-ONLY-rt-work"] = next as any;
    const r = await sync();
    expect(r.failed).toEqual([{ account: "WORK", reason }]);
    expect((await merged())["+15555550122"]).toBe("Neighbor Bo");
  });

  it("a label with no GOOGLE_RT_<LABEL> secret is a loud config error; that account is skipped and keeps its old list", async () => {
    await sync();
    await h.setEnv({ GOOGLE_RT_WORK: undefined as unknown as string });
    const errs: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => { errs.push(a.join(" ")); orig(...a); };
    try {
      const r = await sync();
      expect(r.updated).toEqual(["PRIMARY", "CLUB"]);
      expect(r.failed).toEqual([{ account: "WORK", reason: "missing_secret_GOOGLE_RT_WORK" }]);
    } finally {
      console.error = orig;
    }
    expect(errs.join("\n")).toContain("CONTACTS_SYNC_FAILED account=WORK reason=missing_secret_GOOGLE_RT_WORK");
    expect((await merged())["+15555550122"]).toBe("Neighbor Bo");
    expect((await ownerTexts())[0]).toContain("WORK (missing_secret_GOOGLE_RT_WORK)");
  });

  it("bad labels and repeats are reported and not used", async () => {
    await h.setEnv({ GOOGLE_ACCOUNTS: "primary, pri-mary ,upload,PRIMARY,wo rk" });
    const r = await sync();
    expect(r.updated).toEqual(["PRIMARY"]);
    expect(r.failed.map((f: any) => f.reason)).toEqual(["invalid_label", "invalid_label", "invalid_label", "invalid_label"]);
  });

  it("keeps every type but fax and pager; follows pages; /direct shows the dropped count", async () => {
    google["TEST-ONLY-rt-primary"] = { pages: [
      [person("Pat One", ["+15555550131", "mobile"], ["+15555550132", "home"], ["+15555550133", "workFax"])],
      [person("Pat Two", ["555.555.0134"], ["+15555550135", "work"])],
    ] };
    await h.setEnv({ GOOGLE_ACCOUNTS: "primary" });
    await sync();
    expect(await merged()).toEqual({ "+15555550131": "Pat One", "+15555550132": "Pat One", "+15555550134": "Pat Two", "+15555550135": "Pat Two" });
    expect((await sql("SELECT label FROM contacts ORDER BY e164")).map((r) => r.label)).toEqual(["mobile", "home", "unlabeled", "work"]);
    const html = await (await h.relay.fetch(`${BASE}/direct`, { headers: { "Cf-Access-Jwt-Assertion": await h.jwt() } })).text();
    expect(html).toContain("PRIMARY: 4 numbers (1 fax/pager dropped)");
  });

  it("the manual upload is merged after every Google account", async () => {
    await sync();
    const up = await h.relay.fetch(`${BASE}/contacts`, {
      method: "POST",
      headers: { "Cf-Access-Jwt-Assertion": await h.jwt(), "content-type": "application/json" },
      body: JSON.stringify({ generated_at: "2026-10-16T23:00:00Z", contacts: [{ name: "Upload Name", numbers: [{ e164: "+15555550121", label: "mobile" }, { e164: "+15555550126", label: "mobile" }] }] }),
    });
    expect(up.status).toBe(200);
    const m = await merged();
    expect(m["+15555550121"]).toBe("Ann Lee");
    expect(m["+15555550126"]).toBe("Upload Name");
  });

  it("missing client id/secret fails every account without wiping", async () => {
    await sync();
    await h.setEnv({ GOOGLE_CLIENT_SECRET: undefined as unknown as string });
    const r = await sync();
    expect(r.failed.map((f: any) => f.reason)).toEqual(["google_client_not_configured", "google_client_not_configured", "google_client_not_configured"]);
    expect(Object.keys(await merged())).toHaveLength(4);
  });

  it("refresh tokens and access tokens never reach the log or console", async () => {
    google["TEST-ONLY-rt-work"].peopleStatus = 500;
    await sync();
    const all = JSON.stringify(await logRows());
    expect(all).not.toContain("TEST-ONLY-rt");
    expect(all).not.toContain("TEST-ONLY-at");
    expect(all).not.toContain("TEST-ONLY-client");
  });

  it("the daily alarm runs the sync", async () => {
    await runIn(h.relay, async (i) => i.alarm());
    expect(Object.keys(await merged())).toHaveLength(4);
  });
});

describe("POST /direct/sync (Sync now)", () => {
  const page = async () => {
    const html = await (await h.relay.fetch(`${BASE}/direct`, { headers: { "Cf-Access-Jwt-Assertion": await h.jwt() } })).text();
    return { html, csrf: html.match(/action="\/direct\/sync"><input type=hidden name=csrf value="([a-f0-9]{32})"/)?.[1] ?? "" };
  };
  const post = async (csrf: string, origin: string | null = BASE, extra: Record<string, string> = {}, jwt = true) =>
    h.relay.fetch(`${BASE}/direct/sync`, {
      method: "POST",
      headers: { ...(jwt ? { "Cf-Access-Jwt-Assertion": await h.jwt() } : {}), "content-type": "application/x-www-form-urlencoded", ...(origin ? { Origin: origin } : {}), ...extra },
      body: new URLSearchParams({ csrf }).toString(),
    });

  it("the /direct page shows a Sync now button with a CSRF token", async () => {
    const { html, csrf } = await page();
    expect(html).toContain("Sync contacts now");
    expect(csrf).toMatch(/^[a-f0-9]{32}$/);
  });

  it("syncs every account now and returns the result; no alert text (the owner sees the result)", async () => {
    google["TEST-ONLY-rt-club"].tokenStatus = 400;
    const r = await post((await page()).csrf);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ updated: ["PRIMARY", "WORK"], failed: [{ account: "CLUB", reason: "google_token_status_400" }] });
    expect(Object.keys(await merged())).toHaveLength(3);
    expect(await ownerTexts()).toEqual([]);
    expect((await logRows()).some((x) => x.event === "contacts_sync_requested")).toBe(true);
  });

  it("needs Access, the same Origin and the single-use CSRF; nothing is fetched from Google when refused", async () => {
    const { csrf } = await page();
    const refused = [
      await post("0".repeat(32)),
      await post(csrf, null),
      await post(csrf, "https://evil.example.test"),
      await post(csrf, BASE, {}, false),
      await post(csrf, BASE, { Authorization: "Bearer TEST-ONLY-request-token" }),
    ];
    for (const r of refused) expect(r.status).toBe(403);
    expect(h.calls.filter((c) => /googleapis/.test(c.url))).toHaveLength(0);
    const fresh = (await page()).csrf;
    expect((await post(fresh)).status).toBe(200);
    expect((await post(fresh)).status).toBe(403); // used
  });

  it("does not exist on the request host, even with REQUEST_TOKEN", async () => {
    const r = await h.relay.fetch(`${API}/direct/sync`, { method: "POST", headers: { Authorization: "Bearer TEST-ONLY-request-token" }, body: "csrf=x" });
    expect(r.status).toBe(404);
    expect(h.calls.filter((c) => /googleapis/.test(c.url))).toHaveLength(0);
  });

  it("no Google accounts configured: no button", async () => {
    await h.setEnv({ GOOGLE_ACCOUNTS: "" });
    const { html, csrf } = await page();
    expect(csrf).toBe("");
    expect(html).toContain("No Google accounts configured");
  });
});

describe("DISABLED alarm", () => {
  it("DISABLED=1: the alarm only purges (no Google calls, no alert texts) and stays scheduled", async () => {
    google["TEST-ONLY-rt-club"].tokenStatus = 400; // would alert if a sync ran
    await h.setEnv({ DISABLED: "1" });
    await runIn(h.relay, async (i) => {
      i.ctx.storage.sql.exec("INSERT INTO direct_sends(ms,day,to_sha) VALUES(0,'1970-01-01','x')");
      await i.alarm();
    });
    expect(h.calls).toHaveLength(0);
    expect(await merged()).toEqual({});
    expect(await sql("SELECT * FROM direct_sends")).toEqual([]); // purge still ran
    expect(await runIn(h.relay, async (i) => i.ctx.storage.getAlarm())).not.toBeNull();
  });
});

describe("removed accounts", () => {
  it("a label removed from GOOGLE_ACCOUNTS has its stored rows deleted on the next sync; UPLOAD stays", async () => {
    await sync();
    await h.relay.fetch(`${BASE}/contacts`, {
      method: "POST",
      headers: { "Cf-Access-Jwt-Assertion": await h.jwt(), "content-type": "application/json" },
      body: JSON.stringify({ generated_at: "2026-10-16T23:00:00Z", contacts: [{ name: "Upload Name", numbers: [{ e164: "+15555550126", label: "mobile" }] }] }),
    });
    await h.setEnv({ GOOGLE_ACCOUNTS: "primary,work" });
    const r = await sync();
    expect(r.failed).toEqual([]);
    expect(await sql("SELECT DISTINCT account FROM contact_sources ORDER BY account")).toEqual([{ account: "PRIMARY" }, { account: "UPLOAD" }, { account: "WORK" }]);
    expect(await sql("SELECT k FROM meta WHERE k LIKE 'acct:CLUB:%'")).toEqual([]);
    expect((await merged())["+15555550123"]).toBeUndefined(); // Mom came only from CLUB
    expect((await logRows()).find((x) => x.event === "contacts_source_purged").detail).toBe("account=CLUB numbers=2 reason=not_in_GOOGLE_ACCOUNTS");
    // Even a failing sync of the remaining accounts purges the removed one
    await h.setEnv({ GOOGLE_ACCOUNTS: "primary", GOOGLE_CLIENT_SECRET: undefined as unknown as string });
    await sync();
    expect(await sql("SELECT DISTINCT account FROM contact_sources ORDER BY account")).toEqual([{ account: "PRIMARY" }, { account: "UPLOAD" }]);
  });
});

describe("DEFAULT_COUNTRY_CODE (required for sync; never assumes +1)", () => {
  // Numbers Google returns without a canonical form, so the relay must apply the country code itself.
  const raw = () => {
    google["TEST-ONLY-rt-primary"] = { pages: [[person("Ann Lee", ["0555 0101", "mobile"]), person("Pat Roe", ["(555) 555-0126", "mobile"]), person("Plus One", ["+15555550127", "mobile"])]] };
  };

  it.each([undefined, "", "1", "US", "+0", "+1234", "NONE"])("DEFAULT_COUNTRY_CODE=%j: every account fails with default_country_code_invalid, no Google call, previous lists kept", async (v) => {
    expect((await sync()).failed).toEqual([]); // a good first sync
    const before = await merged();
    await h.setEnv({ DEFAULT_COUNTRY_CODE: v as unknown as string });
    h.calls.length = 0;
    const r = await sync();
    expect(r.updated).toEqual([]);
    expect(r.failed).toEqual(["PRIMARY", "WORK", "CLUB"].map((account) => ({ account, reason: "default_country_code_invalid" })));
    expect(h.calls.filter((c) => c.url.includes("googleapis.com"))).toHaveLength(0);
    expect(await merged()).toEqual(before);
    expect((await ownerTexts())[0]).toContain("PRIMARY (default_country_code_invalid)");
  });

  it('"+1": 10-digit numbers get +1', async () => {
    raw();
    await h.setEnv({ DEFAULT_COUNTRY_CODE: "+1", GOOGLE_ACCOUNTS: "primary" });
    expect((await sync()).failed).toEqual([]);
    expect(Object.keys(await merged())).toEqual(["+15555550126", "+15555550127"]); // "0555 0101" is not a +1 number
  });

  it('"+44": the trunk 0 is dropped and +44 is put in front; nothing is read as +1', async () => {
    raw();
    await h.setEnv({ DEFAULT_COUNTRY_CODE: "+44", GOOGLE_ACCOUNTS: "primary" });
    expect((await sync()).failed).toEqual([]);
    expect(await merged()).toEqual({ "+15555550127": "Plus One", "+445550101": "Ann Lee", "+445555550126": "Pat Roe" });
  });

  it('"none" (strict E.164): numbers without "+" are dropped', async () => {
    raw();
    await h.setEnv({ DEFAULT_COUNTRY_CODE: "none", GOOGLE_ACCOUNTS: "primary" });
    expect((await sync()).failed).toEqual([]);
    expect(await merged()).toEqual({ "+15555550127": "Plus One" });
  });

  it("/direct shows the setting, and says when it is missing", async () => {
    const page = async () => (await h.relay.fetch(`${BASE}/direct`, { headers: { "Cf-Access-Jwt-Assertion": await h.jwt() } })).text();
    expect(await page()).toContain("<b>DEFAULT_COUNTRY_CODE:</b> +1");
    await h.setEnv({ DEFAULT_COUNTRY_CODE: "none" });
    expect(await page()).toContain("none (strict E.164)");
    await h.setEnv({ DEFAULT_COUNTRY_CODE: undefined as unknown as string });
    expect(await page()).toContain("NOT SET: contact sync is refused");
  });
});
