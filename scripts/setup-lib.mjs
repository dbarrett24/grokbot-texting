#!/usr/bin/env node
// Shared setup steps for setup-mac.sh and setup-windows.ps1. Runs on the OWNER's computer, from the repo folder.
// Every step prints one or more machine-readable lines:  RELAY_STATUS step=<name> result=<ok|fail|needs_human|dry_run|skip> [key=value ...]
// Rules: no secret value is ever printed, logged, or put on a command line. Secrets live only in
// .relay-local/secrets.env (gitignored, owner-only permissions) and go to Cloudflare through `wrangler secret bulk` on stdin.
// Add --dry-run to any step: it checks inputs and prints what it would do, with no Cloudflare, gateway or relay call.
import { spawnSync } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, appendFileSync, readdirSync, rmSync } from "node:fs";
import { resolve as resolveDns4, resolve6, resolveCname } from "node:dns/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const LOCAL = join(REPO, ".relay-local");
const SECRETS = join(LOCAL, "secrets.env");
const SETTINGS = join(LOCAL, "settings.json");
const CONFIG = join(LOCAL, "wrangler.toml");
const LOGS = join(LOCAL, "logs");
const GATEWAY = "https://api.sms-gate.app/3rdparty/v1";
export const TEST_BODY = "Hi,\n\nThis is a relay test. Would you reply OK when you see it?";

// ---------- output ----------
const clean = (v) => String(v).replace(/[^A-Za-z0-9._:/@+,-]/g, "_").slice(0, 400);
export function statusLine(step, result, extra = {}) {
  const kv = Object.entries(extra).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => ` ${k}=${clean(v)}`).join("");
  return `RELAY_STATUS step=${clean(step)} result=${clean(result)}${kv}`;
}
let exitCode = 0;
function out(step, result, extra) {
  console.log(statusLine(step, result, extra));
  if (result === "fail") exitCode = 1;
  else if (result === "needs_human" && exitCode === 0) exitCode = 2;
}
function log(step, text) {
  mkdirSync(LOGS, { recursive: true });
  appendFileSync(join(LOGS, `${step}.log`), `${new Date().toISOString()} ${text}\n`);
}

// ---------- local files ----------
export function parseEnv(text) {
  const m = new Map();
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf("=");
    if (i > 0 && !line.startsWith("#")) m.set(line.slice(0, i).trim(), JSON.parse(line.slice(i + 1)));
  }
  return m;
}
export function formatEnv(m) {
  return "# Local only. Never commit, paste, or share this file.\n" + [...m].map(([k, v]) => `${k}=${JSON.stringify(v)}`).join("\n") + "\n";
}
function loadSecrets() { return existsSync(SECRETS) ? parseEnv(readFileSync(SECRETS, "utf8")) : new Map(); }
function saveSecrets(m) {
  mkdirSync(LOCAL, { recursive: true });
  writeFileSync(SECRETS, formatEnv(m), { mode: 0o600 });
  try { chmodSync(SECRETS, 0o600); } catch { /* Windows: the folder sits in the user's profile */ }
}
function loadSettings() { return existsSync(SETTINGS) ? JSON.parse(readFileSync(SETTINGS, "utf8")) : {}; }
function saveSettings(s) { mkdirSync(LOCAL, { recursive: true }); writeFileSync(SETTINGS, JSON.stringify(s, null, 2) + "\n"); }

// ---------- generated keys ----------
const TYPEABLE = "abcdefghijkmnpqrstuvwxyz23456789"; // 32 symbols, no 0/o/1/l: easy to type on a phone
export function typeablePassphrase() {
  const b = randomBytes(40);
  const chars = [...b].map((x) => TYPEABLE[x & 31]).join(""); // 40 x 5 bits = 200 bits
  return chars.match(/.{5}/g).join("-"); // 47 characters, over the relay's 32 minimum
}
const GENERATORS = {
  REQUEST_TOKEN: () => randomBytes(32).toString("hex"),
  LOG_HASH_KEY: () => randomBytes(32).toString("base64"),
  GATEWAY_PASSPHRASE: typeablePassphrase,
  DEVICE_TOKEN: () => randomBytes(32).toString("hex"),
  NTFY_URL: () => `https://ntfy.sh/relay-${randomBytes(16).toString("hex")}`, // the long random topic name keeps it private
};

