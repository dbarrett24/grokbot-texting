import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import { encryptField as encryptFieldRsa, fingerprint, sha256Hex, hex, hmacHex, importHmacKey } from "./e2e";
import { checkPassphrase, encryptFieldPassphrase, parseIterations } from "./passphrase";
import { verifyAccess, type Net } from "./access";
import { E164, Refuse, hasLink, localDate, maskNumber, parseAllowlist, parseCount, parseSwitch, parseTapConfig, parseTimezone, sendCap, validateRequestBody, type TapConfig } from "./rules";
import {
  insideHours, matchName, parseRequiredLimit, minuteOfDay, normalizeName, parseHours, parseNotifyEach, parseOptionalLimit, parseSnapshot,
  safeName, switchOnUnlessZero, switchOnlyIfOne, validateBody, parseAccounts, parseCountryCode, peopleToContacts, UPLOAD_SOURCE, type ContactRow, type SnapshotContact,
} from "./direct";

const HOUR = 3_600_000;
const CANDIDATE_TTL_MS = 15 * 60_000;
const MAX_LIVE_CANDIDATES = 200;
type Via = "name" | "candidate" | "number";
/** Outcome of the direct-send transaction. */
type DirectPlan = { kind: "send" } | { kind: "refuse"; reason: string; status: number; newlyPaused: boolean };

