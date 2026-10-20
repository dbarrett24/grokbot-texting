import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import { encryptField as encryptFieldRsa, fingerprint, sha256Hex, hex, hmacHex, importHmacKey } from "./e2e";
import { checkPassphrase, encryptFieldPassphrase, parseIterations } from "./passphrase";
import { verifyAccess, type Net } from "./access";
import { aadFor, decodeAccountRow, decodeClientBlob, decodeClientRow, importTokenKey, isClientId, isClientSecret, isLabel, open, seal, type GoogleClient, type TokenKey } from "./google";
import {
  CSRF_TTL_MS, GONE_KEEP_MS, LEGACY_SOURCE, isContactsPath, isExampleNumber, last4, ownerFromAccess, parseEnableAllBody, parsePrefsBody, renderContactsPage, type Owner,
} from "./contacts";
import { E164, Refuse, hasLink, localDate, maskNumber, parseAllowlist, parseCount, parseSwitch, parseTapConfig, parseTimezone, sendCap, validateRequestBody, validateTapText, type TapConfig } from "./rules";
import {
  insideHours, matchName, parseRequiredLimit, minuteOfDay, normalizeName, parseHours, parseNotifyEach, parseOptionalLimit, parseSnapshot,
  safeName, switchOnUnlessZero, switchOnlyIfOne, validateBody, parseAccounts, parseCountryCode, peopleToContacts, UPLOAD_SOURCE, type ContactRow, type SnapshotContact,
  echoName, entryRefuse, parseGroupMms, parseMultiList, type MultiField,
} from "./direct";
import {
  CLAIM_TIMEOUT_MS, ConfigRefuse, DEVICE_DEFAULT_DAILY_CAP, DEVICE_SWEEP_MS, STALE_AFTER_MS, TAP_PING_TEXT,
  checkDeviceNotify, deviceTokenProblem, isDevice, parseUnclaimedExpiryMs, parseDelivery, parseOutcome, parseShortcutPing, pingMime, safeDetail, shortcutRunUrl,
  type Delivery, type JobState, type Outcome,
} from "./device";

const HOUR = 3_600_000;
const CANDIDATE_TTL_MS = 15 * 60_000;
const MAX_LIVE_CANDIDATES = 200;
type Via = "name" | "candidate" | "number" | "names" | "candidates";
/** single = the original one-recipient send; copies = multi-send as separate 1:1 texts; group = one group MMS. */
type SendMode = "single" | "copies" | "group";
type Target = { e164: string; e164_sha: string; name: string };
type DirectCfg = { daily: number | null; perMinute: number | null; hours: { start: number; end: number } | null; notifyEach: boolean; runaway: boolean; runawayMax: number; groupMms: boolean };
/** Outcome of the direct-send transaction. */
type DirectPlan = { kind: "send" } | { kind: "refuse"; reason: string; status: number; newlyPaused: boolean };

type State = "pending" | "approved_sending" | "queued_device" | "sent" | "send_failed" | "send_uncertain" | "denied";
/** Who a device job belongs to: a tap approval or a direct send. Owner notices never go through the device. */
type JobKind = "tap" | "direct";
interface Job {
  id: string;
  kind: JobKind;
  ref: string | null;
  who: string | null;
  sha: string | null;
  state: JobState;
  lease: string | null;
}
/** Result of the last hop: sent now through the gateway, or queued for the owner's device. */
type Delivered = { queued: false; gid: string } | { queued: true; job: string };

