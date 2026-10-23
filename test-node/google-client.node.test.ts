// scripts/google-client.mjs: the downloaded console JSON becomes two Worker secrets on stdin, then the file is deleted.
// The secret string must not appear in anything the script prints, including when wrangler fails or echoes it.
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, existsSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error plain .mjs script, no types
import { parseClientJson, fileArg, configArg, installClientJson } from "../scripts/google-client.mjs";

const SECRET = "WALK-ONLY-client-secret";
const ID = "123-walkonly.apps.googleusercontent.com";
const json = JSON.stringify({ web: { client_id: ID, client_secret: SECRET, redirect_uris: ["https://app.example.com/contacts/google/callback"] } });

type Put = { args: string[]; value: string; stdout: string };
function fakeSpawn(opts: { code?: number; echo?: boolean } = {}) {
  const puts: Put[] = [];
  const spawn = (_cmd: string, args: string[]) => {
    const put: Put = { args, value: "", stdout: "" };
    puts.push(put);
    const handlers: Record<string, (arg: unknown) => void> = {};
    return {
      stdout: { on(ev: string, fn: (chunk: unknown) => void) { if (ev === "data" && opts.echo) fn(SECRET); } },
      stderr: { on(ev: string, fn: (chunk: unknown) => void) { if (ev === "data" && opts.echo) fn(SECRET); } },
      stdin: { end(v: string) { put.value = v; } },
      on(ev: string, fn: (arg: unknown) => void) {
        handlers[ev] = fn;
        if (ev === "close") queueMicrotask(() => fn(opts.code ?? 0));
      },
    };
  };
  return { spawn, puts };
}

describe("parseClientJson", () => {
  it("reads the web client and refuses a bad id or secret", () => {
    expect(parseClientJson(json)).toEqual({ id: ID, secret: SECRET });
    expect(() => parseClientJson("{")).toThrow(/client_json_invalid/);
    expect(() => parseClientJson(JSON.stringify({ web: { client_id: "nope", client_secret: SECRET } }))).toThrow(/client_id_invalid/);
    expect(() => parseClientJson(JSON.stringify({ web: { client_id: ID, client_secret: "short" } }))).toThrow(/client_secret_invalid/);
  });
});

describe("fileArg", () => {
  it("takes --file=path as one element and refuses a split flag", () => {
    expect(fileArg(["--file=client.json"])).toBe("client.json");
    expect(() => fileArg(["--file", "client.json"])).toThrow(/one argument/);
    expect(() => fileArg([])).toThrow(/--file=/);
  });
});

describe("configArg", () => {
  it("takes --config=path as one element and has no default", () => {
    expect(configArg(["--config=.relay-local/wrangler.toml"])).toBe(".relay-local/wrangler.toml");
    expect(() => configArg(["--config", ".relay-local/wrangler.toml"])).toThrow(/one argument/);
    expect(() => configArg([])).toThrow(/pass --config=<path>/);
    expect(() => configArg(["--config="])).toThrow(/pass --config=<path>/);
  });
});

const LIVE = ".relay-local/wrangler.toml";
function tempConfig(body = 'name = "sms-relay"\n'): { dir: string; config: string } {
  const dir = mkdtempSync(join(tmpdir(), "gclient-cfg-"));
  const config = join(dir, LIVE);
  mkdirSync(join(dir, ".relay-local"));
  writeFileSync(config, body);
  return { dir, config };
}

