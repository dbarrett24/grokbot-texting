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
import { mainKind } from "./is-main.mjs";
import { installNoTtyGuard } from "./no-tty-guard.mjs";

// Tests set one of these. A real TTY read or /dev/tty open then throws instead of prompting.
if (process.env.VITEST === "true" || process.env.SETUP_NONINTERACTIVE === "1") installNoTtyGuard();

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
  GOOGLE_TOKEN_KEY: () => randomBytes(32).toString("base64"), // seals in-app Google tokens (src/google.ts)
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
  // Only when the app ALREADY has a passphrase (no device key): type that one in, so setup never replaces it.
  GATEWAY_PASSPHRASE: { prompt: "SMS Gateway app: the passphrase already set under Settings, Encryption", hidden: true, ok: (v) => v.length >= 32 && v.length <= 256 && !/[\r\n]/.test(v) },
};

// ---------- native dialogs on the owner's screen (the answer never reaches stdout) ----------
const asText = (s) => JSON.stringify(String(s));

/** The reject choice. Confirm buttons are ["No, different", "Yes, it matches"], so this is "No, different". @param {string[]} buttons */
export function defaultButton(buttons) {
  return buttons[0]; // reject: "No, different" is the first confirm button
}

/**
 * Button prompts reject on empty input and on EOF (null).
 * @param {string[]} buttons
 * @param {string | null} raw
 * @returns {{ value: string }}
 */
export function buttonAnswer(buttons, raw) {
  if (raw === null || String(raw).trim() === "") return { value: defaultButton(buttons) };
  return { value: String(raw).replace(/\r?\n$/, "").trim() };
}

/**
 * Answer for a non-interactive prompt. `stdinText` (null = EOF) and SETUP_ANSWER are injected and skip the real stdin.
 * A TTY stdin throws: tests must not read the terminal.
 * @param {{ stdinText?: string | null, stdin?: { isTTY?: boolean, fd?: number } }} [io]
 * @returns {string | null}
 */
export function readPromptRaw(io = {}) {
  if (Object.prototype.hasOwnProperty.call(io, "stdinText")) return io.stdinText ?? null;
  if (process.env.SETUP_ANSWER !== undefined) return process.env.SETUP_ANSWER;
  const stdin = io.stdin || process.stdin;
  if (stdin.isTTY) throw new Error("refusing_tty_stdin");
  const fd = typeof stdin.fd === "number" ? stdin.fd : 0;
  try {
    const text = readFileSync(fd, "utf8");
    return text === "" ? null : text;
  } catch (e) {
    const code = e && typeof e === "object" && "code" in e ? String(/** @type {{ code?: unknown }} */ (e).code) : "";
    if (code === "EAGAIN" || code === "EOF") return null;
    throw e;
  }
}

/**
 * Linux zenity argv. Button dialogs default to cancel (reject).
 * @param {{ prompt: string, show: string | null, buttons: string[] | null, hidden: boolean }} spec
 * @returns {string[]}
 */
export function linuxDialogArgs(spec) {
  if (spec.show !== null && spec.buttons) {
    return ["--question", `--title=${spec.prompt}`, `--text=${spec.show}`, `--ok-label=${spec.buttons[spec.buttons.length - 1]}`, `--cancel-label=${defaultButton(spec.buttons)}`, "--default-cancel"];
  }
  if (spec.show !== null) return ["--info", `--title=${spec.prompt}`, `--text=${spec.show}`];
  return ["--entry", `--text=${spec.prompt}`, ...(spec.hidden ? ["--hide-text"] : [])];
}

/** @param {string} text @param {{ write: (chunk: string) => void }} [stdout] */
function writePrompt(text, stdout) {
  const line = text.endsWith("\n") ? text : `${text}\n`;
  const file = process.env.SETUP_PROMPT_OUT;
  if (file) { appendFileSync(file, line); return; }
  const out = stdout || process.stdout;
  if ("isTTY" in out && out.isTTY) throw new Error("refusing_tty_stdout");
  out.write(line);
}

/**
 * Test and piped prompts. Passphrase and topic values (info dialogs, no buttons) are not written anywhere.
 * @param {{ prompt: string, hidden?: boolean, show?: string | null, buttons?: string[] | null, stdinText?: string | null, stdin?: { isTTY?: boolean, fd?: number }, stdout?: { write: (chunk: string) => void } }} spec
 * @returns {{ value?: string, cancelled?: boolean, error?: string }}
 */
function streamDialog(spec) {
  const show = spec.show ?? null;
  const buttons = spec.buttons ?? null;
  if (show !== null && buttons === null) return { value: "Done" };
  const text = [spec.prompt, show].filter((x) => x !== null && x !== "").join("\n\n");
  writePrompt(text, spec.stdout);
  const raw = readPromptRaw(spec);
  if (buttons) return buttonAnswer(buttons, raw);
  if (raw === null || String(raw).trim() === "") return { cancelled: true };
  return { value: String(raw).replace(/\r?\n$/, "") };
}