interface Row {
  id: string;
  created_ms: number;
  expires_ms: number;
  created_day: string;
  recipient: string;
  text: string;
  sha256: string;
  csrf: string;
  state: State;
  decided_ms: number | null;
  gateway_id: string | null;
  via?: string | null; // "contacts" = filed by to_name / candidate_id; NULL = filed by number (ALLOWLIST)
  to_label?: string | null; // contact name for the approve page (never a number)
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

/** A SQL text column, or "" for anything else (NULL, a number, a blob). */
const textOf = (v: unknown): string => (typeof v === "string" ? v : "");

/** Migrated rows the banner counts and "turn all migrated off" acts on. One predicate so the page and the action can't drift. */
const MIGRATED_ON = "migrated=1 AND enabled=1 AND gone_ms IS NULL";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

async function tokenEquals(a: string, b: string): Promise<boolean> {
  // Hash both sides so the comparison is constant-length, then compare without early exit.
  const [x, y] = await Promise.all([sha256Hex(a), sha256Hex(b)]);
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return d === 0 && a.length > 0 && b.length > 0;
}

/**
 * The whole relay lives in ONE Durable Object instance. A DO processes requests one at a
 * time with input gates, so caps and the single-use transition cannot race.
 */
/**
 * Log-safe error code: our own errors are snake_case codes; anything else (a runtime or network message,
 * which could quote a response body) becomes "unexpected_error". Never a snippet of a gateway reply.
 */
export function errCode(e: unknown): string {
  const m = e instanceof Error ? e.message : "";
  return /^[a-z][a-z0-9_]{0,79}$/.test(m) ? m : "unexpected_error";
}
/** Parse a JSON reply or throw a fixed code (never the body). */
async function jsonOr(r: Response, code: string): Promise<any> {
  try {
    return await r.json();
  } catch {
    throw new Error(code);
  }
}

export class Relay extends DurableObject<Env> {
  /** Outbound network. Tests replace this; production uses global fetch. */
  net: Net = (r) => fetch(r);
  /** Clock. Tests replace this. */
  clock: () => number = () => Date.now();
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS requests(
      id TEXT PRIMARY KEY, created_ms INTEGER, expires_ms INTEGER, created_day TEXT,
      recipient TEXT, text TEXT, sha256 TEXT, csrf TEXT, state TEXT,
      decided_ms INTEGER, gateway_id TEXT)`);
    // Added for tap requests filed by contact name. ALTER throws when the column already exists.
    for (const col of ["via TEXT", "to_label TEXT"]) {
      try {
        this.sql.exec(`ALTER TABLE requests ADD COLUMN ${col}`);
      } catch {
        // already there
      }
    }
    this.sql.exec(`CREATE TABLE IF NOT EXISTS sends(ms INTEGER, day TEXT, request_id TEXT)`);
    // DIRECT_SEND state. contacts = the uploaded snapshot (name + E.164 + label only). direct_sends holds
    // only the HMAC (LOG_HASH_KEY) of the number. candidates map an opaque id to that HMAC, single use, 15 minutes.
    // e164_sha columns hold that HMAC; NULL until the first direct request after a load or a key change.
    // contact_sources = each source's last good list (one per Google account, plus UPLOAD from the uploader).
    // contacts = the merged direct list, rebuilt from contact_sources whenever a source changes.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS contact_sources(account TEXT, name TEXT, name_norm TEXT, given_norm TEXT, first_norm TEXT, e164 TEXT, e164_sha TEXT, label TEXT)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS contacts(name TEXT, name_norm TEXT, given_norm TEXT, first_norm TEXT, e164 TEXT, e164_sha TEXT, label TEXT)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS direct_sends(ms INTEGER, day TEXT, to_sha TEXT)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS candidates(id TEXT PRIMARY KEY, grp TEXT, to_sha TEXT, expires_ms INTEGER, used INTEGER)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT)`);
    // /send outcomes that aren't a send (lookups and refusals), for the hourly rate limit. kind: auth | unauth.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS nonsend(ms INTEGER, kind TEXT)`);
    // DELIVERY=mac|shortcut: jobs for the owner's device. text is NULL from the moment a job is claimed.
    // state only moves forward: queued -> claimed -> an outcome, or queued -> expired, or claimed -> claim_timeout.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS device_jobs(id TEXT PRIMARY KEY, created_ms INTEGER, kind TEXT, ref TEXT,
      recipient TEXT, text TEXT, state TEXT, lease TEXT, claimed_ms INTEGER, done_ms INTEGER, who TEXT, sha TEXT)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS log(seq INTEGER PRIMARY KEY AUTOINCREMENT, ms INTEGER,
      event TEXT, request_id TEXT, recipient TEXT, sha256 TEXT, detail TEXT)`);
    // Contacts page. contact_prefs: one row per number, keyed by HMAC(LOG_HASH_KEY, number) (= e164_sha), so a
    // re-sync, rename or source change can't flip anyone on. enabled defaults to 0 (off). gone_ms = number left
    // every source; the row is kept 30 days so a quick re-add gets its old state back.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS contact_prefs(person_key TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0,
      starred INTEGER NOT NULL DEFAULT 0, updated_ms INTEGER, by TEXT, migrated INTEGER NOT NULL DEFAULT 0, first_seen_ms INTEGER, gone_ms INTEGER)`);
    // Numbers to switch on (enabled=1) or flag (enabled=0) once a hash key is available. Filled by the upgrade migration.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS contacts_migration(e164 TEXT PRIMARY KEY, enabled INTEGER NOT NULL)`);
    // Contacts page CSRF: per page load, reusable for 15 minutes, bound to the Access identity.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS page_csrf(token TEXT PRIMARY KEY, email TEXT, expires_ms INTEGER)`);
    // Google connect: refresh tokens and the pasted OAuth client, AES-GCM sealed under GOOGLE_TOKEN_KEY (src/google.ts).
    this.sql.exec(`CREATE TABLE IF NOT EXISTS google_accounts(label TEXT PRIMARY KEY, email TEXT, rt_ct TEXT NOT NULL, rt_iv TEXT NOT NULL, scope TEXT NOT NULL, connected_ms INTEGER NOT NULL, key_ver TEXT NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS google_client(id INTEGER PRIMARY KEY CHECK (id = 1), blob_ct TEXT NOT NULL, blob_iv TEXT NOT NULL, key_ver TEXT NOT NULL, saved_ms INTEGER NOT NULL)`);
    try {
      this.sql.exec("ALTER TABLE contacts ADD COLUMN account TEXT");
    } catch {
      // already there
    }
    this.migratePrefs();
    // Daily purge so retention holds even with no traffic.
    ctx.blockConcurrencyWhile(async () => {
      if ((await ctx.storage.getAlarm()) === null) await ctx.storage.setAlarm(Date.now() + 86_400_000);
    });
  }

  /**
   * One alarm, two jobs. Daily: purge and contact sync. In a device mode it also fires every minute to time
   * out claims and watch the device (deviceSweep). The daily part runs when its due time has passed.
   */
  async alarm() {
    const wall = Date.now();
    const device = this.deviceModeOrNull() !== null && this.env.DISABLED !== "1";
    if (device) {
      try {
        await this.deviceSweep();
      } catch (e) {
        console.error(`DEVICE_SWEEP_FAILED reason=${errCode(e)}`);
        this.log("device_sweep_failed", { detail: errCode(e) });
      }
    }
    if (wall >= Number(this.meta("daily_due_ms") ?? 0)) {
      await this.daily();
      this.setMeta("daily_due_ms", String(wall + 86_400_000));
    }
    const nextDaily = Number(this.meta("daily_due_ms"));
    await this.ctx.storage.setAlarm(device ? Math.min(nextDaily, wall + DEVICE_SWEEP_MS) : nextDaily);
  }

  private async daily() {
    this.purge(this.clock());
    if (this.env.DISABLED === "1") return; // Kill switch: retention only. No Google calls, no alert texts.
    try {
      await this.syncContacts();
    } catch (e) {
      console.error(`CONTACTS_SYNC_CRASHED reason=${errCode(e)}`);
      this.log("contacts_sync_failed", { detail: `account=ALL reason=${errCode(e)}` });
    }
  }

  /** TIMEZONE (required, no default). fetch() checks it first, so every route refuses while it's missing or invalid. */
  private tz() {
    return parseTimezone(this.env.TIMEZONE);
  }
  /** DELIVERY (unset = android). fetch() checks it first, so a garbage value refuses every route. */
  private delivery(): Delivery {
    return parseDelivery(this.env.DELIVERY);
  }
  /** The device mode, or null for android or a garbage DELIVERY (the alarm must not throw). */
  private deviceModeOrNull(): "mac" | "shortcut" | null {
    try {
      const d = this.delivery();
      return isDevice(d) ? d : null;
    } catch {
      return null;
    }
  }
  /** Tap limits; a garbage value refuses with 503 config_invalid (fail closed). */
  private tapCfg(): TapConfig {
    return parseTapConfig(this.env as unknown as Record<string, string | undefined>);
  }
  /** BLOCK_LINKS: opt-in; "1" refuses links in message text (tap and direct). Garbage refuses with `code`. */
  private blockLinks(code: string): boolean {
    return parseSwitch(this.env.BLOCK_LINKS, code);
  }

  log(event: string, f: { request_id?: string | null; recipient?: string | null; sha256?: string | null; detail?: string | null } = {}) {
    this.sql.exec(
      "INSERT INTO log(ms,event,request_id,recipient,sha256,detail) VALUES(?,?,?,?,?,?)",
      this.clock(), event, f.request_id ?? null, f.recipient ? maskNumber(f.recipient) : null, f.sha256 ?? null, f.detail ?? null,
    );
  }

  /** Retention: request rows (which hold the text) after 7 days; log rows (no text, masked numbers) after 12 months. */
  purge(now: number) {
    this.sql.exec("DELETE FROM requests WHERE created_ms < ?", now - 7 * 86_400_000);
    this.sql.exec("DELETE FROM sends WHERE ms < ?", now - 7 * 86_400_000);
    this.sql.exec("DELETE FROM direct_sends WHERE ms < ?", now - 7 * 86_400_000);
    this.sql.exec("DELETE FROM candidates WHERE expires_ms < ?", now - 86_400_000);
    this.sql.exec("DELETE FROM nonsend WHERE ms < ?", now - HOUR);
    this.sql.exec("DELETE FROM device_jobs WHERE created_ms < ?", now - 7 * 86_400_000);
    const cutoff = new Date(now);
    cutoff.setUTCMonth(cutoff.getUTCMonth() - 12);
    this.sql.exec("DELETE FROM log WHERE ms < ?", cutoff.getTime());
  }

  private get(id: string): Row | null {
    const r = this.sql.exec("SELECT * FROM requests WHERE id=?", id).toArray();
    return (r[0] as unknown as Row) ?? null;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    try {
      if (this.env.DISABLED === "1") throw new Refuse("relay_disabled", 503);
      let delivery: Delivery;
      try {
        this.tz(); // required config: refuse every route until TIMEZONE is a valid IANA zone
        delivery = this.delivery(); // same for DELIVERY
        if (isDevice(delivery)) {
          const bad = deviceTokenProblem(this.env.DEVICE_TOKEN, this.env.REQUEST_TOKEN);
          if (bad) throw new Refuse(bad, 503);
          checkDeviceNotify(this.env.NOTIFY_MODE);
          parseUnclaimedExpiryMs(this.env.UNCLAIMED_EXPIRY_MINUTES);
          if (delivery === "shortcut") parseShortcutPing(this.env.SHORTCUT_PING);
        }
      } catch (e) {
        if (e instanceof Refuse) console.error(`CONFIG_ERROR reason=${e instanceof ConfigRefuse ? e.reason : e.code}`);
        throw e;
      }
      const path = url.pathname;
      const host = url.hostname.toLowerCase();
      const reqHost = (this.env.REQUEST_HOST || "").toLowerCase();
      const apprHost = (this.env.APPROVE_HOST || "").toLowerCase();
      if (!reqHost || !apprHost || reqHost === apprHost) throw new Refuse("hosts_not_configured", 503);
      if (isContactsPath(path)) {
        // Owner-only: every /contacts* path exists on APPROVE_HOST (behind Access) and nowhere else.
        if (host !== apprHost) return json(404, { error: "not_found" });
        return await this.contactsRoute(req, path);
      }
      if (host === reqHost) {
        // Request API host: never serves approve or log routes.
        if (req.method === "POST" && path === "/request") return await this.createRequest(req);
        if (req.method === "POST" && path === "/send") return await this.direct(req);
        if (isDevice(delivery) && req.method === "POST" && path === "/device/next") return await this.deviceNext(req);
        if (isDevice(delivery) && req.method === "POST" && path === "/device/result") return await this.deviceResult(req);
        const m = path.match(/^\/request\/([a-f0-9]{32})$/);
        if (req.method === "GET" && m) return await this.status(req, m[1]);
        return json(404, { error: "not_found" });
      }
      if (host === apprHost) {
        // Approve host (whole host behind Access): never serves /request.
        const m = path.match(/^\/approve\/([a-f0-9]{32})$/);
        if (m && req.method === "GET") return await this.approvePage(req, m[1]);
        if (m && req.method === "POST") return await this.decide(req, m[1]);
        if (req.method === "GET" && path === "/log") return await this.showLog(req);
        if (req.method === "GET" && path === "/direct") return await this.directPage(req);
        if (req.method === "POST" && path === "/direct/resume") return await this.resumeDirect(req);
        if (req.method === "POST" && path === "/direct/sync") return await this.syncNow(req);
        return json(404, { error: "not_found" });
      }
      return json(404, { error: "unknown_host" });
    } catch (e) {
      if (e instanceof Refuse) {
        const reason = e instanceof ConfigRefuse ? e.reason : null;
        if (!e.silent) this.log("refused", { detail: reason ? `${e.code} reason=${reason}` : e.code });
        return json(e.status, { error: e.code, ...(reason ? { reason } : {}), ...(e.extra ?? {}) });
      }
      const msg = e instanceof Error ? e.message : "error";
      if (msg.startsWith("access_")) {
        console.log(`access_denied reason=${msg}`); // code only; shows in wrangler tail. Never the token or claims.
        this.log("access_denied", { detail: msg });
        return json(403, { error: "forbidden" });
      }
      this.log("error", { detail: errCode(e) });
      return json(500, { error: "internal" });
    }
  }

  // ---------- token side (bot) ----------
  private async requireRequestToken(req: Request) {
    const h = req.headers.get("Authorization") || "";
    const m = h.match(/^Bearer (.+)$/);
    if (!this.env.REQUEST_TOKEN) throw new Refuse("not_configured", 503);
    if (!m || !(await tokenEquals(m[1], this.env.REQUEST_TOKEN))) throw new Refuse("bad_request_token", 401);
  }

  private async createRequest(req: Request): Promise<Response> {
    await this.requireRequestToken(req);
    const allow = parseAllowlist(this.env.ALLOWLIST);
    const cfg = this.tapCfg();
    const blockLinks = this.blockLinks("config_invalid");
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      throw new Refuse("body_not_json");
    }
    // Filed by contact name or candidate id instead of a number: looked up in the /send list.
    if (body && typeof body === "object" && !Array.isArray(body) && ("to_name" in body || "candidate_id" in body))
      return this.createNamedRequest(body as Record<string, unknown>, cfg, blockLinks);
    const { to, text } = validateRequestBody(body, allow, cfg.maxChars, blockLinks);
    const now = this.clock();
    const day = localDate(now, this.tz());
    const created = this.sql.exec("SELECT COUNT(*) AS c FROM requests WHERE created_day=?", day).one().c as number;
    if (created >= cfg.pendingPerDay) throw new Refuse("request_cap_reached", 429);
    const id = hex(crypto.getRandomValues(new Uint8Array(16)));
    const csrf = hex(crypto.getRandomValues(new Uint8Array(16)));
    const sha = await sha256Hex(text);
    const expires = now + cfg.ttlSeconds * 1000;
    this.sql.exec(
      "INSERT INTO requests(id,created_ms,expires_ms,created_day,recipient,text,sha256,csrf,state) VALUES(?,?,?,?,?,?,?,?,'pending')",
      id, now, expires, day, to, text, sha, csrf,
    );
    this.purge(now);
    this.log("request_created", { request_id: id, recipient: to, sha256: await this.logBodyHash(text) });
    const notified = await this.notify(id, to, allow.get(to) || "", cfg.ttlSeconds);
    return json(202, { id, state: "pending", expires_ms: expires, sha256: sha, notified });
  }

  private async status(req: Request, id: string): Promise<Response> {
    await this.requireRequestToken(req);
    const r = this.get(id);
    if (!r) return json(404, { error: "not_found" });
    const state = r.state === "pending" && this.clock() >= r.expires_ms ? "expired" : r.state;
    return json(200, { id, state, sha256: r.sha256 }); // never echoes text or number
  }

  private async notify(id: string, to: string, label: string, ttlSeconds: number): Promise<boolean> {
    if (hasLink(label)) label = ""; // a link-like ALLOWLIST label never reaches the notice (always on)
    const msg = `SMS relay: approval needed. To ${maskNumber(to)} ${label}, ref ${id.slice(0, 8)}. Open your relay approve page. Expires in ${Math.max(1, Math.round(ttlSeconds / 60))} min.`;
    try {
      await this.deliverToOwner(msg, "SMS relay approval");
      this.log("notified", { request_id: id, detail: this.env.NOTIFY_MODE === "ntfy" ? "ntfy" : "sms" });
      return true;
    } catch (e) {
      this.log("notify_failed", { request_id: id, detail: errCode(e) });
      return false;
    }
  }

  /** Send a notice to the owner's own phone (sms via the gateway, or authenticated ntfy). Never counts against any cap. */
  private async deliverToOwner(msg: string, title: string): Promise<void> {
    if (this.env.NOTIFY_MODE === "ntfy") {
      // Authenticated ntfy only: refuse to post without a token, so a public topic is never used.
      if (!this.env.NTFY_URL?.startsWith("https://") || !this.env.NTFY_TOKEN) throw new Error("ntfy_not_configured");
      const r = await this.net(new Request(this.env.NTFY_URL, { method: "POST", body: msg, headers: { Authorization: `Bearer ${this.env.NTFY_TOKEN}`, Title: title } }));
      if (!r.ok) throw new Error(`ntfy_status_${r.status}`);
    } else {
      const owner = this.env.OWNER_NUMBER || "";
      if (!E164.test(owner)) throw new Error("owner_number_not_configured");
      // Device modes refuse NOTIFY_MODE=sms (fetch checks it); the alarm path can still get here, so refuse too.
      if (this.deviceModeOrNull()) throw new Error("owner_notice_needs_ntfy_in_device_mode");
      await this.gatewaySend(owner, msg);
    }
  }

  // ---------- direct send (DIRECT_SEND) ----------
  private meta(k: string): string | null {
    const r = this.sql.exec("SELECT v FROM meta WHERE k=?", k).toArray();
    return r.length ? (r[0].v as string) : null;
  }
  private setMeta(k: string, v: string | null) {
    if (v === null) this.sql.exec("DELETE FROM meta WHERE k=?", k);
    else this.sql.exec("INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", k, v);
  }

  /**
   * LOG_HASH_KEY: the HMAC-SHA-256 key for every phone-number hash and every direct body hash, so a leaked
   * log or DO row can't be brute-forced back to a number or a short text. null = missing or under 32 chars.
   */
  private hashKeyCache: { secret: string; key: CryptoKey } | null = null;
  private async hashKey(): Promise<CryptoKey | null> {
    const secret = this.env.LOG_HASH_KEY;
    if (typeof secret !== "string" || secret.length < 32) return null;
    if (this.hashKeyCache?.secret !== secret) this.hashKeyCache = { secret, key: await importHmacKey(secret) };
    return this.hashKeyCache.key;
  }
  private numHash(key: CryptoKey, e164: string) {
    return hmacHex(key, `num:${e164}`);
  }
  private bodyHash(key: CryptoKey, text: string) {
    return hmacHex(key, `body:${text}`);
  }
  /**
   * Tap-flow log rows: "hmac:<hex>" when LOG_HASH_KEY is set, else the plain SHA-256 as before, so the tap flow
   * keeps working without the key. The tap API's sha256 field (and requests.sha256) stays the plain SHA-256 of
   * the text: that's the bot's integrity contract, and the requests row holds the text itself for 7 days anyway.
   */
  private async logBodyHash(text: string): Promise<string> {
    const key = await this.hashKey();
    return key ? `hmac:${await this.bodyHash(key, text)}` : sha256Hex(text);
  }
  /**
   * Upgrade migration, once per deploy ("enable once, flag"): everyone currently on the direct list stays on
   * and is flagged for review. A fresh deploy has no contacts, so it enables no one. Synchronous, in one
   * transaction, from the constructor; the numbers get their pref rows when a hash key is next available.
   */
  migratePrefs() {
    if (this.meta("contacts_prefs_v1") !== null) return;
    this.ctx.storage.transactionSync(() => {
      // Any earlier state means an older version ran here (an upgrade); none means a fresh deploy.
      const prior = this.sql.exec("SELECT (SELECT COUNT(*) FROM meta) + (SELECT COUNT(*) FROM contacts) + (SELECT COUNT(*) FROM log) AS c").one()["c"];
      this.setMeta("deploy_kind", prior === 0 ? "fresh" : "upgrade");
      const nums = this.sql.exec("SELECT DISTINCT e164 FROM contacts").toArray().map((r) => r["e164"] as string);
      for (const n of nums) this.sql.exec("INSERT OR IGNORE INTO contacts_migration(e164,enabled) VALUES(?,1)", n);
      this.setMeta("contacts_prefs_v1", String(this.clock()));
      this.setMeta("hash_key_fp", null);
      this.log("contacts_migrated", { detail: `count=${nums.length}` });
    });
  }

  /**
   * DIRECT_ALLOWLIST is deprecated: imported ONCE as the ALLOWLIST_LEGACY source, flagged. Entries that were
   * textable (CONTACTS_SNAPSHOT_ONLY exactly "0", the old template default) stay on; others are flagged off.
   * Later edits to the secret are ignored (logged); delete it after review.
   */
  private importLegacyAllowlist() {
    const raw = this.env.DIRECT_ALLOWLIST;
    if (this.meta("legacy_allowlist_v1") !== null) return;
    if (!raw) return;
    let entries: [string, string][];
    try {
      entries = [...parseAllowlist(raw)];
    } catch {
      this.log("legacy_allowlist_skipped", { detail: "reason=allowlist_malformed" });
      return;
    }
    // Only an upgrade had textable DIRECT_ALLOWLIST entries. A fresh deploy never auto-enables anyone.
    const wasOn = this.meta("deploy_kind") === "upgrade" && this.env.CONTACTS_SNAPSHOT_ONLY === "0";
    const rows: ContactRow[] = entries.map(([e164, name]) => {
      const n = normalizeName(name);
      return { name, name_norm: n, given_norm: "", first_norm: n.split(" ")[0] ?? "", e164, label: "unlabeled" };
    });
    this.ctx.storage.transactionSync(() => {
      this.replaceSource(LEGACY_SOURCE, rows, this.clock());
      for (const r of rows) this.sql.exec("INSERT OR REPLACE INTO contacts_migration(e164,enabled) VALUES(?,?)", r.e164, wasOn ? 1 : 0);
      this.setMeta("legacy_allowlist_v1", String(this.clock()));
      this.log("legacy_allowlist_imported", { detail: `count=${rows.length} enabled=${wasOn ? rows.length : 0}` });
      this.rebuildContacts();
    });
  }

  /**
   * Fill contact e164_sha with the current key's HMAC. Loads store NULL and clear hash_key_fp, and a key
   * rotation changes the fingerprint, so this runs once per load or rotation, never per request.
   */
  private async ensureContactHashes(key: CryptoKey) {
    this.importLegacyAllowlist();
    const fp = await hmacHex(key, "fingerprint");
    if (this.meta("hash_key_fp") === fp) return;
    const prevFp = this.meta("prefs_key_fp");
    const old = this.sql.exec("SELECT DISTINCT e164, e164_sha FROM contact_sources").toArray() as { e164: string; e164_sha: string | null }[];
    const nums = [...new Set(old.map((r) => r.e164))];
    const hashes = await Promise.all(nums.map((n) => this.numHash(key, n)));
    const fresh = new Map(nums.map((n, i) => [n, hashes[i]]));
    // Key rotation: every stored sha (and so every person_key) was made with the previous key.
    const rotated = prevFp !== null && prevFp !== fp;
    const remap: [string, string][] = [];
    for (const r of old) {
      const to = fresh.get(r.e164);
      if (r.e164_sha !== null && to !== undefined && r.e164_sha !== to) remap.push([r.e164_sha, to]);
    }
    const pending = this.sql.exec("SELECT e164, enabled FROM contacts_migration").toArray() as { e164: string; enabled: number }[];
    const pendingKeys = await Promise.all(pending.map((p) => this.numHash(key, p.e164)));
    const now = this.clock();
    this.ctx.storage.transactionSync(() => {
      nums.forEach((n, i) => this.sql.exec("UPDATE contact_sources SET e164_sha=? WHERE e164=?", hashes[i], n));
      if (rotated) for (const [from, to] of remap) this.sql.exec("UPDATE contact_prefs SET person_key=? WHERE person_key=?", to, from);
      this.rebuildContacts(); // also retires candidates drawn under the old key
      pending.forEach((p, i) =>
        this.sql.exec(
          "INSERT INTO contact_prefs(person_key,enabled,starred,migrated,first_seen_ms,updated_ms,by) VALUES(?,?,0,1,?,?,'migration') ON CONFLICT(person_key) DO UPDATE SET enabled=excluded.enabled, migrated=1",
          pendingKeys[i], p.enabled, now, now,
        ),
      );
      this.sql.exec("DELETE FROM contacts_migration");
      this.syncPrefRows(now);
      this.setMeta("hash_key_fp", fp);
      this.setMeta("prefs_key_fp", fp);
    });
  }

  /** A pref row for every number on the merged list (new ones OFF); numbers that left every source age out after 30 days. */
  private syncPrefRows(now: number) {
    for (const r of this.sql.exec("SELECT DISTINCT e164_sha FROM contacts WHERE e164_sha IS NOT NULL").toArray())
      this.sql.exec("INSERT INTO contact_prefs(person_key,enabled,starred,migrated,first_seen_ms) VALUES(?,0,0,0,?) ON CONFLICT(person_key) DO UPDATE SET gone_ms=NULL", r["e164_sha"] as string, now);
    this.sql.exec("UPDATE contact_prefs SET gone_ms=? WHERE gone_ms IS NULL AND person_key NOT IN (SELECT e164_sha FROM contacts WHERE e164_sha IS NOT NULL)", now);
    this.sql.exec("DELETE FROM contact_prefs WHERE gone_ms IS NOT NULL AND gone_ms < ?", now - GONE_KEEP_MS);
  }

  /**
   * Who /send may text: the union, deduped by E.164 in this order (first wins the name):
   *   1. contacts the owner switched ON on the Contacts page (Google sync, upload, imported DIRECT_ALLOWLIST)
   *   2. the tap ALLOWLIST (always: anyone the owner can approve by tap can also be sent to directly)
   */
  private async directList(key: CryptoKey): Promise<(ContactRow & { e164_sha: string })[]> {
    await this.ensureContactHashes(key);
    const rows = this.sql.exec("SELECT c.name,c.name_norm,c.given_norm,c.first_norm,c.e164,c.e164_sha,c.label FROM contacts c JOIN contact_prefs p ON p.person_key=c.e164_sha WHERE p.enabled=1").toArray() as unknown as (ContactRow & { e164_sha: string })[];
    const have = new Set(rows.map((r) => r.e164));
    const add = async (raw: string | undefined) => {
      if (!raw) return; // unset = empty; malformed JSON still refuses (allowlist_malformed)
      for (const [e164, name] of parseAllowlist(raw)) {
        if (have.has(e164)) continue;
        have.add(e164);
        const n = normalizeName(name);
        rows.push({ name, name_norm: n, given_norm: "", first_norm: n.split(" ")[0] ?? "", e164, e164_sha: await this.numHash(key, e164), label: "unlabeled" });
      }
    };
    await add(this.env.ALLOWLIST);
    return rows;
  }

  /**
   * POST /send (request host, REQUEST_TOKEN). Body: exactly one of {to_name}, {candidate_id} or {to}, plus {body}.
   * Never echoes a phone number. See README "Direct send" for the full decision table.
   */
  private async direct(req: Request): Promise<Response> {
    const st = { authed: false, gated: false };
    try {
      return await this.directInner(req, st);
    } catch (e) {
      // Every refusal counts toward the hourly lookup/refusal limit. Over it: 429 lookup_rate, no log row.
      if (e instanceof Refuse && !e.silent && !st.gated) this.nonSendGate(st);
      throw e;
    }
  }

  /**
   * Lookups and refusals on /send, at most DIRECT_LOOKUP_MAX_PER_HOUR (default 30, "off" = none) per rolling
   * hour; successful sends never count and are never limited. Requests without a valid REQUEST_TOKEN use
   * their own bucket, so a flood of bad tokens can't use up the bot's lookups. Over the limit: 429 lookup_rate,
   * answered WITHOUT a log row (that's the point: no log flooding).
   */
  private nonSendGate(st: { authed: boolean; gated: boolean }, units = 1) {
    st.gated = true;
    const raw = this.env.DIRECT_LOOKUP_MAX_PER_HOUR;
    let max: number | null = 30;
    try {
      if (raw !== undefined && raw !== "") max = parseOptionalLimit(raw);
    } catch {
      max = 30; // garbage: keep the default limit (fail closed); direct() refuses the config anyway
    }
    const now = this.clock();
    const kind = st.authed ? "auth" : "unauth";
    if (max !== null) {
      const n = this.sql.exec("SELECT COUNT(*) AS c FROM nonsend WHERE kind=? AND ms > ?", kind, now - HOUR).one().c as number;
      if (n + units > max) {
        const r = new Refuse("lookup_rate", 429);
        r.silent = true;
        throw r;
      }
    }
    for (let i = 0; i < units; i++) this.sql.exec("INSERT INTO nonsend(ms,kind) VALUES(?,?)", now, kind);
  }

  private async directInner(req: Request, st: { authed: boolean; gated: boolean }): Promise<Response> {
    await this.requireRequestToken(req);
    st.authed = true;
    if (!switchOnlyIfOne(this.env.DIRECT_SEND)) throw new Refuse("direct_send_off", 403);
    const key = await this.hashKey();
    if (!key) {
      // Fail closed: without the key, number and body hashes would be brute-forceable.
      console.error("DIRECT_CONFIG_INVALID reason=log_hash_key_missing_or_short");
      throw new Refuse("direct_config_invalid", 503);
    }
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      throw new Refuse("body_not_json");
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Refuse("body_must_be_object");
    const b = raw as Record<string, unknown>;
    if (Object.keys(b).some((k) => !["to", "to_name", "candidate_id", "to_names", "candidate_ids", "body", "resolve", "group"].includes(k))) throw new Refuse("unknown_fields");
    // Exactly one recipient form of all five (the code name predates the two multi-send forms).
    const keys = ["to", "to_name", "candidate_id", "to_names", "candidate_ids"].filter((k) => k in b);
    if (keys.length !== 1) throw new Refuse("exactly_one_of_to_to_name_candidate_id");
    const multi = keys[0] === "to_names" || keys[0] === "candidate_ids";
    // group: true = ONE group MMS instead of separate copies. Multi-send forms only, behind GROUP_MMS.
    if ("group" in b && b.group !== true) throw new Refuse("group_must_be_true");
    if ("group" in b && !multi) throw new Refuse("group_needs_to_names_or_candidate_ids");
    const group = b.group === true;
    // resolve: true = look the name up and return candidate ids only; never sends. The bot reads the name
    // back to the owner, then sends by candidate_id. body is optional here (checked if given).
    if ("resolve" in b && b.resolve !== true) throw new Refuse("resolve_must_be_true");
    const resolve = b.resolve === true;
    if (resolve && !("to_name" in b) && !("to_names" in b)) throw new Refuse("resolve_needs_to_name");
    const maxChars = parseCount(this.env.MAX_TEXT_CHARS, 640, 1, 10000);
    const blockLinks = this.blockLinks("direct_config_invalid");
    const text = resolve ? (b.body === undefined ? "" : validateBody(b.body, maxChars, blockLinks)) : validateBody(b.body, maxChars, blockLinks);
    // Optional limits and guards: parse now so a bad value refuses before anything is stored (fail closed).
    const cfg = {
      daily: this.directDailyCap(),
      lookupMax: parseOptionalLimit(this.env.DIRECT_LOOKUP_MAX_PER_HOUR), // checked here so garbage refuses
      perMinute: parseOptionalLimit(this.env.DIRECT_PER_MINUTE_MAX),
      hours: parseHours(this.env.DIRECT_HOURS),
      notifyEach: parseNotifyEach(this.env.DIRECT_NOTIFY_EACH),
      runaway: switchOnUnlessZero(this.env.RUNAWAY_PAUSE),
      runawayMax: this.env.RUNAWAY_MAX === undefined ? 10 : parseRequiredLimit(this.env.RUNAWAY_MAX),
      groupMms: parseGroupMms(this.env.GROUP_MMS),
    };
    // Group MMS needs the SMS Gateway (one mmsMessage request). The Mac and Shortcut paths send one 1:1 text per
    // job, so a group request is refused here, before the contact list is read or anything is counted.
    if (group && isDevice(this.delivery())) throw new Refuse("group_mms_unsupported_delivery", 409);
    if (group && !cfg.groupMms) throw new Refuse("group_mms_off", 403);
    // Group sends must be able to keep the owner's own number out of the thread. With OWNER_NUMBER unset
    // or not E.164 that check can't run, so every group request is refused (it never silently turns off).
    if (group && !E164.test(this.env.OWNER_NUMBER ?? "")) {
      console.error("CONFIG_ERROR reason=group_mms_needs_owner_number");
      throw new Refuse("config_invalid", 503);
    }
    const now = this.clock();
    const list = await this.directList(key);
    if (multi) return this.directMulti(b, keys[0] as MultiField, list, text, resolve, group, cfg, now, key, st);
    let target: { e164: string; e164_sha: string; name: string };
    let via: Via;
    let candidate: string | null = null;
    if ("to" in b) {
      via = "number";
      const to = b.to;
      if (Array.isArray(to)) throw new Refuse("group_send_not_allowed");
      if (typeof to !== "string") throw new Refuse("recipient_required");
      if (/[,;\s]/.test(to.trim())) throw new Refuse("group_send_not_allowed");
      if (!E164.test(to)) throw new Refuse("recipient_must_be_one_e164_number");
      const hit = list.find((r) => r.e164 === to);
      if (!hit) {
        // On neither list: refused. Never queued for approval, never sent.
        this.nonSendGate(st);
        this.log("direct_refused", { detail: `method=direct via=number to_hmac=${await this.numHash(key, to)} reason=recipient_not_on_allowlist` });
        throw new Refuse("recipient_not_on_allowlist", 403);
      }
      target = hit;
    } else if ("to_name" in b) {
      via = "name";
      if (Array.isArray(b.to_name)) throw new Refuse("group_send_not_allowed");
      if (typeof b.to_name !== "string" || b.to_name.length > 200) throw new Refuse("to_name_invalid");
      const hits = matchName(list, b.to_name);
      if (hits.length === 0) {
        // There's no number, so nothing is sent and nothing is queued.
        this.nonSendGate(st);
        this.log("direct_lookup", { detail: "method=direct via=name result=no_match" });
        return json(200, { state: "no_match", candidates: [] });
      }
      if (hits.length > 1 || resolve) {
        this.nonSendGate(st); // before any candidate is stored
        // Bound the table: expired ids go first, then too many live ones refuse further lookups.
        this.sql.exec("DELETE FROM candidates WHERE expires_ms <= ?", now);
        const live = this.sql.exec("SELECT COUNT(*) AS c FROM candidates WHERE used=0").one().c as number;
        if (live + hits.length > MAX_LIVE_CANDIDATES) throw new Refuse("too_many_candidates", 429);
        const grp = hex(crypto.getRandomValues(new Uint8Array(16)));
        const candidates = hits.map((r) => {
          const id = hex(crypto.getRandomValues(new Uint8Array(16)));
          this.sql.exec("INSERT INTO candidates(id,grp,to_sha,expires_ms,used) VALUES(?,?,?,?,0)", id, grp, r.e164_sha, now + CANDIDATE_TTL_MS);
          return { candidate_id: id, label: `${safeName(r.name)} (${r.label})` };
        });
        const state = hits.length > 1 ? "ambiguous" : "one";
        this.log("direct_lookup", { detail: `method=direct via=name result=${state} candidates=${hits.length}${resolve ? " resolve=1" : ""}` });
        return json(200, { state, candidates, expires_in_s: CANDIDATE_TTL_MS / 1000 });
      }
      target = hits[0];
    } else {
      via = "candidate";
      const id = b.candidate_id;
      if (typeof id !== "string" || !/^[a-f0-9]{32}$/.test(id)) throw new Refuse("candidate_unknown", 404);
      const c = this.sql.exec("SELECT to_sha, expires_ms, used FROM candidates WHERE id=?", id).toArray()[0] as { to_sha: string; expires_ms: number; used: number } | undefined;
      if (!c) throw new Refuse("candidate_unknown", 404);
      if (c.used) throw new Refuse("candidate_used", 409);
      if (now >= c.expires_ms) throw new Refuse("candidate_expired", 410);
      const hit = list.find((r) => r.e164_sha === c.to_sha);
      if (!hit) throw new Refuse("candidate_unknown", 404); // number left the direct list since the lookup
      target = hit;
      candidate = id;
    }
    return this.directSend([target], text, via, candidate ? [candidate] : [], "single", cfg, now, key, st);
  }

  /**
   * POST /send with to_names or candidate_ids (2..3 entries). All or nothing: every entry must resolve to
   * exactly one number on the direct list, no two entries may be the same person or number, and a group
   * may not include the owner's own number. Any failure sends nothing and names the entry by index.
   */
  private async directMulti(
    b: Record<string, unknown>, field: MultiField, list: (ContactRow & { e164_sha: string })[], text: string,
    resolve: boolean, group: boolean, cfg: DirectCfg, now: number, key: CryptoKey, st: { authed: boolean; gated: boolean },
  ): Promise<Response> {
    const entries = parseMultiList(b[field], field);
    const targets: Target[] = [];
    const used: string[] = [];
    if (field === "to_names") {
      const results = entries.map((name, index) => ({ index, name, hits: matchName(list, name) }));
      if (resolve) {
        this.nonSendGate(st, entries.length); // each name is one lookup
        this.sql.exec("DELETE FROM candidates WHERE expires_ms <= ?", now);
        const live = this.sql.exec("SELECT COUNT(*) AS c FROM candidates WHERE used=0").one().c as number;
        if (live + results.reduce((a, r) => a + r.hits.length, 0) > MAX_LIVE_CANDIDATES) throw new Refuse("too_many_candidates", 429);
        const out = results.map((r) => {
          const grp = hex(crypto.getRandomValues(new Uint8Array(16))); // one group per name: using one retires its siblings
          const candidates = r.hits.map((h) => {
            const id = hex(crypto.getRandomValues(new Uint8Array(16)));
            this.sql.exec("INSERT INTO candidates(id,grp,to_sha,expires_ms,used) VALUES(?,?,?,?,0)", id, grp, h.e164_sha, now + CANDIDATE_TTL_MS);
            return { candidate_id: id, label: `${safeName(h.name)} (${h.label})` };
          });
          const state = r.hits.length === 0 ? "no_match" : r.hits.length > 1 ? "ambiguous" : "one";
          return { index: r.index, name: echoName(r.name), state, candidates };
        });
        const tally = (s: string) => out.filter((o) => o.state === s).length;
        this.log("direct_lookup", { detail: `method=direct via=names result=resolve names=${out.length} one=${tally("one")} ambiguous=${tally("ambiguous")} no_match=${tally("no_match")}${group ? " group=1" : ""}` });
        return json(200, { state: "resolved", results: out, expires_in_s: CANDIDATE_TTL_MS / 1000 });
      }
      const failed = results.filter((r) => r.hits.length !== 1).map((r) => ({ index: r.index, name: echoName(r.name), reason: r.hits.length ? "ambiguous" : "no_match" }));
      if (failed.length) {
        this.nonSendGate(st, entries.length); // each name counts toward the lookup limit
        this.log("direct_refused", { detail: `method=direct via=names reason=multi_send_unresolved failed_index=${failed.map((f) => f.index).join("/")}` });
        const r = new Refuse("multi_send_unresolved", 409);
        r.extra = { failed };
        throw r;
      }
      targets.push(...results.map((r) => r.hits[0]));
    } else {
      const groups = new Set<string>();
      for (const [i, id] of entries.entries()) {
        if (!/^[a-f0-9]{32}$/.test(id)) throw entryRefuse("candidate_unknown", 404, i);
        const c = this.sql.exec("SELECT to_sha, expires_ms, used, grp FROM candidates WHERE id=?", id).toArray()[0] as { to_sha: string; expires_ms: number; used: number; grp: string } | undefined;
        if (!c) throw entryRefuse("candidate_unknown", 404, i);
        if (c.used) throw entryRefuse("candidate_used", 409, i);
        if (now >= c.expires_ms) throw entryRefuse("candidate_expired", 410, i);
        // Two ids from one lookup are two numbers for the same name: refused like a repeat.
        if (groups.has(c.grp)) throw entryRefuse("multi_send_duplicate", 400, i);
        groups.add(c.grp);
        const hit = list.find((r) => r.e164_sha === c.to_sha);
        if (!hit) throw entryRefuse("candidate_unknown", 404, i);
        targets.push(hit);
        used.push(id);
      }
    }
    // Two entries that land on the same number (two names for one person) are a repeat too.
    const shas = new Set<string>();
    for (const [i, t] of targets.entries()) {
      if (shas.has(t.e164_sha)) throw entryRefuse("multi_send_duplicate_recipient", 400, i, field === "to_names" ? entries[i] : undefined);
      shas.add(t.e164_sha);
    }
    if (group) {
      // Never put the owner's own number into a group thread.
      const owner = this.env.OWNER_NUMBER ?? ""; // checked as E.164 in directInner before any group request gets here
      const i = targets.findIndex((t) => t.e164 === owner);
      if (i >= 0) throw entryRefuse("group_includes_owner", 400, i, field === "to_names" ? entries[i] : undefined);
    }
    return this.directSend(targets, text, field === "to_names" ? "names" : "candidates", used, group ? "group" : "copies", cfg, now, key, st);
  }

  /**
   * Every guard and counter for 1..3 recipients in ONE synchronous transaction, before any network call.
   * Caps count each recipient (a group MMS to 3 counts 3), and a batch that would go over a cap sends nothing.
   */
  private async directSend(
    targets: Target[], text: string, via: Via, candidates: string[], mode: SendMode, cfg: DirectCfg,
    now: number, key: CryptoKey, st: { authed: boolean; gated: boolean },
  ): Promise<Response> {
    const n = targets.length;
    const day = localDate(now, this.tz());
    const bodySha = `hmac:${await this.bodyHash(key, text)}`;
    const id = hex(crypto.getRandomValues(new Uint8Array(16)));
    // copies: each copy gets its own id and log rows; single and group use the one id.
    const ids = targets.map((_, i) => (mode === "copies" && i > 0 ? hex(crypto.getRandomValues(new Uint8Array(16))) : id));
    const labels = targets.map((t) => safeName(t.name));
    const whoOf = (i: number) => `method=direct via=${via} to_hmac=${targets[i].e164_sha}${mode === "copies" ? ` batch_ref=${id.slice(0, 8)} copy=${i + 1}/${n}` : ""}`;
    const all = targets.map((t) => `to_hmac=${t.e164_sha}`).join(" ");
    const who = mode === "single" ? whoOf(0) : `method=${mode === "group" ? "group_mms" : "direct"} via=${via} recipients=${n} ${all}`;
    const plan = this.ctx.storage.transactionSync((): DirectPlan => {
      for (const candidate of candidates) {
        // Single use for the whole lookup: using one candidate retires its siblings too.
        const grp = this.sql.exec("SELECT grp FROM candidates WHERE id=? AND used=0", candidate).toArray()[0]?.grp as string | undefined;
        if (!grp) throw new Refuse("candidate_used", 409);
        this.sql.exec("UPDATE candidates SET used=1 WHERE grp=?", grp);
      }
      if (cfg.runaway) {
        if (this.meta("direct_paused") === "1") return { kind: "refuse", reason: "direct_paused", status: 503, newlyPaused: false };
        const since = Math.max(now - HOUR, Number(this.meta("direct_resumed_ms") ?? 0));
        const recent = this.sql.exec("SELECT COUNT(*) AS c FROM direct_sends WHERE ms > ?", since).one().c as number;
        if (recent + n > cfg.runawayMax) {
          this.setMeta("direct_paused", "1");
          this.setMeta("direct_paused_ms", String(now));
          this.log("direct_paused", { detail: `method=direct reason=runaway sends_last_hour=${recent} batch=${n} max=${cfg.runawayMax}` });
          return { kind: "refuse", reason: "direct_paused", status: 503, newlyPaused: true };
        }
      }
      if (cfg.hours && !insideHours(minuteOfDay(now, this.tz()), cfg.hours)) return { kind: "refuse", reason: "direct_outside_hours", status: 429, newlyPaused: false };
      if (cfg.daily !== null && (this.sql.exec("SELECT COUNT(*) AS c FROM direct_sends WHERE day=?", day).one().c as number) + n > cfg.daily)
        return { kind: "refuse", reason: "direct_daily_cap_reached", status: 429, newlyPaused: false };
      if (cfg.perMinute !== null && (this.sql.exec("SELECT COUNT(*) AS c FROM direct_sends WHERE ms > ?", now - 60_000).one().c as number) + n > cfg.perMinute)
        return { kind: "refuse", reason: "direct_per_minute_reached", status: 429, newlyPaused: false };
      for (const t of targets) this.sql.exec("INSERT INTO direct_sends(ms,day,to_sha) VALUES(?,?,?)", now, day, t.e164_sha);
      if (mode === "copies") targets.forEach((_, i) => this.log("direct_approved", { request_id: ids[i], sha256: bodySha, detail: `${whoOf(i)} by=request_token` }));
      else this.log("direct_approved", { request_id: id, sha256: bodySha, detail: `${who} by=request_token` });
      return { kind: "send" };
    });
    this.purge(now);
    if (plan.kind === "refuse") {
      // Logged after the transaction so the refusal row survives (a Refuse thrown inside would roll it back).
      if (plan.newlyPaused) await this.notifyPaused(now); // the owner hears about a pause even when over the rate limit
      this.nonSendGate(st);
      this.log("direct_refused", { request_id: id, sha256: bodySha, detail: `${who} reason=${plan.reason}` });
      throw new Refuse(plan.reason, plan.status);
    }
    if (mode === "group") {
      // ONE gateway request carrying every recipient: the phone sends one MMS with all of them in To.
      // directInner refuses group requests in a device mode before anything is counted; this is the backstop.
      let gid: string;
      try {
        if (isDevice(this.delivery())) throw new Error("group_mms_unsupported_delivery");
        gid = await this.gatewaySendGroup(targets.map((t) => t.e164), text);
      } catch (e) {
        this.log("direct_send_failed", { request_id: id, sha256: bodySha, detail: `${who} error=${errCode(e)}` });
        return json(502, { id, state: "send_failed", method: "group_mms" });
      }
      this.log("direct_sent", { request_id: id, sha256: bodySha, detail: `${who} gateway_id=${gid}` });
      let notified: boolean | undefined;
      if (cfg.notifyEach) notified = await this.notifyDirectEach(id, `group text to ${labels.join(" + ")}`, text, now);
      // MMS has no delivery report, so "sent" is the final state.
      return json(200, { id, state: "sent", method: "group_mms", to: labels, ...(notified === undefined ? {} : { notified }) });
    }
    // single and copies: each recipient goes through deliver(), so the SMS Gateway sends it now and a device
    // mode queues one job per copy, in order (the device claims the oldest first).
    const sent: string[] = [];
    const queued: string[] = [];
    let notified: boolean | undefined;
    for (const [i, t] of targets.entries()) {
      let d: Delivered;
      let queuedJob: string | null = null;
      try {
        d = await this.deliver(t.e164, text, { kind: "direct", id: ids[i], who: whoOf(i), sha: bodySha }, (job) => {
          queuedJob = job;
        });
      } catch (e) {
        if (queuedJob !== null) {
          // The job is already queued and the device will claim it, so this is NOT a failure: answering 502 here
          // would make the bot retry and double-text. Log the error and treat it like any other queued text.
          this.logAfterQueue(ids[i], queuedJob, e);
          d = { queued: true, job: queuedJob };
        } else {
          this.log("direct_send_failed", { request_id: ids[i], sha256: bodySha, detail: `${whoOf(i)} error=${errCode(e)}` });
          if (mode === "single") return json(502, { id, state: "send_failed", method: "direct" });
          // Stop here: the remaining copies are not sent and nothing is retried.
          for (let j = i + 1; j < n; j++) this.log("direct_not_sent", { request_id: ids[j], sha256: bodySha, detail: `${whoOf(j)} reason=stopped_after_failure` });
          const done = sent.length + queued.length > 0;
          return json(502, { id, state: done ? "partial" : "send_failed", method: "direct", sent, ...(queued.length ? { queued } : {}), not_sent: labels.slice(i) });
        }
      }
      if (d.queued) queued.push(labels[i]);
      else {
        this.log("direct_sent", { request_id: ids[i], sha256: bodySha, detail: `${whoOf(i)} gateway_id=${d.gid}` });
        sent.push(labels[i]);
      }
      if (cfg.notifyEach) {
        const ok = await this.notifyDirectEach(ids[i], labels[i], text, now, d.queued);
        notified = (notified ?? true) && ok;
      }
    }
    const to = mode === "single" ? labels[0] : labels;
    const extra = notified === undefined ? {} : { notified };
    // A device mode queues every copy: 202 queued. The device reports each outcome to /device/result.
    if (queued.length) return json(202, { id, state: "queued", method: "direct", to, ...extra });
    return json(200, { id, state: "sent", method: "direct", to, ...extra });
  }

  private async notifyPaused(now: number) {
    const when = this.fmtTime(now);
    const msg = `SMS relay: direct send PAUSED at ${when} (runaway guard). Direct requests are refused until you resume. Check the log, then resume at https://${this.env.APPROVE_HOST}/direct`;
    try {
      await this.deliverToOwner(msg, "SMS relay direct send paused");
      this.log("direct_pause_notified", { detail: this.env.NOTIFY_MODE === "ntfy" ? "ntfy" : "sms" });
    } catch (e) {
      const why = errCode(e);
      console.error(`DIRECT_PAUSE_NOTIFY_FAILED reason=${why}`);
      this.log("direct_pause_notify_failed", { detail: why });
    }
  }

  private async notifyDirectEach(id: string, label: string, text: string, now: number, queued = false): Promise<boolean> {
    const chars = [...text];
    const preview = chars.length > 80 ? chars.slice(0, 80).join("") + "…" : text;
    // A queued text hasn't gone anywhere yet: say so, and name the device that will send it.
    const what = queued ? `text queued for your ${this.delivery() === "mac" ? "Mac" : "iPhone Shortcut"} to send to` : "direct send to";
    const msg = `SMS relay ${what} ${label} at ${this.fmtTime(now)}: "${preview}" ref ${id.slice(0, 8)}. Log: https://${this.env.APPROVE_HOST}/log`;
    try {
      await this.deliverToOwner(msg, queued ? "SMS relay text queued" : "SMS relay direct send");
      this.log("direct_notified", { request_id: id });
      return true;
    } catch (e) {
      const why = errCode(e);
      console.error(`DIRECT_NOTIFY_FAILED ref=${id.slice(0, 8)} reason=${why}`);
      this.log("direct_notify_failed", { request_id: id, detail: why });
      return false;
    }
  }

  private fmtTime(ms: number): string {
    return new Intl.DateTimeFormat("en-US", { timeZone: this.tz(), month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(ms));
  }

  /** Same-origin JSON or form POST only (no cross-site requests can carry the owner's Access session here). */
  private sameOrigin(req: Request, allowMissing: boolean) {
    const origin = req.headers.get("Origin");
    if (origin === null && allowMissing) return;
    if (origin !== new URL(req.url).origin) throw new Refuse("bad_origin", 403);
  }

  /** POST /contacts (approve host, Access): replace the whole snapshot. Used by scripts/import-contacts.mjs. */
  private async uploadContacts(req: Request): Promise<Response> {
    const who = await this.requireOwner(req, "contacts");
    // application/json can't be sent cross-site without a CORS preflight, which this route never answers.
    if ((req.headers.get("content-type") || "").split(";")[0].trim().toLowerCase() !== "application/json") throw new Refuse("contacts_must_be_json", 415);
    this.sameOrigin(req, true); // the uploader (cloudflared access curl) sends no Origin
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      throw new Refuse("body_not_json");
    }
    const snap = parseSnapshot(body);
    // Same rule as sync: an empty result (wrong file, only fax/pager numbers) never wipes the previous list.
    if (!snap.rows.length) throw new Refuse("contacts_snapshot_invalid_empty", 400);
    const now = this.clock();
    this.ctx.storage.transactionSync(() => {
      this.replaceSource(UPLOAD_SOURCE, snap.rows, now);
      this.setMeta("snapshot_generated_at", snap.generatedAt);
      this.log("contacts_snapshot", { detail: `account=${UPLOAD_SOURCE} contacts=${snap.contacts} numbers=${snap.rows.length} generated_at=${snap.generatedAt} method=${who.method} by=${who.email}` });
      this.rebuildContacts();
    });
    return json(200, { contacts: snap.contacts, numbers: snap.rows.length, generated_at: snap.generatedAt });
  }

  /** Replace one source's last good list. */
  private replaceSource(account: string, rows: ContactRow[], now: number) {
    // Keep each known number's current hash: on a later key rotation it's what maps the old person_key to the new.
    const known = new Map((this.sql.exec("SELECT e164, e164_sha FROM contact_sources WHERE e164_sha IS NOT NULL").toArray() as { e164: string; e164_sha: string }[]).map((r) => [r.e164, r.e164_sha]));
    this.sql.exec("DELETE FROM contact_sources WHERE account=?", account);
    rows.forEach((r) =>
      this.sql.exec(
        "INSERT INTO contact_sources(account,name,name_norm,given_norm,first_norm,e164,e164_sha,label) VALUES(?,?,?,?,?,?,?,?)",
        account, r.name, r.name_norm, r.given_norm, r.first_norm, r.e164, known.get(r.e164) ?? null, r.label,
      ),
    );
    this.setMeta(`acct:${account}:ok_ms`, String(now));
    this.setMeta(`acct:${account}:numbers`, String(rows.length));
    this.setMeta("hash_key_fp", null); // new rows: hashed on the next direct request
  }

  /**
   * Merged direct list = union of the sources in GOOGLE_ACCOUNTS order, then UPLOAD, deduped by E.164.
   * On a conflict the first source in that order wins (its display name and label are kept).
   * Sources no longer listed in GOOGLE_ACCOUNTS are left out of the merge, and the next sync deletes their rows.
   * Outstanding candidate ids are retired, since the list they were drawn from changed.
   */
  private rebuildContacts() {
    const order = [...this.googleLabels(), UPLOAD_SOURCE, LEGACY_SOURCE];
    this.sql.exec("DELETE FROM contacts");
    this.setMeta("hash_key_fp", null); // pref rows follow the new list on the next read
    this.sql.exec("DELETE FROM candidates");
    const seen = new Set<string>();
    for (const acct of order) {
      for (const r of this.sql.exec("SELECT name,name_norm,given_norm,first_norm,e164,e164_sha,label FROM contact_sources WHERE account=? ORDER BY rowid", acct).toArray() as any[]) {
        if (seen.has(r.e164)) continue;
        seen.add(r.e164);
        this.sql.exec("INSERT INTO contacts(name,name_norm,given_norm,first_norm,e164,e164_sha,label,account) VALUES(?,?,?,?,?,?,?,?)", r.name, r.name_norm, r.given_norm, r.first_norm, r.e164, r.e164_sha, r.label, acct);
      }
    }
    const numbers = seen.size;
    this.setMeta("snapshot_uploaded_ms", String(this.clock()));
    this.setMeta("snapshot_numbers", String(numbers));
    // Distinct display names, not people: two "Mom"s count once. The page labels it that way.
    this.setMeta("snapshot_names", String(this.sql.exec("SELECT COUNT(DISTINCT name) AS c FROM contacts").one().c));
  }

  /**
   * Pull each GOOGLE_ACCOUNTS account's contacts (People API, read-only) and refresh its stored list.
   * Per account: a missing GOOGLE_RT_<LABEL> secret, a token or API error, or an empty result keeps that
   * account's previous list and is alerted; the other accounts still refresh. Runs from the daily alarm.
   */
  async syncContacts(opts: { alert: boolean } = { alert: true }): Promise<{ updated: string[]; failed: { account: string; reason: string }[] }> {
    const now = this.clock();
    const { invalid } = parseAccounts(this.env.GOOGLE_ACCOUNTS);
    const valid = this.googleLabels();
    const failed: { account: string; reason: string }[] = invalid.map((l) => ({ account: l, reason: "invalid_label" }));
    const updated: string[] = [];
    let cc: string | null = null;
    let ccError: string | null = null;
    try {
      cc = parseCountryCode(this.env.DEFAULT_COUNTRY_CODE);
    } catch (e) {
      ccError = e instanceof Refuse ? e.code : errCode(e); // every account keeps its previous list
    }
    for (const acct of valid) {
      if (ccError) {
        failed.push({ account: acct, reason: ccError });
        continue;
      }
      let rt: string | null;
      try {
        rt = await this.googleRefreshToken(acct);
      } catch (e) {
        failed.push({ account: acct, reason: errCode(e) });
        continue;
      }
      if (!rt) {
        failed.push({ account: acct, reason: `missing_secret_GOOGLE_RT_${acct}` });
        continue;
      }
      try {
        const { contacts, dropped } = await this.fetchGoogleContacts(rt, cc);
        const snap = parseSnapshot({ generated_at: new Date(now).toISOString(), contacts });
        if (!snap.rows.length) throw new Error("empty_result");
        this.ctx.storage.transactionSync(() => {
          this.replaceSource(acct, snap.rows, now);
          this.setMeta(`acct:${acct}:dropped`, String(dropped));
          this.log("contacts_sync", { detail: `account=${acct} contacts=${snap.contacts} numbers=${snap.rows.length} dropped_fax_pager=${dropped}` });
        });
        updated.push(acct);
      } catch (e) {
        const why = e instanceof Refuse ? e.code : errCode(e);
        failed.push({ account: acct, reason: why });
      }
    }
    // A label removed from GOOGLE_ACCOUNTS: its stored list is deleted, not just left out of the merge.
    const keep = new Set([...valid, UPLOAD_SOURCE, LEGACY_SOURCE]);
    const gone = (this.sql.exec("SELECT DISTINCT account FROM contact_sources").toArray().map((r) => r.account as string)).filter((a) => !keep.has(a));
    this.ctx.storage.transactionSync(() => {
      for (const a of gone) {
        const n = this.sql.exec("SELECT COUNT(*) AS c FROM contact_sources WHERE account=?", a).one().c as number;
        this.sql.exec("DELETE FROM contact_sources WHERE account=?", a);
        this.sql.exec("DELETE FROM meta WHERE k LIKE ?", `acct:${a}:%`);
        this.log("contacts_source_purged", { detail: `account=${a} numbers=${n} reason=not_in_GOOGLE_ACCOUNTS` });
      }
    });
    for (const f of failed) {
      console.error(`CONTACTS_SYNC_FAILED account=${f.account} reason=${f.reason} (previous list kept)`);
      this.log("contacts_sync_failed", { detail: `account=${f.account} reason=${f.reason} kept_previous=1` });
    }
    this.ctx.storage.transactionSync(() => this.rebuildContacts());
    if (failed.length && opts.alert) {
      const msg = `SMS relay contacts sync: kept the previous list for ${failed.map((f) => `${f.account} (${f.reason})`).join(", ")}.${updated.length ? ` Updated: ${updated.join(", ")}.` : ""} Details: https://${this.env.APPROVE_HOST}/log`;
      try {
        await this.deliverToOwner(msg, "SMS relay contacts sync");
        this.log("contacts_sync_alerted", { detail: `failed=${failed.length}` });
      } catch (e) {
        console.error(`CONTACTS_SYNC_ALERT_FAILED reason=${errCode(e)}`);
        this.log("contacts_sync_alert_failed", { detail: errCode(e) });
      }
    }
    return { updated, failed };
  }

  // ---------- Google connect storage (src/google.ts) ----------
  /** Current GOOGLE_TOKEN_KEY, then GOOGLE_TOKEN_KEY_OLD (decrypt only, for rotation). A malformed key throws its code. */
  private async tokenKeys(): Promise<{ cur: TokenKey | null; old: TokenKey | null }> {
    return { cur: await importTokenKey(this.env.GOOGLE_TOKEN_KEY), old: await importTokenKey(this.env.GOOGLE_TOKEN_KEY_OLD) };
  }
  private async requireTokenKey(): Promise<TokenKey> {
    const { cur } = await this.tokenKeys();
    if (!cur) throw new Refuse("google_token_key_missing", 503);
    return cur;
  }

  /** Account order: GOOGLE_ACCOUNTS (legacy seed, first wins name conflicts), then in-app connected labels by connect time. */
  googleLabels(): string[] {
    const seed = parseAccounts(this.env.GOOGLE_ACCOUNTS).valid;
    const stored = this.sql.exec("SELECT label FROM google_accounts ORDER BY connected_ms, label").toArray().flatMap((r) => (typeof r["label"] === "string" ? [r["label"]] : []));
    return [...seed, ...stored.filter((l) => !seed.includes(l))];
  }

  /** The OAuth client: the in-app (stored, sealed) one first, then the GOOGLE_CLIENT_ID/SECRET secrets. null = neither. */
  async googleClient(): Promise<GoogleClient | null> {
    const raw = this.sql.exec("SELECT blob_ct, blob_iv, key_ver, saved_ms FROM google_client WHERE id=1").toArray()[0];
    if (raw) {
      const row = decodeClientRow(raw);
      const { cur, old } = await this.tokenKeys();
      const { plaintext, kid } = await open([cur, old], { ct: row.blob_ct, iv: row.blob_iv, kid: row.key_ver }, aadFor("client", "client"));
      const c = decodeClientBlob(plaintext);
      if (cur && kid !== cur.kid) await this.saveGoogleClient(c.id, c.secret, row.saved_ms); // rotation: re-seal under the new key
      return { ...c, source: "stored" };
    }
    const id = this.env.GOOGLE_CLIENT_ID, secret = this.env.GOOGLE_CLIENT_SECRET;
    return id && secret ? { id, secret, source: "secrets" } : null;
  }

  /** Store the pasted client, sealed. Needs GOOGLE_TOKEN_KEY. */
  async saveGoogleClient(id: string, secret: string, savedMs = this.clock()): Promise<void> {
    if (!isClientId(id)) throw new Refuse("google_client_id_invalid");
    if (!isClientSecret(secret)) throw new Refuse("google_client_secret_invalid");
    const k = await this.requireTokenKey();
    const s = await seal(k, JSON.stringify({ id, secret }), aadFor("client", "client"));
    this.sql.exec("INSERT OR REPLACE INTO google_client(id, blob_ct, blob_iv, key_ver, saved_ms) VALUES(1,?,?,?,?)", s.ct, s.iv, s.kid, savedMs);
  }

  /** A label's refresh token: the stored row first, else the GOOGLE_RT_<LABEL> secret (pre-upgrade deploys). null = neither. */
  async googleRefreshToken(label: string): Promise<string | null> {
    const raw = this.sql.exec("SELECT * FROM google_accounts WHERE label=?", label).toArray()[0];
    if (raw) {
      const row = decodeAccountRow(raw);
      const { cur, old } = await this.tokenKeys();
      const { plaintext, kid } = await open([cur, old], { ct: row.rt_ct, iv: row.rt_iv, kid: row.key_ver }, aadFor("rt", row.label));
      if (cur && kid !== cur.kid) await this.saveGoogleAccount(row.label, plaintext, row.scope, row.email, row.connected_ms);
      return plaintext;
    }
    const rt = (this.env as unknown as Record<string, string | undefined>)[`GOOGLE_RT_${label}`];
    return rt || null;
  }

  /** Store (or replace) a label's refresh token, sealed with the label as associated data. */
  async saveGoogleAccount(label: string, refreshToken: string, scope: string, email: string | null, connectedMs = this.clock()): Promise<void> {
    if (!isLabel(label)) throw new Refuse("google_label_invalid");
    if (!refreshToken) throw new Refuse("google_no_refresh_token");
    const k = await this.requireTokenKey();
    const s = await seal(k, refreshToken, aadFor("rt", label));
    this.sql.exec("INSERT OR REPLACE INTO google_accounts(label, email, rt_ct, rt_iv, scope, connected_ms, key_ver) VALUES(?,?,?,?,?,?,?)", label, email, s.ct, s.iv, scope, connectedMs, s.kid);
  }

  /** Remove a label's stored token. (Revoking at Google is the Disconnect route's job.) */
  deleteGoogleAccount(label: string): boolean {
    const n = this.sql.exec("SELECT COUNT(*) AS c FROM google_accounts WHERE label=?", label).one()["c"] as number;
    this.sql.exec("DELETE FROM google_accounts WHERE label=?", label);
    return n > 0;
  }

  /** OAuth refresh → People API connections (names + phone numbers only). Errors are codes, never token values. */
  private async fetchGoogleContacts(refreshToken: string, cc: string | null) {
    const client = await this.googleClient();
    if (!client) throw new Error("google_client_not_configured");
    const { id, secret } = client;
    const tr = await this.net(
      new Request("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: id, client_secret: secret }).toString(),
      }),
    );
    if (!tr.ok) throw new Error(`google_token_status_${tr.status}`);
    const access = ((await jsonOr(tr, "google_token_bad_json")) as { access_token?: unknown }).access_token;
    if (typeof access !== "string" || !access) throw new Error("google_token_missing");
    const all: SnapshotContact[] = [];
    const stats = { dropped: 0 };
    let page = "";
    for (let i = 0; i < 20; i++) {
      const u = new URL("https://people.googleapis.com/v1/people/me/connections");
      u.searchParams.set("personFields", "names,phoneNumbers");
      u.searchParams.set("pageSize", "1000");
      if (page) u.searchParams.set("pageToken", page);
      const r = await this.net(new Request(u.toString(), { headers: { Authorization: `Bearer ${access}` } }));
      if (!r.ok) throw new Error(`google_people_status_${r.status}`);
      const j = (await jsonOr(r, "google_people_bad_json")) as { connections?: unknown; nextPageToken?: unknown };
      all.push(...peopleToContacts(j.connections, stats, cc));
      if (typeof j.nextPageToken !== "string" || !j.nextPageToken) return { contacts: all, dropped: stats.dropped };
      page = j.nextPageToken;
    }
    throw new Error("google_people_too_many_pages");
  }

  /** GET /direct (approve host, Access): status, snapshot age and count, and the resume button when paused. */
  private async directPage(req: Request): Promise<Response> {
    await this.requireOwner(req, "direct");
    const csrf = hex(crypto.getRandomValues(new Uint8Array(16)));
    this.setMeta("direct_csrf", csrf); // one token for the page's forms (resume, sync); single use
    const paused = this.meta("direct_paused") === "1";
    const pausedMs = Number(this.meta("direct_paused_ms") ?? 0);
    const now = this.clock();
    const lastHour = this.sql.exec("SELECT COUNT(*) AS c FROM direct_sends WHERE ms > ?", now - HOUR).one().c as number;
    const snapAt = this.meta("snapshot_uploaded_ms");
    const html = `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><title>Direct send</title>
<body style="font:16px system-ui;max-width:32em;margin:1em auto;padding:0 1em">
<h2>Direct send</h2>
<p><a href="/contacts">Contacts page</a>: choose who the bot may text.</p>
<p><b>DIRECT_SEND:</b> ${switchOnlyIfOne(this.env.DIRECT_SEND) ? "on" : "off"} · <b>runaway guard:</b> ${switchOnUnlessZero(this.env.RUNAWAY_PAUSE) ? "on" : "off"}</p>
<p><b>State:</b> ${paused ? `PAUSED since ${esc(this.fmtTime(pausedMs))}. Direct requests are refused.` : "running"}</p>
<p><b>Direct sends in the last hour:</b> ${lastHour}</p>
${this.devicePageLine()}
<p><b>DEFAULT_COUNTRY_CODE:</b> ${(() => { try { return esc(parseCountryCode(this.env.DEFAULT_COUNTRY_CODE) ?? "none (strict E.164)"); } catch { return "NOT SET: contact sync is refused until it is"; } })()}</p>
<p><b>Direct list:</b> ${snapAt ? `${esc(this.meta("snapshot_numbers") ?? "?")} numbers under ${esc(this.meta("snapshot_names") ?? "?")} distinct names, rebuilt ${esc(this.fmtTime(Number(snapAt)))}` : "empty"}</p>
<ul>${[...this.googleLabels(), UPLOAD_SOURCE].map((a) => { const ok = this.meta(`acct:${a}:ok_ms`); return `<li>${esc(a)}: ${ok ? `${esc(this.meta(`acct:${a}:numbers`) ?? "?")} numbers${this.meta(`acct:${a}:dropped`) ? ` (${esc(this.meta(`acct:${a}:dropped`)!)} fax/pager dropped)` : ""}, last good ${esc(this.fmtTime(Number(ok)))}` : "never loaded"}</li>`; }).join("")}</ul>
${this.googleLabels().length ? `<form method=post action="/direct/sync"><input type=hidden name=csrf value="${csrf}"><button>Sync contacts now</button></form>` : "<p>No Google accounts configured (GOOGLE_ACCOUNTS).</p>"}
${paused ? `<form method=post action="/direct/resume"><input type=hidden name=csrf value="${csrf}"><button style="font-size:1.2em">Resume direct send</button></form>` : ""}
</body>`;
    return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'" } });
  }

  /** Access + same Origin (required) + the single-use CSRF token from GET /direct. */
  private async directForm(req: Request, route: "resume" | "sync"): Promise<{ who: Owner; fromContacts: boolean }> {
    const who = await this.requireOwner(req, route);
    this.sameOrigin(req, false);
    const form = await req.formData();
    if (route === "sync" && form.get("from") === "contacts") {
      this.checkPageCsrf(form.get("csrf"), who); // the Contacts page's token (Access-bound, 15 min)
      return { who, fromContacts: true };
    }
    const want = this.meta("direct_csrf");
    if (!want || form.get("csrf") !== want) throw new Refuse("bad_csrf", 403);
    this.setMeta("direct_csrf", null); // single use
    return { who, fromContacts: false };
  }

  /** POST /direct/sync (approve host only, same checks as resume): pull every Google account now. */
  private async syncNow(req: Request): Promise<Response> {
    const { who, fromContacts } = await this.directForm(req, "sync");
    this.log("contacts_sync_requested", { detail: `method=${who.method} by=${who.email}` });
    // The owner is looking at the result, so no alert text for a failure here (it's still logged).
    const { updated, failed } = await this.syncContacts({ alert: false });
    if (fromContacts) return new Response(null, { status: 303, headers: { location: `/contacts?synced=${failed.length ? "partial" : "ok"}`, "cache-control": "no-store" } });
    return json(200, { updated, failed });
  }

  /** POST /direct/resume (approve host, Access + Origin + CSRF from GET /direct). */
  private async resumeDirect(req: Request): Promise<Response> {
    const { who } = await this.directForm(req, "resume");
    if (this.meta("direct_paused") !== "1") throw new Refuse("not_paused", 409);
    const now = this.clock();
    this.setMeta("direct_paused", null);
    this.setMeta("direct_resumed_ms", String(now)); // the runaway window restarts here
    this.log("direct_resumed", { detail: `method=${who.method} by=${who.email}` });
    return json(200, { state: "running" });
  }

  // ---------- Contacts page (APPROVE_HOST only; fetch() 404s every /contacts* path elsewhere) ----------
  private async contactsRoute(req: Request, path: string): Promise<Response> {
    if (req.method === "POST" && path === "/contacts") return await this.uploadContacts(req);
    if (req.method === "GET" && path === "/contacts") return await this.contactsPage(req);
    if (req.method === "GET" && path === "/contacts/list") return await this.contactsList(req);
    if (req.method === "POST" && path === "/contacts/prefs") return await this.contactsPrefs(req);
    if (req.method === "POST" && path === "/contacts/enable-all") return await this.contactsEnableAll(req);
    if (req.method === "POST" && path === "/contacts/migrated-off") return await this.contactsMigratedOff(req);
    if (req.method === "POST" && path === "/contacts/preview") return await this.contactsPreview(req);
    return json(404, { error: "not_found" });
  }

  /** Mint a page token: reusable for 15 minutes, only by the Access identity that loaded the page. */
  private mintPageCsrf(who: Owner, now: number): string {
    this.sql.exec("DELETE FROM page_csrf WHERE expires_ms <= ?", now);
    const t = hex(crypto.getRandomValues(new Uint8Array(16)));
    this.sql.exec("INSERT INTO page_csrf(token,email,expires_ms) VALUES(?,?,?)", t, who.email.toLowerCase(), now + CSRF_TTL_MS);
    return t;
  }
  private checkPageCsrf(token: unknown, who: Owner) {
    const row = typeof token === "string" && /^[a-f0-9]{32}$/.test(token) ? (this.sql.exec("SELECT email, expires_ms FROM page_csrf WHERE token=?", token).toArray()[0] as { email: string; expires_ms: number } | undefined) : undefined;
    if (!row || row.email !== who.email.toLowerCase() || row.expires_ms <= this.clock()) throw new Refuse("bad_csrf", 403);
  }

  /** Access + same Origin (required) + JSON + page CSRF. Every contacts write goes through here. */
  private async contactsWrite(req: Request, route: "prefs" | "preview"): Promise<{ who: Owner; body: Record<string, unknown>; key: CryptoKey }> {
    const who = await this.requireOwner(req, route);
    this.sameOrigin(req, false);
    if ((req.headers.get("content-type") || "").split(";")[0]?.trim().toLowerCase() !== "application/json") throw new Refuse("contacts_must_be_json", 415);
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      throw new Refuse("body_not_json");
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Refuse("body_must_be_object");
    const body = raw as Record<string, unknown>;
    this.checkPageCsrf(body["csrf"], who);
    return { who, body, key: await this.contactsKey() };
  }
  private async contactsKey(): Promise<CryptoKey> {
    const key = await this.hashKey();
    if (!key) {
      console.error("CONFIG_ERROR reason=log_hash_key_missing_or_short");
      throw new Refuse("config_invalid", 503);
    }
    await this.ensureContactHashes(key);
    return key;
  }

  /** GET /contacts: the page. Numbers never appear in the HTML; the list loads from /contacts/list (last 4 only). */
  private async contactsPage(req: Request): Promise<Response> {
    const who = await this.requireOwner(req, "contacts_page");
    const now = this.clock();
    const key = await this.hashKey();
    if (key) await this.ensureContactHashes(key);
    this.setMeta("contacts_prev_visit_ms", this.meta("contacts_last_visit_ms") ?? "0");
    this.setMeta("contacts_last_visit_ms", String(now));
    const csrf = this.mintPageCsrf(who, now);
    const nonce = hex(crypto.getRandomValues(new Uint8Array(16)));
    const accts = this.googleLabels();
    const lastErr = this.sql.exec("SELECT ms, detail FROM log WHERE event IN ('contacts_sync','contacts_sync_failed','contacts_snapshot') ORDER BY seq DESC LIMIT 1").toArray()[0] as { ms: number; detail: string } | undefined;
    const errCodeOf = lastErr?.detail?.match(/reason=([a-zA-Z0-9_]+)/)?.[1];
    const synced = new URL(req.url).searchParams.get("synced");
    const html = renderContactsPage({
      csrf, nonce, method: who.method,
      migratedOn: key ? (this.sql.exec(`SELECT COUNT(*) AS c FROM contact_prefs WHERE ${MIGRATED_ON}`).one()["c"] as number) : 0,
      sources: [...accts, UPLOAD_SOURCE, LEGACY_SOURCE].filter((a) => a !== LEGACY_SOURCE || this.meta(`acct:${a}:ok_ms`)).map((a) => {
        const ok = this.meta(`acct:${a}:ok_ms`);
        return { name: a, numbers: this.meta(`acct:${a}:numbers`), lastGood: ok ? this.fmtTime(Number(ok)) : null };
      }),
      lastError: errCodeOf && lastErr ? { code: errCodeOf, when: this.fmtTime(lastErr.ms) } : null,
      canSync: accts.length > 0,
      toast: synced === "ok" ? "Sync finished" : synced === "partial" ? "Sync finished with errors: see Health" : null,
      hashKeyMissing: !key,
    });
    return new Response(html, {
      headers: {
        "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", "referrer-policy": "same-origin", // not no-referrer: Chrome then sends Origin: null on the Sync now form
        "content-security-policy": `default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'nonce-${nonce}'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'`,
      },
    });
  }

  /** GET /contacts/list: [{key,name,label,last4,enabled,starred,migrated,new,source}]. Never more than the last 4 digits. */
  private async contactsList(req: Request): Promise<Response> {
    await this.requireOwner(req, "contacts_page");
    await this.contactsKey();
    const since = Number(this.meta("contacts_prev_visit_ms") ?? "0");
    const rows = this.sql.exec(
      "SELECT c.name, c.label, c.e164, c.e164_sha, c.account, p.enabled, p.starred, p.migrated, p.first_seen_ms FROM contacts c JOIN contact_prefs p ON p.person_key=c.e164_sha ORDER BY p.starred DESC, c.name",
    ).toArray() as { name: string; label: string; e164: string; e164_sha: string; account: string; enabled: number; starred: number; migrated: number; first_seen_ms: number }[];
    const people: Record<string, unknown>[] = rows.map((r) => ({
      key: r.e164_sha, name: safeName(r.name), label: r.label, last4: last4(r.e164), enabled: r.enabled === 1, starred: r.starred === 1,
      migrated: r.migrated === 1, new: since > 0 && (r.first_seen_ms ?? 0) > since, source: r.account, readonly: false,
    }));
    // ALLOWLIST numbers are always sendable (directList), so they always get a read-only "always on" row, even
    // when the same number is also a contact: that contact's own switch can't turn them off.
    const always = this.env.ALLOWLIST ? parseAllowlist(this.env.ALLOWLIST) : new Map<string, string>();
    rows.forEach((r, i) => {
      if (always.has(r.e164)) people[i] = { ...people[i], key: null, label: "always on (ALLOWLIST)", enabled: true, starred: false, readonly: true };
    });
    const have = new Set(rows.map((r) => r.e164));
    for (const [e164, name] of always) {
      if (have.has(e164)) continue; // shown above as the contact's own read-only row
      people.push({ key: null, name: safeName(name), label: "always on (ALLOWLIST)", last4: last4(e164), enabled: true, starred: false, migrated: false, new: false, source: "ALLOWLIST", readonly: true });
    }
    return json(200, { people });
  }

  private numberOf(personKey: string): string | null {
    const r = this.sql.exec("SELECT e164 FROM contacts WHERE e164_sha=? LIMIT 1", personKey).toArray()[0];
    return r ? (r["e164"] as string) : null;
  }

  /** POST /contacts/prefs: per-person on/off and star. Switching someone on refuses documentation-example numbers. */
  private async contactsPrefs(req: Request): Promise<Response> {
    const { who, body } = await this.contactsWrite(req, "prefs");
    const changes = parsePrefsBody(body);
    for (const c of changes) {
      const e164 = this.numberOf(c.key);
      if (!e164) throw new Refuse("contact_unknown", 404);
      if (c.enabled === true && isExampleNumber(e164)) {
        const r = new Refuse("example_number", 422);
        r.extra = { message: "this looks like a documentation example" };
        throw r;
      }
    }
    const now = this.clock();
    const n = { enabled: 0, disabled: 0, starred: 0, unstarred: 0 };
    this.ctx.storage.transactionSync(() => {
      for (const c of changes) {
        if (c.enabled !== undefined) {
          this.sql.exec("UPDATE contact_prefs SET enabled=?, migrated=0, updated_ms=?, by=? WHERE person_key=?", c.enabled ? 1 : 0, now, who.email, c.key);
          n[c.enabled ? "enabled" : "disabled"]++;
        }
        if (c.starred !== undefined) {
          this.sql.exec("UPDATE contact_prefs SET starred=?, updated_ms=?, by=? WHERE person_key=?", c.starred ? 1 : 0, now, who.email, c.key);
          n[c.starred ? "starred" : "unstarred"]++;
        }
      }
      this.sql.exec("DELETE FROM candidates"); // the sendable set may have changed
      this.log("contacts_prefs", { detail: `updated=${changes.length} enabled=${n.enabled} disabled=${n.disabled} starred=${n.starred} unstarred=${n.unstarred} method=${who.method} by=${who.email}` });
    });
    return json(200, { updated: changes.length });
  }

  /** POST /contacts/enable-all: the keys the page showed, and the count the owner confirmed. Example numbers are skipped. */
  private async contactsEnableAll(req: Request): Promise<Response> {
    const { who, body } = await this.contactsWrite(req, "prefs");
    const { keys, confirm } = parseEnableAllBody(body);
    if (confirm !== keys.length) throw new Refuse("confirm_count_mismatch", 409);
    const ok: string[] = [];
    for (const k of keys) {
      const e164 = this.numberOf(k);
      if (e164 === null) throw new Refuse("contact_unknown", 404);
      if (!isExampleNumber(e164)) ok.push(k);
    }
    const now = this.clock();
    this.ctx.storage.transactionSync(() => {
      for (const k of ok) this.sql.exec("UPDATE contact_prefs SET enabled=1, migrated=0, updated_ms=?, by=? WHERE person_key=?", now, who.email, k);
      this.sql.exec("DELETE FROM candidates");
      this.log("contacts_enable_all", { detail: `updated=${ok.length} skipped_example=${keys.length - ok.length} method=${who.method} by=${who.email}` });
    });
    return json(200, { updated: ok.length, skipped_example: keys.length - ok.length });
  }

  /** POST /contacts/migrated-off: turn off everyone the upgrade left on. confirm_count = how many the page showed. */
  private async contactsMigratedOff(req: Request): Promise<Response> {
    const { who, body } = await this.contactsWrite(req, "prefs");
    if (Object.keys(body).some((k) => k !== "csrf" && k !== "confirm_count")) throw new Refuse("unknown_fields");
    const n = this.sql.exec(`SELECT COUNT(*) AS c FROM contact_prefs WHERE ${MIGRATED_ON}`).one()["c"] as number;
    if (body["confirm_count"] !== n) throw new Refuse("confirm_count_mismatch", 409);
    const now = this.clock();
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(`UPDATE contact_prefs SET enabled=0, updated_ms=?, by=? WHERE ${MIGRATED_ON}`, now, who.email);
      this.sql.exec("DELETE FROM candidates");
      this.log("contacts_migrated_off", { detail: `updated=${n} method=${who.method} by=${who.email}` });
    });
    return json(200, { updated: n });
  }

  /**
   * POST /contacts/preview: what the bot's /send resolve would match, over the sendable list. Never sends,
   * never stores candidates, never counts toward the bot's lookup limit.
   */
  private async contactsPreview(req: Request): Promise<Response> {
    const { who, body, key } = await this.contactsWrite(req, "preview");
    if (Object.keys(body).some((k) => k !== "csrf" && k !== "name")) throw new Refuse("unknown_fields");
    const name = body["name"];
    if (typeof name !== "string" || name.length > 200) throw new Refuse("to_name_invalid");
    const list = await this.directList(key);
    const hits = matchName(list, name);
    const state: "one" | "ambiguous" | "no_match" = hits.length === 0 ? "no_match" : hits.length === 1 ? "one" : "ambiguous";
    let reason: string | null = null;
    if (state === "no_match") {
      const all = this.sql.exec("SELECT name_norm, given_norm, first_norm FROM contacts").toArray().map((r) => ({ name_norm: textOf(r["name_norm"]), given_norm: textOf(r["given_norm"]), first_norm: textOf(r["first_norm"]) }));
      reason = matchName(all, name).length ? `${safeName(name)} exists but is off` : `no contact named ${safeName(name)}`;
    }
    this.log("contacts_preview", { detail: `state=${state} matches=${hits.length} method=${who.method}` });
    return json(200, { state, matches: hits.map((r) => ({ name: safeName(r.name), label: r.label, last4: last4(r.e164) })), reason });
  }

  // ---------- Access side (the owner) ----------
  private async requireOwner(req: Request, route: "page" | "decide" | "log" | "contacts" | "direct" | "resume" | "sync" | "contacts_page" | "prefs" | "preview"): Promise<Owner> {
    // Token split: the bot's request token must never work here, so refuse any Authorization header.
    if (req.headers.get("Authorization")) throw new Error("access_bearer_not_allowed");
    const who = await verifyAccess(
      req,
      {
        teamDomain: this.env.ACCESS_TEAM_DOMAIN,
        aud: this.env.ACCESS_AUD,
        approverEmail: this.env.APPROVER_EMAIL,
        requiredAmr: (this.env.REQUIRED_AMR || "").split(",").map((s) => s.trim()).filter(Boolean),
        allowEmailOtp: this.env.ALLOW_EMAIL_OTP === "1",
        nowMs: this.clock(),
      },
      this.net,
    );
    // Bypass use is logged on every Access-protected route; route= says whether it was a page view, a decision or a log read.
    if (who.method === "email_otp") this.log("approve_via_email_otp", { detail: `method=email_otp route=${route}` });
    if (who.method === "email_otp_or_policy") this.log("approve_via_email_otp_or_policy", { detail: `method=email_otp_or_policy route=${route}` });
    return ownerFromAccess(who);
  }

  private async approvePage(req: Request, id: string): Promise<Response> {
    await this.requireOwner(req, "page");
    const r = this.get(id);
    if (!r) return json(404, { error: "not_found" });
    const allow = parseAllowlist(this.env.ALLOWLIST);
    const expired = this.clock() >= r.expires_ms;
    const open = r.state === "pending" && !expired;
    const mins = Math.max(0, Math.ceil((r.expires_ms - this.clock()) / 60000));
    // Everything shown comes from the relay's stored row, never from the query string or the bot.
    const html = `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><title>Approve text</title>
<body style="font:16px system-ui;max-width:32em;margin:1em auto;padding:0 1em">
<h2>Send this text?</h2>
<p><b>To:</b> ${esc((r.via === "contacts" ? r.to_label : allow.get(r.recipient)) || "not on allowlist")} (${esc(maskNumber(r.recipient))})</p>
<pre style="white-space:pre-wrap;border:1px solid #888;padding:.75em">${esc(r.text)}</pre>
<p><small>ref ${r.id.slice(0, 8)} · sha256 ${r.sha256.slice(0, 12)} · ${open ? `expires in ${mins} min` : `state: ${expired && r.state === "pending" ? "expired" : r.state}`}</small></p>
${open ? `<form method=post><input type=hidden name=csrf value="${r.csrf}">
<button name=action value=approve style="font-size:1.2em">Approve and send</button>
<button name=action value=deny style="font-size:1.2em">Deny</button></form>` : ""}
</body>`;
    this.log("approve_page_viewed", { request_id: id });
    return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'" } });
  }

  private async decide(req: Request, id: string): Promise<Response> {
    const who = await this.requireOwner(req, "decide");
    const origin = req.headers.get("Origin");
    if (origin !== new URL(req.url).origin) throw new Refuse("bad_origin", 403);
    const form = await req.formData();
    const r = this.get(id);
    if (!r) return json(404, { error: "not_found" });
    if (form.get("csrf") !== r.csrf) throw new Refuse("bad_csrf", 403);
    if (r.state !== "pending") throw new Refuse("already_used", 409);
    const now = this.clock();
    if (now >= r.expires_ms) throw new Refuse("expired", 410);
    const action = form.get("action");
    const logSha = await this.logBodyHash(r.text);
    if (action === "deny") {
      this.sql.exec("UPDATE requests SET state='denied', decided_ms=? WHERE id=?", now, id);
      this.log("denied", { request_id: id, recipient: r.recipient, sha256: logSha, detail: `method=${who.method} by=${who.email}` });
      return json(200, { id, state: "denied" });
    }
    if (action !== "approve") throw new Refuse("bad_action");
    const cfg = this.tapCfg(); // a garbage tap setting refuses the approval (deny always works)
    // Re-check policy at send time against the CURRENT secrets.
    const allow = parseAllowlist(this.env.ALLOWLIST);
    if (r.via === "contacts") {
      await this.requireStillOnList(r.recipient); // filed by name: still on the /send list?
    } else {
      if (!allow.has(r.recipient)) throw new Refuse("recipient_not_on_allowlist", 403);
    }
    if ((await sha256Hex(r.text)) !== r.sha256) throw new Refuse("stored_text_hash_mismatch", 500);
    const day = localDate(now, this.tz());
    const sentToday = this.sql.exec("SELECT COUNT(*) AS c FROM sends WHERE day=?", day).one().c as number;
    const cap = sendCap(day, this.env.CAP_START_DATE, cfg.capInitial, cfg.capAfter, cfg.raiseAfterDays);
    if (sentToday >= cap) throw new Refuse("daily_send_cap_reached", 429);
    const last = this.sql.exec("SELECT MAX(ms) AS m FROM sends").one().m as number | null;
    if (last !== null && now - last < cfg.minSecondsBetween * 1000) throw new Refuse("too_soon_after_previous_send", 429);
    // Single use: consume BEFORE the network call, and count it against the cap even if the send fails.
    this.sql.exec("UPDATE requests SET state='approved_sending', decided_ms=? WHERE id=?", now, id);
    this.sql.exec("INSERT INTO sends(ms,day,request_id) VALUES(?,?,?)", now, day, id);
    this.log("approved", { request_id: id, recipient: r.recipient, sha256: logSha, detail: `method=${who.method} by=${who.email}` });
    let queuedJob: string | null = null;
    try {
      // queued_device is written in the same step as the job (before the Shortcut ping is awaited), so a claim
      // and result that land during the ping still find the request row and record the outcome on it.
      const d = await this.deliver(r.recipient, r.text, { kind: "tap", id }, (job) => {
        queuedJob = job;
        this.sql.exec("UPDATE requests SET state='queued_device', gateway_id=? WHERE id=?", job, id);
      });
      if (d.queued) return json(202, { id, state: "queued" });
      const gid = d.gid;
      this.sql.exec("UPDATE requests SET state='sent', gateway_id=? WHERE id=?", gid, id);
      this.log("sent", { request_id: id, recipient: r.recipient, sha256: logSha, detail: gid });
      return json(200, { id, state: "sent" });
    } catch (e) {
      if (queuedJob !== null) {
        this.logAfterQueue(id, queuedJob, e); // the job is queued; the device reports its outcome
        return json(202, { id, state: "queued" });
      }
      this.sql.exec("UPDATE requests SET state='send_failed' WHERE id=?", id);
      this.log("send_failed", { request_id: id, recipient: r.recipient, sha256: logSha, detail: errCode(e) });
      return json(502, { id, state: "send_failed" });
    }
  }

  private async showLog(req: Request): Promise<Response> {
    await this.requireOwner(req, "log");
    const rows = this.sql.exec("SELECT ms,event,request_id,recipient,sha256,detail FROM log ORDER BY seq DESC LIMIT 500").toArray();
    return json(200, rows);
  }

  // ---------- device delivery (DELIVERY = mac | shortcut) ----------

  /** DIRECT_DAILY_CAP: unset means 25 in a device mode (Apple ID spam-flag risk) and no cap on android. "off" = none. */
  private directDailyCap(): number | null {
    const raw = this.env.DIRECT_DAILY_CAP;
    if ((raw === undefined || raw === "") && isDevice(this.delivery())) return DEVICE_DEFAULT_DAILY_CAP;
    return parseOptionalLimit(raw);
  }

  /**
   * The last hop. android: the SMS Gateway, now. mac/shortcut: a queued job the owner's device claims over
   * POST /device/next. Callers run every guard and counter BEFORE this, so a queued job is already approved.
   */
  private async deliver(
    to: string,
    text: string,
    ref: { kind: JobKind; id: string; who?: string; sha?: string },
    onQueued?: (job: string) => void,
  ): Promise<Delivered> {
    const mode = this.delivery();
    if (!isDevice(mode)) return { queued: false, gid: await this.gatewaySend(to, text) };
    if (!E164.test(to)) throw new Error("bad_recipient");
    const job = hex(crypto.getRandomValues(new Uint8Array(16)));
    this.sql.exec(
      "INSERT INTO device_jobs(id,created_ms,kind,ref,recipient,text,state,who,sha) VALUES(?,?,?,?,?,?,'queued',?,?)",
      job, this.clock(), ref.kind, ref.id, to, text, ref.who ?? null, ref.sha ?? null,
    );
    onQueued?.(job); // synchronous with the INSERT: nothing else runs before the caller's state is saved
    this.log("device_queued", { request_id: ref.id, detail: `job_id=${job.slice(0, 8)} kind=${ref.kind} via=${mode}` });
    await this.ensureDeviceAlarm();
    if (mode === "shortcut") await this.pingShortcut();
    return { queued: true, job };
  }

  /** An error after a job was queued (the alarm arming): logged, never turned into a failure or a retry. */
  private logAfterQueue(ref: string, job: string, e: unknown) {
    console.error(`DEVICE_AFTER_QUEUE_ERROR job_id=${job.slice(0, 8)} reason=${errCode(e)}`);
    this.log("device_after_queue_error", { request_id: ref, detail: `job_id=${job.slice(0, 8)} reason=${errCode(e)}` });
  }

  /** In a device mode the alarm must fire within DEVICE_SWEEP_MS (claim timeouts, the stale watch). */
  private async ensureDeviceAlarm() {
    const want = Date.now() + DEVICE_SWEEP_MS;
    const at = await this.ctx.storage.getAlarm();
    if (at === null || at > want) await this.ctx.storage.setAlarm(want);
  }

  /** Email ping transport (Cloudflare Email Routing send_email binding PING_EMAIL). Tests replace this. */
  pingEmail: (m: { from: string; to: string; mime: string }) => Promise<void> = async (m) => {
    const binding = (this.env as unknown as { PING_EMAIL?: { send(msg: unknown): Promise<void> } }).PING_EMAIL;
    if (!binding) throw new Error("ping_email_not_configured");
    const { EmailMessage } = await import("cloudflare:email");
    await binding.send(new EmailMessage(m.from, m.to, m.mime));
  };

  /** Shortcut path: tell the iPhone a job is waiting. The ping never carries the text or a number. Failure keeps the job queued. */
  private async pingShortcut() {
    const via = parseShortcutPing(this.env.SHORTCUT_PING);
    try {
      if (via === "email") {
        const from = this.env.PING_FROM || "";
        const to = this.env.PING_TO || "";
        if (!/^[^\s@<>]+@[^\s@<>]+$/.test(from) || !/^[^\s@<>]+@[^\s@<>]+$/.test(to)) throw new Error("ping_email_not_configured");
        const msgId = `${hex(crypto.getRandomValues(new Uint8Array(12)))}@${from.split("@")[1]}`;
        await this.pingEmail({ from, to, mime: pingMime(from, to, msgId, new Date(this.clock())) });
      } else {
        if (!this.env.NTFY_URL?.startsWith("https://") || !this.env.NTFY_TOKEN) throw new Error("ntfy_not_configured");
        const r = await this.net(new Request(this.env.NTFY_URL, {
          method: "POST",
          body: TAP_PING_TEXT,
          headers: { Authorization: `Bearer ${this.env.NTFY_TOKEN}`, Title: "SMS relay", Click: shortcutRunUrl(this.env.SHORTCUT_NAME || "Relay Send") },
        }));
        if (!r.ok) throw new Error(`ntfy_status_${r.status}`);
      }
      this.log("device_pinged", { detail: `via=${via}` });
    } catch (e) {
      console.error(`DEVICE_PING_FAILED via=${via} reason=${errCode(e)}`);
      this.log("device_ping_failed", { detail: `via=${via} reason=${errCode(e)}` });
    }
  }

  /** DEVICE_TOKEN only. REQUEST_TOKEN never works here (and DEVICE_TOKEN never works on the bot routes). */
  private async requireDeviceToken(req: Request) {
    const bad = deviceTokenProblem(this.env.DEVICE_TOKEN, this.env.REQUEST_TOKEN);
    if (bad) throw new Refuse(bad, 503);
    const m = (req.headers.get("Authorization") || "").match(/^Bearer (.+)$/);
    if (!m || !(await tokenEquals(m[1], this.env.DEVICE_TOKEN!))) {
      console.log("device_auth_failed"); // no log row: a polling stranger must not be able to flood the log
      const r = new Refuse("bad_device_token", 401);
      r.silent = true;
      throw r;
    }
  }

  /**
   * POST /device/next (request host, DEVICE_TOKEN). Hands out at most one job at a time, oldest first.
   * The claim is one synchronous transaction inside the single Durable Object: the job leaves "queued" in the
   * same step that hands it out, so it can be claimed once. Its text is erased from storage in that step too.
   */
  private async deviceNext(req: Request): Promise<Response> {
    await this.requireDeviceToken(req);
    await this.ensureDeviceAlarm(); // a check-in arms the minute sweep, so a device that then dies is noticed in 10 min
    await this.deviceSweep(); // time out stuck claims first, so a dead one never blocks the queue
    const now = this.clock();
    const out = this.ctx.storage.transactionSync(() => {
      this.setMeta("device_last_seen_ms", String(now));
      if (this.meta("device_stale") === "1") {
        this.setMeta("device_stale", null); // the outage is over; the next one gets its own notice
        this.log("device_back");
      }
      const busy = this.sql.exec("SELECT COUNT(*) AS c FROM device_jobs WHERE state='claimed'").one().c as number;
      if (busy > 0) return { job: null, reason: "busy" };
      const j = this.sql.exec("SELECT id, ref, recipient, text FROM device_jobs WHERE state='queued' ORDER BY created_ms, rowid LIMIT 1").toArray()[0] as
        | { id: string; ref: string | null; recipient: string; text: string }
        | undefined;
      if (!j) return { job: null };
      const lease = hex(crypto.getRandomValues(new Uint8Array(16)));
      this.sql.exec("UPDATE device_jobs SET state='claimed', lease=?, claimed_ms=?, text=NULL WHERE id=? AND state='queued'", lease, now, j.id);
      this.log("device_claimed", { request_id: j.ref, detail: `job_id=${j.id.slice(0, 8)}` });
      return { job: { id: j.id, lease, to: j.recipient, text: j.text, result_by_ms: now + CLAIM_TIMEOUT_MS } };
    });
    return json(200, out);
  }

  /** POST /device/result {id, lease, outcome, detail?}. One result per claim; nothing is ever re-queued. */
  private async deviceResult(req: Request): Promise<Response> {
    await this.requireDeviceToken(req);
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      throw new Refuse("body_not_json");
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Refuse("body_must_be_object");
    const b = raw as Record<string, unknown>;
    if (Object.keys(b).some((k) => !["id", "lease", "outcome", "detail"].includes(k))) throw new Refuse("unknown_fields");
    if (typeof b.id !== "string" || !/^[a-f0-9]{32}$/.test(b.id)) throw new Refuse("job_unknown", 404);
    if (typeof b.lease !== "string" || !/^[a-f0-9]{32}$/.test(b.lease)) throw new Refuse("bad_lease", 403);
    const outcome = parseOutcome(b.outcome);
    const detail = safeDetail(b.detail);
    await this.deviceSweep(); // a result after the claim timed out is refused below
    const now = this.clock();
    const id = b.id;
    const lease = b.lease;
    const verdict = this.ctx.storage.transactionSync((): { status: number; error?: string } => {
      const j = this.sql.exec("SELECT id, kind, ref, who, sha, state, lease FROM device_jobs WHERE id=?", id).toArray()[0] as unknown as Job | undefined;
      if (!j) return { status: 404, error: "job_unknown" };
      if (j.lease !== lease) return { status: 403, error: "bad_lease" };
      if (j.state === "claim_timeout") {
        this.log("device_result_late", { request_id: j.ref, detail: `job_id=${id.slice(0, 8)} outcome=${outcome}` });
        return { status: 409, error: "claim_timed_out" };
      }
      if (j.state !== "claimed") return { status: 409, error: "result_already_recorded" };
      this.sql.exec("UPDATE device_jobs SET state=?, done_ms=? WHERE id=? AND state='claimed'", outcome, now, id);
      this.finishJob(j, outcome, detail);
      return { status: 200 };
    });
    if (verdict.error) throw new Refuse(verdict.error, verdict.status);
    return json(200, { id, state: outcome });
  }

  /** Record a job's end on its owner: the tap request row, the direct-send log, or a notice. */
  private finishJob(j: Job, end: Outcome | "claim_timeout" | "expired", detail: string | null = null) {
    const sent = end === "sent" || end === "sent_unverified";
    // claim_timeout: the device took the text and went quiet, so it may have sent. Never "failed", never retried.
    const uncertain = end === "uncertain" || end === "claim_timeout";
    const extra = `job_id=${j.id.slice(0, 8)} outcome=${end}${detail ? ` detail=${detail}` : ""}`;
    if (j.kind === "tap" && j.ref) {
      const st: State = sent ? "sent" : uncertain ? "send_uncertain" : "send_failed";
      this.sql.exec("UPDATE requests SET state=? WHERE id=? AND state='queued_device'", st, j.ref);
      this.log(sent ? "sent" : uncertain ? "send_uncertain" : "send_failed", { request_id: j.ref, detail: extra });
    } else {
      const ev = sent ? "direct_sent" : uncertain ? "direct_send_uncertain" : "direct_send_failed";
      this.log(ev, { request_id: j.ref, sha256: j.sha, detail: `${j.who ?? "method=direct"} ${extra}` });
    }
  }

  /**
   * Time out claims (2 min, fail closed), drop unclaimed jobs older than 30 min, and watch the device.
   * The state changes are one transaction; the owner notice goes out after it, at most once per outage.
   */
  async deviceSweep(): Promise<void> {
    const mode = this.deviceModeOrNull();
    if (!mode) return;
    const now = this.clock();
    let expiryMs: number;
    try {
      expiryMs = parseUnclaimedExpiryMs(this.env.UNCLAIMED_EXPIRY_MINUTES);
    } catch {
      expiryMs = parseUnclaimedExpiryMs(undefined); // garbage: fetch refuses every route; the sweep keeps the default
    }
    const { stale, expired } = this.ctx.storage.transactionSync(() => this.sweepSync(mode, now, expiryMs));
    for (const x of expired) await this.notifyExpired(x, expiryMs);
    if (stale !== null) await this.notifyStale(mode, stale, expiryMs);
  }

  /**
   * Returns the jobs that just expired (for their owner notices) and, when the device has JUST gone stale,
   * the minutes since its last poll.
   */
  private sweepSync(mode: "mac" | "shortcut", now: number, expiryMs: number): { stale: number | null; expired: { job: string; ref: string | null; to: string }[] } {
    const expired: { job: string; ref: string | null; to: string }[] = [];
    const timedOut = this.sql.exec("SELECT id, kind, ref, who, sha, state, lease FROM device_jobs WHERE state='claimed' AND claimed_ms <= ?", now - CLAIM_TIMEOUT_MS).toArray() as unknown as Job[];
    for (const j of timedOut) {
      this.sql.exec("UPDATE device_jobs SET state='claim_timeout', done_ms=? WHERE id=? AND state='claimed'", now, j.id);
      console.error(`DEVICE_CLAIM_TIMEOUT job_id=${j.id.slice(0, 8)} (not retried)`);
      this.log("device_claim_timeout", { request_id: j.ref, detail: `job_id=${j.id.slice(0, 8)} timeout_s=${CLAIM_TIMEOUT_MS / 1000}` });
      this.finishJob(j, "claim_timeout");
    }
    const old = this.sql.exec("SELECT id, kind, ref, who, sha, state, lease, recipient FROM device_jobs WHERE state='queued' AND created_ms <= ?", now - expiryMs).toArray() as unknown as (Job & { recipient: string })[];
    for (const j of old) {
      this.sql.exec("UPDATE device_jobs SET state='expired', text=NULL, done_ms=? WHERE id=? AND state='queued'", now, j.id);
      this.log("device_job_expired", { request_id: j.ref, detail: `job_id=${j.id.slice(0, 8)} max_age_min=${expiryMs / 60_000}` });
      this.finishJob(j, "expired");
      expired.push({ job: j.id, ref: j.ref, to: j.recipient });
    }
    // shortcut: a healthy Shortcut only polls when pinged, so a poll gap means nothing. Stale = the oldest
    // queued text has waited STALE_AFTER_MS unclaimed. The next poll (device_back) re-arms the notice.
    if (mode === "shortcut") {
      const oldest = this.sql.exec("SELECT MIN(created_ms) AS m FROM device_jobs WHERE state='queued'").one().m as number | null;
      if (oldest === null || now - oldest < STALE_AFTER_MS || this.meta("device_stale") === "1") return { stale: null, expired };
      this.setMeta("device_stale", "1");
      const waited = Math.floor((now - oldest) / 60_000);
      console.error(`DEVICE_STALE minutes_unclaimed=${waited}`);
      this.log("device_stale", { detail: `minutes_unclaimed=${waited} via=shortcut` });
      return { stale: waited, expired };
    }
    // mac: the helper polls every few seconds, so 10 minutes without a poll is an outage. The watch starts
    // the first time a device mode runs, so a Mac that never polls is caught too.
    const seen = this.meta("device_last_seen_ms");
    let since = seen === null ? null : Number(seen);
    if (since === null) {
      const watch = this.meta("device_watch_ms");
      if (watch === null) {
        this.setMeta("device_watch_ms", String(now));
        return { stale: null, expired };
      }
      since = Number(watch);
    }
    if (now - since < STALE_AFTER_MS || this.meta("device_stale") === "1") return { stale: null, expired };
    this.setMeta("device_stale", "1");
    const minutes = Math.floor((now - since) / 60_000);
    console.error(`DEVICE_STALE minutes_since_poll=${minutes}`);
    this.log("device_stale", { detail: `minutes_since_poll=${minutes} ever_polled=${seen === null ? 0 : 1}` });
    return { stale: minutes, expired };
  }

  /** One owner notice per expired text: who it was for (masked) and that it was NOT sent. Never the text. */
  private async notifyExpired(x: { job: string; ref: string | null; to: string }, expiryMs: number) {
    const ref = (x.ref ?? x.job).slice(0, 8);
    const msg = `SMS relay: a text to ${maskNumber(x.to)} wasn't picked up by your device within ${expiryMs / 60_000} min, so it was dropped and NOT sent. ref ${ref}. Ask your bot to send it again once the device is back.`;
    try {
      await this.deliverToOwner(msg, "SMS relay text dropped");
      this.log("device_expired_notified", { request_id: x.ref, detail: `job_id=${x.job.slice(0, 8)}` });
    } catch (e) {
      console.error(`DEVICE_EXPIRED_NOTIFY_FAILED job_id=${x.job.slice(0, 8)} reason=${errCode(e)}`);
      this.log("device_expired_notify_failed", { request_id: x.ref, detail: `job_id=${x.job.slice(0, 8)} reason=${errCode(e)}` });
    }
  }

  /** The one stale notice per outage, through the owner-notice path (ntfy: device modes refuse sms). */
  private async notifyStale(mode: "mac" | "shortcut", minutes: number, expiryMs: number) {
    const drop = `unclaimed ones are dropped after ${expiryMs / 60_000} min`;
    const msg =
      mode === "mac"
        ? `SMS relay: your Mac hasn't checked in for ${minutes} min. Texts wait in the queue (${drop}). Check it's on, awake, logged in and online.`
        : `SMS relay: a text has waited ${minutes} min and your iPhone Shortcut hasn't picked it up. Texts wait in the queue (${drop}). Check the automation still runs (open Shortcuts > Automation) and the iPhone is online.`;
    try {
      await this.deliverToOwner(msg, "SMS relay device offline");
      this.log("device_stale_notified", { detail: "ntfy" });
    } catch (e) {
      console.error(`DEVICE_STALE_NOTIFY_FAILED reason=${errCode(e)}`);
      this.log("device_stale_notify_failed", { detail: errCode(e) });
    }
  }

  /** One line for GET /direct: the delivery mode and, in a device mode, the last poll. */
  private devicePageLine(): string {
    const mode = this.deviceModeOrNull();
    if (!mode) return "<p><b>Delivery:</b> android (SMS Gateway)</p>";
    const seen = this.meta("device_last_seen_ms");
    const queued = this.sql.exec("SELECT COUNT(*) AS c FROM device_jobs WHERE state='queued'").one().c as number;
    return `<p><b>Delivery:</b> ${mode} · <b>last poll:</b> ${seen ? esc(this.fmtTime(Number(seen))) : "never"}${this.meta("device_stale") === "1" ? " (STALE)" : ""} · <b>queued:</b> ${queued}</p>`;
  }

  /**
   * POST /request by contact name ({to_name, text}) or candidate id ({candidate_id, text}) instead of a number.
   * The name is looked up in the same list /send uses (contacts, then DIRECT_ALLOWLIST when allowed, then
   * ALLOWLIST). Exactly one match files the request; no match or several matches file nothing and answer like
   * /send does (candidate ids for the ambiguous case). Needs LOG_HASH_KEY, because the list is keyed by its HMAC.
   */
  private async createNamedRequest(b: Record<string, unknown>, cfg: TapConfig, blockLinks: boolean): Promise<Response> {
    if (Object.keys(b).some((k) => !["to", "to_name", "candidate_id", "text"].includes(k))) throw new Refuse("unknown_fields");
    if (["to", "to_name", "candidate_id"].filter((k) => k in b).length !== 1) throw new Refuse("exactly_one_of_to_to_name_candidate_id");
    const text = validateTapText(b.text, cfg.maxChars, blockLinks);
    const hashKey = await this.hashKey();
    if (!hashKey) {
      console.error("CONFIG_ERROR reason=log_hash_key_missing_or_short");
      throw new Refuse("config_invalid", 503);
    }
    const now = this.clock();
    const people = await this.directList(hashKey);
    const gate = { authed: true, gated: false };
    let pick: (ContactRow & { e164_sha: string }) | undefined;
    let usedCandidate: string | null = null;
    if ("to_name" in b) {
      const q = b.to_name;
      if (Array.isArray(q)) throw new Refuse("group_send_not_allowed");
      if (typeof q !== "string" || q.length > 200) throw new Refuse("to_name_invalid");
      const found = matchName(people, q);
      if (found.length === 0) {
        this.nonSendGate(gate);
        this.log("request_lookup", { detail: "method=tap via=name result=no_match" });
        return json(200, { state: "no_match", candidates: [] });
      }
      if (found.length > 1) {
        // Nothing is filed: the bot reads the labels back and files again with the chosen candidate_id.
        this.nonSendGate(gate);
        this.sql.exec("DELETE FROM candidates WHERE expires_ms<=?", now);
        const liveNow = this.sql.exec("SELECT COUNT(*) AS c FROM candidates WHERE used = 0").one().c as number;
        if (liveNow + found.length > MAX_LIVE_CANDIDATES) throw new Refuse("too_many_candidates", 429);
        const lookup = hex(crypto.getRandomValues(new Uint8Array(16)));
        const candidates = found.map((row) => {
          const cid = hex(crypto.getRandomValues(new Uint8Array(16)));
          this.sql.exec("INSERT INTO candidates(id, grp, to_sha, expires_ms, used) VALUES (?, ?, ?, ?, 0)", cid, lookup, row.e164_sha, now + CANDIDATE_TTL_MS);
          return { candidate_id: cid, label: `${safeName(row.name)} (${row.label})` };
        });
        this.log("request_lookup", { detail: `method=tap via=name result=ambiguous candidates=${found.length}` });
        return json(200, { state: "ambiguous", candidates, expires_in_s: CANDIDATE_TTL_MS / 1000 });
      }
      pick = found[0];
    } else {
      const cid = b.candidate_id;
      if (typeof cid !== "string" || !/^[a-f0-9]{32}$/.test(cid)) throw new Refuse("candidate_unknown", 404);
      const row = this.sql.exec("SELECT grp, to_sha, expires_ms, used FROM candidates WHERE id = ?", cid).toArray()[0] as { grp: string; to_sha: string; expires_ms: number; used: number } | undefined;
      if (!row) throw new Refuse("candidate_unknown", 404);
      if (row.used === 1) throw new Refuse("candidate_used", 409);
      if (row.expires_ms <= now) throw new Refuse("candidate_expired", 410);
      pick = people.find((p) => p.e164_sha === row.to_sha);
      if (!pick) throw new Refuse("candidate_unknown", 404); // the number left the list since the lookup
      usedCandidate = cid;
    }
    const day = localDate(now, this.tz());
    const filed = this.sql.exec("SELECT COUNT(*) AS c FROM requests WHERE created_day = ?", day).one().c as number;
    if (filed >= cfg.pendingPerDay) throw new Refuse("request_cap_reached", 429);
    // Single use for the whole lookup, like /send: filing with one candidate retires its siblings.
    if (usedCandidate) this.sql.exec("UPDATE candidates SET used = 1 WHERE grp = (SELECT grp FROM candidates WHERE id = ?)", usedCandidate);
    const label = safeName(pick.name);
    const id = hex(crypto.getRandomValues(new Uint8Array(16)));
    const csrf = hex(crypto.getRandomValues(new Uint8Array(16)));
    const sha = await sha256Hex(text);
    const expires = now + cfg.ttlSeconds * 1000;
    this.sql.exec(
      "INSERT INTO requests(id,created_ms,expires_ms,created_day,recipient,text,sha256,csrf,state,via,to_label) VALUES(?,?,?,?,?,?,?,?,'pending','contacts',?)",
      id, now, expires, day, pick.e164, text, sha, csrf, label,
    );
    this.purge(now);
    this.log("request_created", { request_id: id, recipient: pick.e164, sha256: await this.logBodyHash(text), detail: `via=${usedCandidate ? "candidate" : "name"}` });
    const notified = await this.notify(id, pick.e164, label, cfg.ttlSeconds);
    return json(202, { id, state: "pending", expires_ms: expires, sha256: sha, notified, to: label });
  }

  /** Approve-time check for a request filed by name: the number must still be on the /send list. */
  private async requireStillOnList(e164: string) {
    const hashKey = await this.hashKey();
    if (!hashKey) throw new Refuse("config_invalid", 503);
    if (!(await this.directList(hashKey)).some((p) => p.e164 === e164)) throw new Refuse("recipient_not_on_allowlist", 403);
  }

  // ---------- gateway ----------
  private async gw(method: string, path: string, body?: unknown): Promise<any> {
    const e = this.env;
    if (!e.GATEWAY_BASE_URL?.startsWith("https://") || !e.GATEWAY_USER || !e.GATEWAY_PASS) throw new Error("gateway_not_configured");
    const r = await this.net(
      new Request(e.GATEWAY_BASE_URL.replace(/\/$/, "") + path, {
        method,
        body: body === undefined ? undefined : JSON.stringify(body),
        headers: { Authorization: "Basic " + btoa(`${e.GATEWAY_USER}:${e.GATEWAY_PASS}`), "Content-Type": "application/json" },
      }),
    );
    if (!r.ok) throw new Error(`gateway_status_${r.status}`);
    return jsonOr(r, "gateway_bad_json");
  }

  /**
   * Single-recipient, E2E-encrypted send to the configured device. Mode selection (fail closed):
   * - listed device id must equal GATEWAY_DEVICE_ID, else refuse (security event)
   * - GATEWAY_MODE = "passphrase" (explicit owner choice) → passphrase mode even if the device lists a publicKey
   *   (the app picks the decryptor by prefix); GATEWAY_PASSPHRASE MUST be set, else refuse
   * - device has publicKey (GATEWAY_MODE unset or "device_key"): pin (fingerprint + key version) MUST be configured
   *   and match → RSA mode; publicKey with no pin, or a mismatch → refuse (security event). Never falls back.
   * - GATEWAY_MODE = "device_key" and the device has no publicKey → refuse
   * - device has no publicKey and GATEWAY_PASSPHRASE is set → passphrase mode
   * - neither → refuse. Any other GATEWAY_MODE value refuses every send (config_error).
   * Returns the gateway message id.
   */
  async gatewaySend(to: string, text: string): Promise<string> {
    return this.gatewayPost([to], text, "sms");
  }

  /** Group MMS: ONE request, mmsMessage, every recipient in phoneNumbers (the phone puts them all in To). */
  async gatewaySendGroup(to: string[], text: string): Promise<string> {
    if (to.length < 2) throw new Error("group_needs_two_recipients");
    return this.gatewayPost(to, text, "mms");
  }

  private async gatewayPost(to: string[], text: string, kind: "sms" | "mms"): Promise<string> {
    if (!to.length || (kind === "sms" && to.length !== 1) || to.some((t) => !E164.test(t))) throw new Error("bad_recipient");
    const want = this.env.GATEWAY_DEVICE_ID;
    if (!want) throw new Error("gateway_device_id_not_configured");
    // Config load: a configured-but-short passphrase refuses EVERY send (either mode), before any network call.
    const gm = this.env.GATEWAY_MODE ?? "";
    try {
      if (gm !== "" && gm !== "passphrase" && gm !== "device_key") throw new Error("gateway_mode_invalid");
      checkPassphrase(this.env.GATEWAY_PASSPHRASE);
      if (this.env.GATEWAY_PASSPHRASE) parseIterations(this.env.GATEWAY_PBKDF2_ITERATIONS);
    } catch (e) {
      const code = errCode(e);
      this.log("config_error", { detail: code });
      throw new Error(code);
    }
    const devs = await this.gw("GET", "/devices");
    if (!Array.isArray(devs)) throw new Error("devices_not_list");
    const dev = devs.find((d: any) => d && typeof d === "object" && d.id === want);
    if (!dev) return this.security("device_id_not_listed");
    let encryptField: (s: string) => Promise<string>;
    let mode: string;
    if (gm === "passphrase") {
      // Explicit only: a passphrase merely being present never overrides a device key (no silent downgrade).
      if (!this.env.GATEWAY_PASSPHRASE) return this.security("gateway_mode_passphrase_but_no_passphrase");
      const iters = parseIterations(this.env.GATEWAY_PBKDF2_ITERATIONS);
      const pass = this.env.GATEWAY_PASSPHRASE;
      encryptField = (s) => encryptFieldPassphrase(pass, iters, s);
      mode = "passphrase";
    } else if (typeof dev.publicKey === "string" && dev.publicKey) {
      const pin = this.env.GATEWAY_PINNED_FINGERPRINT;
      const ver = this.env.GATEWAY_KEY_VERSION;
      if (!pin || !ver || !/^\d+$/.test(ver)) return this.security("device_key_present_but_no_pin");
      if ((await fingerprint(dev.publicKey)) !== pin || dev.keyVersion !== Number(ver)) return this.security("device_key_pin_mismatch");
      encryptField = (s) => encryptFieldRsa(dev.publicKey, dev.keyVersion, s);
      mode = "rsa";
    } else if (gm === "device_key") {
      return this.security("gateway_mode_device_key_but_no_device_key");
    } else if (this.env.GATEWAY_PASSPHRASE) {
      const iters = parseIterations(this.env.GATEWAY_PBKDF2_ITERATIONS);
      const pass = this.env.GATEWAY_PASSPHRASE;
      encryptField = (s) => encryptFieldPassphrase(pass, iters, s);
      mode = "passphrase";
    } else {
      return this.security("no_device_key_and_no_passphrase");
    }
    const content = { text: await encryptField(text) };
    const phoneNumbers: string[] = [];
    for (const t of to) phoneNumbers.push(await encryptField(t));
    // sms: textMessage, one recipient (keeps delivery reports). mms: mmsMessage, text only, no attachments.
    const body = kind === "mms" ? { deviceId: want, isEncrypted: true, mmsMessage: content, phoneNumbers } : { deviceId: want, isEncrypted: true, textMessage: content, phoneNumbers };
    const resp = await this.gw("POST", "/messages", body);
    this.log("gateway_mode", { detail: kind === "mms" ? `${mode} mms` : mode });
    return resp && typeof resp.id === "string" ? resp.id : "unknown";
  }

  /** Log a security event (code only, never secret values) and refuse. */
  private security(code: string): never {
    this.log("security_event", { detail: code });
    throw new Error(code);
  }
}