type State = "pending" | "approved_sending" | "sent" | "send_failed" | "denied";

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
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

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
    this.sql.exec(`CREATE TABLE IF NOT EXISTS log(seq INTEGER PRIMARY KEY AUTOINCREMENT, ms INTEGER,
      event TEXT, request_id TEXT, recipient TEXT, sha256 TEXT, detail TEXT)`);
    // Daily purge so retention holds even with no traffic.
    ctx.blockConcurrencyWhile(async () => {
      if ((await ctx.storage.getAlarm()) === null) await ctx.storage.setAlarm(Date.now() + 86_400_000);
    });
  }

  async alarm() {
    this.purge(this.clock());
    if (this.env.DISABLED === "1") {
      // Kill switch: retention only. No Google calls, no alert texts.
      await this.ctx.storage.setAlarm(Date.now() + 86_400_000);
      return;
    }
    try {
      await this.syncContacts();
    } catch (e) {
      console.error(`CONTACTS_SYNC_CRASHED reason=${errCode(e)}`);
      this.log("contacts_sync_failed", { detail: `account=ALL reason=${errCode(e)}` });
    }
    await this.ctx.storage.setAlarm(Date.now() + 86_400_000);
  }

  /** TIMEZONE (required, no default). fetch() checks it first, so every route refuses while it's missing or invalid. */
  private tz() {
    return parseTimezone(this.env.TIMEZONE);
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
      try {
        this.tz(); // required config: refuse every route until TIMEZONE is a valid IANA zone
      } catch (e) {
        if (e instanceof Refuse) console.error(`CONFIG_ERROR reason=${e.code}`);
        throw e;
      }
      const path = url.pathname;
      const host = url.hostname.toLowerCase();
      const reqHost = (this.env.REQUEST_HOST || "").toLowerCase();
      const apprHost = (this.env.APPROVE_HOST || "").toLowerCase();
      if (!reqHost || !apprHost || reqHost === apprHost) throw new Refuse("hosts_not_configured", 503);
      if (host === reqHost) {
        // Request API host: never serves approve or log routes.
        if (req.method === "POST" && path === "/request") return await this.createRequest(req);
        if (req.method === "POST" && path === "/send") return await this.direct(req);
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
        if (req.method === "POST" && path === "/contacts") return await this.uploadContacts(req);
        if (req.method === "GET" && path === "/direct") return await this.directPage(req);
        if (req.method === "POST" && path === "/direct/resume") return await this.resumeDirect(req);
        if (req.method === "POST" && path === "/direct/sync") return await this.syncNow(req);
        return json(404, { error: "not_found" });
      }
      return json(404, { error: "unknown_host" });
    } catch (e) {
      if (e instanceof Refuse) {
        if (!e.silent) this.log("refused", { detail: e.code });
        return json(e.status, { error: e.code });
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
   * Fill contact e164_sha with the current key's HMAC. Loads store NULL and clear hash_key_fp, and a key
   * rotation changes the fingerprint, so this runs once per load or rotation, never per request.
   */
  private async ensureContactHashes(key: CryptoKey) {
    const fp = await hmacHex(key, "fingerprint");
    if (this.meta("hash_key_fp") === fp) return;
    const nums = this.sql.exec("SELECT DISTINCT e164 FROM contact_sources").toArray().map((r) => r.e164 as string);
    const hashes = await Promise.all(nums.map((n) => this.numHash(key, n)));
    this.ctx.storage.transactionSync(() => {
      nums.forEach((n, i) => this.sql.exec("UPDATE contact_sources SET e164_sha=? WHERE e164=?", hashes[i], n));
      this.rebuildContacts(); // also retires candidates drawn under the old key
      this.setMeta("hash_key_fp", fp);
    });
  }

  /**
   * Who /send may text: the union, deduped by E.164 in this order (first wins the name):
   *   1. contacts (Google sync + manual upload)
   *   2. the DIRECT_ALLOWLIST secret, only when CONTACTS_SNAPSHOT_ONLY is exactly "0"
   *   3. the tap ALLOWLIST (always: anyone the owner can approve by tap can also be sent to directly)
   */
  private async directList(key: CryptoKey): Promise<(ContactRow & { e164_sha: string })[]> {
    await this.ensureContactHashes(key);
    const rows = this.sql.exec("SELECT name,name_norm,given_norm,first_norm,e164,e164_sha,label FROM contacts").toArray() as unknown as (ContactRow & { e164_sha: string })[];
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
    if (!switchOnUnlessZero(this.env.CONTACTS_SNAPSHOT_ONLY)) await add(this.env.DIRECT_ALLOWLIST);
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
  private nonSendGate(st: { authed: boolean; gated: boolean }) {
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
      if (n >= max) {
        const r = new Refuse("lookup_rate", 429);
        r.silent = true;
        throw r;
      }
    }
    this.sql.exec("INSERT INTO nonsend(ms,kind) VALUES(?,?)", now, kind);
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
    if (Object.keys(b).some((k) => !["to", "to_name", "candidate_id", "body", "resolve"].includes(k))) throw new Refuse("unknown_fields");
    const keys = ["to", "to_name", "candidate_id"].filter((k) => k in b);
    if (keys.length !== 1) throw new Refuse("exactly_one_of_to_to_name_candidate_id");
    // resolve: true = look the name up and return candidate ids only; never sends. The bot reads the name
    // back to the owner, then sends by candidate_id. body is optional here (checked if given).
    if ("resolve" in b && b.resolve !== true) throw new Refuse("resolve_must_be_true");
    const resolve = b.resolve === true;
    if (resolve && !("to_name" in b)) throw new Refuse("resolve_needs_to_name");
    const maxChars = parseCount(this.env.MAX_TEXT_CHARS, 640, 1, 10000);
    const blockLinks = this.blockLinks("direct_config_invalid");
    const text = resolve ? (b.body === undefined ? "" : validateBody(b.body, maxChars, blockLinks)) : validateBody(b.body, maxChars, blockLinks);
    // Optional limits and guards: parse now so a bad value refuses before anything is stored (fail closed).
    const cfg = {
      daily: parseOptionalLimit(this.env.DIRECT_DAILY_CAP),
      lookupMax: parseOptionalLimit(this.env.DIRECT_LOOKUP_MAX_PER_HOUR), // checked here so garbage refuses
      perMinute: parseOptionalLimit(this.env.DIRECT_PER_MINUTE_MAX),
      hours: parseHours(this.env.DIRECT_HOURS),
      notifyEach: parseNotifyEach(this.env.DIRECT_NOTIFY_EACH),
      runaway: switchOnUnlessZero(this.env.RUNAWAY_PAUSE),
      runawayMax: this.env.RUNAWAY_MAX === undefined ? 10 : parseRequiredLimit(this.env.RUNAWAY_MAX),
    };
    const now = this.clock();
    const list = await this.directList(key);
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
    return this.directSend(target, text, via, candidate, cfg, now, key, st);
  }

  private async directSend(
    target: { e164: string; e164_sha: string; name: string },
    text: string,
    via: Via,
    candidate: string | null,
    cfg: { daily: number | null; perMinute: number | null; hours: { start: number; end: number } | null; notifyEach: boolean; runaway: boolean; runawayMax: number },
    now: number,
    key: CryptoKey,
    st: { authed: boolean; gated: boolean },
  ): Promise<Response> {
    const day = localDate(now, this.tz());
    const bodySha = `hmac:${await this.bodyHash(key, text)}`;
    const id = hex(crypto.getRandomValues(new Uint8Array(16)));
    const label = safeName(target.name);
    const who = `method=direct via=${via} to_hmac=${target.e164_sha} label=${label}`;
    // Every guard and every counter update in ONE synchronous transaction, before any network call.
    const plan = this.ctx.storage.transactionSync((): DirectPlan => {
      if (candidate) {
        // Single use for the whole lookup: using one candidate retires its siblings too.
        const grp = this.sql.exec("SELECT grp FROM candidates WHERE id=? AND used=0", candidate).toArray()[0]?.grp as string | undefined;
        if (!grp) throw new Refuse("candidate_used", 409);
        this.sql.exec("UPDATE candidates SET used=1 WHERE grp=?", grp);
      }
      if (cfg.runaway) {
        if (this.meta("direct_paused") === "1") return { kind: "refuse", reason: "direct_paused", status: 503, newlyPaused: false };
        const since = Math.max(now - HOUR, Number(this.meta("direct_resumed_ms") ?? 0));
        const recent = this.sql.exec("SELECT COUNT(*) AS c FROM direct_sends WHERE ms > ?", since).one().c as number;
        if (recent >= cfg.runawayMax) {
          this.setMeta("direct_paused", "1");
          this.setMeta("direct_paused_ms", String(now));
          this.log("direct_paused", { detail: `method=direct reason=runaway sends_last_hour=${recent} max=${cfg.runawayMax}` });
          return { kind: "refuse", reason: "direct_paused", status: 503, newlyPaused: true };
        }
      }
      if (cfg.hours && !insideHours(minuteOfDay(now, this.tz()), cfg.hours)) return { kind: "refuse", reason: "direct_outside_hours", status: 429, newlyPaused: false };
      if (cfg.daily !== null && (this.sql.exec("SELECT COUNT(*) AS c FROM direct_sends WHERE day=?", day).one().c as number) >= cfg.daily)
        return { kind: "refuse", reason: "direct_daily_cap_reached", status: 429, newlyPaused: false };
      if (cfg.perMinute !== null && (this.sql.exec("SELECT COUNT(*) AS c FROM direct_sends WHERE ms > ?", now - 60_000).one().c as number) >= cfg.perMinute)
        return { kind: "refuse", reason: "direct_per_minute_reached", status: 429, newlyPaused: false };
      this.sql.exec("INSERT INTO direct_sends(ms,day,to_sha) VALUES(?,?,?)", now, day, target.e164_sha);
      this.log("direct_approved", { request_id: id, sha256: bodySha, detail: `${who} by=request_token` });
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
    let gid: string;
    try {
      gid = await this.gatewaySend(target.e164, text);
    } catch (e) {
      this.log("direct_send_failed", { request_id: id, sha256: bodySha, detail: `${who} error=${errCode(e)}` });
      return json(502, { id, state: "send_failed", method: "direct" });
    }
    this.log("direct_sent", { request_id: id, sha256: bodySha, detail: `${who} gateway_id=${gid}` });
    let notified: boolean | undefined;
    if (cfg.notifyEach) notified = await this.notifyDirectEach(id, label, text, now);
    return json(200, { id, state: "sent", method: "direct", to: label, ...(notified === undefined ? {} : { notified }) });
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

  private async notifyDirectEach(id: string, label: string, text: string, now: number): Promise<boolean> {
    const chars = [...text];
    const preview = chars.length > 80 ? chars.slice(0, 80).join("") + "…" : text;
    const msg = `SMS relay direct send to ${label} at ${this.fmtTime(now)}: "${preview}" ref ${id.slice(0, 8)}. Log: https://${this.env.APPROVE_HOST}/log`;
    try {
      await this.deliverToOwner(msg, "SMS relay direct send");
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
    this.sql.exec("DELETE FROM contact_sources WHERE account=?", account);
    rows.forEach((r) =>
      this.sql.exec(
        "INSERT INTO contact_sources(account,name,name_norm,given_norm,first_norm,e164,e164_sha,label) VALUES(?,?,?,?,?,?,?,?)",
        account, r.name, r.name_norm, r.given_norm, r.first_norm, r.e164, null, r.label,
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
    const order = [...parseAccounts(this.env.GOOGLE_ACCOUNTS).valid, UPLOAD_SOURCE];
    this.sql.exec("DELETE FROM contacts");
    this.sql.exec("DELETE FROM candidates");
    const seen = new Set<string>();
    for (const acct of order) {
      for (const r of this.sql.exec("SELECT name,name_norm,given_norm,first_norm,e164,e164_sha,label FROM contact_sources WHERE account=? ORDER BY rowid", acct).toArray() as any[]) {
        if (seen.has(r.e164)) continue;
        seen.add(r.e164);
        this.sql.exec("INSERT INTO contacts(name,name_norm,given_norm,first_norm,e164,e164_sha,label) VALUES(?,?,?,?,?,?,?)", r.name, r.name_norm, r.given_norm, r.first_norm, r.e164, r.e164_sha, r.label);
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
    const { valid, invalid } = parseAccounts(this.env.GOOGLE_ACCOUNTS);
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
      const rt = (this.env as unknown as Record<string, string | undefined>)[`GOOGLE_RT_${acct}`];
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
    const keep = new Set([...valid, UPLOAD_SOURCE]);
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

  /** OAuth refresh → People API connections (names + phone numbers only). Errors are codes, never token values. */
  private async fetchGoogleContacts(refreshToken: string, cc: string | null) {
    const id = this.env.GOOGLE_CLIENT_ID;
    const secret = this.env.GOOGLE_CLIENT_SECRET;
    if (!id || !secret) throw new Error("google_client_not_configured");
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
<p><b>DIRECT_SEND:</b> ${switchOnlyIfOne(this.env.DIRECT_SEND) ? "on" : "off"} · <b>runaway guard:</b> ${switchOnUnlessZero(this.env.RUNAWAY_PAUSE) ? "on" : "off"}</p>
<p><b>State:</b> ${paused ? `PAUSED since ${esc(this.fmtTime(pausedMs))}. Direct requests are refused.` : "running"}</p>
<p><b>Direct sends in the last hour:</b> ${lastHour}</p>
<p><b>DEFAULT_COUNTRY_CODE:</b> ${(() => { try { return esc(parseCountryCode(this.env.DEFAULT_COUNTRY_CODE) ?? "none (strict E.164)"); } catch { return "NOT SET: contact sync is refused until it is"; } })()}</p>
<p><b>Direct list:</b> ${snapAt ? `${esc(this.meta("snapshot_numbers") ?? "?")} numbers under ${esc(this.meta("snapshot_names") ?? "?")} distinct names, rebuilt ${esc(this.fmtTime(Number(snapAt)))}` : "empty"}</p>
<ul>${[...parseAccounts(this.env.GOOGLE_ACCOUNTS).valid, UPLOAD_SOURCE].map((a) => { const ok = this.meta(`acct:${a}:ok_ms`); return `<li>${esc(a)}: ${ok ? `${esc(this.meta(`acct:${a}:numbers`) ?? "?")} numbers${this.meta(`acct:${a}:dropped`) ? ` (${esc(this.meta(`acct:${a}:dropped`)!)} fax/pager dropped)` : ""}, last good ${esc(this.fmtTime(Number(ok)))}` : "never loaded"}</li>`; }).join("")}</ul>
${parseAccounts(this.env.GOOGLE_ACCOUNTS).valid.length ? `<form method=post action="/direct/sync"><input type=hidden name=csrf value="${csrf}"><button>Sync contacts now</button></form>` : "<p>No Google accounts configured (GOOGLE_ACCOUNTS).</p>"}
${paused ? `<form method=post action="/direct/resume"><input type=hidden name=csrf value="${csrf}"><button style="font-size:1.2em">Resume direct send</button></form>` : ""}
</body>`;
    return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'" } });
  }

  /** Access + same Origin (required) + the single-use CSRF token from GET /direct. */
  private async directForm(req: Request, route: "resume" | "sync") {
    const who = await this.requireOwner(req, route);
    this.sameOrigin(req, false);
    const form = await req.formData();
    const want = this.meta("direct_csrf");
    if (!want || form.get("csrf") !== want) throw new Refuse("bad_csrf", 403);
    this.setMeta("direct_csrf", null); // single use
    return who;
  }

  /** POST /direct/sync (approve host only, same checks as resume): pull every Google account now. */
  private async syncNow(req: Request): Promise<Response> {
    const who = await this.directForm(req, "sync");
    this.log("contacts_sync_requested", { detail: `method=${who.method} by=${who.email}` });
    // The owner is looking at the result, so no alert text for a failure here (it's still logged).
    const { updated, failed } = await this.syncContacts({ alert: false });
    return json(200, { updated, failed });
  }

  /** POST /direct/resume (approve host, Access + Origin + CSRF from GET /direct). */
  private async resumeDirect(req: Request): Promise<Response> {
    const who = await this.directForm(req, "resume");
    if (this.meta("direct_paused") !== "1") throw new Refuse("not_paused", 409);
    const now = this.clock();
    this.setMeta("direct_paused", null);
    this.setMeta("direct_resumed_ms", String(now)); // the runaway window restarts here
    this.log("direct_resumed", { detail: `method=${who.method} by=${who.email}` });
    return json(200, { state: "running" });
  }

  // ---------- Access side (the owner) ----------
  private async requireOwner(req: Request, route: "page" | "decide" | "log" | "contacts" | "direct" | "resume" | "sync") {
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
    return who;
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
<p><b>To:</b> ${esc(allow.get(r.recipient) || "not on allowlist")} (${esc(maskNumber(r.recipient))})</p>
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
    if (!allow.has(r.recipient)) throw new Refuse("recipient_not_on_allowlist", 403);
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
    try {
      const gid = await this.gatewaySend(r.recipient, r.text);
      this.sql.exec("UPDATE requests SET state='sent', gateway_id=? WHERE id=?", gid, id);
      this.log("sent", { request_id: id, recipient: r.recipient, sha256: logSha, detail: gid });
      return json(200, { id, state: "sent" });
    } catch (e) {
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
   * - device has publicKey: pin (fingerprint + key version) MUST be configured and match → RSA mode;
   *   publicKey with no pin, or a mismatch → refuse (security event). Never falls back to passphrase.
   * - device has no publicKey and GATEWAY_PASSPHRASE is set → legacy passphrase mode
   * - neither → refuse
   * Returns the gateway message id.
   */
  async gatewaySend(to: string, text: string): Promise<string> {
    if (!E164.test(to)) throw new Error("bad_recipient");
    const want = this.env.GATEWAY_DEVICE_ID;
    if (!want) throw new Error("gateway_device_id_not_configured");
    // Config load: a configured-but-short passphrase refuses EVERY send (either mode), before any network call.
    try {
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
    if (typeof dev.publicKey === "string" && dev.publicKey) {
      const pin = this.env.GATEWAY_PINNED_FINGERPRINT;
      const ver = this.env.GATEWAY_KEY_VERSION;
      if (!pin || !ver || !/^\d+$/.test(ver)) return this.security("device_key_present_but_no_pin");
      if ((await fingerprint(dev.publicKey)) !== pin || dev.keyVersion !== Number(ver)) return this.security("device_key_pin_mismatch");
      encryptField = (s) => encryptFieldRsa(dev.publicKey, dev.keyVersion, s);
      mode = "rsa";
    } else if (this.env.GATEWAY_PASSPHRASE) {
      const iters = parseIterations(this.env.GATEWAY_PBKDF2_ITERATIONS);
      const pass = this.env.GATEWAY_PASSPHRASE;
      encryptField = (s) => encryptFieldPassphrase(pass, iters, s);
      mode = "passphrase";
    } else {
      return this.security("no_device_key_and_no_passphrase");
    }
    const body = {
      deviceId: want,
      isEncrypted: true,
      textMessage: { text: await encryptField(text) },
      phoneNumbers: [await encryptField(to)],
    };
    const resp = await this.gw("POST", "/messages", body);
    this.log("gateway_mode", { detail: mode });
    return resp && typeof resp.id === "string" ? resp.id : "unknown";
  }

  /** Log a security event (code only, never secret values) and refuse. */
  private security(code: string): never {
    this.log("security_event", { detail: code });
    throw new Error(code);
  }
}
