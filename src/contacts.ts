// Contacts page (APPROVE_HOST /contacts*): pure helpers and the page itself. Owner-only by construction:
// every write takes an `Owner`, and only Relay.requireOwner (Access JWT verified) can make one.
import type { SignInMethod } from "./access";
import { contactsLiveScript } from "./contacts-live";
import { HARBOR_CSS, pickerLiveScript } from "./harbor";
import { renderHeader, renderNav } from "./pages";
import { Refuse } from "./rules";

declare const OWNER_BRAND: unique symbol;
/** Proof that Access verified the owner for this request. Not constructible outside requireOwner (type-level). */
export type Owner = { readonly email: string; readonly method: SignInMethod; readonly [OWNER_BRAND]: true };
/** The only place an Owner is minted. Call it with verifyAccess's result and nothing else. */
export function ownerFromAccess(v: { email: string; method: SignInMethod }): Owner {
  return v as Owner;
}

/** Every path the contacts feature owns. On REQUEST_HOST all of these answer 404. */
export function isContactsPath(path: string): boolean {
  return path === "/contacts" || path.startsWith("/contacts/");
}

export const LEGACY_SOURCE = "ALLOWLIST_LEGACY";
export const PREFS_MAX_CHANGES = 500;
export const ENABLE_ALL_MAX = 5000;
export const CSRF_TTL_MS = 15 * 60_000;
export const GONE_KEEP_MS = 30 * 86_400_000;

/**
 * Documentation-example numbers: North American 555-0100..0199 (reserved for fiction) and 555 + "1234".
 * The page refuses to switch these on, so a pasted example can never become a recipient.
 */
export function isExampleNumber(e164: string): boolean {
  return /^\+1\d{3}555(?:01\d\d|1234)$/.test(e164);
}

export const last4 = (e164: string) => e164.slice(-4);

const KEY_RE = /^[a-f0-9]{64}$/;
export type PrefChange = { key: string; enabled?: boolean; starred?: boolean };

/** {csrf, changes:[{key, enabled?, starred?}]}: strict shape, max 500 changes. */
export function parsePrefsBody(b: Record<string, unknown>): PrefChange[] {
  if (Object.keys(b).some((k) => k !== "csrf" && k !== "changes")) throw new Refuse("unknown_fields");
  const ch = b["changes"];
  if (!Array.isArray(ch) || ch.length === 0 || ch.length > PREFS_MAX_CHANGES) throw new Refuse("changes_invalid");
  return ch.map((c) => {
    if (!c || typeof c !== "object" || Array.isArray(c)) throw new Refuse("changes_invalid");
    const o = c as Record<string, unknown>;
    if (Object.keys(o).some((k) => k !== "key" && k !== "enabled" && k !== "starred")) throw new Refuse("unknown_fields");
    if (typeof o["key"] !== "string" || !KEY_RE.test(o["key"])) throw new Refuse("key_invalid");
    if ("enabled" in o && typeof o["enabled"] !== "boolean") throw new Refuse("enabled_invalid");
    if ("starred" in o && typeof o["starred"] !== "boolean") throw new Refuse("starred_invalid");
    if (!("enabled" in o) && !("starred" in o)) throw new Refuse("changes_invalid");
    return { key: o["key"], ...("enabled" in o ? { enabled: o["enabled"] as boolean } : {}), ...("starred" in o ? { starred: o["starred"] as boolean } : {}) };
  });
}

/** {csrf, keys:[…], confirm_count}: keys deduped; the count must equal what the owner confirmed. */
export function parseEnableAllBody(b: Record<string, unknown>): { keys: string[]; confirm: number } {
  if (Object.keys(b).some((k) => k !== "csrf" && k !== "keys" && k !== "confirm_count")) throw new Refuse("unknown_fields");
  if (!Array.isArray(b["keys"]) || b["keys"].length === 0 || b["keys"].length > ENABLE_ALL_MAX || b["keys"].some((k) => typeof k !== "string" || !KEY_RE.test(k))) throw new Refuse("keys_invalid");
  if (typeof b["confirm_count"] !== "number" || !Number.isInteger(b["confirm_count"])) throw new Refuse("confirm_count_invalid");
  return { keys: [...new Set(b["keys"] as string[])], confirm: b["confirm_count"] };
}

