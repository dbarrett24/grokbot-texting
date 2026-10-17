// Pure validation rules. Kept free of I/O so they are easy to test and to vet.
export const E164 = /^\+[1-9]\d{7,14}$/;
// Fail-closed link pattern: any scheme,
// "www", or anything shaped like a domain (word.tld) counts as a link.
export const LINK = /https?|www|\b\w+\.[A-Za-z]{2,24}\b/i;
// Bare IPv4 address, with or without a port or path ("192.168.1.1/x").
const IPV4 = /(?<![\d.])\d{1,3}(?:\.\d{1,3}){3}(?!\d)/;
// Ideographic and other full stops that phones render as a dot. NFKC already folds U+FF0E and U+FE52.
const DOTS = /[\u3002\uFF0E\uFF61\uFE52]/g;
/**
 * Link rule. Always applied to contact names and ALLOWLIST labels that go into the owner's notices and
 * /send answers (data that comes from Google or config). Applied to the message text only when
 * BLOCK_LINKS = "1" (off by default: the owner's own texts may carry links). The rule:
 * strip invisible format characters (\p{Cf}: zero-width space/joiners, soft hyphen, bidi marks),
 * NFKC, map look-alike dots to ".", then refuse URLs, domains and bare IPv4 addresses.
 * Known false positive, accepted (fails closed): "6.Ok" reads as a domain.
 */
export function linkNormalize(text: string): string {
  return text.replace(/\p{Cf}/gu, "").normalize("NFKC").replace(/\p{Cf}/gu, "").replace(DOTS, ".");
}
export function hasLink(text: string): boolean {
  const t = linkNormalize(text);
  return LINK.test(t) || IPV4.test(t);
}

export class Refuse extends Error {
  /** silent: answered without a log row (the lookup/refusal rate limit). */
  silent = false;
  /** Extra digit-free fields for the JSON answer (multi-send: which entry failed). Never a number. */
  extra?: Record<string, unknown>;
  constructor(public code: string, public status = 400) {
    super(code);
  }
}

export function parseAllowlist(raw: string | undefined): Map<string, string> {
  if (!raw) throw new Refuse("allowlist_missing", 503);
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    throw new Refuse("allowlist_malformed", 503);
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Refuse("allowlist_malformed", 503);
  const m = new Map<string, string>();
  for (const [num, label] of Object.entries(obj as Record<string, unknown>)) {
    if (!E164.test(num) || typeof label !== "string") throw new Refuse("allowlist_malformed", 503);
    m.set(num, label);
  }
  return m;
}

export interface SendRequestBody {
  to: string;
  text: string;
}

/** Strict body parse: exactly {to, text}; one E.164 recipient; length cap; links refused only when blockLinks (BLOCK_LINKS = "1"). */
export function validateRequestBody(body: unknown, allow: Map<string, string>, maxChars: number, blockLinks = false): SendRequestBody {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Refuse("body_must_be_object");
  const keys = Object.keys(body);
  const extra = keys.filter((k) => k !== "to" && k !== "text");
  if (extra.length) throw new Refuse("unknown_fields"); // e.g. phoneNumbers, cc, recipients
  const { to, text } = body as Record<string, unknown>;
  if (Array.isArray(to)) throw new Refuse("group_send_not_allowed");
  if (typeof to !== "string") throw new Refuse("recipient_required");
  if (/[,;\s]/.test(to.trim()) ) throw new Refuse("group_send_not_allowed");
  if (!E164.test(to)) throw new Refuse("recipient_must_be_one_e164_number");
  if (!allow.has(to)) throw new Refuse("recipient_not_on_allowlist", 403);
  if (typeof text !== "string" || !text.trim()) throw new Refuse("empty_text");
  if ([...text].length > maxChars) throw new Refuse("text_too_long");
  // Links in the message text are allowed unless BLOCK_LINKS = "1".
  if (blockLinks && hasLink(text)) throw new Refuse("links_not_allowed");
  return { to, text };
}

/**
 * Text checks for a tap request filed by contact name or candidate id: the same rules as the text part of
 * validateRequestBody (non-empty, length cap, links only when BLOCK_LINKS is on).
 */
