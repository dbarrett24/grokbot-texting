#!/usr/bin/env node
// npm run walk: one command for the local contacts walk.
// 1. writes walk.local.toml from wrangler.toml (scripts/walk-config.mjs), so the [[rules]] can't drift;
// 2. starts `wrangler dev --local` on 127.0.0.1 (not "localhost", which may resolve to ::1 first) with a fresh persist dir;
// 3. fails fast if the build reports errors (wrangler can print "Ready" and then fail the build);
// 4. waits until GET /contacts is 200 AND a harbor asset is served, which also warms the first request;
// 5. only then prints the URL. Ctrl-C stops wrangler.
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isMain } from "./is-main.mjs";
import { writeWalkConfig, WALK_CONFIG } from "./walk-config.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const WARM_PATHS = ["/contacts", "/harbor/source-serif-4-latin-600.woff2", "/harbor/leaves/corners-1024.webp"];

/** Does a chunk of wrangler output report a failed build? Returns the error count (0 = none). */
const ANSI = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g");
/** @param {unknown} text */
export function buildErrors(text) {
  const plain = String(text).replace(ANSI, "");
  const m = plain.match(/Build failed with (\d+) error/);
  if (m) return Number(m[1]);
  return (plain.match(/\[ERROR\]/g) || []).length;
}

/** Is a warm-up response good enough to call the page usable? */
/** @param {string} path @param {number} status @param {string | null | undefined} contentType */
export function warmOk(path, status, contentType) {
  if (status !== 200) return false;
  if (path === "/contacts") return /text\/html/.test(contentType || "");
  if (path.endsWith(".woff2")) return /font\/woff2/.test(contentType || "");
  if (path.endsWith(".webp")) return /image\/webp/.test(contentType || "");
  return true;
}

/** Poll every path until warmOk, or throw after timeoutMs. fetchFn is injectable for tests. */
/**
 * @param {string} base
 * @param {{ fetchFn?: (url: string, init?: RequestInit) => Promise<Response>, timeoutMs?: number, intervalMs?: number, failed?: () => number, now?: () => number, sleep?: (ms: number) => Promise<unknown> }} [opts]
 */
export async function waitUsable(base, { fetchFn = fetch, timeoutMs = 60000, intervalMs = 100, failed = () => 0, now = Date.now, sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const start = now();
  for (const path of WARM_PATHS) {
    for (;;) {
      const errs = failed();
      if (errs) throw new Error(`build failed with ${errs} error(s); see output above`);
      try {
        const r = await fetchFn(base + path, { signal: AbortSignal.timeout(Math.max(1000, timeoutMs)) });
        await r.arrayBuffer();
        if (warmOk(path, r.status, r.headers.get("content-type"))) break;
        if (r.status >= 400 && r.status !== 404 && r.status !== 503) throw new Error(`${path} answered ${r.status}`);
      } catch (e) {
        if (e instanceof Error && /answered/.test(e.message)) throw e;
      }
      if (now() - start > timeoutMs) throw new Error(`${path} not usable after ${timeoutMs} ms`);
      await sleep(intervalMs);
    }
  }
  return now() - start;
}

async function main() {
  const port = Number(process.env.WALK_PORT || 8787);
  const base = `http://127.0.0.1:${port}`;
  const t0 = Date.now();
  writeWalkConfig(ROOT);
  const persist = join(ROOT, `.walk-state-${Date.now()}`);
  const bin = join(ROOT, "node_modules", ".bin", "wrangler");
  const child = spawn(bin, ["dev", `--config=${WALK_CONFIG}`, `--port=${port}`, "--ip=127.0.0.1", `--persist-to=${persist}`, "--show-interactive-dev-session=false", "--local"], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
  let errs = 0;
  const watch = (/** @type {NodeJS.WriteStream} */ s) => (/** @type {Buffer} */ d) => { s.write(d); errs += buildErrors(d); };
  child.stdout.on("data", watch(process.stdout));
  child.stderr.on("data", watch(process.stderr));
  const stop = () => { child.kill("SIGINT"); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  child.on("exit", (/** @type {number | null} */ code) => process.exit(code ?? 1));
  try {
    await waitUsable(base, { failed: () => errs, timeoutMs: Number(process.env.WALK_TIMEOUT_MS || 90000) });
  } catch (e) {
    console.error(`\nwalk: NOT usable: ${e instanceof Error ? e.message : String(e)}`);
    stop();
    process.exitCode = 1;
    return;
  }
  console.log(`\nwalk: ready in ${Date.now() - t0} ms -> ${base}/contacts  (fake local data; Ctrl-C to stop)`);
}

if (isMain(import.meta.url)) void main();
