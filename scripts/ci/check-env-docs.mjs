#!/usr/bin/env node
// @ts-check
// Config/doc drift check (mistake class "docs drift": F0, F1, F5, 429d155, pr6 N1, 2987c6e).
//   1. every [vars] key in wrangler.toml is a field of `interface Env` (src/env.ts)            → error
//   2. every Env field is named in README.md, DEPLOY.md, SETUP-iphone.md or SETTINGS.md          → warning today, error with --strict
// `npm run check:env-docs` passes --strict (google-connect 4/4 documented the last two), so part 2 is an error.
// Usage: node scripts/ci/check-env-docs.mjs [--strict] [repoDir]
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const strict = process.argv.includes("--strict");
const dir = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? ".";
/** @param {string} f */
const read = (f) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8") : "");
const env = read("src/env.ts");
const body = env.slice(env.indexOf("interface Env"));
const fields = [...body.matchAll(/^\s{2}([A-Z][A-Z0-9_]+)\??:/gm)].flatMap((m) => (m[1] !== undefined && m[1] !== "RELAY" ? [m[1]] : []));
const DOC_FILES = ["README.md", "DEPLOY.md", "SETUP-iphone.md", "SETTINGS.md"];
const docs = DOC_FILES.map(read).join("\n");

/** @type {string[]} */
const errors = [];
/** @type {string[]} */
const undocumented = [];
for (const f of fields) if (!new RegExp(`\\b${f}\\b`).test(docs)) undocumented.push(`src/env.ts: ${f} is a setting but no doc (${DOC_FILES.join(", ")}) names it. Document what it does and its default.`);
const vars = /^\[vars\]\s*\n([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(read("wrangler.toml"))?.[1];
if (vars !== undefined) for (const m of vars.matchAll(/^([A-Z][A-Z0-9_]*)\s*=/gm)) if (m[1] !== undefined && !fields.includes(m[1])) errors.push(`wrangler.toml: [vars] ${m[1]} is not a field of interface Env in src/env.ts. Add it there (typed) or remove it.`);

if (strict) errors.push(...undocumented);
else for (const u of undocumented) console.warn(`warning: ${u}`);
for (const e of errors) console.error(e);
if (errors.length) process.exit(1);
console.log(`check-env-docs: OK (${fields.length} settings, ${undocumented.length} undocumented${strict ? "" : " (warning)"}; wrangler [vars] all typed)`);
