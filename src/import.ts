// Drag-in import (POST /import-contacts on REQUEST_HOST): the bot hands over a file the owner dropped into the
// chat (a vCard, or a Google, Outlook or plain name,phone CSV). These pure helpers turn it into snapshot contacts.
// The relay adds them to the address book (source IMPORT, every new number OFF) and, if anyone's switch would
// change, files an allowlist proposal the owner must confirm on /approve/import/<id>. Nothing here touches storage.
import { phoneLabel, toE164, type PhoneLabel, type SnapshotContact } from "./direct";
import { Refuse } from "./rules";

export const IMPORT_SOURCE = "IMPORT";
export const IMPORT_MAX_CHARS = 2_000_000;
export const IMPORT_MAX_NUMBERS = 5000;
export const PROPOSAL_TTL_MS = 24 * 3_600_000;
export type ImportFormat = "vcard" | "csv";
export type AllowlistMode = "add" | "replace" | "none";
export interface ImportStats { droppedType: number; invalid: number; duplicates: number }
export interface ImportRequest { filename: string; format: ImportFormat; content: string; allowlist: AllowlistMode }

/** Strict body: {filename, content, allowlist?, format?}. Only .vcf/.vcard/.csv (or an explicit format) is read. */
export function parseImportBody(body: unknown): ImportRequest {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Refuse("body_must_be_object");
  const b = body as { filename?: unknown; content?: unknown; allowlist?: unknown; format?: unknown };
  if (Object.keys(b).some((k) => !["filename", "content", "allowlist", "format"].includes(k))) throw new Refuse("import_unknown_field");
  if (typeof b.content !== "string" || !b.content.trim()) throw new Refuse("import_content_missing");
  if (b.content.length > IMPORT_MAX_CHARS) throw new Refuse("import_too_large", 413);
  const filename = typeof b.filename === "string" ? b.filename.slice(0, 200) : "";
  let format: ImportFormat | null = null;
  if (b.format !== undefined) {
    if (b.format !== "vcard" && b.format !== "csv") throw new Refuse("import_format_invalid");
    format = b.format;
  } else if (/\.(vcf|vcard)$/i.test(filename)) format = "vcard";
  else if (/\.csv$/i.test(filename)) format = "csv";
  else if (/^\uFEFF?\s*BEGIN:VCARD/i.test(b.content)) format = "vcard";
  if (!format) throw new Refuse("import_format_unknown", 415);
  const mode = b.allowlist ?? "add";
  if (mode !== "add" && mode !== "replace" && mode !== "none") throw new Refuse("import_allowlist_mode_invalid");
  return { filename, format, content: b.content, allowlist: mode };
}

const stripBom = (s: string) => s.replace(/^\uFEFF/, "");

/** RFC 4180-ish: quoted cells (commas, newlines, doubled quotes), CRLF/LF/CR rows, blank rows dropped. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", q = false;
  const s = stripBom(text);
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"' && s[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim() !== ""));
}

/** Outlook / plain header words → stored label (anything else goes through phoneLabel). */
const OUTLOOK_LABEL: Record<string, string> = { primary: "main", "company main": "main", business: "work", "business mobile": "work mobile", phone: "unlabeled", telephone: "unlabeled", car: "other", radio: "other", callback: "other", "home mobile": "mobile" };

