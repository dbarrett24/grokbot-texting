#!/usr/bin/env node
// Optional manual uploader, run on your own computer. It reads Google Contacts exports (CSV or vCard;
// several accounts can be passed together), keeps display name + given name + phone numbers only (every type
// except fax and pager; no emails, notes, addresses), normalizes to E.164, dedupes, and uploads the snapshot to the
// Access-protected approve host with `cloudflared access curl`. It prints counts only, never names or
// numbers, and writes nothing into this repo. The temp file is mode 600 and deleted afterwards.
//
//   node scripts/import-contacts.mjs --country-code +44 --host app.example.com primary.csv work.vcf
//   node scripts/import-contacts.mjs --country-code none --dry-run primary.csv   # counts only, no upload
// --country-code is required: the code put in front of numbers saved without "+", or "none" (strict E.164).
import { readFileSync, writeFileSync, unlinkSync, mkdtempSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const E164 = /^\+[1-9]\d{7,14}$/;

/** Same rule as src/direct.ts parseCountryCode: "+<1-3 digits>" or "none" (null = strict). Anything else throws. */
export function parseCountryCode(raw) {
  if (raw === "none") return null;
  if (typeof raw === "string" && /^\+[1-9][0-9]{0,2}$/.test(raw)) return raw;
  throw new Error("--country-code must be like +44 or +1, or none (strict E.164)");
}

/** Same rule as src/direct.ts toE164 (a node test checks they agree). cc: "+44" etc, or null = strict. */
export function toE164(raw, cc) {
  const s = String(raw).trim();
  const digits = s.replace(/\D/g, "");
  let out;
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

/**
 * Same table as src/direct.ts phoneLabel: "" → unlabeled; fax and pager → null (dropped); "Mobile",
 * "* Mobile", "cell" → mobile; "Work Mobile" → work mobile; iPhone, main, home, work, other kept;
 * a custom label is kept as-is when it is plain letters (≤20), otherwise as "other".
 */
const LABEL_RE = /^[a-z][a-z ]{0,19}$/;
const KNOWN = { mobile: "mobile", cell: "mobile", cellphone: "mobile", workmobile: "work mobile", iphone: "iphone", main: "main", home: "home", work: "work", other: "other", googlevoice: "google voice" };
export function phoneLabel(raw) {
  const t = String(raw ?? "").replace(/^\*\s*/, "").trim().toLowerCase().replace(/\s+/g, " ");
  if (t === "") return "unlabeled";
  const compact = t.replace(/[\s_-]/g, "");
  if (/fax|pager/.test(compact)) return null;
  if (KNOWN[compact]) return KNOWN[compact];
  return LABEL_RE.test(t) ? t : "other";
}

/** vCard TEL TYPE list → label. Any fax/pager type drops the number; cell wins; no type → unlabeled. */
export function vcardLabel(types) {
  const ts = types.map((t) => t.toLowerCase()).filter((t) => t && !["voice", "pref", "text", "msg"].includes(t) && !t.startsWith("pref="));
  if (ts.some((t) => /fax|pager/.test(t))) return null;
  if (ts.some((t) => t === "cell" || t === "mobile")) return ts.includes("work") ? "work mobile" : "mobile";
  return ts.length ? phoneLabel(ts[0]) : "unlabeled";
}

export function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim() !== ""));
}

/** Google Contacts CSV (new "First Name"/"Phone 1 - Label" or old "Name"/"Given Name"/"Phone 1 - Type"). */
export function contactsFromCsv(text, stats, cc) {
  const [head, ...body] = parseCsv(text.replace(/^\uFEFF/, ""));
  const col = (n) => head.indexOf(n);
  const phoneCols = [];
  for (let k = 1; k <= 20; k++) {
    const v = col(`Phone ${k} - Value`);
    if (v < 0) continue;
    phoneCols.push({ v, l: Math.max(col(`Phone ${k} - Label`), col(`Phone ${k} - Type`)) });
  }
  const out = [];
  for (const r of body) {
    const get = (n) => (col(n) >= 0 ? (r[col(n)] ?? "").trim() : "");
    const given = get("First Name") || get("Given Name");
    const name = get("Name") || [given, get("Middle Name") || get("Additional Name"), get("Last Name") || get("Family Name")].filter(Boolean).join(" ") || get("Nickname");
    const numbers = [];
    for (const { v, l } of phoneCols) {
      const label = phoneLabel(l >= 0 ? r[l] : "");
      for (const raw of String(r[v] ?? "").split(":::").map((s) => s.trim()).filter(Boolean)) {
        if (!label) { stats.droppedType++; continue; }
        const e164 = toE164(raw, cc);
        if (!e164) { stats.invalid++; continue; }
        numbers.push({ e164, label });
      }
    }
    if (numbers.length) out.push({ name, ...(given ? { given } : {}), numbers });
  }
  return out;
}