/** One fix line for google_token_key_missing, shared by the sync table and the /contacts google_error table. */
export const TOKEN_KEY_MISSING_FIX = "GOOGLE_TOKEN_KEY is missing or doesn't match: run setup step keys, then secrets (DEPLOY.md section 14 for rotation).";

/** Sync error code → the DEPLOY.md fix text (section 9 table). */
export const SYNC_FIX: Record<string, string> = {
  google_client_not_configured: "No Google client yet: run node scripts/google-client.mjs (README), then press Connect Google.",
  google_token_key_missing: TOKEN_KEY_MISSING_FIX,
  google_token_decrypt_failed: "The stored Google token can't be read: press Reconnect for that account.",
  default_country_code_invalid: "Set DEFAULT_COUNTRY_CODE (DEPLOY.md section 5) and deploy.",
  google_people_status_403: "People API not enabled: DEPLOY.md section 9 step 2.",
  google_token_status_400: "Google access expired or was revoked. Make sure the app is published (Audience), then press Reconnect.",
  empty_result: "That account has no contacts with a phone number.",
};
export function syncFix(code: string): string {
  if (code.startsWith("missing_secret_GOOGLE_RT_")) return "That account isn't connected: press Connect Google (or Reconnect) for it below.";
  return SYNC_FIX[code] ?? "See DEPLOY.md section 9 troubleshooting.";
}

/**
 * Google Cloud console deep links for the Set up Google checklist. These URL patterns come from a third-party guide
 * and live testing, not from Google's documentation (google-connect-design.md "Deep links"). Only the project can be
 * prefilled by URL; the page fills in ?project= once the owner types the project ID.
 */
export const GCP_LINKS = {
  createProject: "https://console.cloud.google.com/projectcreate",
  enablePeople: "https://console.cloud.google.com/flows/enableapi?apiid=people.googleapis.com",
  peopleLibrary: "https://console.cloud.google.com/apis/library/people.googleapis.com",
  branding: "https://console.cloud.google.com/auth/overview/create",
  audience: "https://console.cloud.google.com/auth/audience",
  createClient: "https://console.cloud.google.com/auth/clients/create",
  connections: "https://myaccount.google.com/connections",
} as const;
/** Links that take ?project=<id>. */
export const GCP_PROJECT_LINKS: readonly (keyof typeof GCP_LINKS)[] = ["enablePeople", "peopleLibrary", "branding", "audience", "createClient"];

/** google_error=<code> on /contacts → what to do. Unknown codes get the generic line. */
export const GOOGLE_ERROR_FIX: Record<string, string> = {
  google_label_invalid: "Use letters, digits or _ for the account name (up to 32), e.g. work.",
  google_client_not_configured: "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET with node scripts/google-client.mjs (README).",
  google_token_key_missing: TOKEN_KEY_MISSING_FIX,
  google_token_key_invalid: "GOOGLE_TOKEN_KEY is malformed (it must be 32 bytes, as hex or base64): make a new one with setup step keys, then secrets (DEPLOY.md section 14).",
  google_consent_denied: "Google sign-in was cancelled.",
  google_state_invalid: "That sign-in link was already used or isn't ours. Press Connect Google again.",
  google_state_expired: "The sign-in took longer than 10 minutes. Press Connect Google again.",
  google_state_wrong_identity: "Signed in to this page as someone else. Press Connect Google again.",
  google_scope_not_exact: "Google granted a different permission than read-only contacts, so it was revoked. Tick only the contacts box and try again.",
  google_no_refresh_token: "Google sent no long-lived token. Remove the app at myaccount.google.com/connections, then Connect again.",
  google_not_connected: "That account isn't connected here.",
};
export const googleErrorFix = (code: string) => GOOGLE_ERROR_FIX[code] ?? (code.startsWith("google_token_status_") ? "Google refused the sign-in code. Check the redirect URI on the client, then try again." : "Google sign-in failed. Try again.");

