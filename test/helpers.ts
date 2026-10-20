import { env as rawEnv, runInDurableObject } from "cloudflare:test";
import type { Env } from "../src/env";
const env = rawEnv as unknown as Env;
import type { Relay } from "../src/relay";
import { scan } from "./phone-scan";
import { b64, bigToBytes, fingerprint, mgf1Sha1, modpow, unb64 } from "../src/e2e";

export const FRIEND = "+15555550101";
export const TWO = "+15555550102";
export const OWNER = "+15555550100";
export const STRANGER = "+15555550199";
export const T0 = Date.parse("2026-10-16T18:00:00-06:00"); // 6 PM MT, day 15 after CAP_START_DATE → cap 10
export const T_EARLY = Date.parse("2026-10-05T12:00:00-06:00"); // day 4 → cap 5

const b64url = (u: Uint8Array) => b64(u).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const big = (u: Uint8Array) => BigInt("0x" + [...u].map((x) => x.toString(16).padStart(2, "0")).join(""));
const jwkBytes = (s: string) => unb64(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));

export interface Harness {
  relay: DurableObjectStub;
  calls: { url: string; method: string; body: string; auth: string | null }[];
  setNow(ms: number): void;
  setEnv(patch: Record<string, string>): Promise<void>;
  jwt(over?: Record<string, unknown>): Promise<string>;
  gatewayFails: { value: boolean };
  /** What GET /devices returns. Default: device with the pinned test key. */
  device: { value: Record<string, unknown> };
  spkiB64: string;
  decryptPassphrase(field: string, passphrase: string): Promise<string>;
  decrypt(field: string): Promise<string>;
  messagesPosted(): any[];
}

let baseEnv: Record<string, unknown> | undefined;
let keys: { dev: CryptoKeyPair; sig: CryptoKeyPair; spkiB64: string; fp: string; devJwk: JsonWebKey; sigJwk: JsonWebKey } | null = null;

async function keysOnce() {
  if (keys) return keys;
  // Ephemeral keys generated in memory per test run; never written anywhere.
  const dev = (await crypto.subtle.generateKey({ name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["encrypt", "decrypt"])) as CryptoKeyPair;
  const sig = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const spkiB64 = b64(new Uint8Array((await crypto.subtle.exportKey("spki", dev.publicKey)) as ArrayBuffer));
  keys = {
    dev, sig, spkiB64, fp: await fingerprint(spkiB64),
    devJwk: (await crypto.subtle.exportKey("jwk", dev.privateKey)) as JsonWebKey,
    sigJwk: (await crypto.subtle.exportKey("jwk", sig.publicKey)) as JsonWebKey,
  };
  return keys;
}

export async function harness(): Promise<Harness> {
  const k = await keysOnce();
  const relay = env.RELAY.get(env.RELAY.idFromName("test-" + crypto.randomUUID())) // fresh storage per test;
  const calls: Harness["calls"] = [];
  const gatewayFails = { value: false };
  const device = { value: { id: "test-device", name: "phone", publicKey: k.spkiB64, keyVersion: 1 } as Record<string, unknown> };
  let now = T0;
  const net = async (req: Request) => {
    const body = req.method === "GET" ? "" : await req.text();
    calls.push({ url: req.url, method: req.method, body, auth: req.headers.get("Authorization") });
    const u = new URL(req.url);
    if (u.host === "test-team.cloudflareaccess.com" && u.pathname === "/cdn-cgi/access/certs")
      return Response.json({ keys: [{ ...k.sigJwk, kid: "test-kid", alg: "RS256" }] });
    if (u.host === "api.sms-gate.app" && u.pathname === "/3rdparty/v1/devices")
      return Response.json([device.value]);
    if (u.host === "api.sms-gate.app" && u.pathname === "/3rdparty/v1/messages")
      return gatewayFails.value ? new Response("down", { status: 500 }) : Response.json({ id: "gw-" + calls.length });
    return new Response("unexpected host in test", { status: 599 });
  };
  // Record every response body for the suite-wide phone-number scan (test/phone-scan.ts).
  scan.stubs.push(relay);
  const realFetch = relay.fetch.bind(relay);
  (relay as any).fetch = async (...a: Parameters<typeof realFetch>) => {
    const r = await realFetch(...a);
    scan.responses.push(await r.clone().text());
    return r;
  };
  await runInDurableObject(relay, async (inst: Relay) => {
    inst.net = net;
    inst.clock = () => now;
    // The DO instance can outlive a test, so always rebuild env from the pristine copy.
    baseEnv ??= { ...(inst as any).env };
    (inst as any).env = { ...baseEnv, GATEWAY_PINNED_FINGERPRINT: k.fp };
  });
  return {
    relay,
    calls,
    gatewayFails,
    device,
    spkiB64: k.spkiB64,
    async decryptPassphrase(field, passphrase) {
      const [empty, alg, it, salt, ct] = field.split("$");
      if (empty !== "" || alg !== "aes-256-cbc/pbkdf2-sha1" || !it.startsWith("i=")) throw new Error("format");
      const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]);
      const key = await crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-1", salt: unb64(salt), iterations: Number(it.slice(2)) }, base, { name: "AES-CBC", length: 256 }, false, ["decrypt"]);
      return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-CBC", iv: unb64(salt) }, key, unb64(ct)));
    },
    setNow: (ms) => { now = ms; },
    async setEnv(patch) {
      await runInDurableObject(relay, async (inst: Relay) => { (inst as any).env = { ...(inst as any).env, ...patch }; });
    },
    async jwt(over = {}) {
      const header = b64url(new TextEncoder().encode(JSON.stringify({ alg: "RS256", kid: "test-kid" })));
      const payload = b64url(new TextEncoder().encode(JSON.stringify({
        aud: ["TEST-ONLY-aud"], iss: "https://test-team.cloudflareaccess.com", email: "approver@example.test",
        amr: ["test-passkey-amr"], exp: Math.floor(now / 1000) + 600, iat: Math.floor(now / 1000), ...over,
      })));
      const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", k.sig.privateKey, new TextEncoder().encode(header + "." + payload)));
      return `${header}.${payload}.${b64url(sig)}`;
    },
    // Test-side decrypt of the SMSGate field format, to prove the E2E encoding round-trips.
    async decrypt(field) {
      const [, , , kv, wrapped, iv, ct] = field.split("$");
      if (kv !== "k=1") throw new Error("key version");
      const n = big(jwkBytes(k.devJwk.n!)), d = big(jwkBytes(k.devJwk.d!));
      const kLen = 256;
      const em = bigToBytes(modpow(big(unb64(wrapped)), d, n), kLen);
      const maskedSeed = em.subarray(1, 33), maskedDb = em.subarray(33);
      const seedMask = await mgf1Sha1(maskedDb, 32);
      const seed = maskedSeed.map((x, i) => x ^ seedMask[i]);
      const dbMask = await mgf1Sha1(seed, maskedDb.length);
      const db = maskedDb.map((x, i) => x ^ dbMask[i]);
      const one = db.indexOf(1, 32);
      const aesRaw = db.subarray(one + 1);
      const key = await crypto.subtle.importKey("raw", aesRaw, "AES-GCM", false, ["decrypt"]);
      const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, key, unb64(ct));
      return new TextDecoder().decode(pt);
    },
    messagesPosted() {
      return calls.filter((c) => c.url.endsWith("/messages")).map((c) => JSON.parse(c.body));
    },
  };
}

