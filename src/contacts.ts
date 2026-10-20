// Contacts page (APPROVE_HOST /contacts*): pure helpers and the page itself. Owner-only by construction:
// every write takes an `Owner`, and only Relay.requireOwner (Access JWT verified) can make one.
import type { SignInMethod } from "./access";
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

/** Sync error code → the DEPLOY.md fix text (section 9 table). */
export const SYNC_FIX: Record<string, string> = {
  google_client_not_configured: "Google client secrets missing: DEPLOY.md section 9 step 4.",
  default_country_code_invalid: "Set DEFAULT_COUNTRY_CODE (DEPLOY.md section 5) and deploy.",
  google_people_status_403: "People API not enabled: DEPLOY.md section 9 step 2.",
  google_token_status_400: "Google access expired or was revoked. Publish the app, then rerun setup step google.",
  empty_result: "That account has no contacts with a phone number.",
};
export function syncFix(code: string): string {
  if (code.startsWith("missing_secret_GOOGLE_RT_")) return "Run setup step google for that account, then secrets.";
  return SYNC_FIX[code] ?? "See DEPLOY.md section 9 troubleshooting.";
}

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ESC[c] ?? c);

export interface PageModel {
  csrf: string;
  nonce: string;
  migratedOn: number;
  method: string;
  sources: { name: string; numbers: string | null; lastGood: string | null }[];
  lastError: { code: string; when: string } | null;
  canSync: boolean;
  toast: string | null;
  hashKeyMissing: boolean;
}

