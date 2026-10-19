// Was this module started directly (`node path/to/script.mjs`), or imported?
//
// Node resolves a module's own URL (import.meta.url) through symlinks, but leaves process.argv[1] as it was
// typed. Comparing the two raw strings fails whenever the path goes through a link, and on macOS it always
// does: TMPDIR (/var/folders/...) is a link to /private/var/folders/.... Then a script quietly skipped its
// main() and exited 0 with no output. Both sides are therefore resolved with realpath before comparing.
//
// One copy of this file serves every entry point: scripts/*.mjs import it directly, and mac/relay-device.mjs
// imports mac/is-main.mjs, a one-line re-export that mac/install.sh replaces with this file.
import { realpathSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** realpath, or null when the path is missing or can't be resolved (never throws). */
export function realOrNull(p) {
  if (typeof p !== "string" || p === "") return null;
  try {
    return realpathSync(resolve(p));
  } catch {
    return null;
  }
}

/**
 * "main"     the process was started with this file (after resolving links on both sides)
 * "imported" anything else that isn't suspicious: argv[1] unset (node -e, a REPL), or a different script
 * "unclear"  argv[1] names a file with this module's file name, but it isn't this file. A caller that was
 *            meant to run should say so loudly instead of exiting 0 with no output.
 */
export function entryKind(moduleUrl, argv1 = process.argv[1]) {
  const self = realOrNull(fileURLToPath(moduleUrl));
  const started = realOrNull(argv1);
  if (self !== null && started !== null && self === started) return "main";
  if (typeof argv1 === "string" && argv1 !== "" && basename(argv1) === basename(fileURLToPath(moduleUrl))) return "unclear";
  return "imported";
}

/** True only when this module is the script node was started with. */
export function isMain(moduleUrl, argv1 = process.argv[1]) {
  return entryKind(moduleUrl, argv1) === "main";
}

/**
 * For a script's last lines: "main" runs it; "imported" does nothing (importers see no change); "unclear"
 * prints why on stderr and exits 70 (EX_SOFTWARE), so a broken check can never look like a quiet success.
 */
export function mainKind(moduleUrl, onUnclear) {
  const kind = entryKind(moduleUrl);
  if (kind === "unclear") {
    const msg = `${basename(fileURLToPath(moduleUrl))}: started as ${process.argv[1]} but that isn't this file after resolving links; refusing to guess (nothing was run)`;
    if (onUnclear) onUnclear(msg);
    else console.error(msg);
    process.exit(70);
  }
  return kind;
}
