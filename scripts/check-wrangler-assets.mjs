#!/usr/bin/env node
// @ts-check
// A deploy config must carry the harbor asset rules, and its main must be this repo's src/index.ts.
// The committed wrangler.toml has both [[rules]] blocks. .relay-local/wrangler.toml is gitignored, so
// git pull never adds them: without the Text rule, esbuild reports Could not resolve "url(/harbor/...)";
// without the Data rule, "No loader is configured" for .woff2 and .webp (20 errors together).
// A config in a subfolder (`.relay-local/`) needs main = "../src/index.ts". The root file needs main = "src/index.ts".
//
//   node scripts/check-wrangler-assets.mjs
//   node scripts/check-wrangler-assets.mjs --config=<path>
//   node scripts/check-wrangler-assets.mjs --config <path>
//
// No --config: check wrangler.toml, and .relay-local/wrangler.toml when that file exists.
// --config: check that file only.
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMain, realOrNull } from "./is-main.mjs";
import { arrayTables, topKey } from "./walk-config.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

/** @typedef {{ type: string | undefined, fallthrough: boolean | undefined, globs: string[] | undefined }} RuleFields */

const TEXT_GLOBS = ["**/*.css", "**/*.svg"];
const DATA_GLOBS = ["**/*.woff2", "**/*.webp"];
const TEXT_WANT = '[[rules]] type = "Text" globs = ["**/*.css", "**/*.svg"] fallthrough = false';
const DATA_WANT = '[[rules]] type = "Data" globs = ["**/*.woff2", "**/*.webp"] fallthrough = false';

/**
 * @param {string} block
 * @returns {RuleFields}
 */
export function readRule(block) {
  const type = /^type\s*=\s*"([^"]*)"\s*(?:#.*)?$/m.exec(block)?.[1];
  const ft = /^fallthrough\s*=\s*(true|false)\s*(?:#.*)?$/m.exec(block)?.[1];
  const g = /^globs\s*=\s*\[([^\]]*)\]/m.exec(block);
  /** @type {string[] | undefined} */
  let globs;
  if (g?.[1] !== undefined) {
    globs = [];
    for (const m of g[1].matchAll(/"([^"\\]*)"/g)) {
      if (m[1] !== undefined) globs.push(m[1]);
    }
  }
  return { type, fallthrough: ft === undefined ? undefined : ft === "true", globs };
}

/**
 * @param {string[] | undefined} got
 * @param {readonly string[]} want
 */
function sameGlobs(got, want) {
  if (got === undefined || got.length !== want.length) return false;
  const a = [...got].sort();
  const b = [...want].sort();
  return a.every((v, i) => v === b[i]);
}

/**
 * @param {RuleFields} rule
 */
function describe(rule) {
  const g = rule.globs === undefined ? "(missing)" : rule.globs.map((x) => `"${x}"`).join(", ");
  const ft = rule.fallthrough === undefined ? "(missing)" : String(rule.fallthrough);
  const type = rule.type === undefined ? "(missing)" : `"${rule.type}"`;
  return `type = ${type} globs = [${g}] fallthrough = ${ft}`;
}

/**
 * @param {RuleFields[]} rules
 * @param {string} type
 * @param {readonly string[]} globs
 * @param {string} want
 * @returns {string | null}
 */
function ruleGap(rules, type, globs, want) {
  const hits = rules.filter((r) => r.type === type);
  if (hits.length === 0) return `missing ${type} rule; want ${want}`;
  if (hits.length > 1) return `${type} rule appears ${hits.length} times; want exactly one: ${want}`;
  const hit = hits[0];
  if (hit === undefined || hit.fallthrough !== false || !sameGlobs(hit.globs, globs)) {
    return `${type} rule is wrong (${hit === undefined ? "missing" : describe(hit)}); want ${want}`;
  }
  return null;
}

/**
 * Problems with the [[rules]] blocks. Empty when both required rules are present and exact.
 * Globs are compared as a set, so either order of the two Data globs is accepted.
 * @param {string} text
 * @returns {string[]}
 */
