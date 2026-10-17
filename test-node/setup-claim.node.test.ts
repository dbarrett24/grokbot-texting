// The claim guard and the local secret writer in scripts/setup-lib.mjs, run as the bot would run them,
// against a fake `npx wrangler` and a fake DNS. Offline: no Cloudflare, gateway, relay or real DNS call.
import { describe, it, expect, beforeEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, existsSync, statSync, chmodSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const FAKE_NPX = `#!/bin/sh
# fake npx: "npx wrangler <args>"; behaviour from FAKE_WORKER (exists|missing|error) and FAKE_LOGIN (yes|no)
shift
case "$1" in
  whoami) [ "$FAKE_LOGIN" = no ] && { echo "You are not authenticated."; exit 1; }; echo "logged in"; exit 0 ;;
  deployments) case "$FAKE_WORKER" in exists) echo "Deployment 1"; exit 0 ;; missing) echo "Worker not found [code: 10007]" >&2; exit 1 ;; *) echo "network down" >&2; exit 1 ;; esac ;;
  deploy) echo deployed > "$FAKE_LOG.deploy"; exit 0 ;;
  secret) [ "$2" = bulk ] && { cat > "$FAKE_LOG.stdin"; echo "$*" > "$FAKE_LOG.argv"; }; exit 0 ;;
esac
exit 0
`;
const FAKE_DNS = `const dns = require("node:dns"); const { syncBuiltinESMExports } = require("node:module");
const used = (process.env.FAKE_DNS_USED || "").split(",").filter(Boolean);
const f = async (h) => { if (used.includes(h)) return ["192.0.2.1"]; const e = new Error("ENODATA"); e.code = "ENODATA"; throw e; };
dns.promises.resolve = f; dns.promises.resolve6 = f; dns.promises.resolveCname = f; syncBuiltinESMExports();`;

let dir: string;
function run(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, ["--require", join(dir, "fake-dns.cjs"), join(dir, "scripts", "setup-lib.mjs"), ...args], {
    encoding: "utf8", env: { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}`, FAKE_LOG: join(dir, "fake"), FAKE_LOGIN: "yes", ...env },
  });
  return { code: r.status, out: r.stdout + r.stderr };
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-claim-"));
  mkdirSync(join(dir, "scripts")); mkdirSync(join(dir, "bin"));
  copyFileSync(join(ROOT, "scripts", "setup-lib.mjs"), join(dir, "scripts", "setup-lib.mjs"));
  copyFileSync(join(ROOT, "wrangler.toml"), join(dir, "wrangler.toml"));
  writeFileSync(join(dir, "bin", "npx"), FAKE_NPX); chmodSync(join(dir, "bin", "npx"), 0o755);
  writeFileSync(join(dir, "fake-dns.cjs"), FAKE_DNS);
  expect(run(["config", "--worker", "relay-t", "--domain", "owner.test", "--team", "t", "--country", "+1"]).out).toContain("result=ok");
});
const claimed = () => readdirSync(join(dir, ".relay-local")).some((f) => f.startsWith("claimed-"));

describe.skipIf(process.platform === "win32")("claim guard", () => {
  it("claims a free name and free hosts", () => {
    const r = run(["claim"], { FAKE_WORKER: "missing" });
    expect(r.out).toContain("RELAY_STATUS step=claim result=ok"); expect(claimed()).toBe(true);
  });
  it("refuses a Worker name that already exists", () => {
    const r = run(["claim"], { FAKE_WORKER: "exists" });
    expect(r.out).toContain("reason=worker_name_in_use"); expect(r.code).toBe(1); expect(claimed()).toBe(false);
  });
  it("fails closed when it can't tell whether the name exists", () => {
    const r = run(["claim"], { FAKE_WORKER: "error" });
    expect(r.out).toContain("reason=could_not_check_name"); expect(claimed()).toBe(false);
  });
  it("refuses a hostname that already has DNS records (either host)", () => {
    for (const h of ["api.owner.test", "app.owner.test"]) {
      const r = run(["claim"], { FAKE_WORKER: "missing", FAKE_DNS_USED: h });
      expect(r.out).toContain(`reason=host_in_use host=${h}`); expect(claimed()).toBe(false);
    }
  });
  it("asks for the human sign-in instead of guessing when not logged in", () => {
    const r = run(["claim"], { FAKE_LOGIN: "no", FAKE_WORKER: "missing" });
    expect(r.out).toContain("result=needs_human"); expect(r.code).toBe(2); expect(claimed()).toBe(false);
  });
  it("deploy and secrets refuse to run before a claim", () => {
    expect(run(["deploy"]).out).toContain("reason=run_claim_first");
    expect(existsSync(join(dir, "fake.deploy"))).toBe(false);
    const full = { REQUEST_TOKEN: "TEST-ONLY-r", LOG_HASH_KEY: "TEST-ONLY-l", ACCESS_AUD: "a".repeat(64), APPROVER_EMAIL: "o@example.test", OWNER_NUMBER: "+15555550100", OWNER_NAME: "Test Owner", GATEWAY_USER: "TEST-ONLY-u", GATEWAY_PASS: "TEST-ONLY-p", GATEWAY_DEVICE_ID: "d1", GATEWAY_PASSPHRASE: "TEST-ONLY-passphrase" };
    writeFileSync(join(dir, ".relay-local", "secrets.env"), Object.entries(full).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join("\n") + "\n");
    const s = run(["secrets"]);
    expect(s.out).toContain("reason=run_claim_first"); expect(existsSync(join(dir, "fake.stdin"))).toBe(false);
    // after a claim, secrets go on stdin only, never in argv or output
    run(["claim"], { FAKE_WORKER: "missing" });
    const t = run(["secrets"]);
    expect(readFileSync(join(dir, "fake.argv"), "utf8").trim()).toBe("secret bulk");
    expect(JSON.parse(readFileSync(join(dir, "fake.stdin"), "utf8")).GATEWAY_PASS).toBe("TEST-ONLY-p");
    for (const v of Object.values(full)) if (v.startsWith("TEST-ONLY")) expect(t.out).not.toContain(v);
  });
});

describe.skipIf(process.platform === "win32")("local secret writer", () => {
  it("writes secrets.env owner-only, never prints a value, and keeps existing keys", () => {
    const a = run(["keys"]);
    const f = join(dir, ".relay-local", "secrets.env");
    expect(statSync(f).mode & 0o777).toBe(0o600);
    const first = readFileSync(f, "utf8");
    const values = [...first.matchAll(/^[A-Z_]+=(".*")$/gm)].map((m) => JSON.parse(m[1]) as string);
    expect(values.length).toBeGreaterThanOrEqual(3);
    for (const v of values) expect(a.out).not.toContain(v);
    chmodSync(f, 0o644);
    run(["keys"]);
    expect(readFileSync(f, "utf8")).toBe(first);
    expect(statSync(f).mode & 0o777).toBe(0o600);
  });
  it("is covered by .gitignore", () => {
    expect(readFileSync(join(ROOT, ".gitignore"), "utf8")).toMatch(/^\.relay-local\/$/m);
  });
});
