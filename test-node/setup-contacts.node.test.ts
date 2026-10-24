// Setup step `contacts` (after google): opens the Contacts page and waits for the owner. Offline; fake opener.
import { describe, it, expect, beforeEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
let dir: string;
const run = (args: string[], env: Record<string, string> = {}) => {
  const r = spawnSync(process.execPath, [join(dir, "scripts", "setup-lib.mjs"), ...args], { encoding: "utf8", env: { ...process.env, PATH: `${join(dir, "bin")}:${process.env["PATH"]}`, FAKE_LOG: join(dir, "fake"), ...env } });
  return r.stdout + r.stderr;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-contacts-"));
  mkdirSync(join(dir, "scripts")); mkdirSync(join(dir, "bin"));
  for (const f of ["setup-lib.mjs", "is-main.mjs", "no-tty-guard.mjs"]) copyFileSync(join(ROOT, "scripts", f), join(dir, "scripts", f));
  copyFileSync(join(ROOT, "wrangler.toml"), join(dir, "wrangler.toml"));
  for (const n of ["xdg-open", "open"]) { writeFileSync(join(dir, "bin", n), `#!/bin/sh\necho "$@" >> "$FAKE_LOG.opened"\n`); chmodSync(join(dir, "bin", n), 0o755); }
});

describe("setup step: contacts", () => {
  it("needs config first", () => {
    expect(run(["contacts"])).toContain("RELAY_STATUS step=contacts result=fail reason=run_config_first");
  });
  it("dry run: names the page, opens nothing", () => {
    run(["config", "--worker", "relay-t", "--domain", "owner.test", "--team", "t", "--country", "+1"]);
    const o = run(["contacts", "--dry-run"]);
    expect(o).toMatch(/RELAY_STATUS step=contacts result=dry_run url=https:\/\/\S+\/contacts would_open=browser/);
    expect(existsSync(join(dir, "fake.opened"))).toBe(false);
  });
  it("opens the page and waits for the owner; --done finishes and points at smoke", () => {
    run(["config", "--worker", "relay-t", "--domain", "owner.test", "--team", "t", "--country", "+1"]);
    const o = run(["contacts"]);
    expect(o).toMatch(/result=needs_human url=https:\/\/\S+\/contacts opened=yes reason=turn_on_people_then_rerun_with_--done/);
    expect(readFileSync(join(dir, "fake.opened"), "utf8")).toMatch(/^https:\/\/\S+\/contacts\n$/);
    expect(run(["contacts", "--done"])).toMatch(/result=ok url=\S+ next=smoke/);
  });
  it("Windows parity: both front ends route the contacts step", () => {
    const ps = readFileSync(join(ROOT, "scripts", "setup-windows.ps1"), "utf8");
    const sh = readFileSync(join(ROOT, "scripts", "setup-mac.sh"), "utf8");
    expect(ps.match(/\$LibSteps = @\(([^)]*)\)/)?.[1]).toContain("'contacts'");
    expect(sh).toMatch(/\|contacts\|/);
  });
});
