#!/usr/bin/env node
// @ts-check
// History guard: commits that must never be in this repo's history (they carried owner data before the template was made generic).
// Fails if any banned SHA is an ancestor of HEAD. BANNED_SHAS=sha1,sha2 overrides the list (used to test the check).
import { execFileSync } from "node:child_process";

const banned = (process.env.BANNED_SHAS ?? "746a756,d9811fc").split(",").map((s) => s.trim()).filter(Boolean);
/** @param {unknown} e */
const statusOf = (e) => (typeof e === "object" && e !== null && "status" in e && typeof e.status === "number" ? e.status : -1);
/** @type {string[]} */
const bad = [];
for (const s of banned) {
  try { execFileSync("git", ["merge-base", s, "HEAD", "--is-ancestor"], { stdio: "ignore" }); bad.push(s); }
  catch (e) { const st = statusOf(e); if (st !== 1 && st !== 128) throw e; } // 1 = not an ancestor, 128 = object absent
}
for (const s of bad) console.error(`check-ancestors: banned commit ${s} is in HEAD's history. Rebuild the branch from main without it; do not merge.`);
if (bad.length) process.exit(1);
console.log(`check-ancestors: OK (${banned.join(", ")} not ancestors of HEAD)`);
