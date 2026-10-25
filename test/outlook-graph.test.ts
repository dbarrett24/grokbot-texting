// Outlook / Microsoft 365 contacts via Microsoft Graph: sign-in (state + PKCE), exact Contacts.Read scope,
// sealed and rotated refresh tokens, paged /me/contacts, never widening the allowlist, tokens never logged.
import { beforeEach, describe, expect, it } from "vitest";
import { API, BASE, harness, type Harness } from "./helpers";
import { inRelay, must, sql as sqlOf } from "./google-fixture";
import { graphToContacts, msScopeIsExact, parseMsAccounts, safeNextLink } from "../src/outlook";
import { GOOGLE_SCOPE, aadFor, importTokenKey, isLabel, open, seal } from "../src/google";
import { msAad } from "../src/outlook";

// All values are TEST-ONLY; numbers are in the fictional 555-01xx range, addresses on example.test.
const KEY = "cd".repeat(32);
const CLIENT_ID = "00000000-0000-0000-0000-testonly0001";
const CLIENT_SECRET = "TEST-ONLY-ms-client-secret";
const RT1 = "TEST-ONLY-ms-rt-first";
const RT2 = "TEST-ONLY-ms-rt-rotated";
const AT = "TEST-ONLY-ms-access-token";
const CB = `${BASE}/contacts/outlook/callback`;
const KEY_G = "ef".repeat(32);
const KEY_NEW = "a1".repeat(32);
const G_RT = "TEST-ONLY-google-rt";
const GRAPH_SCOPE = "https://graph.microsoft.com/Contacts.Read";

type Fake = { tokenCalls: URLSearchParams[]; graphAuth: (string | null)[]; tokenReply: { status: number; body: Record<string, unknown> }; graphStatus: number; pages: Record<string, unknown>[] };
let h: Harness;
let ms: Fake;
const sql = (q: string, ...a: SqlStorageValue[]) => sqlOf(h, q, ...a);
const sync = () => inRelay(h, (r) => r.syncContacts({ alert: false }));

async function pageCsrf(): Promise<string> {
  const r = await h.relay.fetch(`${BASE}/contacts`, { headers: { "Cf-Access-Jwt-Assertion": await h.jwt() } });
  return must((await r.text()).match(/const CSRF="([a-f0-9]{32})"/)?.[1], "csrf");
}
async function post(path: string, fields: Record<string, string>) {
  return h.relay.fetch(`${BASE}${path}`, { method: "POST", headers: { Origin: BASE, "content-type": "application/x-www-form-urlencoded", "Cf-Access-Jwt-Assertion": await h.jwt() }, body: new URLSearchParams(fields).toString(), redirect: "manual" });
}
const where = (r: Response) => new URL(must(r.headers.get("location"), "location"), BASE);
async function connect(label = "work"): Promise<Response> {
  const s = await post("/contacts/outlook/start", { csrf: await pageCsrf(), label });
  const state = must(new URL(must(s.headers.get("location"))).searchParams.get("state"));
  return h.relay.fetch(`${CB}?${new URLSearchParams({ state, code: "TEST-ONLY-code" }).toString()}`, { headers: { "Cf-Access-Jwt-Assertion": await h.jwt() }, redirect: "manual" });
}

beforeEach(async () => {
  h = await harness();
  ms = {
    tokenCalls: [], graphAuth: [], graphStatus: 200,
    tokenReply: { status: 200, body: { token_type: "Bearer", access_token: AT, refresh_token: RT1, scope: GRAPH_SCOPE } },
    pages: [
      { value: [{ displayName: "Ann Lee", givenName: "Ann", mobilePhone: "+15555550141", homePhones: [], businessPhones: ["+15555550142"] }], "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/contacts?$skip=1" },
      { value: [{ displayName: "", givenName: "Bo", surname: "Test", mobilePhone: null, homePhones: ["(555) 555-0143"], businessPhones: [] }, { displayName: "No Number", businessPhones: [] }] },
    ],
  };
  await inRelay(h, (relay) => {
    const base = relay.net;
    relay.net = async (req: Request) => {
      const u = new URL(req.url);
      if (u.host === "login.microsoftonline.com" && u.pathname === "/common/oauth2/v2.0/token") {
        ms.tokenCalls.push(new URLSearchParams(await req.text()));
        return Response.json(ms.tokenReply.body, { status: ms.tokenReply.status });
      }
      if (u.host === "graph.microsoft.com") {
        ms.graphAuth.push(req.headers.get("Authorization"));
        if (ms.graphStatus !== 200) return new Response("{}", { status: ms.graphStatus });
        return Response.json(ms.pages[u.searchParams.get("$skip") ? 1 : 0]);
      }
      return base(req);
    };
  });
  await h.setEnv({ GOOGLE_ACCOUNTS: "", GOOGLE_TOKEN_KEY: KEY_G, MS_TOKEN_KEY: KEY, LOG_HASH_KEY: "TEST-ONLY-log-hash-key-not-a-real-secret", MS_CLIENT_ID: CLIENT_ID, MS_CLIENT_SECRET: CLIENT_SECRET, DIRECT_SEND: "1" });
});

