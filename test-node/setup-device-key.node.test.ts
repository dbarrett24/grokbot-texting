// Device-key setup in scripts/setup-lib.mjs, run as the bot runs it: one derived gateway mode that keys, secrets,
// show, status and smoke all read; confirm-fingerprint pushing the pin to an already deployed Worker; key rotation;
// Windows parity. Offline: fake `npx wrangler` (a pretend Worker that only stores secret NAMES), a fetch preload
// for the gateway listing, fake dialogs. Test-only RSA keys made per run; no real keys, numbers or accounts.
import { describe, it, expect, beforeEach } from "vitest";
import { spawnSync } from "node:child_process";
import nodeCrypto from "node:crypto";
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error plain .mjs script, no types
import { gatewayMode, gatewayDiagnosis, GATEWAY_FIX, requiredSecrets, fingerprintOf, staleHint, STALE_PIN_HINT, pickDevice, confirmText, bothModesListed, winDialogScript } from "../scripts/setup-lib.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
// Pretend Worker: secret names in $FAKE_LOG.worker; each call's argv in $FAKE_LOG.calls; bulk stdin in $FAKE_LOG.stdin.
const FAKE_NPX = `#!/bin/sh
shift
echo "$*" >> "$FAKE_LOG.calls"
case "$1" in
  whoami) echo '{"loggedIn":true,"accounts":[{"id":"acct-a","name":"n"}]}' ;;
  secret) case "$2" in
    bulk) cat > "$FAKE_LOG.stdin"; [ -n "$FAKE_BULK_DROPS" ] && exit 0; node -e 'const fs=require("fs");const f=process.argv[1];const s=new Set(fs.existsSync(f)?fs.readFileSync(f,"utf8").split("\\n").filter(Boolean):[]);for(const k of Object.keys(JSON.parse(fs.readFileSync(process.argv[2],"utf8"))))s.add(k);fs.writeFileSync(f,[...s].join("\\n")+"\\n")' "$FAKE_LOG.worker" "$FAKE_LOG.stdin" ;;
    delete) touch "$FAKE_LOG.worker"; grep -vx "$3" "$FAKE_LOG.worker" > "$FAKE_LOG.w2"; mv "$FAKE_LOG.w2" "$FAKE_LOG.worker" ;;
    list) node -e 'const fs=require("fs");const f=process.argv[1];const n=fs.existsSync(f)?fs.readFileSync(f,"utf8").split("\\n").filter(Boolean):[];console.log(JSON.stringify(n.map(name=>({name,type:"secret_text"}))))' "$FAKE_LOG.worker" ;;
  esac ;;
esac
exit 0
`;
const FAKE_GW = `const real = globalThis.fetch;
globalThis.fetch = async (url) => {
  if (String(url).startsWith("https://api.sms-gate.app/3rdparty/v1/devices")) return new Response(process.env.FAKE_DEVICES || "[]", { status: 200 });
  throw new Error("network disabled in test");
};
if (process.env.FAKE_PLATFORM) Object.defineProperty(process, "platform", { value: process.env.FAKE_PLATFORM });`;
// Fake dialogs: the owner presses "Yes, it matches". powershell.exe also keeps the script it was given.
const FAKE_ZENITY = `#!/bin/sh\nprintf '%s\\n' "$@" > "$FAKE_LOG.zenity"\nexit 0\n`;
const FAKE_PWSH = `#!/bin/sh\ncat > "$FAKE_LOG.pwsh"\necho "Yes, it matches"\n`;
// With process.platform forced to win32, Node runs shell:true commands as \`cmd.exe /d /s /c "<command>"\`.
const FAKE_CMD = `#!/bin/sh\nshift 3\nc=\${1#\\"}; c=\${c%\\"}\neval "$c"\n`;

const newKey = () => (nodeCrypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "der" }) as Buffer).toString("base64");
const KEY_A = newKey(), KEY_B = newKey();
const dev = (pub?: string, ver?: number) => JSON.stringify([{ id: "test-device-1", ...(pub ? { publicKey: pub, keyVersion: ver } : {}) }]);