// ---------- validation of owner-entered values (never echoed) ----------
export const ASKABLE = {
  GATEWAY_USER: { prompt: "SMS Gateway app: the Username under Cloud Server", hidden: false, ok: (v) => /^\S{3,128}$/.test(v) },
  GATEWAY_PASS: { prompt: "SMS Gateway app: the Password under Cloud Server", hidden: true, ok: (v) => /^\S{3,256}$/.test(v) },
  APPROVER_EMAIL: { prompt: "The new email address you made for this", hidden: false, ok: (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) },
  ACCESS_AUD: { prompt: "Cloudflare Zero Trust: the Application Audience (AUD) Tag", hidden: true, ok: (v) => /^[0-9a-f]{64}$/i.test(v) },
  OWNER_NUMBER: { prompt: "Your own mobile number with + and country code, like +15555550100", hidden: false, ok: (v) => /^\+[1-9]\d{6,14}$/.test(v.replace(/[\s().-]/g, "")), fix: (v) => v.replace(/[\s().-]/g, "") },
  OWNER_NAME: { prompt: "Your name, as you want the relay to know you (for the test text)", hidden: false, ok: (v) => /^[^\d"\\]{1,60}$/.test(v.trim()), fix: (v) => v.trim() },
  GOOGLE_CLIENT_ID: { prompt: "Google Cloud: the Client ID", hidden: false, ok: (v) => /\.apps\.googleusercontent\.com$/.test(v) },
  GOOGLE_CLIENT_SECRET: { prompt: "Google Cloud: the Client secret", hidden: true, ok: (v) => /^\S{10,200}$/.test(v) },
  NTFY_TOKEN: { prompt: "ntfy: your access token", hidden: true, ok: (v) => /^\S{10,200}$/.test(v) },
};

// ---------- native dialogs on the owner's screen (the answer never reaches stdout) ----------
const asText = (s) => JSON.stringify(String(s));
function dialog({ prompt, hidden = false, show = null, buttons = null }) {
  if (DRY) {
    const sim = process.env[`RELAY_DRYRUN_ANSWER`];
    return sim === undefined ? { cancelled: true } : { value: sim };
  }
  let r;
  if (process.platform === "darwin") {
    const btn = buttons ? `buttons {${buttons.map(asText).join(", ")}} default button ${asText(buttons[buttons.length - 1])}` : "";
    const script = show !== null
      ? `display dialog ${asText(show)} with title ${asText(prompt)} ${btn || 'buttons {"Done"} default button "Done"'}\nreturn button returned of result`
      : `display dialog ${asText(prompt)} default answer "" ${hidden ? "with hidden answer" : ""} buttons {"Cancel", "OK"} default button "OK"\nreturn text returned of result`;
    r = spawnSync("osascript", ["-"], { input: script, encoding: "utf8" });
  } else if (process.platform === "win32") {
    const ps = winDialogScript({ prompt, hidden, show, buttons });
    r = spawnSync("powershell.exe", ["-NoProfile", "-STA", "-Command", "-"], { input: ps, encoding: "utf8" });
  } else {
    const args = show !== null ? ["--info", `--title=${prompt}`, `--text=${show}`] : ["--entry", `--text=${prompt}`, ...(hidden ? ["--hide-text"] : [])];
    r = spawnSync("zenity", args, { encoding: "utf8" });
  }
  if (r.error) return { error: "no_dialog" };
  if (r.status !== 0) return { cancelled: true };
  return { value: String(r.stdout).replace(/\r?\n$/, "") };
}
function winDialogScript({ prompt, hidden, show, buttons }) {
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
  const pick = buttons ? buttons.map((b, i) => `$b${i}=New-Object Windows.Forms.Button;$b${i}.Text=${q(b)};$b${i}.Width=140;$b${i}.Add_Click({$script:res=${q(b)};$f.Close()});$p.Controls.Add($b${i})`).join(";") : "";
  return [
    "Add-Type -AssemblyName System.Windows.Forms",
    "$f=New-Object Windows.Forms.Form;$f.Text='Texting relay setup';$f.Width=560;$f.Height=230;$f.TopMost=$true;$f.StartPosition='CenterScreen'",
    "$p=New-Object Windows.Forms.FlowLayoutPanel;$p.Dock='Fill';$p.FlowDirection='TopDown';$f.Controls.Add($p)",
    `$l=New-Object Windows.Forms.Label;$l.Text=${q(show !== null ? `${prompt}\n\n${show}` : prompt)};$l.AutoSize=$true;$l.MaximumSize='520,0';$l.Font='Consolas,11';$p.Controls.Add($l)`,
    "$script:res=$null",
    show === null
      ? `$t=New-Object Windows.Forms.TextBox;$t.Width=500;${hidden ? "$t.UseSystemPasswordChar=$true;" : ""}$p.Controls.Add($t);$ok=New-Object Windows.Forms.Button;$ok.Text='OK';$ok.Add_Click({$script:res=$t.Text;$f.Close()});$p.Controls.Add($ok);$f.AcceptButton=$ok`
      : (pick || "$ok=New-Object Windows.Forms.Button;$ok.Text='Done';$ok.Add_Click({$script:res='Done';$f.Close()});$p.Controls.Add($ok)"),
    "[void]$f.ShowDialog()",
    "if ($null -eq $script:res) { exit 1 }; [Console]::Out.Write($script:res)",
  ].join("\n");
}

// ---------- helpers ----------
function wrangler(args, { input, step } = {}) {
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  const r = spawnSync(npx, ["wrangler", ...args], { cwd: LOCAL, input, encoding: "utf8", shell: process.platform === "win32", env: { ...process.env, WRANGLER_SEND_METRICS: "false" } });
  log(step || "wrangler", `wrangler ${args.join(" ")} exit=${r.status}\n${r.stdout || ""}\n${r.stderr || ""}`);
  return r;
}
function settingsOrFail(step) {
  const s = loadSettings();
  if (!s.worker || !existsSync(CONFIG)) { out(step, "fail", { reason: "run_config_first" }); return null; }
  return s;
}
// The claim marker records the Cloudflare account, the Worker name and both hostnames. Deploy and secrets need an
// exact match with the signed-in account, and `config` deletes it whenever the name or a host changes.
// The ownership record (owned-<worker>.json) is written only after a successful deploy. It lets a later claim in
// the SAME account skip the name check and the DNS check for hosts that deploy put there. New hosts are always checked.
const markerPath = (s) => join(LOCAL, `claimed-${s.worker}.json`);
const ownedPath = (s) => join(LOCAL, `owned-${s.worker}.json`);
const readJson = (f) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return null; } };
export function claimMatches(s, c, accountId) {
  return !!c && c.worker === s.worker && c.apiHost === s.apiHost && c.appHost === s.appHost && (accountId === undefined || c.accountId === accountId);
}
function isClaimed(s, accountId) { return claimMatches(s, readJson(markerPath(s)), accountId); }
export function ownedHosts(s, o, accountId) {
  return o && o.worker === s.worker && o.accountId === accountId && Array.isArray(o.hosts) ? o.hosts : null;
}
/** The one Cloudflare account wrangler is signed in to: { id } or { reason }. */
export function accountFrom(r) {
  if (r.status !== 0) return { reason: "login_first" };
  let j = null;
  try { const t = String(r.stdout); j = JSON.parse(t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1)); } catch { /* not JSON */ }
  if (!j || j.loggedIn !== true) return { reason: "login_first" };
  const ids = (Array.isArray(j.accounts) ? j.accounts : []).map((a) => a && a.id).filter((x) => typeof x === "string" && x);
  if (ids.length !== 1) return { reason: ids.length ? "several_accounts" : "no_account" };
  return { id: ids[0] };
}
function account(step) {
  const a = accountFrom(wrangler(["whoami", "--json"], { step }));
  if (!a.id) out(step, a.reason === "login_first" ? "needs_human" : "fail", { reason: a.reason, hint: a.reason === "several_accounts" ? "sign_in_with_only_the_new_account" : "" });
  return a.id;
}
function clearClaims() {
  if (!existsSync(LOCAL)) return;
  for (const f of readdirSync(LOCAL)) if (f.startsWith("claimed-")) rmSync(join(LOCAL, f), { force: true });
}

