// google-connect PR 2: Access-gated sign-in routes, state + PKCE, exact scope, 404 on the bot host, revoke + delete.
import { beforeEach, describe, expect, it } from "vitest";
import { API, BASE, harness, type Harness } from "./helpers";
import { fakeGoogle, inRelay, must, sql as sqlOf, type FakeGoogle } from "./google-fixture";
import { GOOGLE_SCOPE } from "../src/google";

const KEY = "ab".repeat(32); // obviously fake
const CLIENT_ID = "123-testonly.apps.googleusercontent.com";
const CLIENT_SECRET = "TEST-ONLY-client-secret-xyz";
const RT = "TEST-ONLY-rt-from-callback";
const CB = `${BASE}/contacts/google/callback`;

let h: Harness;
let g: FakeGoogle;
const sql = (q: string, ...a: SqlStorageValue[]) => sqlOf(h, q, ...a);

async function pageCsrf(): Promise<string> {
  const r = await h.relay.fetch(`${BASE}/contacts`, { headers: { "Cf-Access-Jwt-Assertion": await h.jwt() } });
  return must((await r.text()).match(/const CSRF="([a-f0-9]{32})"/)?.[1], "csrf");
}
async function form(path: string, fields: Record<string, string>, opts: { origin?: string; host?: string; auth?: string; jwt?: boolean } = {}) {
  const headers: Record<string, string> = { Origin: opts.origin ?? BASE, "content-type": "application/x-www-form-urlencoded" };
  if (opts.jwt !== false) headers["Cf-Access-Jwt-Assertion"] = await h.jwt();
  if (opts.auth) headers["Authorization"] = opts.auth;
  return h.relay.fetch(`${opts.host ?? BASE}${path}`, { method: "POST", headers, body: new URLSearchParams(fields).toString(), redirect: "manual" });
}
const start = async (label = "work") => form("/contacts/google/start", { csrf: await pageCsrf(), label });
async function callback(q: Record<string, string>) {
  return h.relay.fetch(`${CB}?${new URLSearchParams(q).toString()}`, { headers: { "Cf-Access-Jwt-Assertion": await h.jwt() }, redirect: "manual" });
}
const b64url = (u: Uint8Array) => btoa(String.fromCharCode(...u)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const where = (r: Response) => new URL(must(r.headers.get("location"), "location"), BASE);

beforeEach(async () => {
  h = await harness();
  g = await fakeGoogle(h);
  g.tokenReply = { status: 200, body: { access_token: "TEST-ONLY-at", refresh_token: RT, scope: GOOGLE_SCOPE, token_type: "Bearer" } };
  await h.setEnv({ GOOGLE_ACCOUNTS: "", GOOGLE_TOKEN_KEY: KEY, LOG_HASH_KEY: "TEST-ONLY-log-hash-key-not-a-real-secret" });
  await inRelay(h, (i) => i.saveGoogleClient(CLIENT_ID, CLIENT_SECRET));
});

describe("POST /contacts/google/start", () => {
  it("302s to Google with exactly contacts.readonly, PKCE S256 over the stored verifier, and a stored single-use state", async () => {
    const r = await start();
    expect(r.status).toBe(302);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const u = new URL(must(r.headers.get("location")));
    expect(u.origin + u.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(u.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/contacts.readonly");
    expect(u.searchParams.getAll("scope")).toHaveLength(1);
    expect(u.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(u.searchParams.get("redirect_uri")).toBe(CB);
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("prompt")).toBe("consent select_account");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.toString()).not.toContain(CLIENT_SECRET);
    const rows = await sql("SELECT * FROM google_oauth_state");
    const row = must(rows[0]);
    expect(rows).toHaveLength(1);
    expect(row["state"]).toBe(u.searchParams.get("state"));
    expect(row["state"]).toMatch(/^[a-f0-9]{64}$/);
    expect(row["label"]).toBe("WORK");
    expect(row["email"]).toBe("approver@example.test");
    const want = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(typeof row["verifier"] === "string" ? row["verifier"] : ""))));
    expect(u.searchParams.get("code_challenge")).toBe(want);
  });

  it("refuses without the page CSRF token, from another Origin, as GET, and with a bad label", async () => {
    expect((await form("/contacts/google/start", { label: "work" })).status).toBe(403);
    expect((await form("/contacts/google/start", { csrf: "0".repeat(32), label: "work" })).status).toBe(403);
    expect((await form("/contacts/google/start", { csrf: await pageCsrf(), label: "work" }, { origin: "https://evil.example.test" })).status).toBe(403);
    const g = await h.relay.fetch(`${BASE}/contacts/google/start?label=work`, { headers: { "Cf-Access-Jwt-Assertion": await h.jwt() }, redirect: "manual" });
    expect(g.status).toBe(404);
    const bad = await start("wo rk!");
    expect(where(bad).searchParams.get("google_error")).toBe("google_label_invalid");
    expect(await sql("SELECT * FROM google_oauth_state")).toEqual([]);
  });

  it("refuses before going to Google when there is no GOOGLE_TOKEN_KEY or no client", async () => {
    await h.setEnv({ GOOGLE_TOKEN_KEY: "" });
    expect(where(await start()).searchParams.get("google_error")).toBe("google_token_key_missing");
    await h.setEnv({ GOOGLE_TOKEN_KEY: "not-a-valid-key" });
    const bad = await start();
    expect(bad.status).toBe(303); // a code on the page, not a 500
    expect(where(bad).searchParams.get("google_error")).toBe("google_token_key_invalid");
    expect(await sql("SELECT * FROM google_oauth_state")).toEqual([]);
    await h.setEnv({ GOOGLE_TOKEN_KEY: KEY });
    await sql("DELETE FROM google_client");
    expect(where(await start()).searchParams.get("google_error")).toBe("google_client_not_configured");
  });
});