/** Project ID (or number) the console accepts in ?project=. */
export const isProjectRef = (id: string) => /^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(id) || /^[0-9]{6,20}$/.test(id);
/**
 * Add ?project=<id> (or &project=) to a console link. Runs on the server and, as source, in the page script,
 * so the typed ID and the server-known one follow the same rule. An invalid id removes the param.
 */
export function withProject(href: string, id: string): string {
  const u = new URL(href);
  if (/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(id) || /^[0-9]{6,20}$/.test(id)) u.searchParams.set("project", id);
  else u.searchParams.delete("project");
  return u.toString();
}
export interface GooglePanel {
  tokenKey: "ok" | "missing" | "invalid";
  client: "secrets" | null;
  redirectUri: string;
  accounts: { label: string; stored: boolean; fromSeed: boolean; connected: string | null }[];
  /** Disconnected here but still in GOOGLE_ACCOUNTS (and maybe a GOOGLE_RT_ secret): tell the owner to remove them. */
  leftovers: string[];
  /** Stored rows still sealed under GOOGLE_TOKEN_KEY_OLD (rotation). */
  keyStatus: { total: number; onOld: number };
}

export interface MsPanel {
  tokenKey: "ok" | "missing" | "invalid";
  client: boolean;
  redirectUri: string;
  accounts: { label: string; stored: boolean; fromSeed: boolean; connected: string | null }[];
}

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ESC[c] ?? c);

export interface PageModel {
  /** Harbor leaf layer markup (inline SVG) or "". */
  leaves?: string;
  csrf: string;
  nonce: string;
  migratedOn: number;
  lastError: { code: string; when: string } | null;
  canSync: boolean;
  toast: string | null;
  hashKeyMissing: boolean;
  google: GooglePanel;
  /** Error line from ?google_error= (already a code; the fix text is looked up here). */
  googleError: string | null;
  outlook?: MsPanel;
  /** Error line from ?outlook_error= (a code). */
  outlookError?: string | null;
  /** When the last successful contacts_sync finished (fmtTime), or null if none has. */
  lastSync: string | null;
}

/** "Google accounts" panel: lives in the sync disclosure. Quiet text actions, one bordered Connect button. The client id and secret are not on this page. */
export function renderGooglePanel(g: GooglePanel, csrf: string, googleError: string | null): string {
  const canConnect = g.tokenKey === "ok" && g.client !== null;
  const rows = g.accounts.map((x) => `<li><b>${esc(x.label)}</b><span class=when>${x.stored ? `Connected${x.connected ? " " + esc(x.connected) : ""}` : x.fromSeed ? "from secret GOOGLE_RT_" + esc(x.label) + " (legacy)" : "not connected"}</span>
<form method=post action="/contacts/google/start" class=inl><input type=hidden name=csrf value="${csrf}"><input type=hidden name=label value="${esc(x.label)}"><button class=link aria-label="Reconnect ${esc(x.label)}"${canConnect ? "" : " disabled"}>Reconnect</button></form>${x.stored ? `<form method=post action="/contacts/google/disconnect" class=inl data-confirm="Stop syncing ${esc(x.label)}? Its contacts are removed from the list, and Google access is revoked."><input type=hidden name=csrf value="${csrf}"><input type=hidden name=label value="${esc(x.label)}"><button class="link danger" aria-label="Disconnect ${esc(x.label)}">Disconnect</button></form>` : ""}</li>`).join("");
  const keyWarn = g.tokenKey === "ok" ? "" : `<p class=warn>GOOGLE_TOKEN_KEY is ${g.tokenKey === "missing" ? "not set" : "not valid"}, so Google sign-in can't store anything. Run setup step <code>keys</code>, then <code>secrets</code>.</p>`;
  const clientLine = g.client === "secrets" ? "Google client: from the GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET secrets." : "Google client: not set up yet. Run <code>node scripts/google-client.mjs --file=client.json --config=.relay-local/wrangler.toml</code> (README).";
  return `<section id=google aria-label="Google accounts">
${googleError ? `<p class=warn role=alert>Google: <code>${esc(googleError)}</code>. ${esc(googleErrorFix(googleError))}</p>` : ""}${keyWarn}
${g.leftovers.map((l) => `<p class=warn>${esc(l)} was disconnected here and no longer syncs, but it is still set up the old way. Remove it from <code>GOOGLE_ACCOUNTS</code> in wrangler.toml, deploy, and run <code>npx wrangler secret delete GOOGLE_RT_${esc(l)}</code>.</p>`).join("")}
${g.keyStatus.onOld > 0 ? `<p class=warn id=gkeys>${g.keyStatus.onOld} of ${g.keyStatus.total} stored Google sign-ins are still on the old GOOGLE_TOKEN_KEY. Press Sync now (and reload this page); keep GOOGLE_TOKEN_KEY_OLD until this reads 0.</p>` : g.keyStatus.total ? `<p class=ro id=gkeys>All ${g.keyStatus.total} stored Google sign-ins are on the current GOOGLE_TOKEN_KEY.</p>` : ""}
<ul id=gaccts>${rows || "<li>No Google accounts yet.</li>"}</ul>
<form method=post action="/contacts/google/start" class=bar id=gconnect><input type=hidden name=csrf value="${csrf}"><label for=glabel>Add account</label><input type=text id=glabel name=label required maxlength=32 pattern="[A-Za-z0-9_]+" placeholder="work" autocomplete=off><button${canConnect ? "" : " disabled"}>Connect Google</button></form>
<p class=ro>${clientLine}</p>
</section>`;
}