describe("Outlook sign-in", () => {
  it("start 302s to Microsoft with only offline_access Contacts.Read, PKCE S256 and a stored state", async () => {
    const r = await post("/contacts/outlook/start", { csrf: await pageCsrf(), label: "work" });
    expect(r.status).toBe(302);
    const u = new URL(must(r.headers.get("location")));
    expect(u.origin + u.pathname).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
    expect(u.searchParams.get("scope")).toBe("offline_access Contacts.Read");
    expect(u.searchParams.get("redirect_uri")).toBe(CB);
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.toString()).not.toContain(CLIENT_SECRET);
    expect((await sql("SELECT label FROM ms_oauth_state"))[0]?.["label"]).toBe("WORK");
  });

  it("needs the page CSRF token", async () => {
    expect((await post("/contacts/outlook/start", { label: "work" })).status).toBe(403);
  });

  it("callback seals the refresh token (no plaintext in the row) and the state is single use", async () => {
    const r = await connect();
    expect(where(r).searchParams.get("connected")).toBe("OUTLOOK_WORK");
    const call = must(ms.tokenCalls[0]);
    expect(call.get("grant_type")).toBe("authorization_code");
    expect(call.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const row = must((await sql("SELECT * FROM ms_accounts"))[0]);
    expect(row["label"]).toBe("WORK");
    expect(JSON.stringify(row)).not.toContain(RT1);
    expect(await inRelay(h, (relay) => relay.msRefreshToken("WORK"))).toBe(RT1);
    expect((await sql("SELECT COUNT(*) AS c FROM ms_oauth_state"))[0]?.["c"]).toBe(0);
  });

  it("refuses a wider scope and stores nothing", async () => {
    ms.tokenReply.body = { ...ms.tokenReply.body, scope: `${GRAPH_SCOPE} https://graph.microsoft.com/Mail.Read` };
    const r = await connect();
    expect(where(r).searchParams.get("outlook_error")).toBe("outlook_scope_not_exact");
    expect(await sql("SELECT * FROM ms_accounts")).toEqual([]);
  });
});

