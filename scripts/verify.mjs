#!/usr/bin/env node
// @ts-check
// `npm run verify`: the one command to run before asking for review. Runs these package.json scripts in order
// (skipping any that don't exist) and stops at the first failure.
// `npm run mutation` is separate (about 4 h for a full run) and required when src/, mac/ or scripts/ change: see AGENTS.md.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const steps = ["typecheck", "typecheck:strict-next", "typecheck:scripts", "lint", "lint:ratchet", "check", "check:env-docs", "check:ancestors", "check:pii", "test"];
/** @type {unknown} */
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const scripts = typeof pkg === "object" && pkg !== null && "scripts" in pkg && typeof pkg.scripts === "object" && pkg.scripts !== null ? pkg.scripts : {};
for (const s of steps) {
  if (!(s in scripts)) continue;
  console.log(`\n== verify: npm run ${s}`);
  try { execFileSync("npm", ["run", s, "--silent"], { stdio: "inherit" }); }
  catch { console.error(`\nverify FAILED at \`npm run ${s}\`. Fix that before review; the message above names the file.`); process.exit(1); }
}
console.log("\nverify: all steps passed");
