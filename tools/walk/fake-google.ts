// LOCAL WALK HARNESS ONLY. A fake Google for `npm run walk`: OAuth consent, token, revoke and the People API,
// all answered in-process with fake data. Nothing ever reaches a real Google host: any other Google URL is refused.
// Numbers: UK Ofcom drama range (+44 7700 900xxx, reserved for fiction) plus one 555-01xx example.
import { GOOGLE_AUTH_URL, GOOGLE_SCOPE } from "../../src/google";

export const WALK_CODE = "WALK-ONLY-code";
export const WALK_CLIENT_ID = "123-walkonly.apps.googleusercontent.com";
export const WALK_CLIENT_SECRET = "WALK-ONLY-client-secret";

/** What the fake People API returns for every connected account. */
export const FAKE_PEOPLE = [
  { names: [{ displayName: "Google Jordan", givenName: "Jordan" }], phoneNumbers: [{ value: "+447700900201", canonicalForm: "+447700900201", type: "mobile" }] },
  { names: [{ displayName: "Google Casey", givenName: "Casey" }], phoneNumbers: [{ value: "+447700900202", canonicalForm: "+447700900202", type: "work" }] },
  { names: [{ displayName: "Google Example" }], phoneNumbers: [{ value: "+15555550105", canonicalForm: "+15555550105", type: "home" }] },
];

const GOOGLE_HOST = /(^|\.)(google\.com|googleapis\.com|googleusercontent\.com)$/;

/** Is this a Google URL? Every one of them is answered by fakeGoogle, never by the network. */
export function isGoogleUrl(url: string): boolean {
  try { return GOOGLE_HOST.test(new URL(url).hostname); } catch { return false; }
}

/** Answer a Google request with fake data. Unknown Google paths get 599 so a new call shows up loudly. */
export function fakeGoogle(url: string, method: string): Response {
  const u = new URL(url);
  if (u.host === "oauth2.googleapis.com" && u.pathname === "/token" && method === "POST")
    return Response.json({ access_token: "WALK-ONLY-access", refresh_token: "WALK-ONLY-refresh", scope: GOOGLE_SCOPE, token_type: "Bearer", expires_in: 3600 });
  if (u.host === "oauth2.googleapis.com" && u.pathname === "/revoke" && method === "POST") return new Response("", { status: 200 });
  if (u.host === "people.googleapis.com" && u.pathname === "/v1/people/me/connections" && method === "GET") return Response.json({ connections: FAKE_PEOPLE });
  return new Response("walk: fake Google has no such endpoint; real Google is never called", { status: 599 });
}

/**
 * The Worker sends the browser to Google's consent page. In the walk, skip it: send the browser straight back
 * to the callback with the same state and a fake code, as if the owner had pressed Allow. Other responses pass through.
 */
export function skipConsent(res: Response): Response {
  const loc = res.headers.get("location");
  if (!loc || !loc.startsWith(GOOGLE_AUTH_URL)) return res;
  const state = new URL(loc).searchParams.get("state") ?? "";
  const back = `/contacts/google/callback?${new URLSearchParams({ state, code: WALK_CODE }).toString()}`;
  return new Response(null, { status: 302, headers: { location: back, "cache-control": "no-store" } });
}