export function rulesProblems(text) {
  const parsed = arrayTables(text).filter((b) => b.name === "rules").map((b) => readRule(b.text));
  /** @type {string[]} */
  const problems = [];
  const textGap = ruleGap(parsed, "Text", TEXT_GLOBS, TEXT_WANT);
  if (textGap !== null) problems.push(textGap);
  const dataGap = ruleGap(parsed, "Data", DATA_GLOBS, DATA_WANT);
  if (dataGap !== null) problems.push(dataGap);
  return problems;
}

/**
 * @param {string} configPath
 * @param {string | undefined} mainValue
 * @param {string} repoRoot
 * @returns {string | null}
 */
export function mainProblem(configPath, mainValue, repoRoot) {
  if (mainValue === undefined || mainValue === "") {
    return 'main is missing (repo root: main = "src/index.ts"; a subfolder such as .relay-local: main = "../src/index.ts")';
  }
  const abs = resolve(dirname(configPath), mainValue);
  const expected = join(repoRoot, "src", "index.ts");
  if (!existsSync(abs)) return `main = "${mainValue}" does not exist (${abs})`;
  const got = realOrNull(abs);
  const want = realOrNull(expected);
  if (got === null || want === null) return `main = "${mainValue}" could not be resolved to src/index.ts`;
  if (got !== want) {
    const shown = relative(repoRoot, got);
    return `main = "${mainValue}" resolves to ${shown === "" ? got : shown}, not src/index.ts`;
  }
  return null;
}

/**
 * @param {string} configPath
 * @param {string} repoRoot
 * @returns {string[]}
 */
export function configProblems(configPath, repoRoot) {
  /** @type {string} */
  let text;
  try {
    text = readFileSync(configPath, "utf8");
  } catch {
    return [`cannot read ${configPath}`];
  }
  const problems = rulesProblems(text);
  const mainErr = mainProblem(configPath, topKey(text, "main"), repoRoot);
  if (mainErr !== null) problems.push(mainErr);
  return problems;
}

/**
 * @param {string} repoRoot
 * @param {string | undefined} configArg cwd-relative or absolute; undefined = the default files
 * @param {string} cwd
 * @returns {string[]}
 */
export function filesToCheck(repoRoot, configArg, cwd) {
  if (configArg !== undefined) return [resolve(cwd, configArg)];
  const files = [join(repoRoot, "wrangler.toml")];
  const local = join(repoRoot, ".relay-local", "wrangler.toml");
  if (existsSync(local)) files.push(local);
  return files;
}

/**
 * @param {string[]} argv
 * @returns {string | undefined | null} undefined = flag absent; null = flag present with no path
 */
export function configArg(argv) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a.startsWith("--config=")) return a.slice("--config=".length);
    if (a === "--config") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) return null;
      return next;
    }
  }
  return undefined;
}

/**
 * @param {string} p
 * @param {string} repoRoot
 */
function show(p, repoRoot) {
  const rel = relative(repoRoot, p);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return p;
  return rel;
}

/**
 * @param {string[]} paths
 * @param {string} repoRoot
 * @param {boolean} noteAbsentLocal when true and .relay-local/wrangler.toml was not in paths, say so
 * @returns {number} process exit code
 */
export function report(paths, repoRoot, noteAbsentLocal = false) {
  /** @type {string[]} */
  const failed = [];
  for (const p of paths) {
    const problems = configProblems(p, repoRoot);
    if (problems.length === 0) continue;
    failed.push(show(p, repoRoot));
    for (const x of problems) console.error(`check-wrangler: ${show(p, repoRoot)}: ${x}`);
  }
  if (failed.length > 0) {
    console.error(`check-wrangler: FAIL (${failed.length} ${failed.length === 1 ? "config" : "configs"})`);
    return 1;
  }
  const local = join(repoRoot, ".relay-local", "wrangler.toml");
  const names = paths.map((p) => show(p, repoRoot)).join(", ");
  const extra = noteAbsentLocal && !paths.includes(local) ? "; .relay-local/wrangler.toml not present" : "";
  console.log(`check-wrangler: OK (${names}${extra})`);
  return 0;
}

if (isMain(import.meta.url)) {
  const arg = configArg(process.argv.slice(2));
  if (arg === null || arg === "") {
    console.error("check-wrangler: pass --config=<path> or --config <path>");
    process.exit(1);
  }
  const paths = filesToCheck(REPO, arg, process.cwd());
  process.exit(report(paths, REPO, arg === undefined));
}
