#!/usr/bin/env node
// @ts-check
// Personal-data scan (mistake class: owner data in fixtures, PR text and commit authors).
//   node scripts/ci/pii-scan.mjs [--range <base>..<head>]
// Term list, first found wins, NEVER committed: PII_TERMS (comma/newline list; the CI secret), PII_TERMS_FILE
// (a path), or .pii-terms at the repo root (gitignored). scripts/ci/pii-terms.example shows the format with fake entries.
// Scans every tracked file; with --range also the patch text, commit messages and author/committer of those commits,
// (merge commits included; author/committer names and emails), and rejects any author or committer email at gmail.com
// after normalising case, whitespace, brackets and trailing dots (use your users.noreply.github.com address).
// Any +1 number outside the fictional 555-01xx range fails, with or without terms.
// Hits print a redacted match (first 2 characters + ***), never the term.
// The @gmail.com email rule has no bypass. No term list: PII_REQUIRE_TERMS=1 (CI; PII_REQUIRED=1 still works) fails closed; otherwise a loud WARNING and go on.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** @param {string[]} a */
const git = (...a) => execFileSync("git", a, { encoding: "utf8", maxBuffer: 256 << 20 });
const root = git("rev-parse", "--show-toplevel").trim();
const localFile = join(root, ".pii-terms");
const termsFile = process.env.PII_TERMS_FILE || (existsSync(localFile) ? localFile : undefined);
const raw = process.env.PII_TERMS || (termsFile ? readFileSync(termsFile, "utf8") : "");
const terms = raw.split(/[\n,]/).map((t) => t.trim().toLowerCase()).filter((t) => t && !t.startsWith("#"));
// Public links the owner chose to ship (support badge, this repo's GitHub org), in pii-public-urls.txt. Removed before the term scan.
const PUBLIC_FILE = "scripts/ci/pii-public-urls.txt";
const PUBLIC = existsSync(join(root, PUBLIC_FILE))
  ? readFileSync(join(root, PUBLIC_FILE), "utf8").split("\n").map((l) => l.trim().toLowerCase()).filter((l) => l && !l.startsWith("#"))
  : [];
/** @param {string} t */
export const redact = (t) => `${t.slice(0, 2)}***`;
const i = process.argv.indexOf("--range");
const range = i > 0 ? process.argv[i + 1] : undefined;
/** @type {string[]} */
const hits = [];
/** @param {string} s */
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const alnum = /[a-z0-9]/;
/**
 * Blank out (same length, so nothing glues together) each public string that starts on a token boundary.
 * Whatever follows a public prefix stays in place and is still scanned, e.g. "<public url>surname".
 * @param {string} low
 */
const maskPublic = (low, pub = PUBLIC) => {
  const out = low.split("");
  for (const p of pub) {
    for (let at = low.indexOf(p); at >= 0; at = low.indexOf(p, at + 1)) {
      if (at > 0 && alnum.test(low[at - 1] ?? "") && alnum.test(p[0] ?? "")) continue;
      for (let k = at; k < at + p.length; k++) out[k] = " ";
    }
  }
  return out.join("");
};
/** Trim, lowercase, drop <>/quotes and trailing dots, so "Someone@GMail.com." is still gmail. @param {string} e */
const normEmail = (e) => e.trim().toLowerCase().replace(/^[<"']+|[>"']+$/g, "").replace(/\.+$/, "").trim();
/** @param {string} where @param {string} text */
const scan = (where, text) => {
  const low = maskPublic(text.toLowerCase());
  terms.forEach((t, n) => { if (new RegExp(`(^|[^a-z0-9])${esc(t)}([^a-z0-9]|$)`, "m").test(low)) hits.push(`${where}: matches personal-data term #${n + 1} (${redact(t)})`); });
  for (const m of text.matchAll(/\+1[ -]?\(?(\d{3})\)?[ -]?(\d{3})[ -]?(\d{4})\b/g)) {
    if (!(m[2] === "555" && (m[3] ?? "").startsWith("01"))) hits.push(`${where}: phone-shaped ${m[0].slice(0, 5)}… is not a fictional 555-01xx number`);
  }
};
if (!terms.length) {
  if (process.env.PII_REQUIRE_TERMS === "1" || process.env.PII_REQUIRED === "1") {
    console.error("pii-scan: FAIL: no term list and PII_REQUIRE_TERMS=1. Set PII_TERMS, PII_TERMS_FILE or .pii-terms.");
    process.exit(1);
  }
  console.error([
    "",
    "**************************************************************",
    "* WARNING: pii-scan has NO TERM LIST. Names, emails and hosts",
    "* are NOT being checked. Only phone numbers and gmail authors.",
    `* Missing file: ${localFile}`,
    "* Setup: cp scripts/ci/pii-terms.example .pii-terms, then",
    "*        replace the fake lines with the real terms (gitignored),",
    "*        or set PII_TERMS (comma or newline list).",
    "* CI fails closed (PII_REQUIRE_TERMS=1).",
    "**************************************************************",
    "",
  ].join("\n"));
}
for (const f of git("ls-files").split("\n").filter(Boolean)) {
  if (f === "package-lock.json" || f === PUBLIC_FILE) continue;
  let text = "";
  try { text = readFileSync(join(root, f), "utf8"); } catch { continue; } // deleted in the working tree
  scan(f, text);
}
if (range !== undefined) {
  // Merge commits included: their messages and people are scanned too (-m/--cc so a merge's own changes show).
  scan(`patch ${range}`, git("log", "-p", "--cc", "--format=", range));
  scan(`messages ${range}`, git("log", "--format=%B", range));
  const people = git("log", "--format=%h%x09%ae%x09%ce%x09%an%x09%cn", range);
  scan(`authors ${range}`, people); // emails and author/committer names
  for (const line of people.split("\n").filter(Boolean)) {
    const [sha, ae = "", ce = ""] = line.split("\t");
    for (const [role, e] of [["author", ae], ["committer", ce]]) {
      const low = normEmail(e);
      if (/@(gmail|googlemail)\.com$/.test(low)) hits.push(`commit ${sha}: ${role} email ${redact(low)}@gmail.com is a personal address; use your users.noreply.github.com address`);
    }
  }
}
for (const h of hits) console.error(h);
if (hits.length) process.exit(1);
console.log(`pii-scan: OK (${terms.length} terms, files${range !== undefined ? ` + ${range}` : ""})`);
