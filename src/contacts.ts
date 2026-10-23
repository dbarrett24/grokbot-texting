// Contacts page (APPROVE_HOST /contacts*): pure helpers and the page itself. Owner-only by construction:
// every write takes an `Owner`, and only Relay.requireOwner (Access JWT verified) can make one.
import type { SignInMethod } from "./access";
import { Refuse } from "./rules";
import { HARBOR_CSS, pickerLiveScript } from "./harbor";

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
}

/** "Google accounts" panel: accounts with Reconnect/Disconnect, and one Connect Google button. The client id and secret are not on this page. */
export function renderGooglePanel(g: GooglePanel, csrf: string, googleError: string | null): string {
  const canConnect = g.tokenKey === "ok" && g.client !== null;
  const rows = g.accounts.map((x) => `<li><b>${esc(x.label)}</b>: ${x.stored ? `Connected${x.connected ? " " + esc(x.connected) : ""}` : x.fromSeed ? "from secret GOOGLE_RT_" + esc(x.label) + " (legacy)" : "not connected"}
<form method=post action="/contacts/google/start" class=inl><input type=hidden name=csrf value="${csrf}"><input type=hidden name=label value="${esc(x.label)}"><button${canConnect ? "" : " disabled"}>Reconnect</button></form>${x.stored ? `<form method=post action="/contacts/google/disconnect" class=inl data-confirm="Stop syncing ${esc(x.label)}? Its contacts are removed from the list, and Google access is revoked."><input type=hidden name=csrf value="${csrf}"><input type=hidden name=label value="${esc(x.label)}"><button>Disconnect</button></form>` : ""}</li>`).join("");
  const keyWarn = g.tokenKey === "ok" ? "" : `<p class=warn>GOOGLE_TOKEN_KEY is ${g.tokenKey === "missing" ? "not set" : "not valid"}, so Google sign-in can't store anything. Run setup step <code>keys</code>, then <code>secrets</code>.</p>`;
  const clientLine = g.client === "secrets" ? "Google client: from the GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET secrets." : "Google client: not set up yet. Run <code>node scripts/google-client.mjs --file=client.json --config=.relay-local/wrangler.toml</code> (README).";
  return `<section id=google aria-labelledby=gh><h2 id=gh>Google accounts</h2>
${googleError ? `<p class=warn role=alert>Google: <code>${esc(googleError)}</code>. ${esc(googleErrorFix(googleError))}</p>` : ""}${keyWarn}
${g.leftovers.map((l) => `<p class=warn>${esc(l)} was disconnected here and no longer syncs, but it is still set up the old way. Remove it from <code>GOOGLE_ACCOUNTS</code> in wrangler.toml, deploy, and run <code>npx wrangler secret delete GOOGLE_RT_${esc(l)}</code>.</p>`).join("")}
${g.keyStatus.onOld > 0 ? `<p class=warn id=gkeys>${g.keyStatus.onOld} of ${g.keyStatus.total} stored Google sign-ins are still on the old GOOGLE_TOKEN_KEY. Press Sync now (and reload this page); keep GOOGLE_TOKEN_KEY_OLD until this reads 0.</p>` : g.keyStatus.total ? `<p class=ro id=gkeys>All ${g.keyStatus.total} stored Google sign-ins are on the current GOOGLE_TOKEN_KEY.</p>` : ""}
<ul id=gaccts>${rows || "<li>No Google accounts yet.</li>"}</ul>
<form method=post action="/contacts/google/start" class=bar id=gconnect><input type=hidden name=csrf value="${csrf}"><label for=glabel>Account name</label><input type=text id=glabel name=label required maxlength=32 pattern="[A-Za-z0-9_]+" placeholder="work" autocomplete=off><button${canConnect ? "" : " disabled"}>Connect Google</button></form>
<p class=ro>${clientLine}</p>
</section>`;
}