/** Server-rendered shell + one inline module. No framework, no third-party origin, numbers never in HTML. */
export function renderContactsPage(m: PageModel): string {
  const src = m.sources.map((s) => `<li>${esc(s.name)}: ${s.lastGood ? `${esc(s.numbers ?? "?")} numbers, last good ${esc(s.lastGood)}` : "never loaded"}</li>`).join("");
  const err = m.lastError ? `<p class=warn>Last sync error: <code>${esc(m.lastError.code)}</code> (${esc(m.lastError.when)}). ${esc(syncFix(m.lastError.code))}</p>` : "";
  return `<!doctype html><html lang=en><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Contacts</title>
<style nonce="${m.nonce}">
body{font:16px system-ui,sans-serif;max-width:40em;margin:0 auto;padding:.5em 1em}h1{font-size:1.4em}
.banner{background:#fff3cd;border:1px solid #e0c060;padding:.6em;border-radius:6px}.warn{color:#8a1c1c}
.bar{display:flex;flex-wrap:wrap;gap:.4em;margin:.6em 0}.bar button[aria-pressed=true]{background:#234;color:#fff}
button{font:inherit;padding:.35em .7em;border-radius:6px;border:1px solid #888;background:#f4f4f4;cursor:pointer}
ul#list{list-style:none;padding:0;margin:0}#list li{display:flex;align-items:center;gap:.5em;padding:.5em 0;border-bottom:1px solid #ddd}
.who{flex:1;min-width:0}.who small{color:#555;display:block}.star{border:none;background:none;font-size:1.4em;padding:0 .2em}
.star[aria-pressed=true]{color:#c90}.sw{min-width:4.2em}.sw[aria-checked=true]{background:#1a7f37;color:#fff}.ro{color:#555;font-size:.85em}
#toast{position:fixed;left:50%;bottom:1em;transform:translateX(-50%);background:#222;color:#fff;padding:.5em 1em;border-radius:6px;display:none}
input[type=search],input[type=text]{font:inherit;padding:.35em;width:100%;box-sizing:border-box}details{margin:.8em 0}
</style>
<h1>Contacts</h1>
<p>The bot can text only people switched <b>on</b> here (plus ALLOWLIST). New people start off. Read-only Google access; nothing here writes to Google.</p>
${m.hashKeyMissing ? `<p class=warn>LOG_HASH_KEY is missing or short, so the list can't be shown. Run setup step keys, then secrets.</p>` : ""}
${m.migratedOn > 0 ? `<div class=banner id=banner role=status><b>${m.migratedOn}</b> people were reachable before this update and are still on. Review them. <button id=review>Review migrated</button> <button id=migoff>Turn all migrated off</button></div>` : ""}
<form method=post action="/direct/sync" class=bar>${m.canSync ? `<input type=hidden name=csrf value="${m.csrf}"><input type=hidden name=from value=contacts><button id=sync>Sync now</button>` : "<span>No Google accounts configured (GOOGLE_ACCOUNTS).</span>"}</form>
<label for=q class=ro>Search by name</label><input type=search id=q autocomplete=off>
<div class=bar role=group aria-label="Filter">${["All", "On", "Off", "Starred", "Migrated", "New"].map((f, i) => `<button data-f="${f}" aria-pressed="${i === 0}">${f === "New" ? "New since last visit" : f}</button>`).join("")}</div>
<div class=bar><button id=enall>Enable all shown</button><span id=count class=ro></span></div>
<ul id=list aria-label="People"></ul>
<details><summary>Resolve preview</summary><p class=ro>Who the bot would match, over people who are on. Never sends.</p>
<form id=pv><label for=pvq>Name</label><input type=text id=pvq autocomplete=off><button>Preview</button></form><p id=pvout role=status></p></details>
<details open><summary>Health</summary><ul>${src}</ul>${err}<p>Signed in with: <code>${esc(m.method)}</code> · <a href="/log">Log</a> · <a href="/direct">Direct send status</a></p></details>
<div id=toast role=status aria-live=polite></div>
<script type=module nonce="${m.nonce}">
const CSRF=${JSON.stringify(m.csrf)};let rows=[],filter="All";const $=(s)=>document.querySelector(s);
const toast=(t)=>{const e=$("#toast");e.textContent=t;e.style.display="block";clearTimeout(toast.t);toast.t=setTimeout(()=>e.style.display="none",4000)};
const post=async(p,b)=>{const r=await fetch(p,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({csrf:CSRF,...b})});const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.message||j.error||("http_"+r.status));return j};
const shown=()=>{const q=$("#q").value.trim().toLowerCase();return rows.filter(r=>(!q||r.name.toLowerCase().includes(q))&&(filter==="All"||(filter==="On"&&r.enabled)||(filter==="Off"&&!r.enabled)||(filter==="Starred"&&r.starred)||(filter==="Migrated"&&r.migrated)||(filter==="New"&&r.new)))};
function render(){const L=$("#list");L.textContent="";const s=shown();$("#count").textContent=s.length+" shown";for(const r of s){const li=document.createElement("li");
const w=document.createElement("div");w.className="who";w.textContent=r.name;const sm=document.createElement("small");sm.textContent=r.label+" \\u2022\\u2022\\u2022\\u2022 "+r.last4+(r.migrated?" \\u00b7 migrated":"");w.append(sm);
if(r.readonly){const b=document.createElement("span");b.className="ro";b.textContent="always on (ALLOWLIST)";li.append(w,b);L.append(li);continue}
const st=document.createElement("button");st.className="star";st.textContent=r.starred?"\\u2605":"\\u2606";st.setAttribute("aria-pressed",String(r.starred));st.setAttribute("aria-label",(r.starred?"Unstar ":"Star ")+r.name);
st.onclick=async()=>{try{await post("/contacts/prefs",{changes:[{key:r.key,starred:!r.starred}]});r.starred=!r.starred;toast(r.starred?"Starred "+r.name:"Unstarred "+r.name);sort();render()}catch(e){toast("Error: "+e.message)}};
const sw=document.createElement("button");sw.className="sw";sw.setAttribute("role","switch");sw.setAttribute("aria-checked",String(r.enabled));sw.textContent=r.enabled?"On":"Off";sw.setAttribute("aria-label","Bot may text "+r.name);
sw.onclick=async()=>{const on=!r.enabled;if(on&&!confirm("Text "+r.name+" at \\u2022\\u2022\\u2022\\u2022 "+r.last4+"?"))return;try{await post("/contacts/prefs",{changes:[{key:r.key,enabled:on}]});r.enabled=on;r.migrated=false;toast((on?"On: ":"Off: ")+r.name);render()}catch(e){toast("Error: "+e.message)}};
li.append(st,w,sw);L.append(li)}}
const sort=()=>rows.sort((a,b)=>(b["starred"]-a.starred)||a.name.localeCompare(b.name));
async function load(){const r=await fetch("/contacts/list");if(!r.ok){toast("Could not load the list");return}rows=(await r.json()).people;sort();render()}
$("#q").oninput=render;document.querySelectorAll("[data-f]").forEach(b=>b.onclick=()=>{filter=b.dataset.f;document.querySelectorAll("[data-f]").forEach(x=>x.setAttribute("aria-pressed",String(x===b)));render()});
$("#enall").onclick=async()=>{const s=shown().filter(r=>!r.readonly&&!r.enabled);if(!s.length){toast("Everyone shown is already on");return}if(!confirm("Turn on "+s.length+" people? The bot can then text them."))return;
try{const j=await post("/contacts/enable-all",{keys:s.map(r=>r.key),confirm_count:s.length});toast("Turned on "+j.updated+(j.skipped_example?" ("+j.skipped_example+" example numbers skipped)":""));await load()}catch(e){toast("Error: "+e.message)}};
const rv=$("#review");if(rv)rv.onclick=()=>document.querySelector('[data-f="Migrated"]').click();
const mo=$("#migoff");if(mo)mo.onclick=async()=>{const n=rows.filter(r=>r.migrated&&r.enabled).length;if(!confirm("Turn off all "+n+" migrated people?"))return;try{const j=await post("/contacts/migrated-off",{confirm_count:n});toast("Turned off "+j.updated);$("#banner").remove();await load()}catch(e){toast("Error: "+e.message)}};
$("#pv").onsubmit=async(ev)=>{ev.preventDefault();try{const j=await post("/contacts/preview",{name:$("#pvq").value});const o=$("#pvout");
o.textContent=j.state==="no_match"?"No match: "+j.reason:("Bot will match \\u201c"+$("#pvq").value+"\\u201d to "+j.matches.map(m=>m.name+" ("+m.label+") \\u2022\\u2022\\u2022\\u2022 "+m.last4).join(", ")+(j.state==="ambiguous"?" (ambiguous: the bot asks which)":""))}catch(e){toast("Error: "+e.message)}};
${m.toast ? `toast(${JSON.stringify(m.toast)});` : ""}load();
</script></html>`;
}