describe("host split: the bot (API) host never sees /contacts/google/*", () => {
  it("404s start, callback and disconnect on REQUEST_HOST, with or without the bot token or an Access JWT", async () => {
    for (const auth of [undefined, "Bearer TEST-ONLY-request-token"]) {
      for (const p of ["/contacts/google/start", "/contacts/google/disconnect"]) expect((await form(p, { csrf: "x", label: "work" }, { host: API, origin: API, ...(auth ? { auth } : {}) })).status).toBe(404);
      const headers: Record<string, string> = { "Cf-Access-Jwt-Assertion": await h.jwt(), ...(auth ? { Authorization: auth } : {}) };
      const c = await h.relay.fetch(`${API}/contacts/google/callback?state=${"a".repeat(64)}&code=x`, { headers, redirect: "manual" });
      expect(c.status).toBe(404);
    }
    expect(g.tokenCalls).toHaveLength(0);
  });
  it("the bot token on the approve host is refused (403), never a sign-in", async () => {
    const r = await form("/contacts/google/start", { csrf: await pageCsrf(), label: "work" }, { auth: "Bearer TEST-ONLY-request-token" });
    expect(r.status).toBe(403);
    const c = await h.relay.fetch(`${CB}?state=${"a".repeat(64)}&code=x`, { headers: { Authorization: "Bearer TEST-ONLY-request-token" }, redirect: "manual" });
    expect(c.status).toBe(403);
  });
});

