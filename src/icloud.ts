// Apple Contacts over iCloud CardDAV (read-only). Pure helpers: request bodies, a small namespace-tolerant
// multistatus reader, and a vCard parser into the same SnapshotContact model the Google sync uses.
// The Apple ID and app-specific password live only in Worker secrets (ICLOUD_APPLE_ID, ICLOUD_APP_PASSWORD).
// Nothing here logs, stores or returns them; errors are fixed codes.
import { phoneLabel, toE164, type SnapshotContact } from "./direct";
import { E164 } from "./rules";

/** Source label for iCloud rows in contact_sources. Reserved: no Google label may use it. */
export const ICLOUD_SOURCE = "ICLOUD";
export const ICLOUD_ROOT = "https://contacts.icloud.com/";
/** Only iCloud's own contacts hosts are ever contacted (contacts.icloud.com and pNN-contacts.icloud.com). */
const HOST_RE = /^(?:p\d{1,3}-)?contacts\.icloud\.com$/;
export const MAX_ADDRESSBOOKS = 10;

export type ICloudCreds = { appleId: string; password: string };

/**
 * Both secrets set = iCloud sync on. Neither = off (null). Only one = icloud_secret_missing.
 * App-specific passwords are 16 letters, shown as xxxx-xxxx-xxxx-xxxx; anything else = icloud_password_invalid.
 */
export function parseICloudCreds(appleId: string | undefined, password: string | undefined): ICloudCreds | null {
  const id = (appleId ?? "").trim(), pw = (password ?? "").trim();
  if (!id && !pw) return null;
  if (!id || !pw) throw new Error("icloud_secret_missing");
  if (!/^[^\s@:]+@[^\s@:]+\.[^\s@:]+$/.test(id)) throw new Error("icloud_apple_id_invalid");
  if (!/^[a-z]{4}-?[a-z]{4}-?[a-z]{4}-?[a-z]{4}$/.test(pw)) throw new Error("icloud_password_invalid");
  return { appleId: id, password: pw };
}

export function basicAuth(c: ICloudCreds): string {
  const bytes = new TextEncoder().encode(`${c.appleId}:${c.password}`);
  return "Basic " + btoa(String.fromCharCode(...bytes));
}

/** Resolve an href against the URL it came from, and refuse anything that is not https on an iCloud contacts host. */
export function safeUrl(href: string, base: string): string {
  let u: URL;
  try {
    u = new URL(href, base);
  } catch {
    throw new Error("icloud_bad_href");
  }
  if (u.protocol !== "https:" || !HOST_RE.test(u.hostname) || u.username || u.password) throw new Error("icloud_foreign_host");
  return u.toString();
}

export const PROPFIND_PRINCIPAL = `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>`;
export const PROPFIND_HOME = `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav"><d:prop><card:addressbook-home-set/></d:prop></d:propfind>`;
export const PROPFIND_BOOKS = `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>`;
export const REPORT_CARDS = `<?xml version="1.0" encoding="utf-8"?><card:addressbook-query xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav"><d:prop><d:getetag/><card:address-data/></d:prop></card:addressbook-query>`;

