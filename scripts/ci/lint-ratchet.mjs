#!/usr/bin/env node
// @ts-check
// Lint ratchet: findings that existed when the baseline was taken are allowed; a change that adds one fails.
//   node scripts/ci/lint-ratchet.mjs            check: fail if any (file, rule) count is above lint-baseline.json
//   node scripts/ci/lint-ratchet.mjs --update   rewrite the baseline (to lower counts; raising one needs a reviewer's yes)
// Counts are per (file, rule): a finding can move within a file without failing. Rules set to "error" in
// .oxlintrc.json fail `npm run lint` directly; this ratchet covers the "warn" rules.
// It also enforces the exception format: every disable comment must carry a reason, an expiry and a human approver:
//   // oxlint-disable-next-line <rule> -- reason: <why>; expires: YYYY-MM-DD; approved-by: <human>
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const BASELINE = "lint-baseline.json";
const SELF = "scripts/ci/lint-ratchet.mjs";

/** @param {unknown} e @returns {string} */
const stdoutOf = (e) => (typeof e === "object" && e !== null && "stdout" in e && typeof e.stdout === "string" ? e.stdout : "");

/** @returns {{ filename: string, code: string }[]} */
function lint() {
  let out = "";
  try { out = execFileSync("npx", ["oxlint", "--type-aware", "--format=json", "."], { encoding: "utf8", maxBuffer: 64 << 20 }); }
  catch (e) { out = stdoutOf(e); }
  /** @type {unknown} */
  const parsed = JSON.parse(out);
  if (typeof parsed !== "object" || parsed === null || !("diagnostics" in parsed) || !Array.isArray(parsed.diagnostics)) throw new Error("lint-ratchet: unexpected oxlint output");
  /** @type {unknown[]} */
  const diags = parsed.diagnostics;
  return diags.flatMap((d) => (typeof d === "object" && d !== null && "filename" in d && "code" in d && typeof d.filename === "string" && typeof d.code === "string" ? [{ filename: d.filename, code: d.code }] : []));
}

/** @param {string} file @returns {Record<string, number>} */
function readCounts(file) {
  if (!existsSync(file)) return {};
  /** @type {unknown} */
  const v = JSON.parse(readFileSync(file, "utf8"));
  /** @type {Record<string, number>} */
  const out = {};
  if (typeof v === "object" && v !== null) for (const [k, n] of Object.entries(v)) if (typeof n === "number") out[k] = n;
  return out;
}

/** @type {Record<string, number>} */
const counts = {};
for (const d of lint()) { const k = `${d.filename}::${d.code}`; counts[k] = (counts[k] ?? 0) + 1; }
const total = Object.values(counts).reduce((a, b) => a + b, 0);

if (process.argv.includes("--update")) {
  writeFileSync(BASELINE, JSON.stringify(Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b))), null, 2) + "\n");
  console.log(`lint-ratchet: baseline written (${total} findings)`);
  process.exit(0);
}
const base = readCounts(BASELINE);
const worse = Object.entries(counts).filter(([k, n]) => n > (base[k] ?? 0));

const files = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "*.ts", "*.mjs", "*.js"], { encoding: "utf8" }).split("\n").filter((f) => f && f !== SELF);
const today = new Date().toISOString().slice(0, 10);
/** @type {string[]} */
const bad = [];
for (const f of files) {
  readFileSync(f, "utf8").split("\n").forEach((line, i) => {
    if (!/(oxlint|eslint)-disable/.test(line)) return;
    const m = /--\s*reason:\s*\S.*;\s*expires:\s*(\d{4}-\d{2}-\d{2});\s*approved-by:\s*\S+/.exec(line);
    const expires = m?.[1];
    if (expires === undefined) bad.push(`${f}:${i + 1}: lint exception needs "-- reason: ...; expires: YYYY-MM-DD; approved-by: <human>"`);
    else if (expires < today) bad.push(`${f}:${i + 1}: lint exception expired on ${expires}; fix the code or get a new approval`);
  });
}
for (const [k, n] of worse) {
  const [file, code] = k.split("::");
  console.error(`${file ?? k}: ${code ?? ""} went from ${base[k] ?? 0} to ${n}. New code must not add this finding; run \`npx oxlint --type-aware ${file ?? "."}\` for lines and AGENTS.md for the fix.`);
}
for (const b of bad) console.error(b);
if (worse.length || bad.length) process.exit(1);
console.log(`lint-ratchet: OK (no (file, rule) count above baseline; ${total} existing findings)`);