describe("Outlook sync", () => {
  it("refreshes, pages /me/contacts, stores OUTLOOK_WORK rows, and re-seals a rotated refresh token", async () => {
    await connect();
    ms.tokenReply.body = { ...ms.tokenReply.body, refresh_token: RT2 };
    expect(await sync()).toEqual({ updated: ["OUTLOOK_WORK"], failed: [] });
    const refresh = must(ms.tokenCalls[1]);
    expect(refresh.get("grant_type")).toBe("refresh_token");
    expect(refresh.get("refresh_token")).toBe(RT1);
    expect(refresh.get("scope")).toBe("offline_access Contacts.Read");
    expect(ms.graphAuth).toEqual([`Bearer ${AT}`, `Bearer ${AT}`]);
    expect(await sql("SELECT account, name, e164, label FROM contact_sources ORDER BY e164")).toEqual([
      { account: "OUTLOOK_WORK", name: "Ann Lee", e164: "+15555550141", label: "mobile" },
      { account: "OUTLOOK_WORK", name: "Ann Lee", e164: "+15555550142", label: "work" },
      { account: "OUTLOOK_WORK", name: "Bo Test", e164: "+15555550143", label: "home" },
    ]);
    expect(await inRelay(h, (relay) => relay.msRefreshToken("WORK"))).toBe(RT2);
  });

  it("does not widen who can be texted: synced numbers stay OFF", async () => {
    await connect();
    await sync();
    await h.relay.fetch(`${BASE}/contacts/list`, { headers: { "Cf-Access-Jwt-Assertion": await h.jwt() } });
    const prefs = await sql("SELECT enabled FROM contact_prefs");
    expect(prefs.length).toBeGreaterThan(0);
    expect(prefs.every((p) => p["enabled"] === 0)).toBe(true);
    const res = await h.relay.fetch(`${API}/send`, { method: "POST", headers: { Authorization: "Bearer TEST-ONLY-request-token" }, body: JSON.stringify({ to_name: "Ann Lee", body: "hi" }) });
    const j: { state?: unknown } = await res.json();
    expect(j.state).not.toBe("sent");
  });

  it("a token failure keeps the previous list; disconnect deletes token and contacts", async () => {
    await connect();
    await sync();
    ms.tokenReply = { status: 400, body: { error: "invalid_grant" } };
    expect((await sync()).failed).toEqual([{ account: "OUTLOOK_WORK", reason: "outlook_token_status_400" }]);
    expect((await sql("SELECT COUNT(*) AS c FROM contact_sources WHERE account='OUTLOOK_WORK'"))[0]?.["c"]).toBe(3);
    const d = await post("/contacts/outlook/disconnect", { csrf: await pageCsrf(), label: "work" });
    expect(where(d).searchParams.get("disconnected")).toBe("OUTLOOK_WORK");
    expect(await sql("SELECT * FROM ms_accounts")).toEqual([]);
    expect((await sql("SELECT COUNT(*) AS c FROM contact_sources WHERE account='OUTLOOK_WORK'"))[0]?.["c"]).toBe(0);
    expect(await sync()).toEqual({ updated: [], failed: [] });
  });

  it("tokens and the client secret never reach console, logs or DO storage", async () => {
    const out: string[] = [];
    const orig = { log: console.log, error: console.error, warn: console.warn };
    for (const k of ["log", "error", "warn"] as const) console[k] = (...a: unknown[]) => void out.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
    try {
      await connect();
      ms.tokenReply.body = { ...ms.tokenReply.body, refresh_token: RT2 };
      await sync();
      ms.graphStatus = 500;
      await sync();
    } finally {
      Object.assign(console, orig);
    }
    const dump = await inRelay(h, async (_r, st) => {
      const s: string[] = [];
      for (const t of st.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'").toArray()) {
        if (t.name.startsWith("_cf") || t.name.startsWith("sqlite")) continue;
        s.push(JSON.stringify(st.storage.sql.exec(`SELECT * FROM "${t.name}"`).toArray()));
      }
      s.push(JSON.stringify([...(await st.storage.list()).entries()]));
      return s;
    });
    const all = [...out, ...dump].join("\n");
    expect(all).toContain("outlook_graph_status_500");
    for (const v of [RT1, RT2, AT, CLIENT_SECRET, "TEST-ONLY-code"]) expect(all).not.toContain(v);
  });
});

describe("Outlook helpers", () => {
  it("scope: Contacts.Read only, offline_access allowed, either form", () => {
    expect(msScopeIsExact(GRAPH_SCOPE)).toBe(true);
    expect(msScopeIsExact("Contacts.Read offline_access")).toBe(true);
    expect(msScopeIsExact("offline_access")).toBe(false);
    expect(msScopeIsExact(`${GRAPH_SCOPE} User.Read`)).toBe(false);
    expect(msScopeIsExact("https://graph.microsoft.com/Contacts.ReadWrite")).toBe(false);
    expect(msScopeIsExact(undefined)).toBe(false);
  });
  it("nextLink must stay on graph.microsoft.com over https", () => {
    expect(() => safeNextLink("https://evil.example.test/v1.0/me/contacts")).toThrow("outlook_foreign_next_link");
    expect(() => safeNextLink("http://graph.microsoft.com/x")).toThrow("outlook_foreign_next_link");
    expect(safeNextLink(undefined)).toBeNull();
  });
  it("graph contacts: dedupes numbers, skips nameless and numberless", () => {
    expect(graphToContacts([{ displayName: "Cy", mobilePhone: "+15555550144", businessPhones: ["+15555550144"] }, { displayName: "", mobilePhone: "+15555550145" }], "+1")).toEqual([{ name: "Cy", numbers: [{ e164: "+15555550144", label: "mobile" }] }]);
    expect(() => graphToContacts("nope", null)).toThrow("outlook_contacts_bad_json");
  });
  it("labels: OUTLOOK_ is reserved for Google labels; MS_ACCOUNTS parses like GOOGLE_ACCOUNTS", () => {
    expect(isLabel("OUTLOOK_WORK")).toBe(false);
    expect(parseMsAccounts("work, home,bad-label")).toEqual({ valid: ["WORK", "HOME"], invalid: ["bad?label"] });
  });
});