/** "Outlook accounts" panel (Microsoft Graph, Contacts.Read). Same layout as the Google panel. */
export function renderMsPanel(o: MsPanel, csrf: string, err: string | null): string {
  const canConnect = o.tokenKey === "ok" && o.client;
  const rows = o.accounts.map((x) => `<li><b>${esc(x.label)}</b><span class=when>${x.stored ? `Connected${x.connected ? " " + esc(x.connected) : ""}` : x.fromSeed ? "from secret MS_RT_" + esc(x.label) + " (legacy)" : "not connected"}</span>
<form method=post action="/contacts/outlook/start" class=inl><input type=hidden name=csrf value="${csrf}"><input type=hidden name=label value="${esc(x.label)}"><button class=link aria-label="Reconnect Outlook ${esc(x.label)}"${canConnect ? "" : " disabled"}>Reconnect</button></form>${x.stored ? `<form method=post action="/contacts/outlook/disconnect" data-confirm="Stop syncing Outlook ${esc(x.label)}? Its contacts are removed from the list." class=inl><input type=hidden name=csrf value="${csrf}"><input type=hidden name=label value="${esc(x.label)}"><button class="link danger" aria-label="Disconnect Outlook ${esc(x.label)}">Disconnect</button></form>` : ""}</li>`).join("");
  return `<section id=outlook aria-label="Outlook accounts">
${err ? `<p class=warn role=alert>Outlook: <code>${esc(err)}</code>.</p>` : ""}${o.tokenKey === "ok" ? "" : `<p class=warn>GOOGLE_TOKEN_KEY is ${o.tokenKey === "missing" ? "not set" : "not valid"}; Outlook sign-in uses the same key. Run setup step <code>keys</code>, then <code>secrets</code>.</p>`}
<ul id=oaccts>${rows || "<li>No Outlook accounts yet.</li>"}</ul>
<form method=post action="/contacts/outlook/start" class=bar id=oconnect><input type=hidden name=csrf value="${csrf}"><label for=olabel>Add account</label><input type=text id=olabel name=label required maxlength=24 pattern="[A-Za-z0-9_]+" placeholder="work" autocomplete=off><button${canConnect ? "" : " disabled"}>Connect Outlook</button></form>
<p class=ro>${o.client ? "Microsoft client: from the MS_CLIENT_ID / MS_CLIENT_SECRET secrets." : "Microsoft client: not set up yet (README, Outlook contacts)."} Redirect URI: <code>${esc(o.redirectUri)}</code></p>
</section>`;
}

