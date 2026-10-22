// LOCAL WALK HARNESS ONLY (npm run walk). Never deploy this entry: it signs its own Access tokens.
// It refuses to run unless WALK_LOCAL = "1" and the Access team domain is a reserved .invalid name,
// which the generated walk.local.toml sets and a real deploy never has.
import type { Env } from "../../src/env";
export { Relay } from "../../src/relay";
import { walkAllowed } from "./guard";
import { walkForward } from "./forward";

const WALK_HOST = "approve.walk.invalid";
const KID = "walk-local";
let keys: Promise<{ priv: CryptoKey; jwk: JsonWebKey }> | undefined;
const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));

function walkKeys() {
  keys ??= (async () => {
    const kp = (await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true, ["sign", "verify"],
    )) as CryptoKeyPair;
    const jwk = (await crypto.subtle.exportKey("jwk", kp.publicKey)) as JsonWebKey;
    return { priv: kp.privateKey, jwk: { ...jwk, kid: KID } as JsonWebKey };
  })();
  return keys;
}

async function walkJwt(env: Env): Promise<string> {
  const { priv } = await walkKeys();
  const now = Math.floor(Date.now() / 1000);
  const head = enc({ alg: "RS256", kid: KID });
  const body = enc({ aud: [env.ACCESS_AUD], iss: env.ACCESS_TEAM_DOMAIN.replace(/\/$/, ""), email: env.APPROVER_EMAIL, amr: [env.REQUIRED_AMR], iat: now, exp: now + 600 });
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", priv, new TextEncoder().encode(head + "." + body)));
  return `${head}.${body}.${b64url(sig)}`;
}

let patched = false;
function patchCerts(env: Env) {
  if (patched) return;
  patched = true;
  const certs = env.ACCESS_TEAM_DOMAIN.replace(/\/$/, "") + "/cdn-cgi/access/certs";
  const real = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === certs) return Response.json({ keys: [(await walkKeys()).jwk] });
    return real(input, init);
  }) as typeof fetch;
}

export default {
  async fetch(req: Request, env: Env & { WALK_LOCAL?: string }): Promise<Response> {
    if (!walkAllowed(env)) return new Response("walk entry: local harness only", { status: 503 });
    patchCerts(env);
    const fwd = walkForward(req, await walkJwt(env), WALK_HOST); // 127.0.0.1 / localhost / [::1] all map to the approve host
    const stub = env.RELAY.get(env.RELAY.idFromName("relay"));
    return stub.fetch(fwd);
  },
} satisfies ExportedHandler<Env & { WALK_LOCAL?: string }>;
