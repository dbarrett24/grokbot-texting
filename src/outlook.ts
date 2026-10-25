// Outlook / Microsoft 365 contacts over Microsoft Graph, read-only. Mirrors src/google.ts: per-label refresh
// tokens sealed with AES-GCM under GOOGLE_TOKEN_KEY (one token key for every provider; distinct associated data),
// a web sign-in with state + PKCE, and an exact scope check. The OAuth client is the MS_CLIENT_ID and
// MS_CLIENT_SECRET Worker secrets. Pure helpers only; the Relay owns the tables. Errors are codes, never values.
import { phoneLabel, toE164, type PhoneLabel, type SnapshotContact } from "./direct";

/** What is asked for. Graph answers with the resource form ("https://graph.microsoft.com/Contacts.Read"). */
export const MS_SCOPE = "offline_access Contacts.Read";
export const MS_AUTH_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
export const MS_TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
export const MS_CONTACTS_URL = "https://graph.microsoft.com/v1.0/me/contacts";
export const MS_STATE_TTL_MS = 10 * 60_000;
export const MS_MAX_PAGES = 50;
/** contact_sources account for an Outlook label: OUTLOOK_WORK. Google labels may not start with this. */
export const MS_PREFIX = "OUTLOOK_";
export const msSource = (label: string) => `${MS_PREFIX}${label}`;

export type MsAccountRow = { label: string; rt_ct: string; rt_iv: string; scope: string; connected_ms: number; key_ver: string };

/** Associated data: an Outlook token can't be replayed as a Google one or as another label. */
export const msAad = (label: string) => new TextEncoder().encode(`sms-relay:outlook:rt:${label}`);

/** A-Z 0-9 _, 1..24 (OUTLOOK_ + label fits the 32-char source limit). */
export function isMsLabel(l: string): boolean {
  return /^[A-Z0-9_]{1,24}$/.test(l);
}
export function parseMsLabelInput(v: unknown): string {
  if (typeof v !== "string") throw new Error("outlook_label_invalid");
  const l = v.trim().toUpperCase();
  if (!isMsLabel(l)) throw new Error("outlook_label_invalid");
  return l;
}
/** MS_ACCOUNTS: comma list of labels whose refresh token is the MS_RT_<LABEL> secret (same idea as GOOGLE_ACCOUNTS). */
export function parseMsAccounts(raw: string | undefined): { valid: string[]; invalid: string[] } {
  const valid: string[] = [], invalid: string[] = [];
  for (const t of (raw ?? "").split(",").map((x) => x.trim()).filter(Boolean)) {
    const l = t.toUpperCase();
    if (isMsLabel(l)) {
      if (!valid.includes(l)) valid.push(l);
    } else invalid.push(t.replace(/[^A-Za-z0-9_]/g, "?").slice(0, 32));
  }
  return { valid, invalid };
}

export function buildMsAuthUrl(p: { clientId: string; redirectUri: string; state: string; challenge: string }): string {
  const u = new URL(MS_AUTH_URL);
  u.searchParams.set("client_id", p.clientId);
  u.searchParams.set("redirect_uri", p.redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("response_mode", "query");
  u.searchParams.set("scope", MS_SCOPE);
  u.searchParams.set("prompt", "select_account");
  u.searchParams.set("state", p.state);
  u.searchParams.set("code_challenge", p.challenge);
  u.searchParams.set("code_challenge_method", "S256");
  return u.toString();
}

/**
 * Granted scope must be Contacts.Read and nothing else, with offline_access allowed (Microsoft often leaves it
 * out of the reply; the refresh token is the proof). Bare or https://graph.microsoft.com/ form, case-insensitive.
 */
export function msScopeIsExact(granted: unknown): boolean {
  if (typeof granted !== "string") return false;
  const parts = granted.split(/\s+/).filter(Boolean).map((p) => p.toLowerCase().replace(/^https:\/\/graph\.microsoft\.com\//, ""));
  return parts.includes("contacts.read") && parts.every((p) => p === "contacts.read" || p === "offline_access");
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (o: Record<string, unknown>, k: string) => {
  const v = o[k];
  if (typeof v !== "string" || !v) throw new Error("outlook_row_invalid");
  return v;
};

export function decodeMsAccountRow(v: unknown): MsAccountRow {
  if (!isObj(v)) throw new Error("outlook_row_invalid");
  const label = str(v, "label");
  if (!isMsLabel(label)) throw new Error("outlook_row_invalid");
  const ms = v["connected_ms"];
  if (typeof ms !== "number" || !Number.isFinite(ms)) throw new Error("outlook_row_invalid");
  return { label, rt_ct: str(v, "rt_ct"), rt_iv: str(v, "rt_iv"), scope: str(v, "scope"), connected_ms: ms, key_ver: str(v, "key_ver") };
}

/** Token reply, typed. Microsoft rotates refresh tokens, so a refresh can return a new one. Never logged. */
export function decodeMsTokenReply(v: unknown): { refreshToken: string | null; accessToken: string | null; scope: unknown } {
  if (!isObj(v)) throw new Error("outlook_token_bad_json");
  const rt = v["refresh_token"], at = v["access_token"];
  return { refreshToken: typeof rt === "string" && rt ? rt : null, accessToken: typeof at === "string" && at ? at : null, scope: v["scope"] };
}

/** Graph contacts page → contact model. mobilePhone, homePhones, businessPhones; names from displayName/givenName. */
export function graphToContacts(value: unknown, cc: string | null): SnapshotContact[] {
  if (!Array.isArray(value)) throw new Error("outlook_contacts_bad_json");
  const out: SnapshotContact[] = [];
  for (const c of value) {
    if (!isObj(c)) continue;
    const dn = typeof c["displayName"] === "string" ? c["displayName"].trim() : "";
    const given = typeof c["givenName"] === "string" ? c["givenName"].trim() : "";
    const name = (dn || [given, typeof c["surname"] === "string" ? c["surname"].trim() : ""].filter(Boolean).join(" ")).slice(0, 200);
    if (!name) continue;
    const raw: [unknown, string][] = [[c["mobilePhone"], "mobile"]];
    for (const [k, l] of [["homePhones", "home"], ["businessPhones", "work"]] as const) {
      const arr = c[k];
      if (Array.isArray(arr)) for (const p of arr) raw.push([p, l]);
    }
    const numbers: { e164: string; label: PhoneLabel }[] = [];
    for (const [p, l] of raw) {
      if (typeof p !== "string" || !p.trim()) continue;
      const e164 = toE164(p, cc);
      const label = phoneLabel(l);
      if (e164 && label && !numbers.some((n) => n.e164 === e164)) numbers.push({ e164, label });
    }
    if (numbers.length) out.push({ name, ...(given ? { given } : {}), numbers });
  }
  return out;
}

/** Only Graph's own https host may be followed for @odata.nextLink. */
export function safeNextLink(v: unknown): string | null {
  if (typeof v !== "string" || !v) return null;
  const u = new URL(v);
  if (u.protocol !== "https:" || u.hostname !== "graph.microsoft.com" || u.username || u.password) throw new Error("outlook_foreign_next_link");
  return u.toString();
}