describe("MS_TOKEN_KEY is Outlook's own key", () => {
  const refusal = async (f: () => Promise<unknown>) => { try { await f(); return "opened"; } catch (e) { return e instanceof Error ? e.message : String(e); } };

  it("seal/open: an Outlook token sealed with MS_TOKEN_KEY can't be opened with GOOGLE_TOKEN_KEY, and vice versa", async () => {
    const msK = must(await importTokenKey(KEY));
    const gK = must(await importTokenKey(KEY_G));
    const msSealed = await seal(msK, RT1, msAad("WORK"));
    const gSealed = await seal(gK, G_RT, aadFor("rt", "WORK"));
    expect(await refusal(() => open([gK, null], msSealed, msAad("WORK")))).toBe("google_token_key_missing");
    expect(await refusal(() => open([msK, null], gSealed, aadFor("rt", "WORK")))).toBe("google_token_key_missing");
    expect((await open([msK, null], msSealed, msAad("WORK"))).plaintext).toBe(RT1);
    // even the same key bytes can't move a token between providers: the AAD differs
    expect(await refusal(() => open([msK, null], { ...msSealed }, aadFor("rt", "WORK")))).toBe("google_token_decrypt_failed");
  });

  it("relay: an Outlook sign-in fails closed when only GOOGLE_TOKEN_KEY holds its key", async () => {
    await connect();
    await h.setEnv({ GOOGLE_TOKEN_KEY: KEY, MS_TOKEN_KEY: KEY_NEW });
    expect((await sync()).failed).toEqual([{ account: "OUTLOOK_WORK", reason: "outlook_token_key_missing" }]);
    await h.setEnv({ MS_TOKEN_KEY: "" });
    const r = await post("/contacts/outlook/start", { csrf: await pageCsrf(), label: "home" });
    expect(where(r).searchParams.get("outlook_error")).toBe("outlook_token_key_missing");
  });

  it("relay: a Google sign-in can't be opened with MS_TOKEN_KEY", async () => {
    await inRelay(h, (relay) => relay.saveGoogleAccount("WORK", G_RT, GOOGLE_SCOPE, "someone@example.test"));
    await h.setEnv({ GOOGLE_TOKEN_KEY: KEY_NEW, MS_TOKEN_KEY: KEY_G });
    expect(await refusal(() => inRelay(h, (relay) => relay.googleRefreshToken("WORK")))).toContain("google_token_key_missing");
  });

  it("rotation: MS_TOKEN_KEY_OLD still opens old rows, which are re-sealed under the new MS_TOKEN_KEY", async () => {
    await connect();
    const oldKid = (await sql("SELECT key_ver FROM ms_accounts"))[0]?.["key_ver"];
    await h.setEnv({ MS_TOKEN_KEY: KEY_NEW, MS_TOKEN_KEY_OLD: KEY });
    expect(await sync()).toEqual({ updated: ["OUTLOOK_WORK"], failed: [] });
    const row = must((await sql("SELECT * FROM ms_accounts"))[0]);
    expect(row["key_ver"]).not.toBe(oldKid);
    expect(row["key_ver"]).toBe(must(await importTokenKey(KEY_NEW)).kid);
    expect(JSON.stringify(row)).not.toContain(RT1);
    await h.setEnv({ MS_TOKEN_KEY_OLD: "" });
    expect(await sync()).toEqual({ updated: ["OUTLOOK_WORK"], failed: [] });
    // GOOGLE_TOKEN_KEY_OLD is not an Outlook rotation key
    await h.setEnv({ MS_TOKEN_KEY: KEY, GOOGLE_TOKEN_KEY_OLD: KEY_NEW });
    expect((await sync()).failed).toEqual([{ account: "OUTLOOK_WORK", reason: "outlook_token_key_missing" }]);
  });
});