describe("installClientJson", () => {
  it("pipes each value to wrangler stdin, passes the same --config to both puts, and deletes the JSON", async () => {
    const { dir, config } = tempConfig(`name = "sms-relay"\n# ${SECRET}\n`);
    const { spawn, puts } = fakeSpawn({ echo: true });
    const logs: string[] = [];
    let unlinked = false;
    try {
      await installClientJson({ text: json, config, unlink: () => { unlinked = true; }, log: (l: string) => logs.push(l), spawn });
      expect(puts.map((p) => p.args)).toEqual([
        ["wrangler", "secret", "put", "GOOGLE_CLIENT_ID", `--config=${config}`],
        ["wrangler", "secret", "put", "GOOGLE_CLIENT_SECRET", `--config=${config}`],
      ]);
      expect(puts[0]?.value).toBe(ID);
      expect(puts[1]?.value).toBe(SECRET);
      expect(logs).toEqual(["GOOGLE_CLIENT_ID set", "GOOGLE_CLIENT_SECRET set"]);
      expect(logs.join("\n")).not.toContain(SECRET);
      expect(unlinked).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a failed put keeps the JSON, names the secret and the retry, and never includes the secret", async () => {
    const { spawn } = fakeSpawn({ code: 1, echo: true });
    const logs: string[] = [];
    let unlinked = false;
    const { dir, config } = tempConfig();
    try {
    await expect(installClientJson({ text: json, config, unlink: () => { unlinked = true; }, log: (l: string) => logs.push(l), spawn })).rejects.toThrow(
      /^wrangler secret put GOOGLE_CLIENT_ID failed\. The client JSON was kept\. Retry: node scripts\/google-client\.mjs --file=<path> --config=<path>$/,
    );
    expect(logs.join("\n")).not.toContain(SECRET);
    expect(unlinked).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a failure of the second put names GOOGLE_CLIENT_SECRET and still keeps the JSON", async () => {
    let n = 0;
    const spawn = () => {
      n += 1;
      const code = n === 1 ? 0 : 1;
      return {
        stdout: { on() {} },
        stderr: { on() {} },
        stdin: { end() {} },
        on(ev: string, fn: (arg: unknown) => void) {
          if (ev === "close") queueMicrotask(() => fn(code));
        },
      };
    };
    let unlinked = false;
    const { dir, config } = tempConfig();
    try {
    await expect(installClientJson({ text: json, config, unlink: () => { unlinked = true; }, log: () => {}, spawn })).rejects.toThrow(/wrangler secret put GOOGLE_CLIENT_SECRET failed/);
    expect(unlinked).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("bad JSON is kept and the thrown message is a code, not the file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gclient-"));
    const path = join(dir, "client.json");
    writeFileSync(path, `{"web":{"client_secret":"${SECRET}"}}`);
    let gone = false;
    const cfg = tempConfig();
    try {
    await expect(installClientJson({
      text: `not json ${SECRET}`,
      config: cfg.config,
      unlink: () => { gone = true; },
      log: () => {},
      spawn: () => { throw new Error("spawn should not run"); },
    })).rejects.toThrow(/^client_json_invalid$/);
    expect(gone).toBe(false);
    expect(existsSync(path)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(cfg.dir, { recursive: true, force: true });
    }
  });

  it("a missing or unreadable config fails before any put, keeps the JSON, and never includes the secret", async () => {
    const { dir, config } = tempConfig();
    const missing = join(dir, "missing.toml");
    const logs: string[] = [];
    let unlinked = false;
    let spawned = 0;
    const spawn = () => { spawned += 1; throw new Error("spawn should not run"); };
    try {
      await expect(installClientJson({ text: json, config: missing, unlink: () => { unlinked = true; }, log: (l: string) => logs.push(l), spawn })).rejects.toThrow(
        /^config_unreadable\. The client JSON was kept\. Pass --config=<path> to a readable wrangler\.toml\.$/,
      );
      await expect(installClientJson({ text: json, config: dir, unlink: () => { unlinked = true; }, log: (l: string) => logs.push(l), spawn })).rejects.toThrow(/config_unreadable/);
      chmodSync(config, 0o000);
      let rootCanRead = true;
      try { readFileSync(config); } catch { rootCanRead = false; }
      if (!rootCanRead) {
        await expect(installClientJson({ text: json, config, unlink: () => { unlinked = true; }, log: (l: string) => logs.push(l), spawn })).rejects.toThrow(/config_unreadable/);
      }
      expect(spawned).toBe(0);
      expect(unlinked).toBe(false);
      expect(logs.join("\n")).not.toContain(SECRET);
    } finally {
      chmodSync(config, 0o644);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not fall back to .relay-local/wrangler.toml when --config is omitted", () => {
    expect(() => configArg([])).toThrow(/pass --config=<path>/);
    expect(configArg(["--file=client.json", "--config=.relay-local/wrangler.toml"])).toBe(".relay-local/wrangler.toml");
  });

  it("the CLI exits non-zero, keeps the JSON, and never prints the secret when wrangler fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "gclient-cli-"));
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const npx = join(bin, "npx");
    const argvLog = join(dir, "argv.txt");
    writeFileSync(npx, `#!/bin/sh\nprintf '%s\\n' "$@" >> ${JSON.stringify(argvLog)}\ncat >/dev/null\nprintf '%s\\n' ${JSON.stringify(SECRET)}\nexit 1\n`);
    chmodSync(npx, 0o755);
    const file = join(dir, "client.json");
    writeFileSync(file, json);
    const { dir: cfgDir, config } = tempConfig("name = \"sms-relay\"\nTOML-MARKER-NOT-A-SECRET\n");
    const r = spawnSync(process.execPath, ["scripts/google-client.mjs", `--file=${file}`, `--config=${config}`], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env["PATH"] ?? ""}` },
    });
    const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
    expect(r.status).not.toBe(0);
    expect(existsSync(file)).toBe(true);
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain("TOML-MARKER-NOT-A-SECRET");
    expect(r.stderr).toContain("GOOGLE_CLIENT_ID");
    expect(r.stderr).toContain("node scripts/google-client.mjs --file=<path> --config=<path>");
    expect(readFileSync(argvLog, "utf8")).toContain(`--config=${config}`);
    rmSync(dir, { recursive: true, force: true });
    rmSync(cfgDir, { recursive: true, force: true });
  });

  it("the CLI passes the same --config to both puts and still does not print the secret", () => {
    const dir = mkdtempSync(join(tmpdir(), "gclient-cli-ok-"));
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const npx = join(bin, "npx");
    const argvLog = join(dir, "argv.txt");
    writeFileSync(npx, `#!/bin/sh\nprintf '%s\\n' "$@" >> ${JSON.stringify(argvLog)}\nprintf '\\n' >> ${JSON.stringify(argvLog)}\ncat >/dev/null\nexit 0\n`);
    chmodSync(npx, 0o755);
    const file = join(dir, "client.json");
    writeFileSync(file, json);
    const { dir: cfgDir, config } = tempConfig("name = \"sms-relay\"\nTOML-MARKER-NOT-A-SECRET\n");
    const r = spawnSync(process.execPath, ["scripts/google-client.mjs", `--file=${file}`, `--config=${config}`], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env["PATH"] ?? ""}` },
    });
    const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
    const argv = readFileSync(argvLog, "utf8");
    expect(r.status).toBe(0);
    expect(existsSync(file)).toBe(false);
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain("TOML-MARKER-NOT-A-SECRET");
    expect(argv.split(`--config=${config}`).length - 1).toBe(2);
    expect(argv).toContain("GOOGLE_CLIENT_ID");
    expect(argv).toContain("GOOGLE_CLIENT_SECRET");
    expect(argv).not.toContain(SECRET);
    rmSync(dir, { recursive: true, force: true });
    rmSync(cfgDir, { recursive: true, force: true });
  });

  it("the CLI keeps the JSON and does not put when --config is missing or the path cannot be read", () => {
    const dir = mkdtempSync(join(tmpdir(), "gclient-cli-cfg-"));
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const npx = join(bin, "npx");
    const marker = join(dir, "spawned");
    writeFileSync(npx, `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(SECRET)} > ${JSON.stringify(marker)}\nexit 0\n`);
    chmodSync(npx, 0o755);
    const file = join(dir, "client.json");
    writeFileSync(file, json);
    const env = { ...process.env, PATH: `${bin}:${process.env["PATH"] ?? ""}` };
    const missingFlag = spawnSync(process.execPath, ["scripts/google-client.mjs", `--file=${file}`], { encoding: "utf8", env });
    const missingPath = spawnSync(process.execPath, ["scripts/google-client.mjs", `--file=${file}`, "--config=/no/such/wrangler.toml"], { encoding: "utf8", env });
    const out = `${missingFlag.stdout ?? ""}\n${missingFlag.stderr ?? ""}\n${missingPath.stdout ?? ""}\n${missingPath.stderr ?? ""}`;
    expect(missingFlag.status).not.toBe(0);
    expect(missingFlag.stderr).toContain("pass --config=<path>");
    expect(missingPath.status).not.toBe(0);
    expect(missingPath.stderr).toContain("config_unreadable");
    expect(existsSync(file)).toBe(true);
    expect(existsSync(marker)).toBe(false);
    expect(out).not.toContain(SECRET);
    rmSync(dir, { recursive: true, force: true });
  });
});
