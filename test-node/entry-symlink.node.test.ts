// Regression: every script's "was I run directly?" check must survive a symlink in the path. macOS TMPDIR
// (/var/folders/...) is a symlink to /private/var/..., and Node resolves the module's own URL through links
// but leaves process.argv[1] as typed. Before the fix each step then skipped main(), printed nothing and
// exited 0. These tests build a real symlink (on any OS) and run the scripts through it.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, copyFileSync, existsSync, symlinkSync, rmSync, realpathSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const ROOT = realpathSync(new URL("..", import.meta.url).pathname);
let real: string;
let link: string;
let cleanup: string[];

/** A real temp dir and a symlink pointing at it; both removed after each test. */
function linkTo(target: string): string {
  const l = join(realpathSync(tmpdir()), `relay-link-${randomBytes(6).toString("hex")}`);
  symlinkSync(target, l, "dir");
  cleanup.push(l);
  return l;
}
function run(script: string, args: string[], opts: { cwd?: string; env?: Record<string, string | undefined> } = {}) {
  const env: Record<string, string | undefined> = { ...process.env, ...opts.env };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  const r = spawnSync(process.execPath, [script, ...args], { encoding: "utf8", cwd: opts.cwd, env: env as NodeJS.ProcessEnv, timeout: 30_000 });
  return { code: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

beforeEach(() => {
  cleanup = [];
  real = mkdtempSync(join(realpathSync(tmpdir()), "relay-real-"));
  cleanup.push(real);
  link = linkTo(real);
  // The setup helper writes .relay-local next to its own folder, so run a copy in the temp dir, reached
  // through the link (the way a macOS TMPDIR path reaches it).
  mkdirSync(join(link, "scripts"));
  for (const f of ["setup-lib.mjs", "is-main.mjs"]) {
    if (existsSync(join(ROOT, "scripts", f))) copyFileSync(join(ROOT, "scripts", f), join(link, "scripts", f));
  }
  copyFileSync(join(ROOT, "wrangler.toml"), join(link, "wrangler.toml"));
});
afterEach(() => {
  for (const p of cleanup.reverse()) rmSync(p, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("scripts run through a symlinked path still run", () => {
  it("setup-lib.mjs via a symlinked TMPDIR path: the step runs and prints its status line", () => {
    const r = run(join(link, "scripts", "setup-lib.mjs"), ["status"], { env: { TMPDIR: link } });
    expect(r.out).toContain("RELAY_STATUS step=status result=ok");
    expect(r.code).toBe(0);
  });

  it("setup-lib.mjs via the symlink, relative path from a symlinked cwd: an unknown step is a loud usage failure, not a silent 0", () => {
    const r = run(join("scripts", "setup-lib.mjs"), ["no-such-step"], { cwd: link, env: { TMPDIR: link } });
    expect(r.out).toContain("RELAY_STATUS step=usage result=fail");
    expect(r.code).toBe(3);
  });

  it("setup-lib.mjs config through the symlink writes its settings into the real folder", () => {
    const r = run(join(link, "scripts", "setup-lib.mjs"), ["config", "--worker", "relay-t", "--domain", "owner.test", "--team", "t", "--country", "+1"], { env: { TMPDIR: link } });
    expect(r.out).toContain("RELAY_STATUS step=config result=ok");
    expect(existsSync(join(real, ".relay-local", "settings.json"))).toBe(true);
  });

  it("import-contacts.mjs through a symlinked repo path: a bad --country-code is reported (exit 2), not skipped", () => {
    const repo = linkTo(ROOT);
    const r = run(join(repo, "scripts", "import-contacts.mjs"), ["--dry-run", "--country-code", "bogus"]);
    expect(r.code).toBe(2);
    expect(r.out.trim()).not.toBe("");
  });

  it("google-client.mjs through a symlinked repo path: missing --file is reported (exit 1), not skipped", () => {
    const repo = linkTo(ROOT);
    const r = run(join(repo, "scripts", "google-client.mjs"), []);
    expect(r.code).toBe(1);
    expect(r.out).toContain("--file=");
  });

  it("google-consent.mjs through a symlinked repo path: missing client id is reported (exit 1), not skipped", () => {
    const repo = linkTo(ROOT);
    const r = run(join(repo, "scripts", "google-consent.mjs"), ["primary"], { env: { GOOGLE_CLIENT_ID: undefined, GOOGLE_CLIENT_SECRET: undefined } });
    expect(r.code).toBe(1);
    expect(r.out).toContain("GOOGLE_CLIENT_ID");
  });

  it("mac/relay-device.mjs through a symlinked repo path: main() runs (config error, exit 78), not skipped", () => {
    const repo = linkTo(ROOT);
    const r = run(join(repo, "mac", "relay-device.mjs"), ["--check"], { env: { RELAY_URL: undefined, IMSG_PATH: "/nonexistent/imsg" } });
    expect(r.code).toBe(78);
    expect(r.out).toContain("relay-device:");
  });
});

describe("mac/install.sh installs everything relay-device.mjs imports", () => {
  it("each relative import of the helper is copied next to it", () => {
    const helper = readFileSync(join(ROOT, "mac", "relay-device.mjs"), "utf8");
    const install = readFileSync(join(ROOT, "mac", "install.sh"), "utf8");
    const rel = [...helper.matchAll(/from "\.\/([^"]+)"/g)].map((m) => m[1]);
    expect(rel).toContain("is-main.mjs");
    for (const f of rel) expect(install).toContain(`"$DEST/${f}"`);
  });
});
