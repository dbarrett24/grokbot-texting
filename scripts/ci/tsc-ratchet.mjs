#!/usr/bin/env node
// @ts-check
// TypeScript error ratchet for configs the code doesn't pass yet. Errors that existed when the baseline was taken are
// allowed; a change that adds one (per config, file and error code) fails.
//   node scripts/ci/tsc-ratchet.mjs <baseline.json> <tsconfig>... [--update]
// Used by `typecheck:strict-next` (flags such as noUncheckedIndexedAccess that are not yet in the base configs).
// When a config reaches 0 errors, move its flags into the base config and drop the ratchet.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const args = process.argv.slice(2).filter((a) => a !== "--update");
const [baseline, ...configs] = args;
if (baseline === undefined || configs.length === 0) { console.error("usage: tsc-ratchet.mjs <baseline.json> <tsconfig>... [--update]"); process.exit(2); }
const label = baseline.replace(/^tsc-|-baseline\.json$/g, "");

/** @param {unknown} e @returns {string} */
const stdoutOf = (e) => (typeof e === "object" && e !== null && "stdout" in e && typeof e.stdout === "string" ? e.stdout : "");

/** @type {Record<string, number>} */
const counts = {};
for (const p of configs) {
  let out = "";
  try { out = execFileSync("npx", ["tsc", "--noEmit", "-p", p], { encoding: "utf8", maxBuffer: 64 << 20 }); } catch (e) { out = stdoutOf(e); }
  const unattributed = out.split("\n").filter((l) => /error TS\d+/.test(l) && !/^\S+?\(\d+,\d+\): error TS\d+/.test(l));
  if (unattributed.length) { console.error(`${p}: tsc failed before checking files:\n${unattributed.join("\n")}`); process.exit(2); }
  for (const m of out.matchAll(/^(\S+?)\(\d+,\d+\): error (TS\d+)/gm)) { const k = `${p}::${m[1] ?? "?"}::${m[2] ?? "?"}`; counts[k] = (counts[k] ?? 0) + 1; }
}
const total = Object.values(counts).reduce((a, b) => a + b, 0);
if (process.argv.includes("--update")) {
  writeFileSync(baseline, JSON.stringify(Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b))), null, 2) + "\n");
  console.log(`${label}: baseline written (${total} errors)`);
  process.exit(0);
}
/** @type {Record<string, number>} */
const base = {};
if (existsSync(baseline)) {
  /** @type {unknown} */
  const v = JSON.parse(readFileSync(baseline, "utf8"));
  if (typeof v === "object" && v !== null) for (const [k, n] of Object.entries(v)) if (typeof n === "number") base[k] = n;
}
const worse = Object.entries(counts).filter(([k, n]) => n > (base[k] ?? 0));
for (const [k, n] of worse) {
  const [p, f, code] = k.split("::");
  console.error(`${f ?? k}: ${code ?? ""} under ${p ?? ""} went from ${base[k] ?? 0} to ${n}. Run \`npx tsc --noEmit -p ${p ?? "tsconfig.json"}\` and narrow the value instead of adding to the count (AGENTS.md rule R2).`);
}
if (worse.length) process.exit(1);
console.log(`${label}: OK (${total} existing errors, none new)`);