let dir: string;
function run(args: string[], env: Record<string, string | undefined> = {}, input?: string) {
  const merged: NodeJS.ProcessEnv = {
    ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}`, FAKE_LOG: join(dir, "fake"),
    // Never open a real native dialog (osascript on macOS) from a test: default to the fake Linux zenity path.
    FAKE_PLATFORM: "linux",
    // Prompts read an injected answer and write the prompt text to a file, never to a TTY.
    SETUP_NONINTERACTIVE: "1", SETUP_PROMPT_OUT: join(dir, "prompt.txt"), ...env,
  };
  for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k];
  const r = spawnSync(process.execPath, ["--require", join(dir, "fake-gw.cjs"), join(dir, "scripts", "setup-lib.mjs"), ...args], {
    encoding: "utf8", timeout: 20_000, env: merged, ...(input !== undefined ? { input } : {}),
  });
  return { code: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
}
/** confirm-fingerprint with an injected "Yes". Does not spawn osascript, zenity, or powershell. */
function confirm(env: Record<string, string | undefined> = {}) {
  return run(["confirm-fingerprint"], { SETUP_ANSWER: "Yes, it matches", ...env });
}
const promptText = () => readFileSync(join(dir, "prompt.txt"), "utf8");
const local = (f: string) => join(dir, ".relay-local", f);
const env = () => Object.fromEntries(readFileSync(local("secrets.env"), "utf8").split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), JSON.parse(l.slice(l.indexOf("=") + 1))]));
const settings = () => JSON.parse(readFileSync(local("settings.json"), "utf8"));
const calls = () => (existsSync(join(dir, "fake.calls")) ? readFileSync(join(dir, "fake.calls"), "utf8").trim().split("\n") : []);
const worker = () => (existsSync(join(dir, "fake.worker")) ? readFileSync(join(dir, "fake.worker"), "utf8").split("\n").filter(Boolean).sort() : []);
const clearCalls = () => rmSync(join(dir, "fake.calls"), { force: true });
const deployed = () => writeFileSync(local("owned-relay-t.json"), JSON.stringify({ worker: "relay-t", accountId: "acct-a", hosts: ["api.owner.test", "app.owner.test"] }));
const claimedNow = () => writeFileSync(local("claimed-relay-t.json"), JSON.stringify({ worker: "relay-t", apiHost: "api.owner.test", appHost: "app.owner.test", accountId: "acct-a" }));
const yes = { RELAY_DRYRUN_ANSWER: "Yes, it matches" };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-devkey-"));
  mkdirSync(join(dir, "scripts")); mkdirSync(join(dir, "bin"));
  copyFileSync(join(ROOT, "scripts", "setup-lib.mjs"), join(dir, "scripts", "setup-lib.mjs"));
  copyFileSync(join(ROOT, "scripts", "no-tty-guard.mjs"), join(dir, "scripts", "no-tty-guard.mjs"));
  if (existsSync(join(ROOT, "scripts", "is-main.mjs"))) copyFileSync(join(ROOT, "scripts", "is-main.mjs"), join(dir, "scripts", "is-main.mjs")); // after the realpath fix lands
  copyFileSync(join(ROOT, "wrangler.toml"), join(dir, "wrangler.toml"));
  for (const [n, body] of [["npx", FAKE_NPX], ["npx.cmd", FAKE_NPX], ["zenity", FAKE_ZENITY], ["powershell.exe", FAKE_PWSH], ["cmd.exe", FAKE_CMD]]) {
    writeFileSync(join(dir, "bin", n), body); chmodSync(join(dir, "bin", n), 0o755);
  }
  writeFileSync(join(dir, "fake-gw.cjs"), FAKE_GW);
  // Most of this file exercises device-key mode, which is opt-in while the app bug stands (see "default mode").
  expect(run(["config", "--worker", "relay-t", "--domain", "owner.test", "--team", "t", "--country", "+1", "--gateway-mode", "device-key"]).out).toContain("gateway_mode=device_key");
  for (const [k, v] of [["GATEWAY_USER", "TEST-ONLY-user"], ["GATEWAY_PASS", "TEST-ONLY-pass-123"], ["APPROVER_EMAIL", "a@owner.test"], ["OWNER_NUMBER", "+15555550100"], ["OWNER_NAME", "Test"], ["ACCESS_AUD", "a".repeat(64)]])
    expect(run(["ask", k, "--dry-run"], { RELAY_DRYRUN_ANSWER: v }).out).toContain("result=ok");
});

describe("one derived gateway mode", () => {
  it("is device_key / passphrase / unknown / none, and only the mode's own secrets are required", () => {
    const m = new Map<string, string>();
    expect(gatewayMode({ deviceKey: true }, m)).toBe("passphrase"); // the default, even with a phone key
    expect(gatewayMode({ deviceKey: false }, m)).toBe("passphrase");
    expect(gatewayMode({ deviceKey: true, gatewayMode: "device_key" }, m)).toBe("device_key");
    expect(gatewayMode({ deviceKey: false, gatewayMode: "passphrase" }, m)).toBe("passphrase");
    expect(gatewayMode({}, m)).toBe("unknown");
    expect(gatewayMode({}, new Map([["GATEWAY_PINNED_FINGERPRINT", "X"]]))).toBe("passphrase"); // B1: a pin alone never opts in
    expect(gatewayMode({ delivery: "mac", deviceKey: true }, m)).toBe("none");
    expect(requiredSecrets({ gatewayMode: "device_key" }, m)).not.toContain("GATEWAY_PASSPHRASE");
    expect(requiredSecrets({ deviceKey: false }, m)).not.toContain("GATEWAY_PINNED_FINGERPRINT");
    expect(requiredSecrets({}, m)).not.toContain("GATEWAY_PASSPHRASE");
    expect(requiredSecrets({}, m)).not.toContain("GATEWAY_PINNED_FINGERPRINT");
  });
});

describe.skipIf(process.platform === "win32")("device-key setup (offline)", () => {
  it("REGRESSION: gateway-check, confirm-fingerprint, config, keys, secrets carries the pin + version and no passphrase", () => {
    const g = run(["gateway-check"], { FAKE_DEVICES: dev(KEY_A, 3) });
    expect(g.out).toContain("RELAY_STATUS step=gateway_mode result=ok reason=device_key");
    expect(run(["confirm-fingerprint", "--dry-run"], yes).out).toContain("pinned=yes");
    expect(run(["config"]).out).toContain("result=ok");
    const k = run(["keys"]);
    expect(k.out).toContain("made=REQUEST_TOKEN,LOG_HASH_KEY,GOOGLE_TOKEN_KEY ");
    expect(k.out).not.toContain("GATEWAY_PASSPHRASE");
    const s = run(["secrets", "--dry-run"]);
    expect(s.out).toContain("names=REQUEST_TOKEN,LOG_HASH_KEY,ACCESS_AUD,APPROVER_EMAIL,OWNER_NUMBER,ALLOWLIST,GATEWAY_USER,GATEWAY_PASS,GATEWAY_DEVICE_ID,GATEWAY_PINNED_FINGERPRINT,GATEWAY_KEY_VERSION,GATEWAY_MODE,GOOGLE_TOKEN_KEY ");
    expect(s.out).not.toMatch(/names=[^ ]*GATEWAY_PASSPHRASE/);
    const e = env();
    expect(e.GATEWAY_PINNED_FINGERPRINT).toBe(fingerprintOf(KEY_A));
    expect(e.GATEWAY_KEY_VERSION).toBe("3");
    expect(e).not.toHaveProperty("GATEWAY_PASSPHRASE");
    expect(e).not.toHaveProperty("PENDING_FINGERPRINT");
  });

  it("no publicKey: passphrase mode, keys makes one, secrets carries it", () => {
    run(["config", "--gateway-mode", "passphrase"]);
    const g = run(["gateway-check"], { FAKE_DEVICES: dev() });
    expect(g.out).toContain("reason=passphrase");
    expect(settings().deviceKey).toBe(false);
    expect(run(["keys"]).out).toContain("made=REQUEST_TOKEN,LOG_HASH_KEY,GOOGLE_TOKEN_KEY,GATEWAY_PASSPHRASE ");
    expect(run(["secrets", "--dry-run"]).out).toMatch(/names=[^ ]*GATEWAY_PASSPHRASE/);
  });

  it("never replaces a passphrase the app already has", () => {
    run(["config", "--gateway-mode", "passphrase"]);
    run(["gateway-check"], { FAKE_DEVICES: dev() });
    const typed = "TEST-ONLY-existing-app-passphrase-0123456789";
    expect(run(["ask", "GATEWAY_PASSPHRASE", "--dry-run"], { RELAY_DRYRUN_ANSWER: typed }).out).toContain("result=ok");
    const k = run(["keys"]);
    expect(k.out).toContain("kept=");
    expect(k.out).toMatch(/kept=[^ ]*GATEWAY_PASSPHRASE/);
    expect(k.out).not.toContain(typed);
    expect(env().GATEWAY_PASSPHRASE).toBe(typed);
    expect(run(["ask", "GATEWAY_PASSPHRASE", "--dry-run"], { RELAY_DRYRUN_ANSWER: "short" }).out).toContain("result=fail");
  });

  it("before gateway-check (no choice made): keys makes no passphrase and secrets refuses", () => {
    const st = JSON.parse(readFileSync(local("settings.json"), "utf8")); delete st.gatewayMode;
    writeFileSync(local("settings.json"), JSON.stringify(st));
    expect(run(["keys"]).out).toContain("gateway_mode=unknown next=gateway-check");
    expect(env()).not.toHaveProperty("GATEWAY_PASSPHRASE");
    expect(run(["secrets", "--dry-run"]).out).toContain("reason=gateway_mode_unknown");
  });

  it("device-key mode refuses to show a passphrase, and secrets waits for the confirm", () => {
    run(["gateway-check"], { FAKE_DEVICES: dev(KEY_A, 1) });
    expect(run(["show", "GATEWAY_PASSPHRASE"]).out).toContain("reason=gateway_mode_device_key");
    run(["keys"]);
    expect(run(["secrets", "--dry-run"]).out).toContain("reason=fingerprint_not_confirmed");
  });

  it("gateway-check --dry-run writes nothing and still names the mode", () => {
    const before = readFileSync(local("secrets.env"), "utf8");
    const r = run(["gateway-check", "--dry-run"], { RELAY_DRYRUN_DEVICES: dev(KEY_A, 1) });
    expect(r.out).toContain("RELAY_STATUS step=gateway_mode result=dry_run reason=device_key");
    expect(readFileSync(local("secrets.env"), "utf8")).toBe(before);
  });

  it("undeployed Worker: confirm writes secrets.env only, no wrangler call", () => {
    run(["gateway-check"], { FAKE_DEVICES: dev(KEY_A, 2) });
    const c = confirm();
    expect(c.out).toContain("RELAY_STATUS step=worker-pin result=skip reason=not_deployed_yet");
    expect(calls()).toEqual([]);
    expect(env().GATEWAY_KEY_VERSION).toBe("2");
  });

  it("deployed Worker, dry run: shows both puts, prints no value, calls nothing", () => {
    run(["gateway-check"], { FAKE_DEVICES: dev(KEY_A, 2) });
    deployed();
    const c = run(["confirm-fingerprint", "--dry-run"], yes);
    expect(c.out).toContain("step=worker-pin result=dry_run worker=relay-t would_put=GATEWAY_PINNED_FINGERPRINT,GATEWAY_KEY_VERSION,GATEWAY_MODE would_remove=GATEWAY_PASSPHRASE_if_set");
    expect(c.out).not.toContain(fingerprintOf(KEY_A));
    expect(calls()).toEqual([]);
  });

  it("deployed Worker: confirm pushes pin + version over stdin and removes a stale passphrase, printing no value", () => {
    writeFileSync(join(dir, "fake.worker"), "REQUEST_TOKEN\nGATEWAY_PASSPHRASE\n"); // an earlier passphrase-mode run
    run(["gateway-check"], { FAKE_DEVICES: dev(KEY_A, 2) });
    deployed();
    const c = confirm(); // injected answer; the prompt is captured, not shown on a terminal
    const z = promptText();
    const g = fingerprintOf(KEY_A).split(":");
    expect(z).toContain(`${g[0]}  ${g[1]}   ...   ${g[14]}  ${g[15]}`); // big: first two and last two groups
    expect(z).toContain(fingerprintOf(KEY_A)); // full value, secondary
    expect(c.out).toContain("RELAY_STATUS step=worker-pin result=ok worker=relay-t put=GATEWAY_PINNED_FINGERPRINT,GATEWAY_KEY_VERSION,GATEWAY_MODE removed_passphrase=yes");
    expect(c.out).not.toContain(fingerprintOf(KEY_A));
    expect(calls()).toEqual(["whoami --json", "secret bulk", "secret list --format json", "secret delete GATEWAY_PASSPHRASE"]);
    expect(JSON.parse(readFileSync(join(dir, "fake.stdin"), "utf8"))).toEqual({ GATEWAY_PINNED_FINGERPRINT: fingerprintOf(KEY_A), GATEWAY_KEY_VERSION: "2", GATEWAY_MODE: "device_key" });
    expect(worker()).toEqual(["GATEWAY_KEY_VERSION", "GATEWAY_MODE", "GATEWAY_PINNED_FINGERPRINT", "REQUEST_TOKEN"]);
  });

  it("deployed Worker without a passphrase: nothing is deleted", () => {
    run(["gateway-check"], { FAKE_DEVICES: dev(KEY_A, 2) });
    deployed();
    expect(confirm().out).toContain("removed_passphrase=no");
    expect(calls().some((c) => c.includes("delete"))).toBe(false);
  });

  it("a Worker deployed from another Cloudflare account is not touched", () => {
    run(["gateway-check"], { FAKE_DEVICES: dev(KEY_A, 2) });
    writeFileSync(local("owned-relay-t.json"), JSON.stringify({ worker: "relay-t", accountId: "acct-other", hosts: ["api.owner.test", "app.owner.test"] }));
    expect(confirm().out).toContain("step=worker-pin result=fail reason=different_cloudflare_account");
    expect(calls()).toEqual(["whoami --json"]);
  });

  it("'No, different' pins nothing and pushes nothing", () => {
    run(["gateway-check"], { FAKE_DEVICES: dev(KEY_A, 2) });
    deployed();
    expect(run(["confirm-fingerprint", "--dry-run"], { RELAY_DRYRUN_ANSWER: "No, different" }).out).toContain("reason=fingerprint_mismatch");
    expect(env()).not.toHaveProperty("GATEWAY_PINNED_FINGERPRINT");
    expect(calls()).toEqual([]);
  });

  it("key rotation: the old pin stays until the new key is confirmed, then the Worker gets the new one", () => {
    run(["gateway-check"], { FAKE_DEVICES: dev(KEY_A, 1) });
    run(["confirm-fingerprint", "--dry-run"], yes);
    deployed(); claimedNow(); run(["keys"]);
    expect(run(["gateway-check"], { FAKE_DEVICES: dev(KEY_A, 1) }).out).toContain("next=none_already_pinned");
    const g = run(["gateway-check"], { FAKE_DEVICES: dev(KEY_B, 2) });
    expect(g.out).toContain("next=confirm-fingerprint");
    expect(env().GATEWAY_PINNED_FINGERPRINT).toBe(fingerprintOf(KEY_A)); // unconfirmed key never replaces the pin
    expect(env().GATEWAY_KEY_VERSION).toBe("1");
    expect(run(["secrets"]).out).toContain("reason=fingerprint_not_confirmed");
    clearCalls();
    const c = confirm();
    expect(c.out).toContain("replaced=previous_pin");
    expect(c.out).toContain("step=worker-pin result=ok");
    expect(JSON.parse(readFileSync(join(dir, "fake.stdin"), "utf8"))).toEqual({ GATEWAY_PINNED_FINGERPRINT: fingerprintOf(KEY_B), GATEWAY_KEY_VERSION: "2", GATEWAY_MODE: "device_key" });
  });

  it("secrets in device-key mode removes a stale passphrase it finds on the Worker", () => {
    writeFileSync(join(dir, "fake.worker"), "GATEWAY_PASSPHRASE\n");
    run(["gateway-check"], { FAKE_DEVICES: dev(KEY_A, 1) });
    run(["confirm-fingerprint", "--dry-run"], yes);
    run(["keys"]); claimedNow();
    const s = run(["secrets"]);
    expect(s.out).toContain("gateway_mode=device_key");
    expect(s.out).toContain("removed=GATEWAY_PASSPHRASE");
    expect(worker()).not.toContain("GATEWAY_PASSPHRASE");
    expect(worker()).toContain("GATEWAY_PINNED_FINGERPRINT");
  });

  it("smoke names the fix for device_key_present_but_no_pin and its reverse (device-key mode)", () => {
    run(["gateway-check"], { FAKE_DEVICES: dev(KEY_A, 1) }); // device-key mode, key not confirmed yet
    run(["keys"]);
    const a = run(["smoke", "--dry-run"], { RELAY_DRYRUN_DEVICES: dev(KEY_A, 1) });
    expect(a.out).toContain(`step=smoke-gateway result=fail reason=device_key_present_but_no_pin fix=${GATEWAY_FIX.device_key_present_but_no_pin}`);
    run(["confirm-fingerprint", "--dry-run"], yes);
    const b = run(["smoke", "--dry-run"], { RELAY_DRYRUN_DEVICES: dev() }); // reverse: pinned, but the phone has no key
    expect(b.out).toContain(`reason=no_device_key_and_no_passphrase fix=${GATEWAY_FIX.no_device_key_and_no_passphrase}`);
    expect(run(["smoke", "--dry-run"], { RELAY_DRYRUN_DEVICES: dev(KEY_A, 1) }).out).toContain("step=smoke-gateway result=ok mode=device_key");
    expect(run(["smoke", "--dry-run"], { RELAY_DRYRUN_DEVICES: dev(KEY_B, 2) }).out).toContain("reason=device_key_pin_mismatch");
  });

  it("N3: confirm-fingerprint keeps the local passphrase, so switching back needs no re-entry in the app", () => {
    run(["config", "--gateway-mode", "passphrase"]);
    run(["gateway-check"], { FAKE_DEVICES: dev() });
    const typed = "TEST-ONLY-existing-app-passphrase-0123456789";
    run(["ask", "GATEWAY_PASSPHRASE", "--dry-run"], { RELAY_DRYRUN_ANSWER: typed });
    run(["config", "--gateway-mode", "device-key"]);
    run(["gateway-check"], { FAKE_DEVICES: dev(KEY_A, 1) });
    run(["confirm-fingerprint", "--dry-run"], yes);
    expect(env().GATEWAY_PASSPHRASE).toBe(typed);
    run(["keys"]);
    expect(run(["secrets", "--dry-run"]).out).not.toMatch(/names=[^ ]*GATEWAY_PASSPHRASE/); // never sent in device-key mode
    run(["config", "--gateway-mode", "passphrase"]);
    expect(run(["keys"]).out).toMatch(/kept=[^ ]*GATEWAY_PASSPHRASE/);
    expect(env().GATEWAY_PASSPHRASE).toBe(typed);
  });
});

describe.skipIf(process.platform === "win32")("CARO vet fixes", () => {
  it("B1 scenario A: default passphrase mode on a phone WITH a device key: smoke passes, no confirm-fingerprint loop", () => {
    clearMode();
    run(["gateway-check"], { FAKE_DEVICES: dev(KEY_A, 1) });
    const before = run(["smoke", "--dry-run"], { RELAY_DRYRUN_DEVICES: dev(KEY_A, 1) }); // no passphrase yet
    expect(before.out).toContain(`step=smoke-gateway result=fail reason=gateway_mode_passphrase_but_no_passphrase fix=${GATEWAY_FIX.gateway_mode_passphrase_but_no_passphrase}`);
    expect(before.out).not.toContain("confirm-fingerprint");
    run(["keys"]);
    const after = run(["smoke", "--dry-run"], { RELAY_DRYRUN_DEVICES: dev(KEY_A, 1) });
    expect(after.out).toContain("step=smoke-gateway result=ok mode=passphrase");
    expect(after.out).not.toContain("device_key_present_but_no_pin");
  });

  it("B1 (EL): a stored pin with no recorded choice is passphrase mode plus a stale-pin hint, never device_key", () => {
    run(["gateway-check"], { FAKE_DEVICES: dev(KEY_A, 1) });
    run(["confirm-fingerprint", "--dry-run"], yes);
    clearMode(); // e.g. pinned by hand: the pin is there, no gatewayMode recorded
    expect(env()["GATEWAY_PINNED_FINGERPRINT"]).toBe(fingerprintOf(KEY_A));
    expect(gatewayMode(settings(), new Map(Object.entries(env())))).toBe("passphrase");
    expect(staleHint(settings(), new Map(Object.entries(env())))).toEqual({ stale_pin: STALE_PIN_HINT });
    const st = run(["status"]);
    expect(st.out).toContain("gateway_mode=passphrase");
    expect(st.out).toContain(`stale_pin=${STALE_PIN_HINT}`);
    const gc = run(["gateway-check"], { FAKE_DEVICES: dev(KEY_A, 1) });
    expect(gc.out).toContain("step=gateway_mode result=ok reason=passphrase");
    expect(gc.out).toContain("stale_pin=");
    expect(gc.out).not.toContain("next=confirm-fingerprint");
    expect(run(["confirm-fingerprint", "--dry-run"], yes).out).toContain("result=skip reason=gateway_mode_passphrase");
    run(["keys"]);
    expect(run(["secrets", "--dry-run"]).out).toMatch(/names=[^ ]*GATEWAY_PASSPHRASE,GATEWAY_MODE/);
    // the explicit choice is the only way in, and then the hint goes away
    run(["config", "--gateway-mode", "device-key"]);
    expect(gatewayMode(settings(), new Map(Object.entries(env())))).toBe("device_key");
    expect(run(["status"]).out).not.toContain("stale_pin=");
  });

  it("N2: worker-pin keeps the stale passphrase when the Worker doesn't list the new pin", () => {
    writeFileSync(join(dir, "fake.worker"), "GATEWAY_PASSPHRASE\n");
    run(["gateway-check"], { FAKE_DEVICES: dev(KEY_A, 2) });
    deployed();
    const c = confirm({ FAKE_BULK_DROPS: "1" });
    expect(c.out).toContain("step=worker-pin result=fail");
    expect(c.out).toContain("absent=GATEWAY_PINNED_FINGERPRINT,GATEWAY_KEY_VERSION,GATEWAY_MODE removed_passphrase=no_pin_not_listed");
    expect(calls().some((x) => x.startsWith("secret delete"))).toBe(false);
    expect(worker()).toContain("GATEWAY_PASSPHRASE");
  });

  it("N5: after keys makes a passphrase, keys / secrets / status say to show it into the app until shown", () => {
    run(["config", "--gateway-mode", "passphrase"]);
    run(["gateway-check"], { FAKE_DEVICES: dev(KEY_A, 1) });
    expect(run(["keys"]).out).toContain("next=show_GATEWAY_PASSPHRASE_then_enter_it_in_the_app");
    expect(run(["secrets", "--dry-run"]).out).toContain("owner_next=show_GATEWAY_PASSPHRASE_then_enter_it_in_the_app");
    expect(run(["status"]).out).toContain("owner_next=show_GATEWAY_PASSPHRASE_then_enter_it_in_the_app");
    const sh = run(["show", "GATEWAY_PASSPHRASE"]); // non-interactive: the value stays off stdout and the prompt file
    expect(sh.out).toContain("shown=on_screen_only");
    const phrase = "Type this into the SMS Gateway app";
    expect(sh.out).not.toContain(env()["GATEWAY_PASSPHRASE"]);
    expect(sh.out).not.toContain(phrase);
    if (existsSync(join(dir, "prompt.txt"))) {
      const captured = promptText();
      expect(captured).not.toContain(env()["GATEWAY_PASSPHRASE"]);
      expect(captured).not.toContain(phrase);
    }
    expect(run(["status"]).out).not.toContain("owner_next=");
    expect(run(["secrets", "--dry-run"]).out).not.toContain("owner_next=");
  });

  it("N5: a passphrase typed in from the app (ask) needs no reminder", () => {
    run(["config", "--gateway-mode", "passphrase"]);
    run(["gateway-check"], { FAKE_DEVICES: dev() });
    run(["keys"]); // made one, so the reminder is on
    expect(run(["status"]).out).toContain("owner_next=");
    run(["ask", "GATEWAY_PASSPHRASE", "--dry-run"], { RELAY_DRYRUN_ANSWER: "TEST-ONLY-existing-app-passphrase-0123456789" }); // owner used the app's own instead
    expect(run(["status"]).out).not.toContain("owner_next=");
  });

  it("Windows parity: B1 smoke and the N5 show go through the same paths on win32", () => {
    const w = { FAKE_PLATFORM: "win32", ComSpec: "cmd.exe" };
    clearMode();
    run(["gateway-check"], { ...w, FAKE_DEVICES: dev(KEY_A, 1) });
    run(["keys"], w);
    expect(run(["smoke", "--dry-run"], { ...w, RELAY_DRYRUN_DEVICES: dev(KEY_A, 1) }).out).toContain("step=smoke-gateway result=ok mode=passphrase");
    expect(run(["status"], w).out).toContain("owner_next=show_GATEWAY_PASSPHRASE");
    const shown = run(["show", "GATEWAY_PASSPHRASE"], w);
    expect(shown.out).toContain("shown=on_screen_only");
    expect(shown.out).not.toContain("Type this into the SMS Gateway app");
    expect(existsSync(join(dir, "fake.pwsh"))).toBe(false);
    expect(run(["status"], w).out).not.toContain("owner_next=");
  });
});

describe("gatewayDiagnosis mirrors the relay's gatewayPost checks", () => {
  const pinned = new Map([["GATEWAY_DEVICE_ID", "d"], ["GATEWAY_PINNED_FINGERPRINT", fingerprintOf(KEY_A)], ["GATEWAY_KEY_VERSION", "1"]]);
  it.each([
    ["no pin", { deviceKey: true, gatewayMode: "device_key" }, new Map([["GATEWAY_DEVICE_ID", "d"]]), [{ id: "d", publicKey: KEY_A, keyVersion: 1 }], "device_key_present_but_no_pin"],
    ["passphrase mode, phone has a key, passphrase stored", { deviceKey: true, gatewayMode: "passphrase" }, new Map([["GATEWAY_DEVICE_ID", "d"], ["GATEWAY_PASSPHRASE", "x"]]), [{ id: "d", publicKey: KEY_A, keyVersion: 1 }], null],
    ["passphrase mode, no passphrase", { deviceKey: true, gatewayMode: "passphrase" }, new Map([["GATEWAY_DEVICE_ID", "d"]]), [{ id: "d", publicKey: KEY_A, keyVersion: 1 }], "gateway_mode_passphrase_but_no_passphrase"],
    ["pinned ok", { deviceKey: true, gatewayMode: "device_key" }, pinned, [{ id: "d", publicKey: KEY_A, keyVersion: 1 }], null],
    ["other key", { deviceKey: true, gatewayMode: "device_key" }, pinned, [{ id: "d", publicKey: KEY_B, keyVersion: 1 }], "device_key_pin_mismatch"],
    ["other version", { deviceKey: true, gatewayMode: "device_key" }, pinned, [{ id: "d", publicKey: KEY_A, keyVersion: 2 }], "device_key_pin_mismatch"],
    ["no key, no passphrase", { deviceKey: true, gatewayMode: "device_key" }, pinned, [{ id: "d" }], "no_device_key_and_no_passphrase"],
    ["no key, passphrase", { deviceKey: false }, new Map([["GATEWAY_DEVICE_ID", "d"], ["GATEWAY_PASSPHRASE", "x"]]), [{ id: "d" }], null],
    ["unlisted", { deviceKey: true, gatewayMode: "device_key" }, pinned, [{ id: "other" }], "device_id_not_listed"],
  ])("%s", (_n, s, m, devs, want) => {
    expect(gatewayDiagnosis(s, m, devs)).toBe(want);
    if (want) expect(GATEWAY_FIX[want as string]).toMatch(/^\S+$/); // one line, one token
  });
});

describe.skipIf(process.platform === "win32")("Windows parity", () => {
  it("setup-windows.ps1 and setup-mac.sh route the same setup-lib steps", () => {
    const ps = readFileSync(join(ROOT, "scripts", "setup-windows.ps1"), "utf8");
    const sh = readFileSync(join(ROOT, "scripts", "setup-mac.sh"), "utf8");
    const lib = ps.match(/\$LibSteps = @\(([^)]*)\)/)![1].match(/'([^']+)'/g)!.map((x) => x.slice(1, -1));
    for (const step of ["keys", "ask", "show", "gateway-check", "confirm-fingerprint", "secrets", "smoke", "test-send"]) {
      expect(lib).toContain(step);
      expect(sh).toMatch(new RegExp(`\\b${step}\\b[^\\n]*\\)\\s*$`, "m"));
    }
  });
  it("on win32: confirm uses the injected prompt, does not spawn powershell, and the Worker push goes through npx.cmd", () => {
    writeFileSync(join(dir, "fake.worker"), "GATEWAY_PASSPHRASE\n");
    const w = { FAKE_PLATFORM: "win32", ComSpec: "cmd.exe" };
    expect(run(["gateway-check"], { ...w, FAKE_DEVICES: dev(KEY_A, 4) }).out).toContain("reason=device_key");
    deployed();
    const c = confirm(w);
    expect(c.out).toContain("step=worker-pin result=ok");
    expect(c.out).toContain("removed_passphrase=yes");
    const g = fingerprintOf(KEY_A).split(":");
    const shown = promptText();
    expect(shown).toContain(`${g[0]}  ${g[1]}   ...   ${g[14]}  ${g[15]}`);
    expect(shown).toContain("Reject unless you just set up this device.");
    expect(existsSync(join(dir, "fake.pwsh"))).toBe(false);
    const script = winDialogScript({ prompt: "Does this match the Key fingerprint in the SMS Gateway app?", hidden: false, show: shown, buttons: ["No, different", "Yes, it matches"] });
    expect(script).toContain("'Yes, it matches'");
    expect(script).toContain("$f.AcceptButton=$b0");
    expect(JSON.parse(readFileSync(join(dir, "fake.stdin"), "utf8")).GATEWAY_KEY_VERSION).toBe("4");
    expect(c.out).not.toContain(fingerprintOf(KEY_A));
  });
});

const clearMode = () => {
  const st = JSON.parse(readFileSync(local("settings.json"), "utf8")); delete st.gatewayMode;
  writeFileSync(local("settings.json"), JSON.stringify(st));
};
/** Device-key setup finished and pushed to a deployed, claimed Worker. */
function deployedInDeviceKeyMode(env: Record<string, string> = {}) {
  run(["gateway-check"], { ...env, FAKE_DEVICES: dev(KEY_A, 1) });
  run(["confirm-fingerprint", "--dry-run"], { ...env, ...yes });
  run(["keys"], env); deployed(); claimedNow();
  expect(run(["secrets"], env).out).toContain("result=ok gateway_mode=device_key");
  expect(worker()).toContain("GATEWAY_PINNED_FINGERPRINT");
  clearCalls();
}

describe.skipIf(process.platform === "win32")("default mode: passphrase while the app's device-key decrypt bug stands", () => {
  it("a phone WITH a device key still gets passphrase mode unless the owner opts in", () => {
    clearMode();
    const g = run(["gateway-check"], { FAKE_DEVICES: dev(KEY_A, 1) });
    expect(g.out).toContain("device_key=yes");
    expect(g.out).toContain("step=gateway_mode result=ok reason=passphrase hint=default_while_app_v1.77.0-1.77.4_device_key_decrypt_bug");
    expect(env()).not.toHaveProperty("PENDING_FINGERPRINT");
    expect(run(["confirm-fingerprint", "--dry-run"], yes).out).toContain("result=skip reason=gateway_mode_passphrase");
    expect(run(["keys"]).out).toContain("made=REQUEST_TOKEN,LOG_HASH_KEY,GOOGLE_TOKEN_KEY,GATEWAY_PASSPHRASE ");
    const s = run(["secrets", "--dry-run"]);
    expect(s.out).toMatch(/names=[^ ]*GATEWAY_PASSPHRASE,GATEWAY_MODE(,GOOGLE_TOKEN_KEY)? /);
    expect(s.out).not.toMatch(/names=[^ ]*GATEWAY_PINNED_FINGERPRINT/);
    expect(s.out).toContain("would_remove=GATEWAY_PINNED_FINGERPRINT_if_set,GATEWAY_KEY_VERSION_if_set"); // not deployed: can't list
  });

  it("config --gateway-mode takes passphrase | device-key only", () => {
    expect(run(["config", "--gateway-mode", "rsa"]).out).toContain("bad=gateway-mode");
    expect(run(["config", "--gateway-mode", "passphrase"]).out).toContain("gateway_mode=passphrase");
    expect(settings().gatewayMode).toBe("passphrase");
    expect(run(["config", "--gateway-mode", "device-key"]).out).toContain("gateway_mode=device_key");
    expect(settings().gatewayMode).toBe("device_key");
  });

  it("device-key mode on a phone with no device key fails gateway-check with the way out", () => {
    expect(run(["gateway-check"], { FAKE_DEVICES: dev() }).out).toContain("reason=device_key_mode_but_phone_has_no_device_key hint=update_app_to_v1.77+_or_config_--gateway-mode_passphrase");
  });

  it("SWITCH a deployed Worker device-key -> passphrase: dry run names the passphrase put and only the LISTED pin deletes, no values", () => {
    deployedInDeviceKeyMode();
    const c = run(["config", "--gateway-mode", "passphrase"]);
    expect(c.out).toContain("gateway_mode=passphrase next=keys_then_secrets");
    expect(run(["keys"]).out).toContain("made=GATEWAY_PASSPHRASE ");
    const e = env();
    const d = run(["secrets", "--dry-run"]);
    expect(d.out).toMatch(/result=dry_run gateway_mode=passphrase would_set=\d+ names=[^ ]*GATEWAY_PASSPHRASE,GATEWAY_MODE(,GOOGLE_TOKEN_KEY)? would_remove=GATEWAY_PINNED_FINGERPRINT,GATEWAY_KEY_VERSION( owner_next=\S+)?$/m);
    for (const v of Object.values(e)) if (String(v).length >= 8) expect(d.out).not.toContain(String(v));
    expect(calls()).toEqual(["secret list --format json"]); // read-only; nothing put or deleted
    expect(worker()).toContain("GATEWAY_PINNED_FINGERPRINT");
    // only what is listed: a Worker without the version secret
    writeFileSync(join(dir, "fake.worker"), worker().filter((k) => k !== "GATEWAY_KEY_VERSION").join("\n") + "\n");
    expect(run(["secrets", "--dry-run"]).out).toMatch(/would_remove=GATEWAY_PINNED_FINGERPRINT( |$)/m);
    writeFileSync(join(dir, "fake.worker"), worker().filter((k) => k !== "GATEWAY_PINNED_FINGERPRINT").join("\n") + "\n");
    expect(run(["secrets", "--dry-run"]).out).toContain("would_remove=none");
  });

  it("SWITCH for real: passphrase + mode put over stdin, pin and version deleted, Worker ends in passphrase mode", () => {
    deployedInDeviceKeyMode();
    run(["config", "--gateway-mode", "passphrase"]); run(["keys"]);
    const s = run(["secrets"]);
    expect(s.out).toContain("result=ok gateway_mode=passphrase");
    expect(s.out).toContain("removed=GATEWAY_PINNED_FINGERPRINT,GATEWAY_KEY_VERSION");
    expect(s.out).not.toContain(env()["GATEWAY_PASSPHRASE"]);
    const stdin = JSON.parse(readFileSync(join(dir, "fake.stdin"), "utf8"));
    expect(stdin.GATEWAY_MODE).toBe("passphrase");
    expect(stdin.GATEWAY_PASSPHRASE).toBe(env()["GATEWAY_PASSPHRASE"]);
    expect(stdin).not.toHaveProperty("GATEWAY_PINNED_FINGERPRINT");
    expect(worker()).toContain("GATEWAY_PASSPHRASE");
    expect(worker()).not.toContain("GATEWAY_PINNED_FINGERPRINT");
    expect(worker()).not.toContain("GATEWAY_KEY_VERSION");
    expect(calls().filter((c) => c.startsWith("secret delete"))).toEqual(["secret delete GATEWAY_PINNED_FINGERPRINT", "secret delete GATEWAY_KEY_VERSION"]);
  });

  it("Windows parity: the same switch through npx.cmd", () => {
    const w = { FAKE_PLATFORM: "win32", ComSpec: "cmd.exe" };
    deployedInDeviceKeyMode(w);
    run(["config", "--gateway-mode", "passphrase"], w); run(["keys"], w);
    expect(run(["secrets", "--dry-run"], w).out).toContain("would_remove=GATEWAY_PINNED_FINGERPRINT,GATEWAY_KEY_VERSION");
    expect(run(["secrets"], w).out).toContain("removed=GATEWAY_PINNED_FINGERPRINT,GATEWAY_KEY_VERSION");
    expect(worker()).not.toContain("GATEWAY_PINNED_FINGERPRINT");
  });
});

describe.skipIf(process.platform === "win32")("EL gateway-mode safety fixes", () => {
  const two = (a: string, b: string) => JSON.stringify([{ id: a, name: "Test Phone A", publicKey: KEY_A, keyVersion: 1 }, { id: b, name: "Test Phone B", publicKey: KEY_B, keyVersion: 1 }]);

  it("B2: gateway-check never overwrites a stored GATEWAY_DEVICE_ID; a different listing fails device_id_changed", () => {
    expect(run(["gateway-check"], { FAKE_DEVICES: dev(KEY_A, 1) }).out).toContain("step=gateway-check result=ok");
    expect(env()["GATEWAY_DEVICE_ID"]).toBe("test-device-1");
    const r = run(["gateway-check"], { FAKE_DEVICES: JSON.stringify([{ id: "test-device-2", publicKey: KEY_B, keyVersion: 1 }]) });
    expect(r.code).toBe(1);
    expect(r.out).toContain("step=gateway-check result=fail reason=device_id_changed");
    expect(env()["GATEWAY_DEVICE_ID"]).toBe("test-device-1");
    expect(env()["PENDING_FINGERPRINT"]).toBe(fingerprintOf(KEY_A)); // nothing from the other device was held
  });

  it("B3: with a stored id, the listing is filtered by GATEWAY_DEVICE_ID, never devices[0]", () => {
    run(["gateway-check"], { FAKE_DEVICES: dev(KEY_A, 1) });
    // the stored phone listed SECOND: its key is the one held, not the first entry's
    const r = run(["gateway-check"], { FAKE_DEVICES: JSON.stringify([{ id: "test-device-9", publicKey: KEY_B, keyVersion: 1 }, { id: "test-device-1", name: "Test Phone", publicKey: KEY_A, keyVersion: 1 }]) });
    expect(r.out).toContain("step=gateway-check result=ok");
    expect(env()["PENDING_FINGERPRINT"]).toBe(fingerprintOf(KEY_A));
    expect(env()["PENDING_DEVICE_ID"]).toBe("test-device-1");
    // no stored id and several devices: refuse rather than guess
    expect(pickDevice(JSON.parse(two("x1", "x2")), undefined)).toEqual({ reason: "more_than_one_device" });
    expect(pickDevice(JSON.parse(two("x1", "x2")), "x2").device.id).toBe("x2");
    expect(pickDevice(JSON.parse(two("x1", "x2")), "x3")).toEqual({ reason: "device_id_changed" });
    expect(pickDevice([], "x1")).toEqual({ reason: "no_device_yet" });
  });

  it("B3: the fingerprint confirm shows the device id and name", () => {
    run(["gateway-check"], { FAKE_DEVICES: JSON.stringify([{ id: "test-device-1", name: "Test Phone", publicKey: KEY_A, keyVersion: 1 }]) });
    const c = confirm(); // prompt text is written to the injected file, not a native dialog
    expect(c.out).toContain("step=confirm-fingerprint result=ok");
    const shown = promptText();
    expect(shown).toContain("Device: Test Phone");
    expect(shown).toContain("Device id: test-device-1");
    expect(shown).toContain(fingerprintOf(KEY_A));
    expect(env()).not.toHaveProperty("PENDING_DEVICE_ID");
    expect(env()).not.toHaveProperty("PENDING_DEVICE_NAME");
    expect(confirmText("AAAA:BBBB:CCCC:DDDD", "id-1", undefined)).toContain("Device: (no name listed)");
    expect(shown).toContain("Expected fingerprint from the gateway-check step, stored in .relay-local/secrets.env (PENDING_FINGERPRINT).");
    expect(shown).toContain("Reject unless you just set up this device.");
    expect(c.out).not.toContain("Reject unless you just set up this device.");
  });

  it("B5: status and secrets warn when the Worker holds both passphrase and pin secrets", () => {
    expect(bothModesListed(["GATEWAY_PASSPHRASE", "GATEWAY_PINNED_FINGERPRINT"])).toBe(true);
    expect(bothModesListed(["GATEWAY_PASSPHRASE", "GATEWAY_KEY_VERSION"])).toBe(true);
    expect(bothModesListed(["GATEWAY_PASSPHRASE"])).toBe(false);
    expect(bothModesListed(["GATEWAY_PINNED_FINGERPRINT", "GATEWAY_KEY_VERSION"])).toBe(false);
    run(["gateway-check"], { FAKE_DEVICES: dev(KEY_A, 1) });
    confirm();
    run(["keys"]);
    deployed(); claimedNow();
    writeFileSync(join(dir, "fake.worker"), ["GATEWAY_PASSPHRASE", "GATEWAY_PINNED_FINGERPRINT", "GATEWAY_KEY_VERSION", "GATEWAY_MODE"].join("\n") + "\n");
    const st = run(["status"]);
    expect(st.out).toContain("step=worker_secrets result=warn reason=worker_has_passphrase_and_pin gateway_mode=device_key listed=GATEWAY_PASSPHRASE,GATEWAY_PINNED_FINGERPRINT,GATEWAY_KEY_VERSION");
    expect(calls().filter((c) => c.startsWith("secret ") && !c.startsWith("secret list"))).toEqual([]); // status only lists names
    const d = run(["secrets", "--dry-run"]);
    expect(d.out).toContain("step=worker_secrets result=warn reason=worker_has_passphrase_and_pin");
    expect(d.out).not.toContain("TEST-ONLY");
    // the real run warns about what it found, removes the other mode's secret, and the warning then clears
    const s = run(["secrets"]);
    expect(s.out).toContain("step=worker_secrets result=warn reason=worker_has_passphrase_and_pin");
    expect(s.out).toContain("removed=GATEWAY_PASSPHRASE");
    expect(run(["status"]).out).not.toContain("worker_has_passphrase_and_pin");
  });

  it("B5: one mode's secrets only: no warning", () => {
    run(["gateway-check"], { FAKE_DEVICES: dev(KEY_A, 1) });
    confirm();
    run(["keys"]);
    deployed(); claimedNow();
    writeFileSync(join(dir, "fake.worker"), ["GATEWAY_PINNED_FINGERPRINT", "GATEWAY_KEY_VERSION", "GATEWAY_MODE"].join("\n") + "\n");
    expect(run(["status"]).out).not.toContain("result=warn");
    expect(run(["secrets", "--dry-run"]).out).not.toContain("result=warn");
  });
});

describe.skipIf(process.platform === "win32")("native dialogs never spawn under test", () => {
  function arm(name: string) {
    writeFileSync(join(dir, "bin", name), `#!/bin/sh\ntouch "$FAKE_LOG.${name}"\nexit 0\n`);
    chmodSync(join(dir, "bin", name), 0o755);
  }
  it.each([
    ["darwin", "osascript"],
    ["linux", "zenity"],
    ["win32", "powershell.exe"],
  ])("FAKE_PLATFORM=%s blocks %s before it can run", (platform, cmd) => {
    arm(cmd);
    run(["gateway-check"], { FAKE_DEVICES: dev(KEY_A, 1) });
    const c = run(["confirm-fingerprint"], { FAKE_PLATFORM: platform, SETUP_NONINTERACTIVE: "", ComSpec: "cmd.exe" });
    expect(c.code).not.toBe(0);
    expect(c.out).toContain(`reason=native_dialog_blocked:${cmd}`);
    expect(existsSync(join(dir, `fake.${cmd}`))).toBe(false);
    expect(env()).not.toHaveProperty("GATEWAY_PINNED_FINGERPRINT");
  });

  it("empty SETUP_ANSWER and an empty stdin both reject the fingerprint", () => {
    run(["gateway-check"], { FAKE_DEVICES: dev(KEY_A, 1) });
    const empty = run(["confirm-fingerprint"], { SETUP_ANSWER: "" });
    expect(empty.out).toContain("reason=fingerprint_mismatch");
    expect(env()).not.toHaveProperty("GATEWAY_PINNED_FINGERPRINT");
    const eof = run(["confirm-fingerprint"], {}, "");
    expect(eof.out).toContain("reason=fingerprint_mismatch");
    expect(env()).not.toHaveProperty("GATEWAY_PINNED_FINGERPRINT");
  });

  it("an injected stdin line can still confirm, and the prompt file holds the source line", () => {
    run(["gateway-check"], { FAKE_DEVICES: dev(KEY_A, 1) });
    const c = run(["confirm-fingerprint"], {}, "Yes, it matches\n");
    expect(c.out).toContain("pinned=yes");
    expect(c.out).not.toContain(fingerprintOf(KEY_A));
    expect(c.out).not.toContain("Type this into the SMS Gateway app");
    const shown = promptText();
    expect(shown).toContain("Reject unless you just set up this device.");
    expect(shown).toContain("PENDING_FINGERPRINT");
    expect(existsSync(join(dir, "fake.zenity"))).toBe(false);
    expect(existsSync(join(dir, "fake.osascript"))).toBe(false);
  });
});
