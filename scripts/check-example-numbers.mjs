#!/usr/bin/env node
// Repo check (runs first in `npm test`): every North American 555 number in tracked files must be in the
// 555-0100..0199 range reserved for fiction. The 555 + "1234" placeholder and any other 555 line (which can be a real number)
// fail. Usage: node scripts/check-example-numbers.mjs [files...]   (default: git ls-files)
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { isMain } from "./is-main.mjs";

// [+1] [(]NPA[)] 555 LINE, or a bare 555-LINE. Separators: space, dot, dash. Digits on either side = not a match.
const NANP = /(?<![\dA-Za-z])(?:\+?1[\s.-]?)?\(?(\d{3})\)?[\s.-]?555[\s.-]?(\d{4})(?!\d)/g;
const BARE = /(?<![\d(+.-])555[\s.-](\d{4})(?!\d)/g;

/**
 * Offending matches in one text.
 * @param {string} text
 * @returns {{ line: number, match: string }[]}
 */
export function badExampleNumbers(text) {
  /** @type {{ line: number, match: string }[]} */
  const out = [];
  text.split("\n").forEach((line, i) => {
    /** @type {[number, number][]} */
    const seen = []; // [start, end) of NANP matches, so the bare pattern doesn't count the same number twice
    for (const re of [NANP, BARE]) {
      for (const m of line.matchAll(re)) {
        const s = m.index ?? 0, e = s + m[0].length;
        if (re === BARE && seen.some(([a, b]) => s < b && e > a)) continue;
        if (re === NANP) seen.push([s, e]);
        if (!/^01\d\d$/.test(m[m.length - 1] ?? "")) out.push({ line: i + 1, match: m[0].trim() });
      }
    }
  });
  return out;
}

if (isMain(import.meta.url)) {
  const SKIP = /(^|\/)(package-lock\.json|node_modules\/)|\.(png|jpg|gif|ico|woff2?)$/;
  const files = process.argv.length > 2 ? process.argv.slice(2) : execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n").filter(Boolean);
  let bad = 0;
  for (const f of files.filter((f) => !SKIP.test(f))) {
    /** @type {string} */
    let t;
    try { t = readFileSync(f, "utf8"); } catch { continue; }
    for (const h of badExampleNumbers(t)) {
      bad++;
      console.error(`${f}:${h.line}: ${h.match}  (use 555-0100..0199 only)`);
    }
  }
  if (bad) { console.error(`EXAMPLE_NUMBERS result=fail count=${bad}`); process.exit(1); }
  console.log("EXAMPLE_NUMBERS result=ok");
}
