#!/usr/bin/env node
// Read the OAuth client JSON downloaded from Google Cloud Console and store the id and the secret as
// Worker secrets. The JSON is deleted only after both puts succeed. A failed put keeps the file, names
// the secret, and says how to retry. The secret is written only to wrangler's stdin. It is never
// printed, including when wrangler fails (its own output is discarded, because it may echo the value).
import { readFileSync, unlinkSync } from "node:fs";
import { spawn } from "node:child_process";
import { mainKind } from "./is-main.mjs";

const ID_RE = /^[A-Za-z0-9-]{1,120}\.apps\.googleusercontent\.com$/;
const SECRET_RE = /^[\x21-\x7e]{10,200}$/;

/**
 * @param {string} text
 * @returns {{ id: string, secret: string }}
 */
export function parseClientJson(text) {
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("client_json_invalid");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("client_json_invalid");
  const root = /** @type {Record<string, unknown>} */ (parsed);
  const web = root["web"];
  if (web === null || typeof web !== "object" || Array.isArray(web)) throw new Error("client_json_invalid");
  const w = /** @type {Record<string, unknown>} */ (web);
  const id = w["client_id"];
  const secret = w["client_secret"];
  if (typeof id !== "string" || !ID_RE.test(id)) throw new Error("client_id_invalid");
  if (typeof secret !== "string" || !SECRET_RE.test(secret)) throw new Error("client_secret_invalid");
  return { id, secret };
}

/** `--file=<path>` as one argv element. A split `--file path` is refused. */
/** @param {readonly string[]} argv */
export function fileArg(argv) {
  if (argv.includes("--file")) throw new Error("pass --file=<path> as one argument");
  const file = argv.find((s) => s.startsWith("--file="));
  if (!file || file.length <= "--file=".length) throw new Error("pass --file=<path>");
  return file.slice("--file=".length);
}

/**
 * @typedef {{
 *   stdout: { on: (event: string, listener: (chunk: unknown) => void) => void } | null,
 *   stderr: { on: (event: string, listener: (chunk: unknown) => void) => void } | null,
 *   stdin: { end: (chunk: string) => void } | null,
 *   on: (event: string, listener: (arg: unknown) => void) => void,
 * }} PutProc
 * @typedef {(cmd: string, args: string[], opts: { stdio: ["pipe", "pipe", "pipe"] }) => PutProc} SpawnFn
 */

/**
 * Names the secret that failed and how to retry. The value is not part of this string.
 * @param {string} name
 */
function putFailed(name) {
  return new Error(`wrangler secret put ${name} failed. The client JSON was kept. Retry: node scripts/google-client.mjs --file=<path>`);
}

/**
 * @param {string} name
 * @param {string} value
 * @param {SpawnFn} spawnFn
 */
function putSecret(name, value, spawnFn) {
  return new Promise((resolve, reject) => {
    const child = spawnFn("npx", ["wrangler", "secret", "put", name, "--config=.relay-local/wrangler.toml"], { stdio: ["pipe", "pipe", "pipe"] });
    let settled = false;
    /** @param {Error | null} err */
    const done = (err) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(undefined);
    };
    // Discard wrangler's streams. They are not logged: a secret put can echo the value it was given.
    child.stdout?.on("data", () => {});
    child.stderr?.on("data", () => {});
    child.on("error", (err) => done(err instanceof Error ? err : putFailed(name)));
    child.on("close", (code) => done(code === 0 ? null : putFailed(name)));
    if (!child.stdin) {
      done(putFailed(name));
      return;
    }
    child.stdin.end(value);
  });
}

/**
 * Puts both secrets, then deletes the JSON. A failed put leaves the file in place and rejects
 * with the secret's name and the retry command. The value is never logged.
 * @param {{ text: string, unlink: () => void, log: (line: string) => void, spawn: SpawnFn }} o
 */
export async function installClientJson(o) {
  const { id, secret } = parseClientJson(o.text);
  let ok = false;
  try {
    await putSecret("GOOGLE_CLIENT_ID", id, o.spawn);
    o.log("GOOGLE_CLIENT_ID set");
    await putSecret("GOOGLE_CLIENT_SECRET", secret, o.spawn);
    o.log("GOOGLE_CLIENT_SECRET set");
    ok = true;
  } finally {
    if (ok) o.unlink();
  }
}

async function main() {
  const path = fileArg(process.argv.slice(2));
  const text = readFileSync(path, "utf8");
  await installClientJson({
    text,
    unlink: () => { unlinkSync(path); },
    spawn,
    log: (line) => { console.log(line); },
  });
}

if (mainKind(import.meta.url) === "main") main().catch((e) => {
  const msg = e instanceof Error ? e.message : "google_client_failed";
  console.error(msg);
  process.exit(1);
});