export const API = "https://api.example.test";
export const BASE = "https://approve.example.test";

export function postRequest(h: Harness, body: unknown, token = "TEST-ONLY-request-token") {
  return h.relay.fetch(`${API}/request`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function approve(h: Harness, id: string, action = "approve", opts: { jwt?: string; csrf?: string; origin?: string; auth?: string } = {}) {
  const jwt = opts.jwt ?? (await h.jwt());
  let csrf = opts.csrf;
  if (csrf === undefined) {
    const page = await h.relay.fetch(`${BASE}/approve/${id}`, { headers: { "Cf-Access-Jwt-Assertion": jwt } });
    csrf = (await page.text()).match(/name=csrf value="([a-f0-9]+)"/)?.[1] ?? "";
  }
  const headers: Record<string, string> = { "Cf-Access-Jwt-Assertion": jwt, Origin: opts.origin ?? BASE, "content-type": "application/x-www-form-urlencoded" };
  if (opts.auth) headers.Authorization = opts.auth;
  return h.relay.fetch(`${BASE}/approve/${id}`, { method: "POST", headers, body: new URLSearchParams({ csrf, action }).toString() });
}

// ---- refusal-proof helpers: read the relay's own state, so a 403 can't come from the wrong check ----
const runInLoose = runInDurableObject as unknown as (s: unknown, f: (i: any) => Promise<any>) => Promise<any>;

/** The request's real CSRF value, read straight from Durable Object storage (no Access check involved). */
export function csrfOf(h: Harness, id: string): Promise<string> {
  return runInLoose(h.relay, async (inst) => inst.ctx.storage.sql.exec("SELECT csrf FROM requests WHERE id=?", id).one().csrf as string);
}

/** Detail of the newest access_denied log row, or null. */
export function lastAccessReason(h: Harness): Promise<string | null> {
  return runInLoose(h.relay, async (inst) => {
    const rows = inst.ctx.storage.sql.exec("SELECT detail FROM log WHERE event='access_denied' ORDER BY seq DESC LIMIT 1").toArray();
    return rows.length ? (rows[0].detail as string) : null;
  });
}

/** Change one character in the middle of the signature. Always differs from the input. */
export function tamperSig(jwt: string): string {
  const p = jwt.split(".");
  const m = Math.floor(p[2].length / 2);
  p[2] = p[2].slice(0, m) + (p[2][m] === "A" ? "B" : "A") + p[2].slice(m + 1);
  return p.join(".");
}

/**
 * Contacts start OFF (Contacts page). Tests written for "everyone loaded is sendable" switch everyone on
 * through storage, the way the owner would on the page. The page's own guards are tested in contacts-page.test.ts.
 */
export async function enableAll(h: Harness): Promise<void> {
  // Loading the list runs the relay's own hash pass, which creates the (OFF) pref rows. 503 without a hash key: nothing to enable.
  await h.relay.fetch(`${BASE}/contacts/list`, { headers: { "Cf-Access-Jwt-Assertion": await h.jwt() } });
  await runInDurableObject(h.relay, (_inst: Relay, state: DurableObjectState) => {
    state.storage.sql.exec("UPDATE contact_prefs SET enabled=1");
  });
}