describe("GET /contacts/google/callback", () => {
  const stateOf = async () => must(new URL(must((await start()).headers.get("location"))).searchParams.get("state"));

  it("swaps the code with the PKCE verifier + client secret, seals the token, and redirects with no-store / no-referrer", async () => {
    const state = await stateOf();
    const verifier = must((await sql("SELECT verifier FROM google_oauth_state"))[0])["verifier"];
    const r = await callback({ state, code: "TEST-ONLY-code" });
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("/contacts?connected=WORK");
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("referrer-policy")).toBe("no-referrer");
    const t = must(g.tokenCalls[0]);
    expect(Object.fromEntries(t)).toEqual({ code: "TEST-ONLY-code", client_id: CLIENT_ID, client_secret: CLIENT_SECRET, redirect_uri: CB, grant_type: "authorization_code", code_verifier: verifier });
    expect(await inRelay(h, (i) => i.googleRefreshToken("WORK"))).toBe(RT);
    expect((await sql("SELECT scope FROM google_accounts"))[0]?.["scope"]).toBe(GOOGLE_SCOPE);
    expect(JSON.stringify(await sql("SELECT * FROM google_accounts"))).not.toContain(RT);
    expect(JSON.stringify(await sql("SELECT detail FROM log"))).not.toMatch(/TEST-ONLY-(rt|code|at|client-secret)/);
  });

  it("state is single use: a replay is refused and makes no token call", async () => {
    const state = await stateOf();
    await callback({ state, code: "TEST-ONLY-code" });
    const again = await callback({ state, code: "TEST-ONLY-code" });
    expect(where(again).searchParams.get("google_error")).toBe("google_state_invalid");
    expect(g.tokenCalls).toHaveLength(1);
  });

  it("refuses a missing, unknown, expired or other-identity state, with no token call", async () => {
    expect(where(await callback({ code: "x" })).searchParams.get("google_error")).toBe("google_state_invalid");
    expect(where(await callback({ state: "b".repeat(64), code: "x" })).searchParams.get("google_error")).toBe("google_state_invalid");
    const s1 = await stateOf();
    await sql("UPDATE google_oauth_state SET expires_ms=0 WHERE state=?", s1);
    expect(where(await callback({ state: s1, code: "x" })).searchParams.get("google_error")).toBe("google_state_expired");
    const s2 = await stateOf();
    await sql("UPDATE google_oauth_state SET email='someone-else@example.test' WHERE state=?", s2);
    expect(where(await callback({ state: s2, code: "x" })).searchParams.get("google_error")).toBe("google_state_wrong_identity");
    expect(g.tokenCalls).toHaveLength(0);
    expect(await sql("SELECT * FROM google_accounts")).toEqual([]);
  });

  it("state expires 10 minutes after start", async () => {
    const state = await stateOf();
    h.setNow(Number(must((await sql("SELECT expires_ms FROM google_oauth_state"))[0])["expires_ms"]));
    expect(where(await callback({ state, code: "x" })).searchParams.get("google_error")).toBe("google_state_expired");
  });

  for (const [name, scope] of [
    ["wider", `${GOOGLE_SCOPE} https://www.googleapis.com/auth/contacts`],
    ["different", "https://www.googleapis.com/auth/contacts"],
    ["missing", undefined],
  ] as const) {
    it(`a ${name} granted scope is refused, the token revoked at Google, nothing stored`, async () => {
      g.tokenReply.body = { access_token: "TEST-ONLY-at", refresh_token: RT, ...(scope === undefined ? {} : { scope }) };
      const r = await callback({ state: await stateOf(), code: "TEST-ONLY-code" });
      expect(where(r).searchParams.get("google_error")).toBe("google_scope_not_exact");
      expect(g.revokeCalls.map((c) => c.get("token"))).toEqual([RT]);
      expect(await sql("SELECT * FROM google_accounts")).toEqual([]);
    });
  }

  it("no refresh token, consent denied, or a token error: refused with a code, nothing stored", async () => {
    g.tokenReply.body = { access_token: "TEST-ONLY-at", scope: GOOGLE_SCOPE };
    expect(where(await callback({ state: await stateOf(), code: "x" })).searchParams.get("google_error")).toBe("google_no_refresh_token");
    expect(where(await callback({ state: await stateOf(), error: "access_denied" })).searchParams.get("google_error")).toBe("google_consent_denied");
    g.tokenReply = { status: 400, body: { error: "invalid_grant" } };
    expect(where(await callback({ state: await stateOf(), code: "x" })).searchParams.get("google_error")).toBe("google_token_status_400");
    expect(await sql("SELECT * FROM google_accounts")).toEqual([]);
  });
});

