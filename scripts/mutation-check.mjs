#!/usr/bin/env node
// Prove the tests bite: for each mutant, change ONE guard in the source, run the whole suite, and
// require it to FAIL. The file is restored after every mutant (and on Ctrl-C). Exit 0 only if every
// mutant is killed and every pattern was found.  Usage: npm run mutation [-- name-filter]
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const M = [
  // access (PR #1)
  ["signature", "src/access.ts", 'if (!ok) throw new Error("access_jwt_signature");', ""],
  ["aud", "src/access.ts", 'if (!auds.includes(cfg.aud)) throw new Error("access_jwt_aud");', ""],
  ["iss", "src/access.ts", 'if (payload.iss !== cfg.teamDomain.replace(/\\/$/, "")) throw new Error("access_jwt_iss");', ""],
  ["exp", "src/access.ts", 'if (typeof payload.exp !== "number" || payload.exp < now) throw new Error("access_jwt_expired");', ""],
  ["approver_email", "src/access.ts", 'if (typeof payload.email !== "string" || payload.email.toLowerCase() !== cfg.approverEmail.toLowerCase()) throw new Error("access_wrong_identity");', 'if (typeof payload.email !== "string") throw new Error("access_wrong_identity");'],
  ["email_otp_flag", "src/access.ts", 'if (cfg.allowEmailOtp && idpType === "cloudflare")', 'if (idpType === "cloudflare")'],
  ["policy_fallback_idp", "src/access.ts", 'if (cfg.allowEmailOtp && !("idp" in payload) && !("amr" in payload))', 'if (cfg.allowEmailOtp && !("amr" in payload))'],
  // direct send
  ["direct_flag_check", "src/relay.ts", 'if (!switchOnlyIfOne(this.env.DIRECT_SEND)) throw new Refuse("direct_send_off", 403);', ""],
  ["direct_flag_exact_1", "src/direct.ts", 'return raw === "1";', 'return !!raw && raw !== "0";'],
  ["guard_unset_is_on", "src/direct.ts", 'return raw !== "0";', 'return raw === "1";'],
  ["disabled_kill_switch", "src/relay.ts", 'if (this.env.DISABLED === "1") throw new Refuse("relay_disabled", 503);', ""],
  ["to_not_on_list", "src/relay.ts", "const hit = list.find((r) => r.e164 === to);", "const hit = list.find((r) => r.e164 === to) ?? list[0];"],
  ["tap_allowlist_in_union", "src/relay.ts", "await add(this.env.ALLOWLIST);", ""],
  ["snapshot_only_gate", "src/relay.ts", "if (!switchOnUnlessZero(this.env.CONTACTS_SNAPSHOT_ONLY)) await add(this.env.DIRECT_ALLOWLIST);", "await add(this.env.DIRECT_ALLOWLIST);"],
  ["direct_group_array", "src/relay.ts", 'if (Array.isArray(to)) throw new Refuse("group_send_not_allowed");\n      if (typeof to !== "string") throw new Refuse("recipient_required");\n      if (/[,;\\s]/', 'if (typeof to !== "string") throw new Refuse("recipient_required");\n      if (/[,;\\s]/'],
  ["name_ambiguous_sends", "src/relay.ts", "if (hits.length > 1 || resolve) {", "if (hits.length > 99 || resolve) {"],
  ["name_prefix_match", "src/direct.ts", "return rows.filter((r) => r.name_norm === q ||", "return rows.filter((r) => r.name_norm.startsWith(q) ||"],
  ["name_diacritics", "src/direct.ts", '.normalize("NFKD").replace(/\\p{M}/gu, "")', ""],
  ["candidate_single_use", "src/relay.ts", 'this.sql.exec("UPDATE candidates SET used=1 WHERE grp=?", grp);', ""],
  ["candidate_siblings", "src/relay.ts", '"UPDATE candidates SET used=1 WHERE grp=?", grp', '"UPDATE candidates SET used=1 WHERE id=?", candidate'],
  ["candidate_cap", "src/relay.ts", 'if (live + hits.length > MAX_LIVE_CANDIDATES) throw new Refuse("too_many_candidates", 429);', ""],
  ["candidate_expiry", "src/relay.ts", "if (now >= c.expires_ms) throw", "if (false) throw"],
  ["runaway_threshold", "src/relay.ts", "if (recent >= cfg.runawayMax) {", "if (recent > cfg.runawayMax) {"],
  ["runaway_persisted", "src/relay.ts", 'if (this.meta("direct_paused") === "1") return', 'if (false) return'],
  ["resume_csrf", "src/relay.ts", 'if (!want || form.get("csrf") !== want) throw new Refuse("bad_csrf", 403);', 'if (!want) throw new Refuse("bad_csrf", 403);'],
  ["resume_origin", "src/relay.ts", "this.sameOrigin(req, false);", ""],
  ["daily_cap", "src/relay.ts", ">= cfg.daily)", "> cfg.daily)"],
  ["per_minute", "src/relay.ts", ">= cfg.perMinute)", "> cfg.perMinute)"],
  ["hours_window", "src/relay.ts", "if (cfg.hours && !insideHours(", "if (false && !insideHours("],
  ["limit_fail_closed", "src/direct.ts", 'if (!/^[0-9]{1,6}$/.test(raw)) throw new Refuse("direct_config_invalid", 503);', "if (!/^[0-9]{1,6}$/.test(raw)) return null;"],
  ["direct_log_no_number", "src/relay.ts", "detail: `${who} gateway_id=${gid}`", "detail: `${who} to=${target.e164} gateway_id=${gid}`"],
  ["response_no_number", "src/direct.ts", '|| /\\d{4,}/.test(name) || hasLink(name)', '|| false || hasLink(name)'],
  ["approve_page_masked", "src/relay.ts", "(${esc(maskNumber(r.recipient))})", "(${esc(r.recipient)})"],
  ["upload_requires_json", "src/relay.ts", 'throw new Refuse("contacts_must_be_json", 415);', "{}"],
  ["upload_empty_keeps_old", "src/relay.ts", 'if (!snap.rows.length) throw new Refuse("contacts_snapshot_invalid_empty", 400);', ""],
  ["upload_unknown_fields", "src/direct.ts", 'if (Object.keys(o).some((k) => k !== "name" && k !== "given" && k !== "numbers")) bad("unknown_field");', ""],
  // contacts sync
  ["sync_empty_keeps_old", "src/relay.ts", 'if (!snap.rows.length) throw new Error("empty_result");', ""],
  ["sync_name_precedence", "src/relay.ts", "const order = [...parseAccounts(this.env.GOOGLE_ACCOUNTS).valid, UPLOAD_SOURCE];", "const order = [...parseAccounts(this.env.GOOGLE_ACCOUNTS).valid.reverse(), UPLOAD_SOURCE];"],
  ["sync_missing_secret", "src/relay.ts", "if (!rt) {\n        failed.push", "if (false) {\n        failed.push"],
  ["sync_label_charset", "src/direct.ts", "if (!/^[A-Z0-9_]+$/.test(label) ||", "if ("],
  // review round
  ["hmac_key_required", "src/relay.ts", "if (!key) {\n      // Fail closed", "if (false) {\n      // Fail closed"],
  ["hmac_key_min_length", "src/relay.ts", "secret.length < 32", "secret.length < 1"],
  ["hmac_num_plain_sha", "src/relay.ts", "return hmacHex(key, `num:${e164}`);", "return sha256Hex(e164);"],
  ["hmac_body_plain_sha", "src/relay.ts", "return hmacHex(key, `body:${text}`);", "return sha256Hex(text);"],
  ["tap_log_hmac", "src/relay.ts", "return key ? `hmac:${await this.bodyHash(key, text)}` : sha256Hex(text);", "return sha256Hex(text);"],
  ["rehash_on_rotation", "src/relay.ts", 'if (this.meta("hash_key_fp") === fp) return;', 'if (this.meta("hash_key_fp") !== null) return;'],
  ["sync_route_checks", "src/relay.ts", 'const who = await this.directForm(req, "sync");', 'const who = await this.requireOwner(req, "sync");'],
  ["sync_now_no_alert", "src/relay.ts", "await this.syncContacts({ alert: false });", "await this.syncContacts();"],
  ["alarm_disabled_purge_only", "src/relay.ts", 'if (this.env.DISABLED === "1") {\n      // Kill switch: retention only.', 'if (false) {\n      // Kill switch: retention only.'],
  ["resolve_never_sends", "src/relay.ts", "if (hits.length > 1 || resolve) {", "if (hits.length > 1) {"],
  ["link_strip_cf", "src/rules.ts", 'return text.replace(/\\p{Cf}/gu, "").normalize("NFKC").replace(/\\p{Cf}/gu, "").replace(DOTS, ".");', 'return text.normalize("NFKC").replace(DOTS, ".");'],
  ["link_dots", "src/rules.ts", '.replace(DOTS, ".");', ";"],
  ["link_ipv4", "src/rules.ts", "return LINK.test(t) || IPV4.test(t);", "return LINK.test(t);"],
  ["notice_label_link", "src/relay.ts", 'if (hasLink(label)) label = "";', ""],
  ["name_link_hidden", "src/direct.ts", '|| hasLink(name) ? "(unnamed contact)"', '? "(unnamed contact)"'],
  ["fax_pager_dropped", "src/direct.ts", "if (FAX_OR_PAGER.test(compact)) return null;", ""],
  ["fax_pager_dropped_script", "scripts/import-contacts.mjs", "if (/fax|pager/.test(compact)) return null;", ""],
  ["snapshot_label_no_fax", "src/direct.ts", ' || FAX_OR_PAGER.test(p.label.replace(/ /g, ""))) bad("label");', ') bad("label");'],
  ["removed_label_purged", "src/relay.ts", 'this.sql.exec("DELETE FROM contact_sources WHERE account=?", a);', ""],
  ["lookup_rate_limit", "src/relay.ts", "if (n >= max) {", "if (false) {"],
  ["lookup_rate_no_log", "src/relay.ts", "r.silent = true;", ""],
  ["lookup_rate_buckets", "src/relay.ts", 'const kind = st.authed ? "auth" : "unauth";', 'const kind = "auth";'],
  ["gateway_bad_json", "src/relay.ts", 'return jsonOr(r, "gateway_bad_json");', "return r.json();"],
  ["error_codes_only", "src/relay.ts", 'return /^[a-z][a-z0-9_]{0,79}$/.test(m) ? m : "unexpected_error";', 'return m || "error";'],
  ["consent_scope_exact", "scripts/google-consent.mjs", "if (granted.length !== 1 || granted[0] !== SCOPE) {", "if (false) {"],
  // template settings: every switch and required setting has a mutant
  ["timezone_checked_first", "src/relay.ts", "this.tz(); // required config: refuse every route until TIMEZONE is a valid IANA zone", ""],
  ["timezone_no_default", "src/rules.ts", 'if (typeof raw !== "string" || raw.trim() === "") throw new Refuse("timezone_not_configured", 503);', 'if (typeof raw !== "string" || raw.trim() === "") return "UTC";'],
  ["timezone_intl_check", "src/rules.ts", 'new Intl.DateTimeFormat("en-US", { timeZone: raw }).format(0);', ""],
  ["block_links_tap", "src/rules.ts", 'if (blockLinks && hasLink(text)) throw new Refuse("links_not_allowed");', ""],
  ["block_links_tap_wired", "src/relay.ts", "validateRequestBody(body, allow, cfg.maxChars, blockLinks)", "validateRequestBody(body, allow, cfg.maxChars)"],
  ["block_links_direct", "src/direct.ts", 'if (blockLinks && hasLink(body)) throw new Refuse("links_not_allowed");', ""],
  ["block_links_default_off", "src/rules.ts", 'if (raw === undefined || raw === "" || raw === "0") return false;', 'if (raw === "0") return false;\n  if (raw === undefined || raw === "") return true;'],
  ["switch_garbage_fail_closed", "src/rules.ts", "throw new Refuse(code, 503);", "return false;"],
  ["tap_pending_cap_var", "src/rules.ts", "parseCount(e.PENDING_CAP_PER_DAY, d.pendingPerDay, 1, 100000)", "d.pendingPerDay"],
  ["tap_cap_initial_var", "src/rules.ts", "parseCount(e.SEND_CAP_INITIAL, d.capInitial, 1, 100000)", "d.capInitial"],
  ["tap_cap_after_var", "src/rules.ts", "parseCount(e.SEND_CAP_AFTER, d.capAfter, 1, 100000)", "d.capAfter"],
  ["tap_raise_days_var", "src/rules.ts", "parseCount(e.CAP_RAISE_AFTER_DAYS, d.raiseAfterDays, 0, 3650)", "d.raiseAfterDays"],
  ["tap_ttl_var", "src/rules.ts", "parseCount(e.REQUEST_TTL_SECONDS, d.ttlSeconds, 60, 86400)", "d.ttlSeconds"],
  ["tap_spacing_var", "src/rules.ts", "parseCount(e.MIN_SECONDS_BETWEEN_SENDS, d.minSecondsBetween, 0, 86400)", "d.minSecondsBetween"],
  ["tap_max_chars_var", "src/rules.ts", "parseCount(e.MAX_TEXT_CHARS, d.maxChars, 1, 10000)", "d.maxChars"],
  ["direct_max_chars_var", "src/relay.ts", "const maxChars = parseCount(this.env.MAX_TEXT_CHARS, 640, 1, 10000);", "const maxChars = 640;"],
  ["count_garbage_fail_closed", "src/rules.ts", 'if (!/^[0-9]{1,7}$/.test(raw)) throw new Refuse("config_invalid", 503);', "if (!/^[0-9]{1,7}$/.test(raw)) return def;"],
  ["count_range", "src/rules.ts", 'if (n < min || n > max) throw new Refuse("config_invalid", 503);', ""],
  ["tap_cfg_at_approve", "src/relay.ts", "const cfg = this.tapCfg(); // a garbage tap setting refuses the approval", "const cfg = parseTapConfig({}); //"],
  ["direct_cap_unset_none", "src/direct.ts", 'if (raw === undefined || raw === "" || /^off$/i.test(raw)) return null;\n  if (!/^[0-9]{1,6}$/', 'if (raw === undefined || raw === "") return 5;\n  if (/^off$/i.test(raw)) return null;\n  if (!/^[0-9]{1,6}$/'],
  ["country_code_required_sync", "src/relay.ts", "if (ccError) {", "if (false) {"],
  ["country_code_no_silent_plus1", "src/direct.ts", 'throw new Refuse("default_country_code_invalid", 503);', 'return "+1";'],
  ["country_code_applied", "src/direct.ts", 'else out = cc + digits.replace(/^0/, "");', 'else out = "+1" + digits;'],
  ["country_code_strict", "src/direct.ts", "else if (cc === null || !digits) return null;", 'else if (!digits) return null;\n  else if (cc === null) out = "+1" + digits;'],
  ["country_code_script", "scripts/import-contacts.mjs", 'else out = cc + digits.replace(/^0/, "");', 'else out = "+1" + digits;'],
  ["country_code_script_required", "scripts/import-contacts.mjs", 'throw new Error("country code required (+44, +1... or null for strict)");', 'cc = "+1";'],
  ["owner_number_checked", "src/relay.ts", 'if (!E164.test(owner)) throw new Error("owner_number_not_configured");', ""],
  ["consent_url_printed", "scripts/google-consent.mjs", "  log(url);\n", ""],
  ["consent_opener_linux", "scripts/google-consent.mjs", 'return { cmd: "xdg-open", args: [url], opts: {} };', 'return { cmd: "open", args: [url], opts: {} };'],
  ["consent_opener_windows", "scripts/google-consent.mjs", 'if (platform === "win32") return {', "if (false) return {"],
  ["consent_opener_nonfatal", "scripts/google-consent.mjs", "  } catch {\n    r = null;\n  }", "  } catch (e) {\n    throw e;\n  }"],
  ["template_direct_send_on", "wrangler.toml", 'DIRECT_SEND = "1"', 'DIRECT_SEND = "0"'],
  ["template_email_otp_normal", "wrangler.toml", 'ALLOW_EMAIL_OTP = "1"', 'ALLOW_EMAIL_OTP = "0"'],
  ["template_no_default_zone", "wrangler.toml", 'TIMEZONE = "REPLACE_WITH_IANA_TIMEZONE"', 'TIMEZONE = "America/New_York"'],
  ["template_no_default_country", "wrangler.toml", 'DEFAULT_COUNTRY_CODE = "REPLACE_WITH_COUNTRY_CODE"', 'DEFAULT_COUNTRY_CODE = "+1"'],
  ["template_block_links_off", "wrangler.toml", '# BLOCK_LINKS = "1"', 'BLOCK_LINKS = "1"'],
  ["template_no_daily_cap", "wrangler.toml", '# DIRECT_DAILY_CAP = "25"', 'DIRECT_DAILY_CAP = "25"'],
];

const only = process.argv[2];
const originals = new Map();
const restore = () => { for (const [f, s] of originals) writeFileSync(f, s); };
process.on("SIGINT", () => { restore(); process.exit(130); });
let bad = 0;
for (const [name, file, from, to] of M) {
  if (only && !name.includes(only)) continue;
  if (!originals.has(file)) originals.set(file, readFileSync(file, "utf8"));
  const src = originals.get(file);
  if (!src.includes(from)) { console.log(`MUTANT ${name}: PATTERN NOT FOUND in ${file}`); bad++; continue; }
  writeFileSync(file, src.replace(from, to));
  const r = spawnSync("npx", ["vitest", "run"], { stdio: "ignore" });
  writeFileSync(file, src);
  if (r.status === 0) { console.log(`MUTANT ${name}: SURVIVED (tests still pass)`); bad++; }
  else console.log(`MUTANT ${name}: killed`);
}
restore();
console.log(bad ? `${bad} mutant(s) not killed` : "all mutants killed");
process.exit(bad ? 1 : 0);