/** vCard 3/4: FN, N (given name), TEL of every type except fax and pager. Folded lines are unfolded first. */
export function contactsFromVcf(text, stats, cc) {
  const lines = text.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "").split("\n");
  const out = [];
  let cur = null;
  for (const line of lines) {
    const up = line.toUpperCase();
    if (up.startsWith("BEGIN:VCARD")) cur = { name: "", given: "", numbers: [] };
    else if (up.startsWith("END:VCARD") && cur) {
      if (cur.numbers.length) out.push({ name: cur.name, ...(cur.given ? { given: cur.given } : {}), numbers: cur.numbers });
      cur = null;
    } else if (cur) {
      const i = line.indexOf(":");
      if (i < 0) continue;
      const [key, ...params] = line.slice(0, i).split(";");
      const val = line.slice(i + 1).replace(/\\,/g, ",").replace(/\\;/g, ";").trim();
      const k = key.replace(/^item\d+\./i, "").toUpperCase();
      if (k === "FN") cur.name = val;
      else if (k === "N") cur.given = (val.split(";")[1] ?? "").trim();
      else if (k === "TEL") {
        const label = vcardLabel(params.flatMap((p) => p.replace(/^TYPE=/i, "").replace(/"/g, "").split(",")));
        if (!label) { stats.droppedType++; continue; }
        const e164 = toE164(val.replace(/^tel:/i, ""), cc);
        if (!e164) { stats.invalid++; continue; }
        cur.numbers.push({ e164, label });
      }
    }
  }
  return out;
}

/** Merge files in the order given; a number seen before is dropped (first file and first contact win). */
export function buildSnapshot(files, now, cc) {
  if (cc !== null && (typeof cc !== "string" || !/^\+[1-9][0-9]{0,2}$/.test(cc))) throw new Error("country code required (+44, +1... or null for strict)");
  const stats = { droppedType: 0, invalid: 0, duplicates: 0 };
  const seen = new Set();
  const contacts = [];
  for (const { name, text } of files) {
    const list = /\.vcf$/i.test(name) ? contactsFromVcf(text, stats, cc) : contactsFromCsv(text, stats, cc);
    for (const c of list) {
      const numbers = c.numbers.filter((n) => (seen.has(n.e164) ? (stats.duplicates++, false) : (seen.add(n.e164), true)));
      if (numbers.length) contacts.push({ name: c.name.slice(0, 200), ...(c.given ? { given: c.given.slice(0, 100) } : {}), numbers });
    }
  }
  const snapshot = { generated_at: now.toISOString().replace(/\.\d+Z$/, "Z"), contacts };
  const numbers = contacts.reduce((n, c) => n + c.numbers.length, 0);
  return { snapshot, summary: { contacts: contacts.length, numbers, ...stats } };
}

function main(argv) {
  const args = argv.slice(2);
  const dry = args.includes("--dry-run");
  const hi = args.indexOf("--host");
  const host = hi >= 0 ? args[hi + 1] : "";
  const ci = args.indexOf("--country-code");
  const files = args.filter((a, i) => !a.startsWith("--") && !(hi >= 0 && i === hi + 1) && !(ci >= 0 && i === ci + 1));
  let cc;
  try {
    cc = parseCountryCode(ci >= 0 ? args[ci + 1] : undefined);
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  if (!files.length || (!dry && !/^[a-z0-9.-]+$/i.test(host))) {
    console.error("usage: node scripts/import-contacts.mjs --country-code <+44|+1|none> [--dry-run] --host <approve-host> <export.csv|export.vcf> ...");
    process.exit(2);
  }
  const { snapshot, summary } = buildSnapshot(files.map((f) => ({ name: f, text: readFileSync(f, "utf8") })), new Date(), cc);
  console.log(`contacts kept: ${summary.contacts}, numbers: ${summary.numbers}, dropped (fax/pager): ${summary.droppedType}, unreadable: ${summary.invalid}, duplicates: ${summary.duplicates}`);
  if (dry) return;
  const dir = mkdtempSync(join(tmpdir(), "relay-contacts-"));
  const file = join(dir, "snapshot.json");
  try {
    writeFileSync(file, JSON.stringify(snapshot), { mode: 0o600 });
    const r = spawnSync("cloudflared", ["access", "curl", `https://${host}/contacts`, "-sS", "-X", "POST", "-H", "content-type: application/json", "--data-binary", `@${file}`], { encoding: "utf8" });
    if (r.status !== 0) {
      console.error(`upload failed (cloudflared exit ${r.status}). Run: cloudflared access login https://${host}`);
      process.exit(1);
    }
    console.log(`relay answered: ${r.stdout.trim()}`);
  } finally {
    unlinkSync(file);
    rmdirSync(dir);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main(process.argv);