export function validateTapText(raw: unknown, maxChars: number, blockLinks: boolean): string {
  if (typeof raw !== "string" || raw.trim() === "") throw new Refuse("empty_text");
  if (Array.from(raw).length > maxChars) throw new Refuse("text_too_long");
  if (blockLinks && hasLink(raw)) throw new Refuse("links_not_allowed");
  return raw;
}

// ---------- config ----------

/**
 * TIMEZONE is required: an IANA zone name such as "Europe/London". There is no default. Missing or not a
 * zone Intl knows = every route refuses (503 timezone_not_configured / timezone_invalid) until it is fixed.
 */
export function parseTimezone(raw: string | undefined): string {
  if (typeof raw !== "string" || raw.trim() === "") throw new Refuse("timezone_not_configured", 503);
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: raw }).format(0);
  } catch {
    throw new Refuse("timezone_invalid", 503);
  }
  return raw;
}

/**
 * Opt-in switch with a strict value: unset, "" or "0" = off; "1" = on; anything else is a config error
 * (refused with `code`, fail closed) so a typo never silently leaves a guard off.
 */
export function parseSwitch(raw: string | undefined, code: string): boolean {
  if (raw === undefined || raw === "" || raw === "0") return false;
  if (raw === "1") return true;
  throw new Refuse(code, 503);
}

/**
 * A whole-number setting with a default: unset or "" = def. Plain digits within [min, max] = that value.
 * Anything else (words, decimals, negatives, spaces, out of range) refuses with 503 config_invalid.
 */
export function parseCount(raw: string | undefined, def: number, min: number, max: number): number {
  if (raw === undefined || raw === "") return def;
  if (!/^[0-9]{1,7}$/.test(raw)) throw new Refuse("config_invalid", 503);
  const n = Number(raw);
  if (n < min || n > max) throw new Refuse("config_invalid", 503);
  return n;
}

/** Tap-flow limits (and the shared MAX_TEXT_CHARS). Defaults are the original built-in values. */
export interface TapConfig {
  pendingPerDay: number;
  capInitial: number;
  capAfter: number;
  raiseAfterDays: number;
  ttlSeconds: number;
  minSecondsBetween: number;
  maxChars: number;
}
export const TAP_DEFAULTS: TapConfig = { pendingPerDay: 20, capInitial: 5, capAfter: 10, raiseAfterDays: 14, ttlSeconds: 900, minSecondsBetween: 30, maxChars: 640 };
export function parseTapConfig(e: Record<string, string | undefined>): TapConfig {
  const d = TAP_DEFAULTS;
  return {
    pendingPerDay: parseCount(e.PENDING_CAP_PER_DAY, d.pendingPerDay, 1, 100000),
    capInitial: parseCount(e.SEND_CAP_INITIAL, d.capInitial, 1, 100000),
    capAfter: parseCount(e.SEND_CAP_AFTER, d.capAfter, 1, 100000),
    raiseAfterDays: parseCount(e.CAP_RAISE_AFTER_DAYS, d.raiseAfterDays, 0, 3650),
    ttlSeconds: parseCount(e.REQUEST_TTL_SECONDS, d.ttlSeconds, 60, 86400),
    minSecondsBetween: parseCount(e.MIN_SECONDS_BETWEEN_SENDS, d.minSecondsBetween, 0, 86400),
    maxChars: parseCount(e.MAX_TEXT_CHARS, d.maxChars, 1, 10000),
  };
}

/** YYYY-MM-DD in the given IANA zone. */
export function localDate(ms: number, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}

/** Daily send cap: initial for the first N days from start, then after. Fails closed to initial. */
export function sendCap(today: string, start: string, initial: number, after: number, raiseAfterDays: number): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(today)) return initial;
  const s = Date.parse(start + "T00:00:00Z");
  const t = Date.parse(today + "T00:00:00Z");
  if (Number.isNaN(s) || Number.isNaN(t)) return initial;
  return (t - s) / 86_400_000 >= raiseAfterDays ? after : initial;
}

export function maskNumber(n: string): string {
  return "…" + n.slice(-4);
}