const looksPhone = (s: string) => /^[+(]?[\d\s().-]{7,}$/.test(s.trim()) && s.replace(/\D/g, "").length >= 7;

/**
 * CSV → contacts. Recognised by header:
 *   Google: "Phone 1 - Value" (+ "Phone 1 - Label"/"Type"; several numbers in one cell split on ":::").
 *   Outlook: "Mobile Phone", "Home Phone", "Business Phone 2", "Primary Phone"... (any "... Phone" column; faxes and pagers dropped).
 *   Simple: a "name" column and a "phone"/"mobile"/"number" column, or no header at all (name,phone rows).
 */
export function contactsFromCsv(text: string, stats: ImportStats, cc: string | null): SnapshotContact[] {
  const rows = parseCsv(text);
  const first = rows[0];
  if (!first) return [];
  const head = first.map((h) => h.trim());
  const lower = head.map((h) => h.toLowerCase());
  const col = (...names: string[]) => { for (const n of names) { const i = lower.indexOf(n.toLowerCase()); if (i >= 0) return i; } return -1; };
  const phoneCols: { v: number; l: number; fixed?: string }[] = [];
  for (let k = 1; k <= 20; k++) {
    const v = col(`Phone ${k} - Value`);
    if (v >= 0) phoneCols.push({ v, l: Math.max(col(`Phone ${k} - Label`), col(`Phone ${k} - Type`)) });
  }
  let body = rows.slice(1);
  if (!phoneCols.length) {
    lower.forEach((h, i) => {
      const m = h.match(/^(.*?)\s*(phone|mobile|cell|number|tel|telephone)\s*\d*$/);
      if (!m) return;
      const kind = m[2] === "mobile" || m[2] === "cell" ? "mobile" : "";
      const label = `${m[1]} ${kind}`.trim();
      phoneCols.push({ v: i, l: -1, fixed: OUTLOOK_LABEL[label] ?? (label || "unlabeled") });
    });
  }
  const headerless = !phoneCols.length;
  if (headerless) {
    // name,phone with no header: the first row is data too. A row whose 2nd cell isn't a phone is skipped.
    body = rows;
    phoneCols.push({ v: 1, l: -1, fixed: "unlabeled" });
  }
  const nameIdx = headerless ? 0 : col("Name", "Full Name", "Display Name", "Contact Name");
  const out: SnapshotContact[] = [];
  for (const r of body) {
    const get = (...n: string[]) => { const i = col(...n); return i >= 0 ? (r[i] ?? "").trim() : ""; };
    const given = headerless ? "" : get("First Name", "Given Name");
    const name = (nameIdx >= 0 ? (r[nameIdx] ?? "").trim() : "")
      || [given, get("Middle Name", "Additional Name"), get("Last Name", "Family Name", "Surname")].filter(Boolean).join(" ")
      || get("Nickname");
    const numbers: SnapshotContact["numbers"] = [];
    for (const { v, l, fixed } of phoneCols) {
      const label = phoneLabel(fixed ?? (l >= 0 ? r[l] : ""));
      for (const raw of String(r[v] ?? "").split(":::").map((s) => s.trim()).filter(Boolean)) {
        if (headerless && !looksPhone(raw)) continue;
        if (!label) { stats.droppedType++; continue; }
        const e164 = toE164(raw, cc);
        if (!e164) { stats.invalid++; continue; }
        if (!numbers.some((n) => n.e164 === e164)) numbers.push({ e164, label });
      }
    }
    if (numbers.length) out.push({ name: name.slice(0, 200), ...(given ? { given: given.slice(0, 100) } : {}), numbers });
  }
  return out;
}

/** vCard TYPE list → label (same rule as scripts/import-contacts.mjs vcardLabel). */
export function vcardLabel(types: string[]): PhoneLabel | null {
  const ts = types.map((t) => t.toLowerCase().trim()).filter((t) => t && !["voice", "pref", "text", "msg", "internet"].includes(t) && !t.startsWith("pref=") && !t.startsWith("value="));
  if (ts.some((t) => /fax|pager/.test(t))) return null;
  if (ts.some((t) => t === "cell" || t === "mobile" || t === "iphone")) return ts.includes("work") ? "work mobile" : ts.includes("iphone") ? "iphone" : "mobile";
  return ts.length ? phoneLabel(ts[0]) : "unlabeled";
}

const unescapeV = (s: string) => s.replace(/\\n/gi, " ").replace(/\\([,;\\])/g, "$1").trim();

/** vCard 2.1/3/4, one or many cards: FN (or N), given name, every TEL but fax/pager. Folded lines and a BOM are handled. */
export function contactsFromVcf(text: string, stats: ImportStats, cc: string | null): SnapshotContact[] {
  // Unfold: CRLF/LF followed by a space or tab continues the previous line (RFC 6350 3.2).
  const lines = stripBom(text).replace(/\r\n?/g, "\n").replace(/\n[ \t]/g, "").split("\n");
  const out: SnapshotContact[] = [];
  let cur: { name: string; n: string; given: string; numbers: SnapshotContact["numbers"]; groups: Map<string, number>; ab: Map<string, string> } | null = null;
  for (const line of lines) {
    const up = line.trim().toUpperCase();
    if (up === "BEGIN:VCARD") { cur = { name: "", n: "", given: "", numbers: [], groups: new Map(), ab: new Map() }; continue; }
    if (up === "END:VCARD") {
      if (cur) {
        // Apple: item1.TEL:... + item1.X-ABLabel:_$!<Mobile>!$_ (or a custom word). The label wins over TYPE.
        const drop = new Set<number>();
        for (const [g, idx] of cur.groups) {
          const raw = cur.ab.get(g);
          const n = cur.numbers[idx];
          if (raw === undefined || !n) continue;
          const word = raw.replace(/^_\$!<(.*)>!\$_$/, "$1");
          const label = vcardLabel([word]);
          if (!label) { drop.add(idx); stats.droppedType++; } else n.label = label;
        }
        cur.numbers = cur.numbers.filter((_, i) => !drop.has(i));
      }
      if (cur && cur.numbers.length) {
        const name = (cur.name || cur.n).slice(0, 200);
        out.push({ name, ...(cur.given ? { given: cur.given.slice(0, 100) } : {}), numbers: cur.numbers });
      }
      cur = null;
      continue;
    }
    if (!cur) continue;
    const i = line.indexOf(":");
    if (i < 0) continue;
    const [key, ...params] = line.slice(0, i).split(";");
    const val = line.slice(i + 1);
    const group = (key ?? "").match(/^(item\d+)\./i)?.[1]?.toLowerCase() ?? "";
    const k = (key ?? "").replace(/^item\d+\./i, "").toUpperCase();
    if (k === "X-ABLABEL") { if (group) cur.ab.set(group, unescapeV(val)); continue; }
    if (k === "PHOTO" || k === "LOGO" || k === "SOUND" || k === "KEY") continue; // base64 blobs: skipped
    if (k === "FN") cur.name = unescapeV(val);
    else if (k === "N") {
      const parts = val.split(/(?<!\\);/).map(unescapeV);
      cur.given = parts[1] ?? "";
      cur.n = [parts[3], parts[1], parts[2], parts[0], parts[4]].filter(Boolean).join(" ");
    } else if (k === "TEL") {
      // TYPE=cell,voice | TYPE="cell,voice" | TYPE=CELL;TYPE=PREF | vCard 2.1 bare CELL
      // vCard 4.0 also carries VALUE=uri and PREF=1; those are ignored by vcardLabel.
      const types = params.flatMap((p) => p.replace(/^TYPE=/i, "").replace(/"/g, "").split(","));
      const label = vcardLabel(types);
      if (!label) { stats.droppedType++; continue; }
      const e164 = toE164(unescapeV(val).replace(/^tel:/i, "").replace(/;.*$/, ""), cc);
      if (!e164) { stats.invalid++; continue; }
      if (!cur.numbers.some((n) => n.e164 === e164)) {
        if (group) cur.groups.set(group, cur.numbers.length);
        cur.numbers.push({ e164, label });
      }
    }
  }
  return out;
}

/** Parse one dropped file and dedupe by normalized number (first contact wins). */
export function parseImport(req: Pick<ImportRequest, "format" | "content">, cc: string | null): { contacts: SnapshotContact[]; stats: ImportStats; numbers: number } {
  const stats: ImportStats = { droppedType: 0, invalid: 0, duplicates: 0 };
  const raw = req.format === "vcard" ? contactsFromVcf(req.content, stats, cc) : contactsFromCsv(req.content, stats, cc);
  const seen = new Set<string>();
  const contacts: SnapshotContact[] = [];
  for (const c of raw) {
    const numbers = c.numbers.filter((n) => (seen.has(n.e164) ? (stats.duplicates++, false) : (seen.add(n.e164), true)));
    if (numbers.length) contacts.push({ ...c, numbers });
  }
  if (seen.size > IMPORT_MAX_NUMBERS) throw new Refuse("import_too_many_numbers", 413);
  return { contacts, stats, numbers: seen.size };
}

/** The proposal shown to the owner: who would be switched on (adds) and off (removes). Keys are number HMACs. */
export interface AllowlistDiff { adds: string[]; removes: string[] }
/**
 * add: every imported person not already on. replace: also switch off everyone on now who isn't in the file.
 * none: no change. Example numbers are never proposed. The caller leaves ALLOWLIST-secret numbers out of enabledKeys,
 * so a replace never proposes them for OFF.
 */
export function proposeDiff(mode: AllowlistMode, fileKeys: string[], enabledKeys: Set<string>, blocked: Set<string>): AllowlistDiff {
  if (mode === "none") return { adds: [], removes: [] };
  const inFile = new Set(fileKeys);
  const adds = [...inFile].filter((k) => !enabledKeys.has(k) && !blocked.has(k));
  const removes = mode === "replace" ? [...enabledKeys].filter((k) => !inFile.has(k)) : [];
  return { adds, removes };
}