/** @param {{ prompt: string, hidden?: boolean, show?: string | null, buttons?: string[] | null }} spec */
function dialog({ prompt, hidden = false, show = null, buttons = null }) {
  if (DRY) {
    const sim = process.env[`RELAY_DRYRUN_ANSWER`];
    return sim === undefined ? { cancelled: true } : { value: sim };
  }
  if (process.env.SETUP_NONINTERACTIVE === "1") return streamDialog({ prompt, hidden, show, buttons });
  const cmd = process.platform === "darwin" ? "osascript" : process.platform === "win32" ? "powershell.exe" : "zenity";
  if (process.env.VITEST === "true") return { error: `native_dialog_blocked:${cmd}` };
  let r;
  if (process.platform === "darwin") {
    const btn = buttons ? `buttons {${buttons.map(asText).join(", ")}} default button ${asText(defaultButton(buttons))}` : "";
    const script = show !== null
      ? `display dialog ${asText(show)} with title ${asText(prompt)} ${btn || 'buttons {"Done"} default button "Done"'}\nreturn button returned of result`
      : `display dialog ${asText(prompt)} default answer "" ${hidden ? "with hidden answer" : ""} buttons {"Cancel", "OK"} default button "OK"\nreturn text returned of result`;
    r = spawnSync("osascript", ["-"], { input: script, encoding: "utf8" });
  } else if (process.platform === "win32") {
    const ps = winDialogScript({ prompt, hidden, show, buttons });
    r = spawnSync("powershell.exe", ["-NoProfile", "-STA", "-Command", "-"], { input: ps, encoding: "utf8" });
  } else {
    const args = linuxDialogArgs({ prompt, show, buttons, hidden });
    r = spawnSync("zenity", args, { encoding: "utf8" });
    if (!r.error && show !== null && buttons) return { value: r.status === 0 ? buttons[buttons.length - 1] : defaultButton(buttons) };
  }
  if (r.error) return { error: "no_dialog" };
  if (r.status !== 0) return { cancelled: true };
  return { value: String(r.stdout).replace(/\r?\n$/, "") };
}
export function winDialogScript({ prompt, hidden, show, buttons }) {
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
  const pick = buttons ? buttons.map((b, i) => `$b${i}=New-Object Windows.Forms.Button;$b${i}.Text=${q(b)};$b${i}.Width=140;$b${i}.Add_Click({$script:res=${q(b)};$f.Close()});$p.Controls.Add($b${i})`).join(";") + ";$f.AcceptButton=$b0" : "";
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

/**
 * The default while SMS Gateway v1.77.0-v1.77.4 can't decrypt device-key texts: its RSAEncryptionProvider asks the
 * Android Keystore for MGF1-SHA-256, against its own published format (MGF1-SHA-1) and a key not authorized for it
 * ("key store operation failed"). The app picks the decryptor by prefix, so the passphrase format still works on a
 * phone that has a device key. Device key is opt-in: `config --gateway-mode device-key`.
 */
export const DEFAULT_GATEWAY_MODE = "passphrase";
/**
 * How texts are encrypted to the phone. This is the ONE place that decides it; keys, show, secrets, status,
 * gateway-check, confirm-fingerprint and smoke all read it.
 *   "none"       Mac delivery: no SMS Gateway at all
 *   "device_key" chosen with `config --gateway-mode device-key` (needs a phone that publishes a device key)
 *   "passphrase" chosen with `config --gateway-mode passphrase`, or the default once gateway-check has run
 *   "unknown"    no choice and gateway-check hasn't run: nothing gateway-related is made or sent yet
 * device_key is ONLY ever an explicit choice. A stored pin with no recorded choice (e.g. pinned by hand) does not
 * switch the mode: it is the passphrase default, and staleHint() tells the owner to opt in or drop the pin.
 */
export function gatewayMode(s, m) {
  if (s.delivery === "mac") return "none";
  if (s.gatewayMode === "device_key" || s.gatewayMode === "passphrase") return s.gatewayMode;
  if (s.deviceKey === undefined && !m.has("GATEWAY_PINNED_FINGERPRINT")) return "unknown";
  return DEFAULT_GATEWAY_MODE;
}
const PIN_NAMES = ["GATEWAY_PINNED_FINGERPRINT", "GATEWAY_KEY_VERSION"];
/** A local pin that the mode doesn't use (no explicit device_key choice): a hint, never a mode switch. */
export const STALE_PIN_HINT = "stale_pin_ignored:config_--gateway-mode_device-key_to_use_it,or_config_--gateway-mode_passphrase_to_drop_it";
/** @param {unknown} s settings @param {unknown} m secrets map @returns {{ stale_pin?: string }} */
export function staleHint(s, m) {
  const o = /** @type {{ delivery?: unknown, gatewayMode?: unknown }} */ (s && typeof s === "object" ? s : {});
  return o.delivery !== "mac" && !o.gatewayMode && m instanceof Map && m.has("GATEWAY_PINNED_FINGERPRINT") ? { stale_pin: STALE_PIN_HINT } : {};
}
/**
 * The Worker lists both modes' secrets (a passphrase AND a pin): the relay's choice then depends on GATEWAY_MODE alone.
 * @param {unknown} listed secret names from `secret list`
 */
export function bothModesListed(listed) {
  return Array.isArray(listed) && listed.includes("GATEWAY_PASSPHRASE") && PIN_NAMES.some((k) => listed.includes(k));
}
/** @param {string} step @param {unknown} mode @param {unknown} listed @param {Record<string, string>} [extra] */
function warnBoth(step, mode, listed, extra = {}) {
  if (!Array.isArray(listed) || !bothModesListed(listed)) return;
  const names = ["GATEWAY_PASSPHRASE", ...PIN_NAMES].filter((k) => listed.includes(k)).join(",");
  out(step, "warn", { reason: "worker_has_passphrase_and_pin", gateway_mode: String(mode), listed: names, ...extra });
}
/** @param {unknown} v */
const idText = (v) => (typeof v === "string" || typeof v === "number" ? String(v) : "");
/** @typedef {{ id?: unknown, name?: unknown, publicKey?: unknown, keyVersion?: unknown }} ListedDevice */
/**
 * The device gateway-check works with. A stored GATEWAY_DEVICE_ID is never overwritten: the listing is filtered by
 * it, and a missing id fails with device_id_changed. With no stored id the listing must hold exactly one device.
 * @param {unknown} devs the gateway's device listing @param {unknown} storedId
 * @returns {{ device: ListedDevice, reason?: undefined } | { device?: undefined, reason: string }}
 */
export function pickDevice(devs, storedId) {
  if (!Array.isArray(devs) || devs.length === 0) return { reason: "no_device_yet" };
  /** @type {ListedDevice[]} */
  const list = devs.map((x) => (x && typeof x === "object" ? /** @type {ListedDevice} */ (x) : {}));
  if (storedId !== undefined) {
    const d = list.find((x) => idText(x.id) !== "" && idText(x.id) === idText(storedId));
    return d ? { device: d } : { reason: "device_id_changed" };
  }
  if (list.length > 1) return { reason: "more_than_one_device" };
  return { device: /** @type {ListedDevice} */ (list[0]) };
}
/** The confirm-fingerprint text: which device (id and name) and the groups to compare. @param {unknown} fpIn @param {unknown} deviceId @param {unknown} deviceName */
export function confirmText(fpIn, deviceId, deviceName) {
  const fp = idText(fpIn);
  const g = fp.split(":");
  return `Device: ${idText(deviceName) || "(no name listed)"}\nDevice id: ${idText(deviceId) || "(unknown)"}\n\n${g.slice(0, 2).join("  ")}   ...   ${g.slice(-2).join("  ")}\n\nCheck this is your phone, then compare the first two and last two groups against the app:\nSettings, Device, Device Key, Key fingerprint.\n\nExpected fingerprint from the gateway-check step, stored in .relay-local/secrets.env (PENDING_FINGERPRINT).\nReject unless you just set up this device.\n\nFull value (no need to read it all):\n${fp}`;
}
export function requiredSecrets(s, m) {
  const base = ["REQUEST_TOKEN", "LOG_HASH_KEY", "ACCESS_AUD", "APPROVER_EMAIL", "OWNER_NUMBER", "ALLOWLIST"];
  const mode = gatewayMode(s, m);
  if (mode === "none") return [...base, "DEVICE_TOKEN", "NTFY_URL", "NTFY_TOKEN"];
  const gw = ["GATEWAY_USER", "GATEWAY_PASS", "GATEWAY_DEVICE_ID"];
  const enc = mode === "device_key" ? PIN_NAMES : mode === "passphrase" ? ["GATEWAY_PASSPHRASE"] : ["GATEWAY_MODE_UNKNOWN"];
  return [...base, ...gw, ...enc, ...(mode === "unknown" ? [] : ["GATEWAY_MODE"])];
}
export function buildPayload(s, m) {
  const p = {};
  const missing = [];
  for (const k of requiredSecrets(s, m)) {
    if (k === "ALLOWLIST") {
      if (m.has("OWNER_NUMBER") && m.has("OWNER_NAME")) p.ALLOWLIST = JSON.stringify({ [m.get("OWNER_NUMBER")]: m.get("OWNER_NAME") });
      else missing.push(m.has("OWNER_NUMBER") ? "OWNER_NAME" : "OWNER_NUMBER");
    } else if (k === "GATEWAY_MODE_UNKNOWN") missing.push("gateway_mode_run_gateway-check"); // the mode isn't known yet
    else if (k === "GATEWAY_MODE") p.GATEWAY_MODE = gatewayMode(s, m); // the relay reads it (src/relay.ts gatewayPost)
    else if (m.has(k)) p[k] = m.get(k);
    else missing.push(k);
  }
  for (const k of ["GOOGLE_TOKEN_KEY", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]) if (m.has(k)) p[k] = m.get(k);
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
/**
 * One-line fixes for the relay's gateway security events (src/relay.ts gatewayPost), so a failed send says what
 * to run instead of only "send_failed". device_key_present_but_no_pin and its reverse, no_device_key_and_no_passphrase.
 */
export const GATEWAY_FIX = {
  device_key_present_but_no_pin: "run_gateway-check_then_confirm-fingerprint",
  device_key_pin_mismatch: "phone_key_changed:run_gateway-check_then_confirm-fingerprint",
  no_device_key_and_no_passphrase: "phone_has_no_device_key:update_SMS_Gateway_to_v1.77+_then_run_gateway-check",
  device_id_not_listed: "phone_id_changed:run_gateway-check",
  gateway_mode_passphrase_but_no_passphrase: "run_keys_then_show_GATEWAY_PASSPHRASE_into_the_app_or_ask_it_from_the_app_then_secrets",
};
/**
 * What the relay will do with this phone, given what setup stored. Mirrors gatewayPost's checks without
 * sending anything: returns the relay's event code it would hit, or null when the two agree.
 */
export function gatewayDiagnosis(s, m, devs) {
  if (gatewayMode(s, m) === "none") return null;
  const d = Array.isArray(devs) ? devs.find((x) => x && String(x.id) === m.get("GATEWAY_DEVICE_ID")) : null;
  if (!d) return "device_id_not_listed";
  // Passphrase mode: the relay sends the passphrase format whatever the phone lists (GATEWAY_MODE=passphrase).
  if (gatewayMode(s, m) === "passphrase") return m.has("GATEWAY_PASSPHRASE") ? null : "gateway_mode_passphrase_but_no_passphrase";
  if (typeof d.publicKey === "string" && d.publicKey) {
    const pin = m.get("GATEWAY_PINNED_FINGERPRINT"), ver = m.get("GATEWAY_KEY_VERSION");
    if (gatewayMode(s, m) !== "device_key" || !pin || !ver) return "device_key_present_but_no_pin";
    if (fingerprintOf(d.publicKey) !== pin || Number(ver) !== d.keyVersion) return "device_key_pin_mismatch";
    return null;
  }
  return m.has("GATEWAY_PASSPHRASE") && gatewayMode(s, m) === "passphrase" ? null : "no_device_key_and_no_passphrase";
}
async function fetchDevices(m) {
  if (DRY) return JSON.parse(process.env.RELAY_DRYRUN_DEVICES || "[]");
  const r = await fetch(`${GATEWAY}/devices`, { signal: AbortSignal.timeout(30_000), headers: { authorization: "Basic " + Buffer.from(`${m.get("GATEWAY_USER")}:${m.get("GATEWAY_PASS")}`).toString("base64") } });
  if (r.status === 401) throw new Error("wrong_username_or_password");
  if (!r.ok) throw new Error(`gateway_http_${r.status}`);
  return r.json();
}
/** Prints one RELAY_STATUS line for the gateway side of a check. Never prints a value. */
async function gatewayCross(step, s, m) {
  if (gatewayMode(s, m) === "none") return;
  if (!m.has("GATEWAY_USER") || !m.has("GATEWAY_PASS")) return out(step, "skip", { reason: "no_gateway_login_stored" });
  let devs;
  try { devs = await fetchDevices(m); } catch (e) { return out(step, "fail", { reason: String(e?.message || "no_connection").replace(/^fetch failed$/, "no_connection") }); }
  const code = gatewayDiagnosis(s, m, devs);
  out(step, code ? "fail" : "ok", code ? { reason: code, fix: GATEWAY_FIX[code] } : { mode: gatewayMode(s, m) });
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

// ---------- passphrase made here: the owner still has to put it into the app ----------
const SHOW_REMINDER = "show_GATEWAY_PASSPHRASE_then_enter_it_in_the_app";
function showReminder(s, m) {
  return s.passphraseNotShown && gatewayMode(s, m) === "passphrase" && m.has("GATEWAY_PASSPHRASE") ? { owner_next: SHOW_REMINDER } : {};
}
function clearShowReminder() {
  const s = loadSettings();
  if (s.passphraseNotShown) { delete s.passphraseNotShown; saveSettings(s); }
}

// ---------- device-key pin on an already deployed Worker ----------
/** Deletes a GATEWAY_PASSPHRASE secret left on the Worker, only if it's there. Returns yes | no | failed. */
function removeStalePassphrase(step, listed) {
  const r = removeListed(step, listed, ["GATEWAY_PASSPHRASE"]);
  return r === "failed" ? r : r ? "yes" : "no";
}
/** The other mode's secrets: passphrase mode drops a stale pin, device-key mode a stale passphrase. */
export function staleFor(mode) {
  return mode === "device_key" ? ["GATEWAY_PASSPHRASE"] : mode === "passphrase" ? PIN_NAMES : [];
}
/** Deletes each of `names` that the Worker lists, and only those. Returns the deleted names (comma list) or "failed". */
function removeListed(step, listed, names) {
  const gone = [];
  for (const k of names.filter((n) => listed.includes(n))) {
    if (wrangler(["secret", "delete", k], { input: "", step }).status !== 0) return "failed";
    gone.push(k);
  }
  return gone.join(",");
}
function listedSecrets(step) {
  const l = wrangler(["secret", "list", "--format", "json"], { step });
  try { return JSON.parse(l.stdout).map((x) => x.name); } catch { return null; }
}
/**
 * After confirm-fingerprint: if this Worker was deployed from this computer (owned-<worker>.json), put the
 * pin and key version straight onto it (stdin, never argv or output) and remove a stale passphrase secret.
 * Not deployed yet: secrets.env only; `secrets` sends them after deploy.
 */
async function pushPin(s, m) {
  const step = "worker-pin";
  const owned = s.worker ? readJson(ownedPath(s)) : null;
  if (!owned || owned.worker !== s.worker) return out(step, "skip", { reason: "not_deployed_yet", saved: "local_only", next: "secrets_after_deploy" });
  if (DRY) return out(step, "dry_run", { worker: s.worker, would_put: [...PIN_NAMES, "GATEWAY_MODE"].join(","), would_remove: "GATEWAY_PASSPHRASE_if_set" });
  if (!existsSync(CONFIG)) return out(step, "fail", { reason: "run_config_first" });
  const acct = account(step); if (!acct) return;
  if (owned.accountId !== acct) return out(step, "fail", { reason: "different_cloudflare_account", hint: "sign_in_with_the_account_that_deployed" });
  const payload = { ...Object.fromEntries(PIN_NAMES.map((k) => [k, m.get(k)])), GATEWAY_MODE: "device_key" };
  const r = wrangler(["secret", "bulk"], { input: JSON.stringify(payload), step });
  if (r.status !== 0) return out(step, "fail", { log: `.relay-local/logs/${step}.log` });
  const names = listedSecrets(step) || [];
  const absent = Object.keys(payload).filter((k) => !names.includes(k));
  // Verify first: the stale passphrase goes only once the Worker lists the new pin, version and mode.
  if (absent.length) return out(step, "fail", { worker: s.worker, put: Object.keys(payload).join(","), absent: absent.join(","), removed_passphrase: "no_pin_not_listed" });
  const removed = removeStalePassphrase(step, names);
  out(step, removed === "failed" ? "fail" : "ok", { worker: s.worker, put: Object.keys(payload).join(","), removed_passphrase: removed });
}

// ---------- steps ----------
const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : d; };

const steps = {
  async keys() {
    const m = loadSecrets();
    const s = loadSettings();
    // A passphrase is made only in passphrase mode, and never replaces one already stored (or typed in with
    // `ask GATEWAY_PASSPHRASE` because the app already has one). Device-key mode never gets one.
    const mode = gatewayMode(s, m);
    const want = ["REQUEST_TOKEN", "LOG_HASH_KEY", "GOOGLE_TOKEN_KEY", ...(mode === "none" ? ["DEVICE_TOKEN", "NTFY_URL"] : mode === "passphrase" ? ["GATEWAY_PASSPHRASE"] : [])];
    if (args.includes("--new-token")) m.delete("REQUEST_TOKEN"); // rotation: then run `secrets` and give the bot the new one
    const made = [];
    for (const k of want) if (!m.has(k)) { m.set(k, GENERATORS[k]()); made.push(k); }
    saveSecrets(m);
    if (made.includes("GATEWAY_PASSPHRASE")) { s.passphraseNotShown = true; saveSettings(s); } // the app doesn't have it yet
    out("keys", "ok", { made: made.join(",") || "none", kept: want.filter((k) => !made.includes(k)).join(",") || "none", gateway_mode: mode, ...(mode === "unknown" ? { next: "gateway-check" } : made.includes("GATEWAY_PASSPHRASE") ? { next: SHOW_REMINDER } : {}), file: ".relay-local/secrets.env" });
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
    if (name === "GATEWAY_PASSPHRASE") clearShowReminder(); // typed from the app, so the app has it
    out("ask", "ok", { name, saved: "local_only" });
  },

  async show() {
    const SHOWABLE = { GATEWAY_PASSPHRASE: "Type this into the SMS Gateway app: Settings, Encryption, Passphrase", NTFY_URL: "In the ntfy app on your iPhone, tap + and subscribe to this topic (the part after ntfy.sh/)" };
    const name = args.find((a) => SHOWABLE[a]);
    if (!name) return out("show", "fail", { reason: "unknown_name", allowed: Object.keys(SHOWABLE).join(",") });
    const m = loadSecrets();
    if (name === "GATEWAY_PASSPHRASE" && gatewayMode(loadSettings(), m) !== "passphrase") return out("show", "fail", { name, reason: `gateway_mode_${gatewayMode(loadSettings(), m)}`, hint: "no_passphrase_in_device_key_mode" });
    if (!m.has(name)) return out("show", "fail", { name, reason: "run_keys_first" });
    const r = dialog({ prompt: SHOWABLE[name], show: m.get(name) });
    if (!r.error && name === "GATEWAY_PASSPHRASE") clearShowReminder();
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
      gatewayMode: ((g) => (g === "device-key" ? "device_key" : g))(flag("gateway-mode", s.gatewayMode)),
    };
    if (next.gatewayMode === undefined) delete next.gatewayMode;
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
    if (next.gatewayMode !== undefined && !["passphrase", "device_key"].includes(next.gatewayMode)) bad.push("gateway-mode");
    if (bad.length) return out("config", "fail", { bad: bad.join(",") });
    const t = renderConfig(readFileSync(join(REPO, "wrangler.toml"), "utf8"), next);
    const left = leftoverPlaceholders(t);
    if (left.length) return out("config", "fail", { reason: "placeholders_left", count: left.length });
    if (next.worker !== s.worker || next.apiHost !== s.apiHost || next.appHost !== s.appHost) clearClaims();
    saveSettings(next);
    mkdirSync(LOCAL, { recursive: true });
    writeFileSync(CONFIG, t);
    const mode = gatewayMode(next, loadSecrets());
    out("config", "ok", { worker: next.worker, api: next.apiHost, app: next.appHost, timezone: next.timezone, delivery: next.delivery, group_mms: next.groupMms, gateway_mode: mode,
      ...(mode !== gatewayMode(s, loadSecrets()) && mode !== "unknown" && mode !== "none" ? { next: mode === "device_key" ? "gateway-check_then_confirm-fingerprint" : "keys_then_secrets" } : {}) });
  },

  async "gateway-check"() {
    const m = loadSecrets();
    if (!m.has("GATEWAY_USER") || !m.has("GATEWAY_PASS")) return out("gateway-check", "fail", { reason: "ask_gateway_login_first" });
    let devs;
    try { devs = await fetchDevices(m); } catch (e) {
      const why = String(e?.message || "");
      return out("gateway-check", "fail", why === "wrong_username_or_password" ? { reason: why } : why.startsWith("gateway_http_") ? { reason: "gateway_http", http: why.slice(13) } : { reason: "no_connection" });
    }
    const pick = pickDevice(devs, m.get("GATEWAY_DEVICE_ID"));
    if (pick.reason === "no_device_yet") return out("gateway-check", "fail", { reason: "no_device_yet", hint: "phone_app_online" });
    if (pick.reason === "more_than_one_device") return out("gateway-check", "fail", { reason: "more_than_one_device", devices: Array.isArray(devs) ? devs.length : 0, hint: "ask_GATEWAY_DEVICE_ID_is_not_guessed" });
    // Never overwrite the stored id: a different listing is a new phone (or a swapped server), not a silent re-pin.
    if (pick.reason === "device_id_changed") return out("gateway-check", "fail", { reason: "device_id_changed", devices: Array.isArray(devs) ? devs.length : 0, hint: "stop_and_check_the_phone;to_switch_phones_remove_GATEWAY_DEVICE_ID_from_secrets.env_then_rerun" });
    const d = pick.device;
    if (!d) return out("gateway-check", "fail", { reason: pick.reason });
    m.set("GATEWAY_DEVICE_ID", String(d.id));
    const s = loadSettings();
    const hasKey = typeof d.publicKey === "string" && !!d.publicKey;
    s.deviceKey = hasKey; // what the phone reports; the mode itself comes from gatewayMode()
    const mode = gatewayMode(s, m);
    let next;
    if (mode === "device_key") {
      if (!hasKey) {
        if (!DRY) { saveSecrets(m); saveSettings(s); }
        out("gateway-check", "fail", { devices: 1, device_key: "no", reason: "device_key_mode_but_phone_has_no_device_key", hint: "update_app_to_v1.77+_or_config_--gateway-mode_passphrase" });
        return;
      }
      // Device-key mode (opt-in). The fingerprint is computed here; nobody types or pastes it.
      const fp = fingerprintOf(d.publicKey), ver = String(d.keyVersion);
      if (m.get("GATEWAY_PINNED_FINGERPRINT") === fp && m.get("GATEWAY_KEY_VERSION") === ver) {
        m.delete("PENDING_FINGERPRINT"); m.delete("PENDING_KEY_VERSION"); m.delete("PENDING_DEVICE_ID"); m.delete("PENDING_DEVICE_NAME");
        next = "none_already_pinned";
      } else {
        // Held as pending until the owner confirms it by eye; a rotated key never replaces the pin unconfirmed.
        m.set("PENDING_FINGERPRINT", fp); m.set("PENDING_KEY_VERSION", ver);
        m.set("PENDING_DEVICE_ID", String(d.id)); m.set("PENDING_DEVICE_NAME", typeof d.name === "string" ? d.name.slice(0, 80) : "");
        next = "confirm-fingerprint";
      }
    } else {
      m.delete("PENDING_FINGERPRINT"); m.delete("PENDING_KEY_VERSION"); m.delete("PENDING_DEVICE_ID"); m.delete("PENDING_DEVICE_NAME");
      // Passphrase mode (the default): the app decrypts this format by prefix even when it has a device key.
      next = m.has("GATEWAY_PASSPHRASE") ? "none_passphrase_stored" : "keys_then_show_GATEWAY_PASSPHRASE(or_ask_GATEWAY_PASSPHRASE_if_the_app_has_one)";
    }
    if (!DRY) { saveSecrets(m); saveSettings(s); } // a dry run changes nothing on disk
    out("gateway-check", DRY ? "dry_run" : "ok", { devices: 1, device_key: hasKey ? "yes" : "no", next });
    out("gateway_mode", DRY ? "dry_run" : "ok", { reason: mode, ...(mode === "passphrase" && hasKey && !s.gatewayMode ? { hint: "default_while_app_v1.77.0-1.77.4_device_key_decrypt_bug;opt_in:config_--gateway-mode_device-key" } : {}), ...staleHint(s, m) });
  },

  async "confirm-fingerprint"() {
    const m = loadSecrets();
    if (gatewayMode(loadSettings(), m) !== "device_key") return out("confirm-fingerprint", "skip", { reason: `gateway_mode_${gatewayMode(loadSettings(), m)}`, hint: "opt_in:config_--gateway-mode_device-key" });
    if (!m.has("PENDING_FINGERPRINT")) return out("confirm-fingerprint", "skip", { reason: m.has("GATEWAY_PINNED_FINGERPRINT") ? "already_pinned" : "no_device_key" });
    const fp = m.get("PENDING_FINGERPRINT");
    // Which phone (id and name), then the first two and last two groups (64 bits) to compare. Full value below.
    const show = confirmText(fp, m.get("PENDING_DEVICE_ID") ?? m.get("GATEWAY_DEVICE_ID"), m.get("PENDING_DEVICE_NAME"));
    const r = dialog({ prompt: "Does this match the Key fingerprint in the SMS Gateway app?", show, buttons: ["No, different", "Yes, it matches"] });
    if (r.error) return out("confirm-fingerprint", "fail", { reason: r.error });
    if (r.value !== "Yes, it matches") return out("confirm-fingerprint", "fail", { reason: "fingerprint_mismatch", hint: "stop_and_ask_for_help" });
    const rotated = m.has("GATEWAY_PINNED_FINGERPRINT");
    m.set("GATEWAY_PINNED_FINGERPRINT", fp);
    m.set("GATEWAY_KEY_VERSION", m.get("PENDING_KEY_VERSION") ?? m.get("GATEWAY_KEY_VERSION"));
    m.delete("PENDING_FINGERPRINT"); m.delete("PENDING_KEY_VERSION"); m.delete("PENDING_DEVICE_ID"); m.delete("PENDING_DEVICE_NAME");
    // The local passphrase is kept (never sent in device-key mode) so switching back doesn't need re-entry in the app.
    const s = loadSettings();
    s.deviceKey = true;
    saveSecrets(m); saveSettings(s);
    out("confirm-fingerprint", "ok", { pinned: "yes", ...(rotated ? { replaced: "previous_pin" } : {}) });
    await pushPin(s, m); // a deployed Worker gets the pin now, so nobody types it into `secret put`
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
    const mode = gatewayMode(s, m);
    if (mode === "unknown") return out("secrets", "fail", { reason: "gateway_mode_unknown", next: "gateway-check" });
    if (mode === "device_key" && m.has("PENDING_FINGERPRINT")) return out("secrets", "fail", { reason: "fingerprint_not_confirmed", next: "confirm-fingerprint" });
    const { payload, missing } = buildPayload(s, m);
    if (missing.length) return out("secrets", "fail", { reason: "missing", names: missing.join(","), ...(missing.includes("GATEWAY_PINNED_FINGERPRINT") ? { next: "gateway-check_then_confirm-fingerprint" } : {}) });
    if (DRY) {
      // Deployed from here: a read-only `secret list` says exactly which other-mode secrets would be deleted.
      const owned = readJson(ownedPath(s));
      const listed = owned && owned.worker === s.worker ? listedSecrets("secrets") : null;
      const stale = staleFor(mode);
      const wouldRemove = listed ? stale.filter((k) => listed.includes(k)).join(",") || "none" : stale.length ? stale.map((k) => `${k}_if_set`).join(",") : "";
      out("secrets", "dry_run", { gateway_mode: mode, would_set: Object.keys(payload).length, names: Object.keys(payload).join(","), would_remove: wouldRemove, ...showReminder(s, m), ...staleHint(s, m) });
      return warnBoth("worker_secrets", mode, listed, { fix: "secrets_removes_the_other_mode" });
    }
    const acct = account("secrets"); if (!acct) return;
    if (!isClaimed(s, acct)) return out("secrets", "fail", { reason: "run_claim_first" });
    const r = wrangler(["secret", "bulk"], { input: JSON.stringify(payload), step: "secrets" });
    if (r.status !== 0) return out("secrets", "fail", { log: ".relay-local/logs/secrets.log" });
    const names = listedSecrets("secrets") || [];
    warnBoth("worker_secrets", mode, names, { fix: "secrets_removes_the_other_mode" }); // found before the clean-up below
    // The other mode's secrets stay on the Worker until removed (bulk never deletes); delete only what's listed.
    const removed = removeListed("secrets", names, staleFor(mode));
    const absent = Object.keys(payload).filter((k) => !names.includes(k));
    out("secrets", absent.length || removed === "failed" ? "fail" : "ok", { gateway_mode: mode, set: Object.keys(payload).length, absent: absent.join(","), removed: removed || "none", ...showReminder(s, m), ...staleHint(s, m) });
    if (removed !== "failed") warnBoth("worker_secrets", mode, listedSecrets("secrets"), { fix: "delete_the_other_mode_secret_by_hand" }); // still both after the clean-up
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

  /**
   * After google: open the Contacts page so the owner turns on the people the bot may text (everyone starts
   * off). Prints the link, tries to open it, and answers needs_human until the owner says they're done (--done).
   */
  async contacts() {
    const s = /** @type {Record<string, unknown> | null} */ (settingsOrFail("contacts")); if (!s) return;
    const url = `https://${String(s["appHost"])}/contacts`;
    if (DRY) return out("contacts", "dry_run", { url, would_open: "browser" });
    if (args.includes("--done")) return out("contacts", "ok", { url, next: "smoke" });
    console.log(`Open your Contacts page and turn on the people the bot may text (everyone starts off): ${url}`);
    // Same openers as scripts/google-consent.mjs (kept inline: setup-lib is copied on its own in the offline tests).
    const r = process.platform === "darwin" ? spawnSync("open", [url], { stdio: "ignore" })
      : process.platform === "win32" ? spawnSync("cmd", ["/d", "/s", "/c", `start "" "${url}"`], { windowsVerbatimArguments: true, stdio: "ignore" })
      : spawnSync("xdg-open", [url], { stdio: "ignore" });
    out("contacts", "needs_human", { url, opened: r.status === 0 ? "yes" : "no", reason: "turn_on_people_then_rerun_with_--done" });
  },

  async smoke() {
    const s = settingsOrFail("smoke"); if (!s) return;
    if (DRY) {
      out("smoke", "dry_run", { would_check: "app_302,api_log_404,api_send_401,gateway_mode" });
      return gatewayCross("smoke-gateway", s, loadSecrets()); // dry run: devices from RELAY_DRYRUN_DEVICES
    }
    try {
      const a = await fetch(`https://${s.appHost}/log`, { redirect: "manual", signal: AbortSignal.timeout(20_000) });
      const b = await fetch(`https://${s.apiHost}/log`, { redirect: "manual", signal: AbortSignal.timeout(20_000) });
      const c = await relay("/send", { token: "wrong", body: {} });
      const ok = a.status === 302 && b.status === 404 && c.http === 401;
      out("smoke", ok ? "ok" : "fail", { app: a.status, api_log: b.status, api_send: c.http, reason: ok ? "" : (c.http === 503 ? `setting_missing_${c.j?.error || ""}` : "unexpected") });
    } catch { out("smoke", "fail", { reason: "not_reachable_yet", hint: "wait_2_minutes" }); }
    await gatewayCross("smoke-gateway", s, loadSecrets()); // the phone's mode vs. what the Worker was given
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
      if (!good && state === "send_failed") await gatewayCross("test-send-gateway", s, m); // name the likely cause
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
    out("status", "ok", { worker: s.worker || "none", delivery: s.delivery || "none", gateway_mode: gatewayMode(s, m), have: [...m.keys()].join(","), missing: missing.join(",") || "none", claimed: s.worker && isClaimed(s) ? "yes" : "no", ...showReminder(s, m), ...staleHint(s, m) });
    // Deployed from here: a read-only `secret list` (names only) checks the Worker doesn't hold both modes' secrets.
    const owned = s.worker ? readJson(ownedPath(s)) : null;
    if (owned && owned.worker === s.worker && !DRY) warnBoth("worker_secrets", gatewayMode(s, m), listedSecrets("status"), { fix: "run_secrets_to_remove_the_other_mode" });
  },
};

// Run directly (also through symlinked paths such as the macOS TMPDIR): run the step. Imported (tests): nothing.
// A start that names this file but doesn't resolve to it prints a fail status line and exits 70, never a silent 0.
if (mainKind(import.meta.url, (msg) => { out("entry", "fail", { reason: "entry_check_mismatch" }); console.error(msg); }) === "main") {
  const name = args.find((a) => !a.startsWith("--"));
  if (!steps[name]) { out("usage", "fail", { steps: Object.keys(steps).join(",") }); process.exit(3); }
  steps[name]().then(() => process.exit(exitCode), (e) => { log("error", String(e?.stack || e)); out(name, "fail", { reason: "unexpected_error", log: ".relay-local/logs/error.log" }); process.exit(1); });
}
