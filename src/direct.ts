// Pure helpers for DIRECT_SEND: config parsing, the contacts snapshot format, and name matching.
// No I/O here, so every rule can be tested on its own.
import { E164, hasLink, Refuse } from "./rules";

// ---------- config ----------

/**
 * Optional limit: unset, "" or "off" (any case) = no limit (null). A whole number 1..100000 written as
 * plain digits = that limit. Anything else (0, negatives, decimals, spaces, words) is a config error:
 * the direct path refuses with direct_config_invalid until it is fixed (fail closed).
 */
export function parseOptionalLimit(raw: string | undefined): number | null {
  if (raw === undefined || raw === "" || /^off$/i.test(raw)) return null;
  if (!/^[0-9]{1,6}$/.test(raw)) throw new Refuse("direct_config_invalid", 503);
  const n = Number(raw);
  if (n < 1 || n > 100000) throw new Refuse("direct_config_invalid", 503);
  return n;
}

/** A limit that must be set: digits 1..100000. "off" is not accepted (use the matching switch instead). */
export function parseRequiredLimit(raw: string): number {
  if (/^off$/i.test(raw)) throw new Refuse("direct_config_invalid", 503);
  const n = parseOptionalLimit(raw);
  if (n === null) throw new Refuse("direct_config_invalid", 503);
  return n;
}

/** Safe-default switch: only exact "0" turns it off. Unset or anything else = on. */
export function switchOnUnlessZero(raw: string | undefined): boolean {
  return raw !== "0";
}

/** Opt-in switch: only exact "1" turns it on (same convention as DISABLED and ALLOW_EMAIL_OTP). */
export function switchOnlyIfOne(raw: string | undefined): boolean {
  return raw === "1";
}

/** DIRECT_NOTIFY_EACH: unset, "", "0" or "off" = off; "1" = on; anything else = config error. */
export function parseNotifyEach(raw: string | undefined): boolean {
  if (raw === undefined || raw === "" || raw === "0" || /^off$/i.test(raw)) return false;
  if (raw === "1") return true;
  throw new Refuse("direct_config_invalid", 503);
}

/** DIRECT_HOURS "HH:MM-HH:MM" in TIMEZONE (end exclusive; may wrap midnight). Unset/""/"off" = any time. */
export function parseHours(raw: string | undefined): { start: number; end: number } | null {
  if (raw === undefined || raw === "" || /^off$/i.test(raw)) return null;
  const m = raw.match(/^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/);
  if (!m) throw new Refuse("direct_config_invalid", 503);
  const start = Number(m[1]) * 60 + Number(m[2]);
  const end = Number(m[3]) * 60 + Number(m[4]);
  if (start === end) throw new Refuse("direct_config_invalid", 503);
  return { start, end };
}

export function insideHours(minuteOfDay: number, h: { start: number; end: number }): boolean {
  return h.start < h.end ? minuteOfDay >= h.start && minuteOfDay < h.end : minuteOfDay >= h.start || minuteOfDay < h.end;
}

export function minuteOfDay(ms: number, tz: string): number {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ms));
  return Number(p.find((x) => x.type === "hour")!.value) * 60 + Number(p.find((x) => x.type === "minute")!.value);
}

// ---------- contacts snapshot ----------

/** Lowercase letters and spaces, 1-20 chars: "mobile", "work mobile", "iphone", "main", "unlabeled", a custom label... */
export type PhoneLabel = string;
export const LABEL_RE = /^[a-z][a-z ]{0,19}$/;
const FAX_OR_PAGER = /fax|pager/;
/**
 * Phone type → stored label, or null to drop. Only fax and pager numbers are dropped (they can't take a
 * text); mobile, cell, iPhone, main, work mobile, home, work, other, custom and unlabeled are kept.
 * Same table as scripts/import-contacts.mjs phoneLabel (a node test checks they agree).
 */