export function requiredSecrets(s, m) {
  const base = ["REQUEST_TOKEN", "LOG_HASH_KEY", "ACCESS_AUD", "APPROVER_EMAIL", "OWNER_NUMBER", "ALLOWLIST"];
  if (s.delivery === "mac") return [...base, "DEVICE_TOKEN", "NTFY_URL", "NTFY_TOKEN"];
  const gw = ["GATEWAY_USER", "GATEWAY_PASS", "GATEWAY_DEVICE_ID"];
  const enc = m.has("GATEWAY_PINNED_FINGERPRINT") || s.deviceKey ? ["GATEWAY_PINNED_FINGERPRINT", "GATEWAY_KEY_VERSION"] : ["GATEWAY_PASSPHRASE"];
  return [...base, ...gw, ...enc];
}
export function buildPayload(s, m) {
  const p = {};
  const missing = [];
  for (const k of requiredSecrets(s, m)) {
    if (k === "ALLOWLIST") {
      if (m.has("OWNER_NUMBER") && m.has("OWNER_NAME")) p.ALLOWLIST = JSON.stringify({ [m.get("OWNER_NUMBER")]: m.get("OWNER_NAME") });
      else missing.push(m.has("OWNER_NUMBER") ? "OWNER_NAME" : "OWNER_NUMBER");
    } else if (m.has(k)) p[k] = m.get(k);
    else missing.push(k);
  }
  for (const k of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]) if (m.has(k)) p[k] = m.get(k);
  return { payload: p, missing: [...new Set(missing)] };
}
export function renderConfig(template, s) {
  let t = template.replace(/^name = ".*"$/m, `name = "${s.worker}"`).replace(/^main = "src\/index\.ts"$/m, 'main = "../src/index.ts"');
  t = t.replace(/^# routes = \[\n#   \{ pattern = "api\.example\.com".*\n#   \{ pattern = "app\.example\.com".*\n# \]$/m,
    `routes = [\n  { pattern = "${s.apiHost}", custom_domain = true },\n  { pattern = "${s.appHost}", custom_domain = true },\n]`);
  const set = (k, v) => {
    const re = new RegExp(`^#? ?${k} = "[^"]*"`, "m");
    t = re.test(t) ? t.replace(re, `${k} = "${v}"`) : t.replace(/^\[vars\]$/m, `[vars]\n${k} = "${v}"`);
  };
  set("TIMEZONE", s.timezone); set("DEFAULT_COUNTRY_CODE", s.country); set("REQUEST_HOST", s.apiHost); set("APPROVE_HOST", s.appHost);
  set("ACCESS_TEAM_DOMAIN", `https://${s.team}.cloudflareaccess.com`); set("CAP_START_DATE", s.startDate); set("GOOGLE_ACCOUNTS", s.google);
  if (s.delivery === "mac") { set("DELIVERY", "mac"); set("NOTIFY_MODE", "ntfy"); }
  // Always written: "1" only for Android after the owner asks (the relay refuses group texts on Mac/Shortcut delivery).
  set("GROUP_MMS", s.groupMms === "1" && s.delivery === "android" ? "1" : "0");
  return t;
}
export function leftoverPlaceholders(t) {
  return t.split("\n").filter((l) => /^[^#]*(REPLACE|example\.com)/.test(l));
}
export function fingerprintOf(publicKeyB64) {
  return createHash("sha256").update(Buffer.from(publicKeyB64, "base64")).digest("hex").toUpperCase().match(/.{4}/g).join(":");
}
async function hostHasDns(host) {
  for (const f of [resolveDns4, resolve6, resolveCname]) {
    try { if ((await f(host)).length) return true; } catch { /* no record of that type */ }
  }
  return false;
}
async function relay(path, { token, body, method = "POST" }) {
  const s = loadSettings();
  const r = await fetch(`https://${s.apiHost}${path}`, {
    method, redirect: "manual", signal: AbortSignal.timeout(30_000),
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let j = null;
  try { j = await r.json(); } catch { /* not JSON */ }
  return { http: r.status, j };
}

// ---------- steps ----------
const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : d; };

const steps = {
  async keys() {
    const m = loadSecrets();
    const s = loadSettings();
    const want = ["REQUEST_TOKEN", "LOG_HASH_KEY", ...(s.delivery === "mac" ? ["DEVICE_TOKEN", "NTFY_URL"] : ["GATEWAY_PASSPHRASE"])];
    if (args.includes("--new-token")) m.delete("REQUEST_TOKEN"); // rotation: then run `secrets` and give the bot the new one
    const made = [];
    for (const k of want) if (!m.has(k)) { m.set(k, GENERATORS[k]()); made.push(k); }
    saveSecrets(m);
    out("keys", "ok", { made: made.join(",") || "none", kept: want.filter((k) => !made.includes(k)).join(",") || "none", file: ".relay-local/secrets.env" });
  },

  async ask() {
    const name = args.find((a) => ASKABLE[a]);
    if (!name) return out("ask", "fail", { reason: "unknown_name", allowed: Object.keys(ASKABLE).join(",") });
    const spec = ASKABLE[name];
    const r = dialog({ prompt: spec.prompt, hidden: spec.hidden });
    if (r.error) return out("ask", "fail", { name, reason: r.error });
    if (r.cancelled) return out("ask", "needs_human", { name, reason: "cancelled" });
    const v = spec.fix ? spec.fix(r.value) : r.value.trim();
    if (!spec.ok(v)) return out("ask", "fail", { name, reason: "doesnt_look_right" });
    const m = loadSecrets();
    m.set(name, v);
    saveSecrets(m);
    out("ask", "ok", { name, saved: "local_only" });
  },

  async show() {
    const SHOWABLE = { GATEWAY_PASSPHRASE: "Type this into the SMS Gateway app: Settings, Encryption, Passphrase", NTFY_URL: "In the ntfy app on your iPhone, tap + and subscribe to this topic (the part after ntfy.sh/)" };
    const name = args.find((a) => SHOWABLE[a]);
    if (!name) return out("show", "fail", { reason: "unknown_name", allowed: Object.keys(SHOWABLE).join(",") });
    const m = loadSecrets();
    if (!m.has(name)) return out("show", "fail", { name, reason: "run_keys_first" });
    const r = dialog({ prompt: SHOWABLE[name], show: m.get(name) });
    out("show", r.error ? "fail" : "ok", r.error ? { name, reason: r.error } : { name, shown: "on_screen_only" });
  },

  async config() {
    const s = loadSettings();
    const domain = flag("domain", s.domain);
    const keepHosts = domain === s.domain; // a new domain means new default hosts
    const next = {
      ...s,
      worker: flag("worker", s.worker || "sms-relay"),
      domain,
      apiHost: flag("api-host", (keepHosts && s.apiHost) || (domain && `api.${domain}`)),
      appHost: flag("app-host", (keepHosts && s.appHost) || (domain && `app.${domain}`)),
      team: flag("team", s.team),
      country: flag("country", s.country),
      delivery: flag("delivery", s.delivery || "android"),
      google: flag("google", s.google || "primary"),
      timezone: flag("timezone", s.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone),
      startDate: s.startDate || new Date().toLocaleDateString("en-CA"),
      groupMms: flag("group-mms", s.groupMms || "0"),
    };
    const bad = [];
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(next.worker)) bad.push("worker");
    for (const h of ["apiHost", "appHost"]) if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(next[h] || "")) bad.push(h);
    if (next.apiHost && next.apiHost === next.appHost) bad.push("hosts_must_differ");
    if (!/^[a-z0-9-]{1,63}$/i.test(next.team || "")) bad.push("team");
    if (!/^(\+[1-9]\d{0,3}|none)$/.test(next.country || "")) bad.push("country");
    if (!["android", "mac"].includes(next.delivery)) bad.push("delivery");
    if (!/^[A-Za-z0-9_]+(,[A-Za-z0-9_]+)*$/.test(next.google)) bad.push("google");
    try { new Intl.DateTimeFormat("en", { timeZone: next.timezone }); } catch { bad.push("timezone"); }
    if (!["0", "1"].includes(next.groupMms)) bad.push("group-mms");
    if (next.groupMms === "1" && next.delivery !== "android") bad.push("group_texts_android_only");
    if (bad.length) return out("config", "fail", { bad: bad.join(",") });
    const t = renderConfig(readFileSync(join(REPO, "wrangler.toml"), "utf8"), next);
    const left = leftoverPlaceholders(t);
    if (left.length) return out("config", "fail", { reason: "placeholders_left", count: left.length });
    if (next.worker !== s.worker || next.apiHost !== s.apiHost || next.appHost !== s.appHost) clearClaims();
    saveSettings(next);
    mkdirSync(LOCAL, { recursive: true });
    writeFileSync(CONFIG, t);
    out("config", "ok", { worker: next.worker, api: next.apiHost, app: next.appHost, timezone: next.timezone, delivery: next.delivery, group_mms: next.groupMms });
  },

  async "gateway-check"() {
    const m = loadSecrets();
    if (!m.has("GATEWAY_USER") || !m.has("GATEWAY_PASS")) return out("gateway-check", "fail", { reason: "ask_gateway_login_first" });
    let devs;
    if (DRY) devs = JSON.parse(process.env.RELAY_DRYRUN_DEVICES || "[]");
    else {
      try {
        const r = await fetch(`${GATEWAY}/devices`, { signal: AbortSignal.timeout(30_000), headers: { authorization: "Basic " + Buffer.from(`${m.get("GATEWAY_USER")}:${m.get("GATEWAY_PASS")}`).toString("base64") } });
        if (r.status === 401) return out("gateway-check", "fail", { reason: "wrong_username_or_password" });
        if (!r.ok) return out("gateway-check", "fail", { reason: "gateway_http", http: r.status });
        devs = await r.json();
      } catch { return out("gateway-check", "fail", { reason: "no_connection" }); }
    }
    if (!Array.isArray(devs) || devs.length === 0) return out("gateway-check", "fail", { reason: "no_device_yet", hint: "phone_app_online" });
    if (devs.length > 1) return out("gateway-check", "fail", { reason: "more_than_one_device", devices: devs.length });
    const d = devs[0];
    m.set("GATEWAY_DEVICE_ID", String(d.id));
    const s = loadSettings();
    if (typeof d.publicKey === "string" && d.publicKey) {
      m.set("PENDING_FINGERPRINT", fingerprintOf(d.publicKey));
      m.set("GATEWAY_KEY_VERSION", String(d.keyVersion));
      s.deviceKey = true;
    } else s.deviceKey = false;
    if (!DRY) { saveSecrets(m); saveSettings(s); } // a dry run changes nothing on disk
    out("gateway-check", DRY ? "dry_run" : "ok", { devices: 1, device_key: s.deviceKey ? "yes" : "no", next: s.deviceKey ? "confirm-fingerprint" : "show_GATEWAY_PASSPHRASE" });
  },

  async "confirm-fingerprint"() {
    const m = loadSecrets();
    if (!m.has("PENDING_FINGERPRINT")) return out("confirm-fingerprint", "skip", { reason: "no_device_key" });
    const fp = m.get("PENDING_FINGERPRINT");
    const r = dialog({ prompt: "Does this match the Key fingerprint in the SMS Gateway app?", show: `${fp}\n\nIn the app: Settings, Device, Device Key, Key fingerprint.\nCheck the first two and the last two groups.`, buttons: ["No, different", "Yes, it matches"] });
    if (r.error) return out("confirm-fingerprint", "fail", { reason: r.error });
    if (r.value !== "Yes, it matches") return out("confirm-fingerprint", "fail", { reason: "fingerprint_mismatch", hint: "stop_and_ask_for_help" });
    m.set("GATEWAY_PINNED_FINGERPRINT", fp); m.delete("PENDING_FINGERPRINT"); m.delete("GATEWAY_PASSPHRASE");
    saveSecrets(m);
    out("confirm-fingerprint", "ok", { pinned: "yes" });
  },

  async claim() {
    const s = settingsOrFail("claim"); if (!s) return;
    if (DRY) return out("claim", "dry_run", { worker: s.worker, would_check: "worker_name_and_dns" });
    const acct = account("claim"); if (!acct) return;
    if (isClaimed(s, acct)) return out("claim", "ok", { worker: s.worker, already: "yes" });
    const owned = ownedHosts(s, readJson(ownedPath(s)), acct);
    if (!owned) {
      const r = wrangler(["deployments", "list", "--name", s.worker], { step: "claim" });
      if (r.status === 0) return out("claim", "fail", { reason: "worker_name_in_use", worker: s.worker, hint: "pick_another_name" });
      if (!/not found|does not exist|10007/i.test(`${r.stdout}${r.stderr}`)) return out("claim", "fail", { reason: "could_not_check_name", log: ".relay-local/logs/claim.log" });
    }
    for (const h of [s.apiHost, s.appHost]) {
      if (owned && owned.includes(h)) continue; // our own deploy made this record
      if (await hostHasDns(h)) return out("claim", "fail", { reason: "host_in_use", host: h, hint: "pick_another_host" });
    }
    writeFileSync(markerPath(s), JSON.stringify({ worker: s.worker, apiHost: s.apiHost, appHost: s.appHost, accountId: acct }) + "\n");
    out("claim", "ok", { worker: s.worker });
  },

  async deploy() {
    const s = settingsOrFail("deploy"); if (!s) return;
    if (DRY) {
      const r = wrangler(["deploy", "--dry-run", "--outdir", "dist"], { step: "deploy" });
      return out("deploy", r.status === 0 ? "dry_run" : "fail", { worker: s.worker, built: r.status === 0 ? "yes" : "no", log: ".relay-local/logs/deploy.log" });
    }
    const acct = account("deploy"); if (!acct) return;
    if (!isClaimed(s, acct)) return out("deploy", "fail", { reason: "run_claim_first" });
    const r = wrangler(["deploy"], { step: "deploy" });
    if (r.status === 0) {
      const hosts = [...new Set([...(ownedHosts(s, readJson(ownedPath(s)), acct) || []), s.apiHost, s.appHost])];
      writeFileSync(ownedPath(s), JSON.stringify({ worker: s.worker, accountId: acct, hosts }) + "\n");
    }
    out("deploy", r.status === 0 ? "ok" : "fail", { worker: s.worker, log: ".relay-local/logs/deploy.log" });
  },

  async secrets() {
    const s = settingsOrFail("secrets"); if (!s) return;
    const m = loadSecrets();
    const { payload, missing } = buildPayload(s, m);
    if (missing.length) return out("secrets", "fail", { reason: "missing", names: missing.join(",") });
    if (DRY) return out("secrets", "dry_run", { would_set: Object.keys(payload).length, names: Object.keys(payload).join(",") });
    const acct = account("secrets"); if (!acct) return;
    if (!isClaimed(s, acct)) return out("secrets", "fail", { reason: "run_claim_first" });
    const r = wrangler(["secret", "bulk"], { input: JSON.stringify(payload), step: "secrets" });
    if (r.status !== 0) return out("secrets", "fail", { log: ".relay-local/logs/secrets.log" });
    const l = wrangler(["secret", "list", "--format", "json"], { step: "secrets" });
    let names = [];
    try { names = JSON.parse(l.stdout).map((x) => x.name); } catch { /* checked below */ }
    const absent = Object.keys(payload).filter((k) => !names.includes(k));
    out("secrets", absent.length ? "fail" : "ok", { set: Object.keys(payload).length, absent: absent.join(",") });
  },

  async google() {
    const s = settingsOrFail("google"); if (!s) return;
    const label = flag("label", s.google.split(",")[0]);
    const m = loadSecrets();
    if (!m.has("GOOGLE_CLIENT_ID") || !m.has("GOOGLE_CLIENT_SECRET")) return out("google", "fail", { reason: "ask_google_client_first" });
    if (DRY) return out("google", "dry_run", { label });
    const r = spawnSync(process.execPath, [join(REPO, "scripts", "google-consent.mjs"), label], {
      cwd: LOCAL, encoding: "utf8", timeout: 6 * 60_000,
      env: { ...process.env, GOOGLE_CLIENT_ID: m.get("GOOGLE_CLIENT_ID"), GOOGLE_CLIENT_SECRET: m.get("GOOGLE_CLIENT_SECRET") },
    });
    log("google", `exit=${r.status}\n${r.stdout}\n${r.stderr}`);
    out("google", r.status === 0 ? "ok" : "fail", { label, log: ".relay-local/logs/google.log" });
  },

  async smoke() {
    const s = settingsOrFail("smoke"); if (!s) return;
    if (DRY) return out("smoke", "dry_run", { would_check: "app_302,api_log_404,api_send_401" });
    try {
      const a = await fetch(`https://${s.appHost}/log`, { redirect: "manual", signal: AbortSignal.timeout(20_000) });
      const b = await fetch(`https://${s.apiHost}/log`, { redirect: "manual", signal: AbortSignal.timeout(20_000) });
      const c = await relay("/send", { token: "wrong", body: {} });
      const ok = a.status === 302 && b.status === 404 && c.http === 401;
      out("smoke", ok ? "ok" : "fail", { app: a.status, api_log: b.status, api_send: c.http, reason: ok ? "" : (c.http === 503 ? `setting_missing_${c.j?.error || ""}` : "unexpected") });
    } catch { out("smoke", "fail", { reason: "not_reachable_yet", hint: "wait_2_minutes" }); }
  },

  async resolve() {
    const s = settingsOrFail("resolve"); if (!s) return;
    const m = loadSecrets();
    if (!m.has("OWNER_NAME")) return out("resolve", "fail", { reason: "ask_owner_name_first" });
    if (DRY) return out("resolve", "dry_run", { would_send: "nothing" });
    try {
      const r = await relay("/send", { token: m.get("REQUEST_TOKEN"), body: { to_name: m.get("OWNER_NAME"), resolve: true } });
      out("resolve", r.j?.state === "one" ? "ok" : "fail", { http: r.http, state: r.j?.state || r.j?.error || "none" });
    } catch { out("resolve", "fail", { reason: "no_connection" }); }
  },

  async "test-send"() {
    const s = settingsOrFail("test-send"); if (!s) return;
    if (!args.includes("--confirmed")) return out("test-send", "needs_human", { reason: "read_back_and_get_yes_then_add_--confirmed" });
    const m = loadSecrets();
    if (DRY) return out("test-send", "dry_run", { to: "owner", would_send: "test_text" });
    let cid;
    try {
      const r = await relay("/send", { token: m.get("REQUEST_TOKEN"), body: { to_name: m.get("OWNER_NAME"), resolve: true } });
      if (r.j?.state !== "one") return out("test-send", "fail", { stage: "lookup", state: r.j?.state || r.j?.error || r.http });
      cid = r.j.candidate_id;
    } catch { return out("test-send", "fail", { stage: "lookup", reason: "no_connection" }); }
    try {
      const r = await relay("/send", { token: m.get("REQUEST_TOKEN"), body: { candidate_id: cid, body: TEST_BODY } });
      const state = r.j?.state || r.j?.error || "none";
      const good = (r.http === 200 && state === "sent") || (r.http === 202 && state === "queued");
      out("test-send", good ? "ok" : "fail", { http: r.http, state, retry: "never" });
    } catch { out("test-send", "fail", { stage: "send", reason: "unknown_if_sent", hint: "check_phone_before_retry" }); }
  },

  async "copy-token"() {
    const m = loadSecrets();
    if (!m.has("REQUEST_TOKEN")) return out("copy-token", "fail", { reason: "run_keys_first" });
    if (DRY) return out("copy-token", "dry_run");
    const r = process.platform === "darwin" ? spawnSync("pbcopy", [], { input: m.get("REQUEST_TOKEN") })
      : process.platform === "win32" ? spawnSync("powershell.exe", ["-NoProfile", "-Command", "$input | Set-Clipboard"], { input: m.get("REQUEST_TOKEN") })
      : spawnSync("xclip", ["-selection", "clipboard"], { input: m.get("REQUEST_TOKEN") });
    out("copy-token", r.status === 0 ? "ok" : "fail", { copied: r.status === 0 ? "clipboard" : "", next: "paste_into_secret_card_then_clear-clipboard" });
  },

  async "clear-clipboard"() {
    if (DRY) return out("clear-clipboard", "dry_run");
    const r = process.platform === "darwin" ? spawnSync("pbcopy", [], { input: "" })
      : process.platform === "win32" ? spawnSync("powershell.exe", ["-NoProfile", "-Command", "Set-Clipboard -Value ' '"])
      : spawnSync("xclip", ["-selection", "clipboard"], { input: "" });
    out("clear-clipboard", r.status === 0 ? "ok" : "fail");
  },

  async status() {
    const m = loadSecrets();
    const s = loadSettings();
    const { missing } = s.worker ? buildPayload(s, m) : { missing: ["config"] };
    out("status", "ok", { worker: s.worker || "none", delivery: s.delivery || "none", have: [...m.keys()].join(","), missing: missing.join(",") || "none", claimed: s.worker && isClaimed(s) ? "yes" : "no" });
  },
};

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const name = args.find((a) => !a.startsWith("--"));
  if (!steps[name]) { out("usage", "fail", { steps: Object.keys(steps).join(",") }); process.exit(3); }
  steps[name]().then(() => process.exit(exitCode), (e) => { log("error", String(e?.stack || e)); out(name, "fail", { reason: "unexpected_error", log: ".relay-local/logs/error.log" }); process.exit(1); });
}
