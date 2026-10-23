// Google connection storage: per-label refresh tokens, AES-GCM 256 encrypted at rest in the Relay
// Durable Object's SQLite under the GOOGLE_TOKEN_KEY secret. The OAuth client is the GOOGLE_CLIENT_ID
// and GOOGLE_CLIENT_SECRET Worker secrets (scripts/google-client.mjs), not a row in this database.
// Pure helpers only; the Relay owns the tables. Errors are codes, never key, token or secret values.
import { hex, unb64 } from "./e2e";

/** The one OAuth scope this template ever asks for or accepts. */
export const GOOGLE_SCOPE = "https://www.googleapis.com/auth/contacts.readonly";

export type TokenKey = { kid: string; key: CryptoKey };
export type Sealed = { ct: string; iv: string; kid: string };
export type GoogleClient = { id: string; secret: string; source: "secrets" };
export type GoogleAccountRow = { label: string; email: string | null; rt_ct: string; rt_iv: string; scope: string; connected_ms: number; key_ver: string };

const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));

/**
 * GOOGLE_TOKEN_KEY: 32 random bytes as 64 hex chars or base64 (setup step keys makes base64).
 * Unset/empty = null (in-app storage off; the GOOGLE_* secrets still work). Anything else = google_token_key_invalid.
 */
export function parseTokenKeyBytes(raw: string | undefined): Uint8Array | null {
  if (raw === undefined || raw.trim() === "") return null;
  const t = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(t)) return Uint8Array.from({ length: 32 }, (_, i) => parseInt(t.slice(i * 2, i * 2 + 2), 16));
  if (/^[A-Za-z0-9+/]{43}=$/.test(t)) {
    const b = unb64(t);
    if (b.length === 32) return b;
  }
  throw new Error("google_token_key_invalid");
}

/** Import a key; kid = first 16 hex of SHA-256(key bytes), stored per row so rotation knows which key sealed it. */
export async function importTokenKey(raw: string | undefined): Promise<TokenKey | null> {
  const bytes = parseTokenKeyBytes(raw);
  if (!bytes) return null;
  const kid = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))).slice(0, 16);
  const key = await crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  return { kid, key };
}

/** Associated data binds a ciphertext to its row: a token sealed for "work" can't be replayed as "primary". */
export const aadFor = (kind: "rt" | "client", label: string) => new TextEncoder().encode(`sms-relay:google:${kind}:${label}`);

/** AES-GCM 256, fresh random 12-byte IV per write. */
export async function seal(k: TokenKey, plaintext: string, aad: Uint8Array): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad }, k.key, new TextEncoder().encode(plaintext)));
  return { ct: b64(ct), iv: b64(iv), kid: k.kid };
}

/** Decrypt with whichever key's kid matches (current, then GOOGLE_TOKEN_KEY_OLD). Tampering or a wrong key = google_token_decrypt_failed. */
export async function open(keys: (TokenKey | null)[], s: Sealed, aad: Uint8Array): Promise<{ plaintext: string; kid: string }> {
  const k = keys.find((x) => x && x.kid === s.kid);
  if (!k) throw new Error("google_token_key_missing");
  let iv: Uint8Array, ct: Uint8Array;
  try {
    iv = unb64(s.iv);
    ct = unb64(s.ct);
  } catch {
    throw new Error("google_token_decrypt_failed");
  }
  try {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: aad }, k.key, ct);
    return { plaintext: new TextDecoder().decode(pt), kid: k.kid };
  } catch {
    throw new Error("google_token_decrypt_failed");
  }
}

// ---- typed decoders: SQLite rows and stored JSON are checked, never cast ----
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (o: Record<string, unknown>, k: string) => {
  const v = o[k];
  if (typeof v !== "string" || !v) throw new Error("google_row_invalid");
  return v;
};
const num = (o: Record<string, unknown>, k: string) => {
  const v = o[k];
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error("google_row_invalid");
  return v;
};

export function decodeAccountRow(v: unknown): GoogleAccountRow {
  if (!isObj(v)) throw new Error("google_row_invalid");
  const email = v["email"];
  if (email !== null && typeof email !== "string") throw new Error("google_row_invalid");
  const label = str(v, "label");
  if (!isLabel(label)) throw new Error("google_row_invalid");
  return { label, email, rt_ct: str(v, "rt_ct"), rt_iv: str(v, "rt_iv"), scope: str(v, "scope"), connected_ms: num(v, "connected_ms"), key_ver: str(v, "key_ver") };
}

/** Same rule as GOOGLE_ACCOUNTS labels (src/direct.ts parseAccounts): A-Z 0-9 _, 1..32, not UPLOAD. */
export function isLabel(l: string): boolean {
  return /^[A-Z0-9_]{1,32}$/.test(l) && l !== "UPLOAD" && l !== "ALLOWLIST_LEGACY";
}

// ---- google-connect PR 2: web sign-in (start/callback), state + PKCE, exact scope, revoke ----
export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
export const GOOGLE_STATE_TTL_MS = 10 * 60_000;

const b64url = (u: Uint8Array) => b64(u).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** PKCE S256: 32 random bytes as the verifier (43 chars), SHA-256 of it as the challenge. */
export async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  return { verifier, challenge };
}

/** Same parameters as scripts/google-consent.mjs, with a web redirect instead of the loopback port. */
export function buildAuthUrl(p: { clientId: string; redirectUri: string; state: string; challenge: string }): string {
  const u = new URL(GOOGLE_AUTH_URL);
  u.searchParams.set("client_id", p.clientId);
  u.searchParams.set("redirect_uri", p.redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", GOOGLE_SCOPE);
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "consent select_account");
  u.searchParams.set("state", p.state);
  u.searchParams.set("code_challenge", p.challenge);
  u.searchParams.set("code_challenge_method", "S256");
  return u.toString();
}

/** The granted scope must be exactly contacts.readonly: nothing more, nothing less. */
export function scopeIsExact(granted: unknown): boolean {
  if (typeof granted !== "string") return false;
  const parts = granted.split(/\s+/).filter(Boolean);
  return parts.length === 1 && parts[0] === GOOGLE_SCOPE;
}

/** Token endpoint reply, typed. Values are never logged. */
export function decodeTokenReply(v: unknown): { refreshToken: string | null; accessToken: string | null; scope: unknown } {
  if (!isObj(v)) throw new Error("google_token_bad_json");
  const rt = v["refresh_token"], at = v["access_token"];
  return { refreshToken: typeof rt === "string" && rt ? rt : null, accessToken: typeof at === "string" && at ? at : null, scope: v["scope"] };
}

/** Label typed on the page ("work") → stored label ("WORK"). */
export function parseLabelInput(v: unknown): string {
  if (typeof v !== "string") throw new Error("google_label_invalid");
  const l = v.trim().toUpperCase();
  if (!isLabel(l)) throw new Error("google_label_invalid");
  return l;
}
