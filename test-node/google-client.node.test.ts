// scripts/google-client.mjs: the downloaded console JSON becomes two Worker secrets on stdin, then the file is deleted.
// The secret string must not appear in anything the script prints, including when wrangler fails or echoes it.
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error plain .mjs script, no types
import { parseClientJson, fileArg, installClientJson } from "../scripts/google-client.mjs";

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

describe("installClientJson", () => {
  it("pipes each value to wrangler stdin, logs only fixed lines, and deletes the JSON", async () => {
    const { spawn, puts } = fakeSpawn({ echo: true });
    const logs: string[] = [];
    let unlinked = false;
    await installClientJson({ text: json, unlink: () => { unlinked = true; }, log: (l: string) => logs.push(l), spawn });
    expect(puts.map((p) => p.args)).toEqual([
      ["wrangler", "secret", "put", "GOOGLE_CLIENT_ID", "--config=.relay-local/wrangler.toml"],
      ["wrangler", "secret", "put", "GOOGLE_CLIENT_SECRET", "--config=.relay-local/wrangler.toml"],
    ]);
    expect(puts[0]?.value).toBe(ID);
    expect(puts[1]?.value).toBe(SECRET);
    expect(logs).toEqual(["GOOGLE_CLIENT_ID set", "GOOGLE_CLIENT_SECRET set"]);
    expect(logs.join("\n")).not.toContain(SECRET);
    expect(unlinked).toBe(true);
  });

  it("a failed put keeps the JSON, names the secret and the retry, and never includes the secret", async () => {
    const { spawn } = fakeSpawn({ code: 1, echo: true });
    const logs: string[] = [];
    let unlinked = false;
    await expect(installClientJson({ text: json, unlink: () => { unlinked = true; }, log: (l: string) => logs.push(l), spawn })).rejects.toThrow(
      /^wrangler secret put GOOGLE_CLIENT_ID failed\. The client JSON was kept\. Retry: node scripts\/google-client\.mjs --file=<path>$/,
    );
    expect(logs.join("\n")).not.toContain(SECRET);
    expect(unlinked).toBe(false);
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
    await expect(installClientJson({ text: json, unlink: () => { unlinked = true; }, log: () => {}, spawn })).rejects.toThrow(/wrangler secret put GOOGLE_CLIENT_SECRET failed/);
    expect(unlinked).toBe(false);
  });

  it("bad JSON is kept and the thrown message is a code, not the file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gclient-"));
    const path = join(dir, "client.json");
    writeFileSync(path, `{"web":{"client_secret":"${SECRET}"}}`);
    let gone = false;
    await expect(installClientJson({
      text: `not json ${SECRET}`,
      unlink: () => { gone = true; },
      log: () => {},
      spawn: () => { throw new Error("spawn should not run"); },
    })).rejects.toThrow(/^client_json_invalid$/);
    expect(gone).toBe(false);
    expect(existsSync(path)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("the CLI exits non-zero, keeps the JSON, and never prints the secret when wrangler fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "gclient-cli-"));
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const npx = join(bin, "npx");
    writeFileSync(npx, `#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' ${JSON.stringify(SECRET)}\nexit 1\n`);
    chmodSync(npx, 0o755);
    const file = join(dir, "client.json");
    writeFileSync(file, json);
    const r = spawnSync(process.execPath, ["scripts/google-client.mjs", `--file=${file}`], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
    });
    const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
    expect(r.status).not.toBe(0);
    expect(existsSync(file)).toBe(true);
    expect(out).not.toContain(SECRET);
    expect(r.stderr).toContain("GOOGLE_CLIENT_ID");
    expect(r.stderr).toContain("node scripts/google-client.mjs --file=<path>");
    rmSync(dir, { recursive: true, force: true });
  });
});
