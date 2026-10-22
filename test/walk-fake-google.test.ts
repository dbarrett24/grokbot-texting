// The local walk's fake Google (tools/walk/fake-google.ts): Connect Google, the callback and Sync now run end to end
// against fake endpoints, and every Google URL is answered by the fake (the test runner's outboundService also fails any real request). Numbers are fictional. TEST-ONLY.
import { beforeEach, describe, expect, it } from "vitest";
import { BASE, harness, type Harness } from "./helpers";
import { inRelay, must } from "./google-fixture";
import { FAKE_PEOPLE, WALK_CLIENT_ID, WALK_CLIENT_SECRET, fakeGoogle, isGoogleUrl, skipConsent } from "../tools/walk/fake-google";

let h: Harness;
beforeEach(async () => {
  h = await harness();
  await h.setEnv({ GOOGLE_ACCOUNTS: "", GOOGLE_TOKEN_KEY: "ab".repeat(32), LOG_HASH_KEY: "TEST-ONLY-log-hash-key-not-a-real-secret" });
  await inRelay(h, (relay) => {
    const base = relay.net;
    relay.net = async (req: Request) => {
      if (isGoogleUrl(req.url)) return fakeGoogle(req.url, req.method);
      return base(req);
    };
  });
});
const jwt = () => h.jwt();
async function csrf(): Promise<string> {
  const html = await (await h.relay.fetch(`${BASE}/contacts`, { headers: { "Cf-Access-Jwt-Assertion": await jwt() } })).text();
  return must(html.match(/const CSRF="([a-f0-9]{32})"/)?.[1], "csrf");
}
async function form(path: string, fields: Record<string, string>) {
  return h.relay.fetch(`${BASE}${path}`, { method: "POST", redirect: "manual", headers: { "Cf-Access-Jwt-Assertion": await jwt(), Origin: BASE, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() });
}
type Person = { name: string; last4: string; source: string };
async function people(): Promise<Person[]> {
  const r = await h.relay.fetch(`${BASE}/contacts/list`, { headers: { "Cf-Access-Jwt-Assertion": await jwt() } });
  return ((await r.json()) as { people: Person[] }).people;
}

describe("walk fake Google", () => {
  it("recognises every Google host and refuses unknown Google paths with 599", () => {
    for (const u of ["https://accounts.google.com/o/oauth2/v2/auth", "https://oauth2.googleapis.com/token", "https://people.googleapis.com/v1/x"]) expect(isGoogleUrl(u)).toBe(true);
    for (const u of ["https://approve.walk.invalid/contacts", "https://evilgoogle.com/", "not a url"]) expect(isGoogleUrl(u)).toBe(false);
    expect(fakeGoogle("https://www.googleapis.com/oauth2/v3/userinfo", "GET").status).toBe(599);
  });
  it("skipConsent turns the redirect to Google's consent page into a callback with the same state; others pass through", () => {
    const r = skipConsent(new Response(null, { status: 302, headers: { location: "https://accounts.google.com/o/oauth2/v2/auth?state=abc&client_id=x" } }));
    expect(r.headers.get("location")).toBe("/contacts/google/callback?state=abc&code=WALK-ONLY-code");
    const other = new Response(null, { status: 303, headers: { location: "/contacts?x=1" } });
    expect(skipConsent(other)).toBe(other);
  });
  it("paste client -> Connect Google -> callback -> Sync now loads the fake People list", async () => {
    expect((await form("/contacts/google/client", { csrf: await csrf(), client_id: WALK_CLIENT_ID, client_secret: WALK_CLIENT_SECRET })).status).toBe(303);
    const start = skipConsent(await form("/contacts/google/start", { csrf: await csrf(), label: "walk" }));
    const back = must(start.headers.get("location"), "location");
    expect(back).toMatch(/^\/contacts\/google\/callback\?state=[a-f0-9]{64}&code=WALK-ONLY-code$/);
    const cb = await h.relay.fetch(`${BASE}${back}`, { headers: { "Cf-Access-Jwt-Assertion": await jwt() }, redirect: "manual" });
    expect(cb.headers.get("location")).toBe("/contacts?connected=WALK");
    const sync = await form("/direct/sync", { csrf: await csrf(), from: "contacts" });
    expect(sync.status).toBe(303);
    const google = (await people()).filter((p) => p.source === "WALK");
    expect(google.map((p) => p.name).sort()).toEqual(FAKE_PEOPLE.map((p) => p.names[0]?.displayName).sort());
  });
});
