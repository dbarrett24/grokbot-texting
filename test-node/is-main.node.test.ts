// scripts/is-main.mjs: the one entry-point check every script uses. Paths are resolved with realpath on both
// sides; a missing or nonexistent argv[1] is "not main", never a throw; and a start that names the script but
// doesn't resolve to it is loud (exit 70), never a silent exit 0. Importers see no change.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, copyFileSync, symlinkSync, rmSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
// @ts-expect-error plain .mjs script, no types
import { entryKind, isMain, realOrNull } from "../scripts/is-main.mjs";

const ROOT = realpathSync(new URL("..", import.meta.url).pathname);
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(realpathSync(tmpdir()), "relay-ismain-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("isMain / entryKind", () => {
  it("same file reached through a symlinked folder is main (both sides resolved)", () => {
    mkdirSync(join(dir, "real"));
    writeFileSync(join(dir, "real", "s.mjs"), "");
    symlinkSync(join(dir, "real"), join(dir, "link"), "dir");
    const url = pathToFileURL(join(dir, "real", "s.mjs")).href;
    expect(isMain(url, join(dir, "link", "s.mjs"))).toBe(true);
    expect(isMain(pathToFileURL(join(dir, "link", "s.mjs")).href, join(dir, "real", "s.mjs"))).toBe(true);
  });

  it.each([undefined, "", join("definitely", "missing", "s.mjs")])("argv[1] = %j → not main, no throw", (a) => {
    writeFileSync(join(dir, "s.mjs"), "");
    const url = pathToFileURL(join(dir, "s.mjs")).href;
    expect(isMain(url, a)).toBe(false);
  });

  it("a different script is imported; a same-named file elsewhere is unclear", () => {
    mkdirSync(join(dir, "a"));
    mkdirSync(join(dir, "b"));
    writeFileSync(join(dir, "a", "s.mjs"), "");
    writeFileSync(join(dir, "b", "s.mjs"), "");
    writeFileSync(join(dir, "a", "other.mjs"), "");
    const url = pathToFileURL(join(dir, "a", "s.mjs")).href;
    expect(entryKind(url, join(dir, "a", "other.mjs"))).toBe("imported");
    expect(entryKind(url, join(dir, "b", "s.mjs"))).toBe("unclear");
    expect(entryKind(url, undefined)).toBe("imported");
  });

  it("realOrNull never throws", () => {
    expect(realOrNull(undefined)).toBeNull();
    expect(realOrNull("")).toBeNull();
    expect(realOrNull(join(dir, "nope"))).toBeNull();
    expect(realOrNull(dir)).toBe(dir);
  });
});

describe.skipIf(process.platform === "win32")("setup-lib.mjs: importers unchanged, an unclear start is loud", () => {
  const node = (code: string) => {
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", timeout: 30_000 });
    return { code: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
  };
  const lib = pathToFileURL(join(ROOT, "scripts", "setup-lib.mjs")).href;

  it("imported (argv[1] unset): no output, exit 0, exports usable", () => {
    const r = node(`const m = await import(${JSON.stringify(lib)}); console.log(typeof m.statusLine);`);
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe("function");
  });

  it("started as a same-named file that isn't this one: a fail status line and exit 70, nothing run", () => {
    mkdirSync(join(dir, "scripts"));
    copyFileSync(join(ROOT, "scripts", "setup-lib.mjs"), join(dir, "scripts", "setup-lib.mjs"));
    const r = node(`process.argv[1] = ${JSON.stringify(join(dir, "scripts", "setup-lib.mjs"))}; process.argv[2] = "status"; await import(${JSON.stringify(lib)});`);
    expect(r.code).toBe(70);
    expect(r.out).toContain("RELAY_STATUS step=entry result=fail reason=entry_check_mismatch");
    expect(r.out).not.toContain("step=status");
  });
});