/** Server-rendered shell + one inline module. No framework, no third-party origin, numbers never in HTML. */
export function renderContactsPage(m: PageModel): string {
  const err = m.lastError ? `<p class=warn>Last sync error: <code>${esc(m.lastError.code)}</code> (${esc(m.lastError.when)}). ${esc(syncFix(m.lastError.code))}</p>` : "";
  return `<!doctype html><html lang=en><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>GrokBot Texting</title>
<style nonce="${m.nonce}">
${HARBOR_CSS}
</style>
${m.leaves ?? ""}<header class=brand><img class=brand-logo src="/harbor/grokbot-logo.svg" alt="" width=32 height=32><h1 class=product>GrokBot Texting</h1></header>
<p>Switch on the people this bot may text. New people start off.</p>
${m.hashKeyMissing ? `<p class=warn>LOG_HASH_KEY is missing or short, so the list can't be shown. Run setup step keys, then secrets.</p>` : ""}
${m.migratedOn > 0 ? `<div class=banner id=banner role=status><b>${m.migratedOn}</b> people were reachable before this update and are still on. Review them. <button id=review>Review migrated</button> <button id=migoff>Turn all migrated off</button></div>` : ""}
<h2>Contacts</h2>
<label for=q class=ro>Search by name</label><input type=search id=q autocomplete=off>
<div class=bar role=group aria-label="Filter">${["All", "On", "Off", "Starred", "Migrated", "New"].map((f, i) => `<button data-f="${f}" aria-pressed="${i === 0}">${f === "New" ? "New since last visit" : f}</button>`).join("")}</div>
<div class=bar><button id=enall>Enable all shown</button><span id=count class=ro></span><span class=per><label class=ro for=per>Per page</label><select id=per><option value=10>10</option><option value=25 selected>25</option><option value=50>50</option><option value=100>100</option></select></span><button id=prev>Previous</button><button id=next>Next</button><span id=page class=ro></span></div>
<ul id=list aria-label="People"></ul>
<h2>Sync</h2>
<form method=post action="/direct/sync" class=bar>${m.canSync ? `<input type=hidden name=csrf value="${m.csrf}"><input type=hidden name=from value=contacts><button id=sync>Sync now</button>` : "<span>No Google accounts yet: use Connect Google below.</span>"}</form>
${err}
${renderGooglePanel(m.google, m.csrf, m.googleError)}
<div id=toast role=status aria-live=polite></div>
<script type=module nonce="${m.nonce}">
const CSRF=${JSON.stringify(m.csrf)};let rows=[],filter="All",page=0;const $=(s)=>document.querySelector(s);
const toast=(t)=>{const e=$("#toast");e.textContent=t;e.style.display="block";clearTimeout(toast.t);toast.t=setTimeout(()=>e.style.display="none",4000)};
const post=async(p,b)=>{const r=await fetch(p,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({csrf:CSRF,...b})});const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.message||j.error||("http_"+r.status));return j};
const shown=()=>{const q=$("#q").value.trim().toLowerCase();return rows.filter(r=>(!q||r.name.toLowerCase().includes(q))&&(filter==="All"||(filter==="On"&&r.enabled)||(filter==="Off"&&!r.enabled)||(filter==="Starred"&&r.starred)||(filter==="Migrated"&&r.migrated)||(filter==="New"&&r.new)))};
const per=()=>{const n=Number($("#per").value);return n===10||n===25||n===50||n===100?n:25};
function render(){const L=$("#list");L.textContent="";const s=shown();const size=per();const pages=Math.max(1,Math.ceil(s.length/size));if(page>pages-1)page=pages-1;if(page<0)page=0;const view=s.slice(page*size,(page+1)*size);$("#count").textContent=s.length+" shown";$("#page").textContent=s.length?(page*size+1)+"-"+(page*size+view.length)+" of "+s.length:"";$("#prev").disabled=page<=0;$("#next").disabled=page+1>=pages;for(const r of view){const li=document.createElement("li");
const w=document.createElement("div");w.className="who";w.textContent=r.name;const sm=document.createElement("small");sm.textContent=r.label+" \\u2022\\u2022\\u2022\\u2022 "+r.last4+(r.migrated?" \\u00b7 migrated":"");w.append(sm);
if(r.readonly){const b=document.createElement("span");b.className="ro";b.textContent="always on (ALLOWLIST)";li.append(w,b);L.append(li);continue}
const st=document.createElement("button");st.className="star";st.textContent=r.starred?"\\u2605":"\\u2606";st.setAttribute("aria-pressed",String(r.starred));st.setAttribute("aria-label",(r.starred?"Unstar ":"Star ")+r.name);
st.onclick=async()=>{try{await post("/contacts/prefs",{changes:[{key:r.key,starred:!r.starred}]});r.starred=!r.starred;toast(r.starred?"Starred "+r.name:"Unstarred "+r.name);sort();render()}catch(e){toast("Error: "+e.message)}};
const sw=document.createElement("button");sw.className="sw";sw.setAttribute("role","switch");sw.setAttribute("aria-checked",String(r.enabled));sw.textContent=r.enabled?"On":"Off";sw.setAttribute("aria-label","Bot may text "+r.name);
sw.onclick=async()=>{const on=!r.enabled;if(on&&!confirm("Text "+r.name+" at \\u2022\\u2022\\u2022\\u2022 "+r.last4+"?"))return;try{await post("/contacts/prefs",{changes:[{key:r.key,enabled:on}]});r.enabled=on;r.migrated=false;toast((on?"On: ":"Off: ")+r.name);render()}catch(e){toast("Error: "+e.message)}};
li.append(st,w,sw);L.append(li)}}
const sort=()=>rows.sort((a,b)=>(b["starred"]-a.starred)||a.name.localeCompare(b.name));
async function load(){const r=await fetch("/contacts/list");if(!r.ok){toast("Could not load the list");return}rows=(await r.json()).people;sort();render()}
$("#q").oninput=()=>{page=0;render()};document.querySelectorAll("[data-f]").forEach(b=>b.onclick=()=>{filter=b.dataset.f;page=0;document.querySelectorAll("[data-f]").forEach(x=>x.setAttribute("aria-pressed",String(x===b)));render()});
$("#per").onchange=()=>{page=0;render()};$("#prev").onclick=()=>{page=Math.max(0,page-1);render()};$("#next").onclick=()=>{page++;render()};
$("#enall").onclick=async()=>{const s=shown().filter(r=>!r.readonly&&!r.enabled);if(!s.length){toast("Everyone shown is already on");return}if(!confirm("Turn on "+s.length+" people? The bot can then text them."))return;
try{const j=await post("/contacts/enable-all",{keys:s.map(r=>r.key),confirm_count:s.length});toast("Turned on "+j.updated+(j.skipped_example?" ("+j.skipped_example+" example numbers skipped)":""));await load()}catch(e){toast("Error: "+e.message)}};
const rv=$("#review");if(rv)rv.onclick=()=>document.querySelector('[data-f="Migrated"]').click();
const mo=$("#migoff");if(mo)mo.onclick=async()=>{const n=rows.filter(r=>r.migrated&&r.enabled).length;if(!confirm("Turn off all "+n+" migrated people?"))return;try{const j=await post("/contacts/migrated-off",{confirm_count:n});toast("Turned off "+j.updated);$("#banner").remove();await load()}catch(e){toast("Error: "+e.message)}};
document.querySelectorAll("form[data-confirm]").forEach(f=>f.addEventListener("submit",(ev)=>{if(!confirm(f.dataset.confirm))ev.preventDefault()}));
${pickerLiveScript()}
${m.toast ? `toast(${JSON.stringify(m.toast)});` : ""}load();
</script></html>`;
}
