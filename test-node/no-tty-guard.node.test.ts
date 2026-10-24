// The suite must fail instead of prompting. These tests call the real open and read paths.
import { spawnSync } from "node:child_process";
import { openSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs script, no types
import { readPromptRaw } from "../scripts/setup-lib.mjs";

describe("non-interactive guard", () => {
  it("trips when a test opens or reads /dev/tty", () => {
    expect(() => openSync("/dev/tty", "r")).toThrow(/refusing_tty_open:\/dev\/tty/);
    expect(() => readFileSync("/dev/tty")).toThrow(/refusing_tty_open:\/dev\/tty/);
  });

  it("trips when code reads a TTY stdin", () => {
    expect(() => { readPromptRaw({ stdin: { isTTY: true } }); }).toThrow(/refusing_tty_stdin/);
    if (process.stdin.isTTY) expect(() => { process.stdin.read(1); }).toThrow(/refusing_tty_stdin/);
  });

  it("setup-lib installs the guard in a child process under vitest", () => {
    const href = new URL("../scripts/setup-lib.mjs", import.meta.url).href;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", `
      await import(${JSON.stringify(href)});
      const fs = await import("node:fs");
      try { fs.openSync("/dev/tty", "r"); console.log("OPENED"); }
      catch (e) { console.log("ERR " + e.message); }
    `], { encoding: "utf8", env: { ...process.env, VITEST: "true" } });
    expect(r.stdout).toContain("ERR refusing_tty_open:/dev/tty");
    expect(r.stdout).not.toContain("OPENED");
    expect(r.status).toBe(0);
  });
});
