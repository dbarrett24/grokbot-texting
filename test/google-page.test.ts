// google-connect PR 3: the Google panel on /contacts: Set up Google checklist (deep links), paste form, one Connect Google button.
import { beforeEach, describe, expect, it } from "vitest";
import { API, BASE, harness, type Harness } from "./helpers";
import { fakeGoogle, inRelay, must, sql as sqlOf, type FakeGoogle } from "./google-fixture";
import { GCP_LINKS } from "../src/contacts";
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
  it("lists every deep link (new tab, no referrer), the exact redirect URI, and opens itself when no client is set", async () => {
    const { html } = await page();
    for (const url of Object.values(GCP_LINKS)) expect(html).toContain(`href="${url}" target=_blank rel="noopener noreferrer"`);
    expect(html).toContain('<code id=gredir>https://approve.example.test/contacts/google/callback</code>');
    expect(html).toMatch(/<details id=gsetup open>/);
    for (const k of ["enablePeople", "peopleLibrary", "branding", "audience", "createClient"] as const) expect(html).toContain(`href="${GCP_LINKS[k]}" target=_blank rel="noopener noreferrer" data-gproj`);
    for (const k of ["createProject", "permissions"] as const) expect(html).not.toContain(`href="${GCP_LINKS[k]}" target=_blank rel="noopener noreferrer" data-gproj`);
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
      permissions: "https://myaccount.google.com/permissions",
    });
    expect(GOOGLE_SCOPE).toBe("https://www.googleapis.com/auth/contacts.readonly");
  });

  it("CSP lets the Connect form go on to Google's consent page and nowhere else", async () => {
    const { res } = await page();
    const csp = must(res.headers.get("content-security-policy"));
    expect(csp).toContain("form-action 'self' https://accounts.google.com;");
    expect(csp).not.toMatch(/form-action[^;]*\*/);
  });

  it("without GOOGLE_TOKEN_KEY: says so, and Save client / Connect are disabled", async () => {
    await h.setEnv({ GOOGLE_TOKEN_KEY: "" });
    const { html } = await page();
    expect(html).toContain("GOOGLE_TOKEN_KEY is not set");
    expect(html).toMatch(/<button disabled>Save client<\/button>/);
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
    expect(html).toMatch(/<details id=gsetup>/); // closed once a client exists
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
    expect(html).toContain("<b>WORK</b>: connected here");
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
    expect((await page("?google_error=google_no_refresh_token")).html).toContain("myaccount.google.com/permissions");
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