export function phoneLabel(raw: unknown): PhoneLabel | null {
  const t = String(raw ?? "").replace(/^\*\s*/, "").trim().toLowerCase().replace(/\s+/g, " ");
  if (t === "") return "unlabeled";
  const compact = t.replace(/[\s_-]/g, "");
  if (FAX_OR_PAGER.test(compact)) return null;
  const known: Record<string, string> = { mobile: "mobile", cell: "mobile", cellphone: "mobile", workmobile: "work mobile", iphone: "iphone", main: "main", home: "home", work: "work", other: "other", googlevoice: "google voice" };
  if (known[compact]) return known[compact];
  return LABEL_RE.test(t) ? t : "other"; // custom label: kept, shown as "other" unless plain letters
}
export interface SnapshotContact {
  name: string;
  given?: string;
  numbers: { e164: string; label: PhoneLabel }[];
}
export interface Snapshot {
  generated_at: string;
  contacts: SnapshotContact[];
}
export interface ContactRow {
  name: string;
  name_norm: string;
  given_norm: string;
  first_norm: string;
  e164: string;
  label: PhoneLabel;
}

export const MAX_SNAPSHOT_NUMBERS = 5000;

/**
 * Strict parse of an uploaded snapshot. Only display name, optional given name, and E.164 numbers
 * with a plain label (lowercase letters, not fax or pager) are accepted. Unknown fields (emails, notes, addresses...) are refused,
 * so they can never be stored. The same number twice is kept once (first contact wins).
 */
export function parseSnapshot(body: unknown): { rows: ContactRow[]; contacts: number; generatedAt: string } {
  const bad = (why: string): never => {
    throw new Refuse(`contacts_snapshot_invalid_${why}`, 400);
  };
  if (!body || typeof body !== "object" || Array.isArray(body)) bad("shape");
  const b = body as Record<string, unknown>;
  if (Object.keys(b).some((k) => k !== "generated_at" && k !== "contacts")) bad("unknown_field");
  if (typeof b.generated_at !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(b.generated_at)) bad("generated_at");
  if (!Array.isArray(b.contacts)) bad("contacts");
  const rows: ContactRow[] = [];
  const seen = new Set<string>();
  let contacts = 0;
  for (const c of b.contacts as unknown[]) {
    if (!c || typeof c !== "object" || Array.isArray(c)) bad("contact");
    const o = c as Record<string, unknown>;
    if (Object.keys(o).some((k) => k !== "name" && k !== "given" && k !== "numbers")) bad("unknown_field");
    if (typeof o.name !== "string" || o.name.length > 200) bad("name");
    if (o.given !== undefined && (typeof o.given !== "string" || o.given.length > 100)) bad("given");
    if (!Array.isArray(o.numbers)) bad("numbers");
    let kept = 0;
    for (const n of o.numbers as unknown[]) {
      if (!n || typeof n !== "object" || Array.isArray(n)) bad("number");
      const p = n as Record<string, unknown>;
      if (Object.keys(p).some((k) => k !== "e164" && k !== "label")) bad("unknown_field");
      if (typeof p.e164 !== "string" || !E164.test(p.e164)) bad("e164");
      if (typeof p.label !== "string" || !LABEL_RE.test(p.label) || FAX_OR_PAGER.test(p.label.replace(/ /g, ""))) bad("label");
      if (seen.has(p.e164 as string)) continue;
      seen.add(p.e164 as string);
      const name = (o.name as string).trim();
      const nameNorm = normalizeName(name);
      rows.push({
        name,
        name_norm: nameNorm,
        given_norm: normalizeName((o.given as string | undefined) ?? ""),
        first_norm: nameNorm.split(" ")[0] ?? "",
        e164: p.e164 as string,
        label: p.label as PhoneLabel,
      });
      kept++;
    }
    if (kept) contacts++;
  }
  if (rows.length > MAX_SNAPSHOT_NUMBERS) bad("too_many_numbers");
  return { rows, contacts, generatedAt: b.generated_at as string };
}

// ---------- names ----------