describe("POST /contacts/google/disconnect", () => {
  const seed = async () => {
    await inRelay(h, (i) => i.saveGoogleAccount("WORK", RT, GOOGLE_SCOPE, null));
    await sql("INSERT INTO contact_sources(account,name,name_norm,given_norm,first_norm,e164,e164_sha,label) VALUES('WORK','Riley Test','riley test','riley','riley','+15555550131','x','mobile')");
    await sql("INSERT INTO meta(k,v) VALUES('acct:WORK:ok_ms','1')");
  };

  it("revokes the stored token at Google, then deletes the token, that label's contacts and its status", async () => {
    await seed();
    const r = await form("/contacts/google/disconnect", { csrf: await pageCsrf(), label: "work" });
    expect(r.headers.get("location")).toBe("/contacts?disconnected=WORK");
    expect(g.revokeCalls.map((c) => c.get("token"))).toEqual([RT]);
    expect(await sql("SELECT * FROM google_accounts")).toEqual([]);
    expect(await sql("SELECT * FROM contact_sources WHERE account='WORK'")).toEqual([]);
    expect(await sql("SELECT * FROM meta WHERE k LIKE 'acct:WORK:%'")).toEqual([]);
    expect((await sql("SELECT detail FROM log WHERE event='google_disconnected'"))[0]?.["detail"]).toBe("label=WORK revoke=ok");
  });

  it("a disconnected GOOGLE_ACCOUNTS label stops syncing: no fallback to GOOGLE_RT_<LABEL> until it is connected again", async () => {
    await seed();
    await h.setEnv({ GOOGLE_ACCOUNTS: "work", GOOGLE_RT_WORK: "TEST-ONLY-legacy-rt" });
    await form("/contacts/google/disconnect", { csrf: await pageCsrf(), label: "work" });
    expect(await inRelay(h, (i) => i.googleLabels())).toEqual([]);
    expect(await inRelay(h, (i) => i.googleLegacyLeftovers())).toEqual(["WORK"]);
    const r = await inRelay(h, (i) => i.syncContacts({ alert: false }));
    expect(r).toEqual({ updated: [], failed: [] });
    expect(g.tokenCalls.map((c) => c.get("refresh_token"))).not.toContain("TEST-ONLY-legacy-rt");
    expect(await sql("SELECT * FROM contact_sources WHERE account='WORK'")).toEqual([]);
    // Connecting again clears the marker.
    const state = must(new URL(must((await start()).headers.get("location"))).searchParams.get("state"));
    await callback({ state, code: "TEST-ONLY-code" });
    expect(await inRelay(h, (i) => i.googleLabels())).toEqual(["WORK"]);
    expect(await inRelay(h, (i) => i.googleLegacyLeftovers())).toEqual([]);
  });

  it("still deletes when Google's revoke fails, and says so", async () => {
    await seed();
    g.revokeStatus = 503;
    const r = await form("/contacts/google/disconnect", { csrf: await pageCsrf(), label: "work" });
    expect(where(r).searchParams.get("revoke")).toBe("failed");
    expect(await sql("SELECT * FROM google_accounts")).toEqual([]);
  });

  it("needs the page CSRF token and same Origin; an unknown label changes nothing", async () => {
    await seed();
    expect((await form("/contacts/google/disconnect", { label: "work" })).status).toBe(403);
    expect((await form("/contacts/google/disconnect", { csrf: await pageCsrf(), label: "work" }, { origin: "https://evil.example.test" })).status).toBe(403);
    const r = await form("/contacts/google/disconnect", { csrf: await pageCsrf(), label: "club" });
    expect(where(r).searchParams.get("google_error")).toBe("google_not_connected");
    expect(g.revokeCalls).toHaveLength(0);
    expect(await sql("SELECT label FROM google_accounts")).toEqual([{ label: "WORK" }]);
  });
});
