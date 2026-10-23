// google-connect PR 3: the Google panel on /contacts: Set up Google checklist (deep links), paste form, one Connect Google button.
import { beforeEach, describe, expect, it } from "vitest";
import { API, BASE, harness, type Harness } from "./helpers";
import { fakeGoogle, inRelay, must, sql as sqlOf, type FakeGoogle } from "./google-fixture";
import { GCP_LINKS, GCP_PROJECT_LINKS, GOOGLE_ERROR_FIX, SYNC_FIX, TOKEN_KEY_MISSING_FIX, googleErrorFix, projectNumberOf, syncFix, withProject } from "../src/contacts";
import { GOOGLE_SCOPE } from "../src/google";

const KEY = "ab".repeat(32); // obviously fake
const CLIENT_ID = "123-testonly.apps.googleusercontent.com";
const CLIENT_SECRET = "TEST-ONLY-pasted-client-secret";

let h: Harness;
let g: FakeGoogle;
const sql = (q: string, ...a: SqlStorageValue[]) => sqlOf(h, q, ...a);
async function page(query = ""): Promise<{ html: string; res: Response }> {
  const res = await h.relay.fetch(`${BASE}/contacts${query}`, { headers: { "Cf-Access-Jwt-Assertion": await h.jwt() } });
  return { html: await res.text(), res };
}
const csrfOf = (html: string) => must(html.match(/const CSRF="([a-f0-9]{32})"/)?.[1], "csrf");
async function post(path: string, fields: Record<string, string>, opts: { origin?: string; host?: string } = {}) {
  return h.relay.fetch(`${opts.host ?? BASE}${path}`, {
    method: "POST", redirect: "manual",
    headers: { "Cf-Access-Jwt-Assertion": await h.jwt(), Origin: opts.origin ?? BASE, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
}
const loc = (r: Response) => must(r.headers.get("location"), "location");

beforeEach(async () => {
  h = await harness();
  g = await fakeGoogle(h);
  await h.setEnv({ GOOGLE_ACCOUNTS: "", GOOGLE_TOKEN_KEY: KEY, LOG_HASH_KEY: "TEST-ONLY-log-hash-key-not-a-real-secret" });
});

describe("Set up Google checklist", () => {
  it("the page is Connect Google only: no client fields, no console checklist", async () => {
    const { html } = await page();
    expect(html).not.toContain("name=client_id");
    expect(html).not.toContain("name=client_secret");
    expect(html).not.toContain("Save client");
    expect(html).not.toContain("id=gsetup");
    expect(html).not.toContain("id=gclient");
    for (const href of Object.values(GCP_LINKS)) expect(html).not.toContain(href);
    expect(html).toContain("node scripts/google-client.mjs --file=client.json");
    expect(html).toMatch(/<button disabled>Connect Google<\/button>/); // no client yet
  });

  it("the deep links are exactly these (EL clicks through them before merge)", () => {
    expect(GCP_LINKS).toEqual({
      createProject: "https://console.cloud.google.com/projectcreate",
      enablePeople: "https://console.cloud.google.com/flows/enableapi?apiid=people.googleapis.com",
      peopleLibrary: "https://console.cloud.google.com/apis/library/people.googleapis.com",
      branding: "https://console.cloud.google.com/auth/overview/create",
      audience: "https://console.cloud.google.com/auth/audience",
      createClient: "https://console.cloud.google.com/auth/clients/create",
      connections: "https://myaccount.google.com/connections",
    });
    expect(GOOGLE_SCOPE).toBe("https://www.googleapis.com/auth/contacts.readonly");
  });

  it("CSP lets the Connect form go on to Google's consent page and nowhere else", async () => {
    const { res } = await page();
    const csp = must(res.headers.get("content-security-policy"));
    expect(csp).toContain("form-action 'self' https://accounts.google.com;");
    expect(csp).not.toMatch(/form-action[^;]*\*/);
  });

  it("without GOOGLE_TOKEN_KEY: says so, and Connect is disabled", async () => {
    await h.setEnv({ GOOGLE_TOKEN_KEY: "" });
    const { html } = await page();
    expect(html).toContain("GOOGLE_TOKEN_KEY is not set");
    expect(html).not.toContain("Save client");
    expect(html).toMatch(/<button disabled>Connect Google<\/button>/);
    await h.setEnv({ GOOGLE_TOKEN_KEY: "not-a-key" });
    expect((await page()).html).toContain("GOOGLE_TOKEN_KEY is not valid");
  });
});

describe("POST /contacts/google/client (paste form)", () => {
  it("seals the pasted client, never echoes the secret, and enables Connect Google", async () => {
    const r = await post("/contacts/google/client", { csrf: csrfOf((await page()).html), client_id: ` ${CLIENT_ID} `, client_secret: CLIENT_SECRET });
    expect(r.status).toBe(303);
    expect(loc(r)).toBe("/contacts?google_client=saved");
    expect(await inRelay(h, (i) => i.googleClient())).toEqual({ id: CLIENT_ID, secret: CLIENT_SECRET, source: "stored" });
    expect(JSON.stringify(await sql("SELECT * FROM google_client"))).not.toContain(CLIENT_SECRET);
    const { html } = await page("?google_client=saved");
    expect(html).not.toContain(CLIENT_SECRET);
    expect(html).toContain("Google client: saved here.");
    expect(html).toContain("Google client saved");
    expect(html).not.toContain("id=gsetup");
    expect(html).not.toContain(CLIENT_SECRET);
    expect(html).toMatch(/<button>Connect Google<\/button>/);
  });

  it("refuses a malformed ID or secret with a code, and without CSRF / same Origin / on the bot host", async () => {
    const csrf = csrfOf((await page()).html);
    expect(loc(await post("/contacts/google/client", { csrf, client_id: "nope", client_secret: CLIENT_SECRET }))).toBe("/contacts?google_error=google_client_id_invalid");
    expect(loc(await post("/contacts/google/client", { csrf, client_id: CLIENT_ID, client_secret: "short" }))).toBe("/contacts?google_error=google_client_secret_invalid");
    expect((await post("/contacts/google/client", { client_id: CLIENT_ID, client_secret: CLIENT_SECRET })).status).toBe(403);
    expect((await post("/contacts/google/client", { csrf, client_id: CLIENT_ID, client_secret: CLIENT_SECRET }, { origin: "https://evil.example.test" })).status).toBe(403);
    expect((await post("/contacts/google/client", { csrf, client_id: CLIENT_ID, client_secret: CLIENT_SECRET }, { host: API, origin: API })).status).toBe(404);
    expect(await sql("SELECT * FROM google_client")).toEqual([]);
  });

  it("without GOOGLE_TOKEN_KEY nothing is stored", async () => {
    const csrf = csrfOf((await page()).html);
    await h.setEnv({ GOOGLE_TOKEN_KEY: "" });
    expect(loc(await post("/contacts/google/client", { csrf, client_id: CLIENT_ID, client_secret: CLIENT_SECRET }))).toBe("/contacts?google_error=google_token_key_missing");
    expect(await sql("SELECT * FROM google_client")).toEqual([]);
  });

  it.each([
    ["the client set as GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET secrets", false, { GOOGLE_TOKEN_KEY: "", GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: CLIENT_SECRET }],
    ["a pasted client still readable via GOOGLE_TOKEN_KEY_OLD", true, { GOOGLE_TOKEN_KEY: "", GOOGLE_TOKEN_KEY_OLD: KEY }],
  ])("Connect Google with %s but no GOOGLE_TOKEN_KEY: refused before Google (nowhere to keep the token), no sign-in started", async (_what, paste, env) => {
    let csrf = csrfOf((await page()).html);
    if (paste) await post("/contacts/google/client", { csrf, client_id: CLIENT_ID, client_secret: CLIENT_SECRET });
    await h.setEnv(env);
    csrf = csrfOf((await page()).html);
    const start = await post("/contacts/google/start", { csrf, label: "work" });
    expect(start.status).toBe(303);
    expect(loc(start)).toBe("/contacts?google_error=google_token_key_missing");
    expect(await sql("SELECT * FROM google_oauth_state")).toEqual([]);
  });
});

describe("accounts panel + Connect Google end to end", () => {
  it("paste client → Connect Google → callback → the account shows as connected with Reconnect and Disconnect", async () => {
    let csrf = csrfOf((await page()).html);
    await post("/contacts/google/client", { csrf, client_id: CLIENT_ID, client_secret: CLIENT_SECRET });
    csrf = csrfOf((await page()).html);
    const start = await post("/contacts/google/start", { csrf, label: "work" });
    const state = must(new URL(loc(start)).searchParams.get("state"));
    g.tokenReply = { status: 200, body: { access_token: "TEST-ONLY-at", refresh_token: "TEST-ONLY-rt", scope: GOOGLE_SCOPE } };
    const cb = await h.relay.fetch(`${BASE}/contacts/google/callback?state=${state}&code=TEST-ONLY-code`, { headers: { "Cf-Access-Jwt-Assertion": await h.jwt() }, redirect: "manual" });
    expect(loc(cb)).toBe("/contacts?connected=WORK");
    const { html } = await page("?connected=WORK");
    expect(html).toMatch(/<b>WORK<\/b>: Connected \S+/);
    expect(html).not.toContain("myaccount.google.com/permissions");
    expect(html).toContain('action="/contacts/google/disconnect" class=inl data-confirm="Stop syncing WORK? Its contacts are removed from the list, and Google access is revoked."');
    expect(html).toContain("Connected WORK. Press Sync now to load its contacts.");
    expect(html).toContain('<button id=sync>Sync now</button>');
    expect(html).not.toContain("TEST-ONLY-rt");
  });

  it("a GOOGLE_ACCOUNTS label backed only by a secret shows as legacy, with Reconnect and no Disconnect", async () => {
    await h.setEnv({ GOOGLE_ACCOUNTS: "primary", GOOGLE_RT_PRIMARY: "TEST-ONLY-env-rt", GOOGLE_CLIENT_ID: "TEST-ONLY-env-client", GOOGLE_CLIENT_SECRET: "TEST-ONLY-env-secret" });
    const { html } = await page();
    expect(html).toContain("<b>PRIMARY</b>: from secret GOOGLE_RT_PRIMARY (legacy)");
    expect(html).toContain('<input type=hidden name=label value="PRIMARY"><button>Reconnect</button>');
    expect(html).not.toContain("/contacts/google/disconnect");
    expect(html).toContain("from the GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET secrets");
    expect(html).not.toContain("TEST-ONLY-env-secret");
  });

  it("google_error shows its fix; anything that isn't a plain code is ignored (no reflection)", async () => {
    expect((await page("?google_error=google_scope_not_exact")).html).toContain("Google granted a different permission than read-only contacts, so it was revoked.");
    expect((await page("?google_error=google_no_refresh_token")).html).toContain("myaccount.google.com/connections");
    const evil = await page(`?google_error=${encodeURIComponent('<script>x</script>')}&connected=${encodeURIComponent("<b>")}`);
    expect(evil.html).not.toContain("<script>x");
    expect(evil.html).not.toContain("role=alert");
    expect(evil.html).not.toContain("Connected <b>");
  });

  it("the page no longer points at the consent script or GOOGLE_ACCOUNTS for setup", async () => {
    const { html } = await page();
    expect(html).not.toMatch(/google-consent|setup step google|No Google accounts configured \(GOOGLE_ACCOUNTS\)/);
    expect(html).toContain("No Google accounts yet: use Connect Google below.");
  });
});

describe("EL review fixes (deep links land in the right project; disconnect leftovers; rotation status)", () => {
  it("withProject adds ?project= / &project= to links 2-6 and drops a bad id", () => {
    expect([...GCP_PROJECT_LINKS]).toEqual(["enablePeople", "peopleLibrary", "branding", "audience", "createClient"]);
    expect(withProject(GCP_LINKS.enablePeople, "contacts-relay-123456")).toBe("https://console.cloud.google.com/flows/enableapi?apiid=people.googleapis.com&project=contacts-relay-123456");
    for (const k of ["peopleLibrary", "branding", "audience", "createClient"] as const) expect(withProject(GCP_LINKS[k], "contacts-relay-123456")).toBe(`${GCP_LINKS[k]}?project=contacts-relay-123456`);
    expect(withProject(GCP_LINKS.audience, "123456789012")).toBe(`${GCP_LINKS.audience}?project=123456789012`);
    for (const bad of ["", "X", "a b", "evil&x=1", "-bad-start"]) expect(withProject(`${GCP_LINKS.audience}?project=old-project-1`, bad)).toBe(GCP_LINKS.audience);
  });

  it("the project number comes from a Web client ID", () => {
    expect(projectNumberOf("123456789012-abc123.apps.googleusercontent.com")).toBe("123456789012");
    expect(projectNumberOf("123-testonly.apps.googleusercontent.com")).toBeNull();
    expect(projectNumberOf(null)).toBeNull();
  });

  it("with a stored client, the page still has no paste form and no console links", async () => {
    await inRelay(h, (i) => i.saveGoogleClient("424242-abc123.apps.googleusercontent.com", CLIENT_SECRET));
    const { html } = await page();
    for (const href of Object.values(GCP_LINKS)) expect(html).not.toContain(href);
    expect(html).not.toContain("name=client_secret");
    expect(html).not.toContain("Type the project ID first");
    expect(html).toContain("Google client: saved here.");
    expect(html).toMatch(/<button>Connect Google<\/button>/);
    expect(html).not.toContain(CLIENT_SECRET);
  });

  it("a disconnected GOOGLE_ACCOUNTS label: the page says to remove the legacy setting and secret", async () => {
    await h.setEnv({ GOOGLE_ACCOUNTS: "work", GOOGLE_RT_WORK: "TEST-ONLY-legacy-rt" });
    await inRelay(h, (i) => i.saveGoogleAccount("WORK", "TEST-ONLY-rt", GOOGLE_SCOPE, null));
    const r = await post("/contacts/google/disconnect", { csrf: csrfOf((await page()).html), label: "work" });
    expect(loc(r)).toContain("disconnected=WORK");
    const { html } = await page();
    expect(html).toContain("WORK was disconnected here and no longer syncs");
    expect(html).toContain("npx wrangler secret delete GOOGLE_RT_WORK");
    expect(html).not.toContain("<b>WORK</b>");
  });

  it("rotation status: counts rows on the old key, then confirms all are on the current key", async () => {
    await inRelay(h, async (i) => { await i.saveGoogleClient(CLIENT_ID, CLIENT_SECRET); await i.saveGoogleAccount("WORK", "TEST-ONLY-rt", GOOGLE_SCOPE, null); });
    await h.setEnv({ GOOGLE_TOKEN_KEY: "cd".repeat(32), GOOGLE_TOKEN_KEY_OLD: KEY });
    expect((await page()).html).toMatch(/1 of 2 stored Google sign-ins are still on the old GOOGLE_TOKEN_KEY/); // the page load re-sealed the client
    await inRelay(h, (i) => i.googleRefreshToken("WORK"));
    expect((await page()).html).toContain("All 2 stored Google sign-ins are on the current GOOGLE_TOKEN_KEY.");
  });
});

describe("GOOGLE_TOKEN_KEY error messages", () => {
  it("google_token_key_invalid has its own fix line pointing to DEPLOY.md section 14", () => {
    expect(GOOGLE_ERROR_FIX["google_token_key_invalid"]).toMatch(/GOOGLE_TOKEN_KEY is malformed/);
    expect(GOOGLE_ERROR_FIX["google_token_key_invalid"]).toMatch(/DEPLOY\.md section 14/);
    expect(googleErrorFix("google_token_key_invalid")).toBe(GOOGLE_ERROR_FIX["google_token_key_invalid"]);
  });
  it("google_token_key_missing reads the same on /contacts and in sync results", () => {
    expect(GOOGLE_ERROR_FIX["google_token_key_missing"]).toBe(TOKEN_KEY_MISSING_FIX);
    expect(SYNC_FIX["google_token_key_missing"]).toBe(TOKEN_KEY_MISSING_FIX);
    expect(syncFix("google_token_key_missing")).toBe(googleErrorFix("google_token_key_missing"));
  });
  it("the page shows the malformed-key fix for ?google_error=google_token_key_invalid", async () => {
    const html = (await page("?google_error=google_token_key_invalid")).html;
    expect(html).toContain("GOOGLE_TOKEN_KEY is malformed");
    expect(html).toContain("DEPLOY.md section 14");
    expect(html).not.toContain("Google sign-in failed. Try again.");
  });
});

describe("Google form routes refuse a body that is not a form", () => {
  const raw = async (path: string, init: { ct?: string; body?: string }) =>
    h.relay.fetch(`${BASE}${path}`, {
      method: "POST", redirect: "manual",
      headers: { "Cf-Access-Jwt-Assertion": await h.jwt(), Origin: BASE, ...(init.ct ? { "content-type": init.ct } : {}) },
      body: init.body ?? "",
    });
  it("POST /contacts/google/start with no content-type, JSON, or a broken multipart is 415 form_required, not 500", async () => {
    for (const init of [{}, { ct: "application/json", body: '{"label":"work"}' }, { ct: "multipart/form-data; boundary=x", body: "not multipart" }]) {
      const r = await raw("/contacts/google/start", init);
      expect(r.status).toBe(415);
      expect(await r.json()).toEqual({ error: "form_required" });
    }
    expect(await sql("SELECT * FROM google_oauth_state")).toEqual([]);
  });
  it("a real form still works", async () => {
    const r = await post("/contacts/google/start", { csrf: csrfOf((await page()).html), label: "work" });
    expect(r.status).toBe(303);
  });
});