/** Lower case, diacritics removed (NFKD, combining marks dropped), whitespace collapsed and trimmed. */
export function normalizeName(s: string): string {
  return s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * to_name matching rule: normalize the query and each contact the same way, then a (contact, number)
 * pair matches when the query equals the full display name, OR the given name, OR the first word of the
 * display name. No prefixes, no fuzzy matching. An empty query matches nothing.
 */
export function matchName<T extends Pick<ContactRow, "name_norm" | "given_norm" | "first_norm">>(rows: T[], query: string): T[] {
  const q = normalizeName(query);
  if (!q) return [];
  return rows.filter((r) => r.name_norm === q || (r.given_norm !== "" && r.given_norm === q) || (r.first_norm !== "" && r.first_norm === q));
}

// ---------- phone-number hygiene ----------

/** True when a string contains something shaped like a phone number (E.164, or 7+ digits in phone grouping). */
export function looksLikePhone(s: string): boolean {
  return PHONE_LIKE.test(s.replace(ISO_TIME, " ").replace(HEX_LABELS, " "));
}
// Labelled hex values the relay prints (8-char ref, 12-char sha prefix, 32-char ids, 64-char hashes) can
// be all digits by chance; they are ids, not numbers. Only those exact lengths are exempt, so a 10- or
// 11-digit number after "id " is still caught.
const HEX_LABELS = /(?:ref|sha256|hmac|csrf|id)[ :="]+(?:[0-9a-f]{64}|[0-9a-f]{32}|[0-9a-f]{12}|[0-9a-f]{8})(?![0-9A-Za-z])/gi;
// ISO dates/times are removed first so log timestamps don't count.
const ISO_TIME = /\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z?)?/g;
// Not preceded or followed by a letter or digit, so hex hashes and ids don't count.
const PHONE_LIKE = /(?<![0-9A-Za-z])(?:\+\d{7,15}|\(?\d(?:[\s().-]*\d){6,})(?![0-9A-Za-z])/;

/** Display name for responses and logs: dropped (generic text) when the name itself looks like a number. */
export function safeName(name: string): string {
  // Names reach the bot and the owner's notices, so the link rule always applies to them (BLOCK_LINKS or not).
  return !name.trim() || looksLikePhone(name) || /\d{4,}/.test(name) || hasLink(name) ? "(unnamed contact)" : name.trim();
}

// ---------- multi-send (to_names / candidate_ids) ----------

export const MULTI_MIN = 2;
export const MULTI_MAX = 3;
export type MultiField = "to_names" | "candidate_ids";

/**
 * A submitted name echoed back in a refusal or a resolve answer. It came from the caller, so it is shown
 * only when it holds no digit at all and nothing link-like; otherwise "(withheld)". Never a number.
 */
export function echoName(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return !t || /\d/.test(t) || hasLink(t) ? "(withheld)" : t.slice(0, 60);
}

/** A refusal that names the failing entry by index (and, for to_names, the digit-free submitted name). */
export function entryRefuse(code: string, status: number, index: number, name?: string, reason?: string): Refuse {
  const r = new Refuse(code, status);
  r.extra = { failed: [{ index, ...(name === undefined ? {} : { name: echoName(name) }), ...(reason ? { reason } : {}) }] };
  return r;
}

/**
 * Shape check for a multi-send list: an array of 2..3 strings, no repeats. to_names repeats are judged
 * after normalizeName ("Jordan" and " jordan " are the same entry); candidate_ids must match exactly.
 */
export function parseMultiList(raw: unknown, field: MultiField): string[] {
  if (!Array.isArray(raw)) throw new Refuse(`${field}_must_be_array`);
  if (raw.length < MULTI_MIN || raw.length > MULTI_MAX) throw new Refuse("multi_send_needs_2_to_3");
  const seen = new Set<string>();
  raw.forEach((x, i) => {
    if (typeof x !== "string") throw entryRefuse("multi_send_entry_not_string", 400, i);
    const k = field === "to_names" ? normalizeName(x) : x;
    if (field === "to_names" && (!k || x.length > 200)) throw entryRefuse("to_name_invalid", 400, i, x);
    if (seen.has(k)) throw entryRefuse("multi_send_duplicate", 400, i, field === "to_names" ? x : undefined);
    seen.add(k);
  });
  return raw as string[];
}

/** GROUP_MMS: unset, "" or "0" = off; exact "1" = on; anything else = config error (fail closed). */
export function parseGroupMms(raw: string | undefined): boolean {
  if (raw === undefined || raw === "" || raw === "0") return false;
  if (raw === "1") return true;
  throw new Refuse("direct_config_invalid", 503);
}

// ---------- body ----------

/** Direct body: non-empty, length cap. Links allowed unless blockLinks (BLOCK_LINKS = "1"), same as the tap flow. */
export function validateBody(body: unknown, maxChars: number, blockLinks = false): string {
  if (typeof body !== "string" || !body.trim()) throw new Refuse("empty_text");
  if ([...body].length > maxChars) throw new Refuse("text_too_long");
  if (blockLinks && hasLink(body)) throw new Refuse("links_not_allowed");
  return body;
}

// ---------- Google contacts sync ----------

/** The manual uploader's source label. Always merged after every Google account. */
export const UPLOAD_SOURCE = "UPLOAD";

/**
 * GOOGLE_ACCOUNTS = "primary,work": an ordered list. Each label is trimmed and upper-cased and
 * must then match [A-Z0-9_]+ (it names the secret GOOGLE_RT_<LABEL>). Bad labels and repeats are reported,
 * not used. UPLOAD is reserved for the manual uploader.
 */
export function parseAccounts(raw: string | undefined): { valid: string[]; invalid: string[] } {
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const part of (raw ?? "").split(",")) {
    const t = part.trim();
    if (!t) continue;
    const label = t.toUpperCase();
    if (!/^[A-Z0-9_]+$/.test(label) || label === UPLOAD_SOURCE || label.length > 32) invalid.push(t.replace(/[^A-Za-z0-9_]/g, "?").slice(0, 32));
    else if (valid.includes(label)) invalid.push(label + "(repeat)");
    else valid.push(label);
  }
  return { valid, invalid };
}

/**
 * DEFAULT_COUNTRY_CODE is required for contact sync: "+<1-3 digits>" (e.g. "+44", "+1") is used for numbers
 * written without a "+", or "none" for strict E.164 (numbers without "+" are dropped). There is no default:
 * unset or anything else throws default_country_code_invalid, so a number is never silently read as +1.
 * Returns the code, or null for strict mode.
 */
export function parseCountryCode(raw: string | undefined): string | null {
  if (raw === "none") return null;
  if (typeof raw === "string" && /^\+[1-9][0-9]{0,2}$/.test(raw)) return raw;
  throw new Refuse("default_country_code_invalid", 503);
}

/**
 * Normalizer shared with scripts/import-contacts.mjs (a node test checks they agree).
 * "+..." → "+" and its digits. Otherwise, with cc null (strict) → null. With a country code:
 *   "+1": 10 digits → +1 and the digits; 11 digits starting with 1 → "+" and the digits; "011..." → "+...".
 *   other codes: "00..." → "+..."; else one leading trunk "0" is dropped and the code is put in front.
 * The result must be E.164 or it is null (dropped).
 */
export function toE164(raw: string, cc: string | null): string | null {
  const s = raw.trim();
  const digits = s.replace(/\D/g, "");
  let out: string;
  if (s.startsWith("+")) out = "+" + digits;
  else if (cc === null || !digits) return null;
  else if (cc === "+1") {
    if (digits.length === 10) out = "+1" + digits;
    else if (digits.length === 11 && digits.startsWith("1")) out = "+" + digits;
    else if (digits.startsWith("011")) out = "+" + digits.slice(3);
    else return null;
  } else if (digits.startsWith("00")) out = "+" + digits.slice(2);
  else out = cc + digits.replace(/^0/, "");
  return E164.test(out) ? out : null;
}

/** People API connections page → snapshot contacts. Keeps every phone type but fax and pager. cc: see toE164. */
export function peopleToContacts(connections: unknown, stats: { dropped: number }, cc: string | null): SnapshotContact[] {
  const out: SnapshotContact[] = [];
  if (!Array.isArray(connections)) return out;
  for (const p of connections) {
    if (!p || typeof p !== "object") continue;
    const person = p as { names?: { displayName?: string; givenName?: string }[]; phoneNumbers?: { value?: string; canonicalForm?: string; type?: string }[] };
    const numbers: SnapshotContact["numbers"] = [];
    for (const n of person.phoneNumbers ?? []) {
      const type = (n.type ?? "").trim();
      const label = phoneLabel(type);
      if (!label) {
        stats.dropped++; // fax or pager
        continue;
      }
      const e164 = (n.canonicalForm && E164.test(n.canonicalForm) ? n.canonicalForm : null) ?? toE164(n.value ?? "", cc);
      if (e164 && !numbers.some((x) => x.e164 === e164)) numbers.push({ e164, label });
    }
    if (!numbers.length) continue;
    const name = person.names?.[0];
    out.push({ name: (name?.displayName ?? "").slice(0, 200), ...(name?.givenName ? { given: name.givenName.slice(0, 100) } : {}), numbers });
  }
  return out;
}