/** Server-rendered shell + one inline module. No framework, no third-party origin, numbers never in HTML. */
export function renderContactsPage(m: PageModel): string {
  const err = m.lastError ? `<p class=warn>Last sync error: <code>${esc(m.lastError.code)}</code> (${esc(m.lastError.when)}). ${esc(syncFix(m.lastError.code))}</p>` : "";
  const stored = m.google.accounts.filter((a) => a.stored).length;
  const needsAttention = m.googleError !== null || m.lastError !== null || m.google.tokenKey !== "ok" || m.google.leftovers.length > 0 || m.google.keyStatus.onOld > 0 || !m.canSync;
  const syncText = !m.canSync
    ? "No Google accounts yet. Add one below to load contacts."
    : `${stored} Google account${stored === 1 ? "" : "s"}${m.lastSync ? ` · Last synced ${esc(m.lastSync)}` : " · Not synced yet"}`;
  const seg = (["All", "On", "Off"] as const).map((f, i) => `<button type=button data-s="${f}" aria-pressed="${i === 0}">${f}<span class=n id="n-${f}"></span></button>`).join("");
  const filters = ([["starred", "Starred"], ["migrated", "Migrated"], ["new", "New since last visit"]] as const).map(([k, t]) => `<label><input type=checkbox data-x="${k}">${t}<span class=n id="n-${k}"></span></label>`).join("");
  return `<!doctype html><html lang=en><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>GrokBot Texting</title>
<style nonce="${m.nonce}">
${HARBOR_CSS}
</style>
${m.leaves ?? ""}${renderHeader()}
${renderNav("contacts")}
<p>Switch on the people this bot may text. New people start off.</p>
<section class=syncbox aria-label="Sync">
<div class=syncline>${m.canSync ? `<span class=dot aria-hidden=true></span>` : ""}<span class=t>${syncText}</span>${m.canSync ? `<form method=post action="/direct/sync"><input type=hidden name=csrf value="${m.csrf}"><input type=hidden name=from value=contacts><button id=sync>Sync now</button></form>` : ""}</div>
${err}
<details${needsAttention ? " open" : ""}><summary>Google accounts <span class=ro>${stored} connected</span></summary>
${renderGooglePanel(m.google, m.csrf, m.googleError)}
</details>
${m.outlook ? `<details${m.outlookError ? " open" : ""}><summary>Outlook accounts <span class=ro>${m.outlook.accounts.filter((a) => a.stored).length} connected</span></summary>
${renderMsPanel(m.outlook, m.csrf, m.outlookError ?? null)}
</details>` : ""}
</section>
${m.hashKeyMissing ? `<p class=warn>LOG_HASH_KEY is missing or short, so the list can't be shown. Run setup step keys, then secrets.</p>` : ""}
${m.migratedOn > 0 ? `<div class=banner id=banner role=status><p><b>${m.migratedOn}</b> people were reachable before this update and are still on.</p><div class=acts><button type=button id=review class=link>Review them</button><button type=button id=migoff>Turn all migrated off</button></div></div>` : ""}
<h2>Contacts</h2>
<label for=q class=ro>Search by name</label><input type=search id=q autocomplete=off>
<div class=tools>
<div class=seg role=group aria-label="Show">${seg}</div>
<details class=more><summary>Filters <span class=badge id=fcount hidden></span></summary><div class=menu role=group aria-label="More filters">
${filters}
<button type=button class="link clear" id=fclear>Clear filters</button></div></details>
</div>
<div class=meta><span id=count aria-live=polite></span><button type=button id=enall class=link hidden>Turn all on</button></div>
<ul id=list aria-label="People"></ul>
<nav class=pager aria-label="Pages"><button type=button id=prev aria-label="Previous page">&#8249;</button><span id=page></span><button type=button id=next aria-label="Next page">&#8250;</button><span class=per><label class=ro for=per>Per page</label><select id=per><option value=10>10</option><option value=25 selected>25</option><option value=50>50</option><option value=100>100</option></select></span></nav>
<div id=live class=vh aria-live=polite></div>
<dialog class=ask id=ask aria-modal=true aria-labelledby=ask-h><h2 id=ask-h>Turn all on</h2><p id=ask-p></p><div class=dlg-acts><button type=button id=ask-no>Cancel</button><button type=button id=ask-yes>Turn all on</button></div></dialog>
<div id=toast role=status aria-live=polite></div>
<script type=module nonce="${m.nonce}">
${contactsLiveScript(m.csrf, m.toast)}
${pickerLiveScript()}
</script></html>`;
}