// ---------- multistatus reading (no DOMParser in Workers; prefixes vary, so match local names) ----------
const el = (name: string) => new RegExp(`<(?:[A-Za-z][\\w.-]*:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[A-Za-z][\\w.-]*:)?${name}\\s*>`, "g");
const unxml = (s: string) =>
  s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d))).replace(/&#x([0-9a-f]+);/gi, (_, x: string) => String.fromCodePoint(parseInt(x, 16))).replace(/&amp;/g, "&");
const first = (xml: string, name: string): string | null => {
  const m = el(name).exec(xml);
  return m ? (m[1] ?? "") : null;
};

export type DavResponse = { href: string; body: string };
export function responses(xml: string): DavResponse[] {
  const out: DavResponse[] = [];
  for (const m of xml.matchAll(el("response"))) {
    const body = m[1] ?? "";
    const href = first(body, "href");
    if (href !== null) out.push({ href: unxml(href.trim()), body });
  }
  return out;
}
/** The href inside a property (current-user-principal, addressbook-home-set), or null. */
export function propHref(xml: string, prop: string): string | null {
  for (const r of responses(xml)) {
    const p = first(r.body, prop);
    if (p === null) continue;
    const h = first(p, "href");
    if (h !== null && h.trim()) return unxml(h.trim());
  }
  return null;
}
/** Collections whose resourcetype includes CardDAV addressbook. */
export function addressBooks(xml: string): string[] {
  return responses(xml).filter((r) => /<(?:[A-Za-z][\w.-]*:)?addressbook[\s/>]/.test(first(r.body, "resourcetype") ?? "")).map((r) => r.href);
}
export function addressData(xml: string): string[] {
  const out: string[] = [];
  for (const r of responses(xml)) {
    const d = first(r.body, "address-data");
    if (d !== null && d.trim()) out.push(unxml(d));
  }
  return out;
}

// ---------- vCard (3.0 and 4.0) ----------
type Line = { group: string; name: string; params: Record<string, string[]>; value: string };
function lines(card: string): Line[] {
  const unfolded = card.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "");
  const out: Line[] = [];
  for (const raw of unfolded.split("\n")) {
    const i = raw.indexOf(":");
    if (i <= 0) continue;
    const head = raw.slice(0, i), value = raw.slice(i + 1);
    const [nameFull = "", ...ps] = head.split(";");
    const dot = nameFull.lastIndexOf(".");
    const params: Record<string, string[]> = {};
    for (const p of ps) {
      const eq = p.indexOf("=");
      const k = (eq < 0 ? "TYPE" : p.slice(0, eq)).toUpperCase();
      const vs = (eq < 0 ? p : p.slice(eq + 1)).replace(/^"|"$/g, "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
      (params[k] ??= []).push(...vs);
    }
    out.push({ group: dot < 0 ? "" : nameFull.slice(0, dot).toLowerCase(), name: (dot < 0 ? nameFull : nameFull.slice(dot + 1)).toUpperCase(), params, value });
  }
  return out;
}
const unescapeText = (s: string) => s.replace(/\\n/gi, " ").replace(/\\([,;\\])/g, "$1").trim();
/** Apple custom labels come as X-ABLabel "_$!<Mobile>!$_" or a plain string. */
const abLabel = (s: string) => unescapeText(s).replace(/^_\$!<(.*)>!\$_$/, "$1");
const IGNORED_TYPES = new Set(["voice", "pref", "internet", "x-internet", "text", "msg"]);

/** One vCard → a snapshot contact (or null with no textable number). fax/pager numbers are counted in stats.dropped. */
export function vcardToContact(card: string, stats: { dropped: number }, cc: string | null): SnapshotContact | null {
  const ls = lines(card);
  const labels = new Map(ls.filter((l) => l.name === "X-ABLABEL" && l.group).map((l) => [l.group, abLabel(l.value)]));
  const fn = ls.find((l) => l.name === "FN");
  const n = ls.find((l) => l.name === "N");
  const org = ls.find((l) => l.name === "ORG");
  const nParts = n ? n.value.split(";").map(unescapeText) : [];
  const given = nParts[1] ?? "";
  const name = (fn ? unescapeText(fn.value) : "") || [given, nParts[0] ?? ""].filter(Boolean).join(" ") || (org ? unescapeText(org.value.split(";")[0] ?? "") : "");
  const numbers: SnapshotContact["numbers"] = [];
  for (const t of ls.filter((l) => l.name === "TEL")) {
    const types = (t.params["TYPE"] ?? []).filter((x) => !IGNORED_TYPES.has(x));
    if (types.some((x) => /fax|pager/.test(x))) {
      stats.dropped++;
      continue;
    }
    const rawLabel = (t.group && labels.get(t.group)) || types[0] || "";
    const label = phoneLabel(rawLabel);
    if (!label) {
      stats.dropped++;
      continue;
    }
    const value = t.value.trim().replace(/^tel:/i, "");
    const e164 = E164.test(value) ? value : toE164(value, cc);
    if (e164 && !numbers.some((x) => x.e164 === e164)) numbers.push({ e164, label });
  }
  if (!numbers.length) return null;
  return { name: name.slice(0, 200), ...(given ? { given: given.slice(0, 100) } : {}), numbers };
}

/** Split a blob that may hold several BEGIN:VCARD..END:VCARD blocks. */
export function splitCards(text: string): string[] {
  return [...text.matchAll(/BEGIN:VCARD[\s\S]*?END:VCARD/gi)].map((m) => m[0]);
}
