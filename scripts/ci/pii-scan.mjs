#!/usr/bin/env node
// @ts-check
// Personal-data scan (mistake class: owner data in fixtures, PR text and commit authors). The term list is NEVER in the repo:
// it comes from PII_TERMS (comma/newline list; a CI secret) or PII_TERMS_FILE (a path outside the repo).
//   node scripts/ci/pii-scan.mjs [--range <base>..<head>]
// Scans every tracked file; with --range also the patch text, commit messages and author/committer of those commits.
// Any +1 number outside the fictional 555-01xx range fails, with or without terms. Hits print as "term #n", never the term.
// Without terms the term scan is SKIPPED (exit 0, notice) unless PII_REQUIRED=1.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** @param {string[]} a */
const git = (...a) => execFileSync("git", a, { encoding: "utf8", maxBuffer: 256 << 20 });
const termsFile = process.env.PII_TERMS_FILE;
const raw = process.env.PII_TERMS ?? (termsFile ? readFileSync(termsFile, "utf8") : "");
const terms = raw.split(/[\n,]/).map((t) => t.trim().toLowerCase()).filter(Boolean);
const i = process.argv.indexOf("--range");
const range = i > 0 ? process.argv[i + 1] : undefined;
/** @type {string[]} */
const hits = [];
/** @param {string} s */
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** @param {string} where @param {string} text */
const scan = (where, text) => {
  const low = text.toLowerCase();
  terms.forEach((t, n) => { if (new RegExp(`(^|[^a-z0-9])${esc(t)}([^a-z0-9]|$)`, "m").test(low)) hits.push(`${where}: matches personal-data term #${n + 1}`); });
  for (const m of text.matchAll(/\+1[ -]?\(?(\d{3})\)?[ -]?(\d{3})[ -]?(\d{4})\b/g)) {
    if (!(m[2] === "555" && (m[3] ?? "").startsWith("01"))) hits.push(`${where}: phone-shaped ${m[0].slice(0, 5)}… is not a fictional 555-01xx number`);
  }
};
for (const f of git("ls-files").split("\n").filter(Boolean)) {
  if (f === "package-lock.json") continue;
  let text = "";
  try { text = readFileSync(f, "utf8"); } catch { continue; } // deleted in the working tree
  scan(f, text);
}
if (range !== undefined) {
  scan(`patch ${range}`, git("log", "-p", "--no-merges", "--format=", range));
  scan(`messages ${range}`, git("log", "--format=%B", range));
  scan(`authors ${range}`, git("log", "--format=%h %an <%ae> | %cn <%ce>", range));
}
if (!terms.length) {
  console.error("pii-scan: NO TERM LIST (set PII_TERMS or PII_TERMS_FILE). Term scan skipped; phone scan ran.");
  if (process.env.PII_REQUIRED === "1") process.exit(1);
}
for (const h of hits) console.error(h);
if (hits.length) process.exit(1);
console.log(`pii-scan: OK (${terms.length} terms, files${range !== undefined ? ` + ${range}` : ""})`);
