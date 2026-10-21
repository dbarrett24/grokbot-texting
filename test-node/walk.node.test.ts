import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
// @ts-ignore plain .mjs scripts
import { arrayTables, buildWalkConfig, WALK_VARS } from "../scripts/walk-config.mjs";
// @ts-ignore plain .mjs scripts
import { buildErrors, warmOk, waitUsable, WARM_PATHS } from "../scripts/walk.mjs";

import { walkAllowed } from "../tools/walk/guard";

const main = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
const blocks = (t: string, name: string) => arrayTables(t).filter((b: { name: string }) => b.name === name).map((b: { text: string }) => b.text);

describe("walk config is generated from wrangler.toml", () => {
  const walk = buildWalkConfig(main);
  it("copies every [[rules]] block verbatim (CSS Text, woff2/webp Data)", () => {
    expect(blocks(main, "rules").length).toBeGreaterThan(0);
    expect(blocks(walk, "rules")).toEqual(blocks(main, "rules"));
    expect(walk).toMatch(/"\*\*\/\*\.css"/);
    expect(walk).toMatch(/"\*\*\/\*\.woff2", "\*\*\/\*\.webp"/);
  });
  it("copies the Durable Object binding, migrations and compatibility_date", () => {
    for (const n of ["durable_objects.bindings", "migrations"]) expect(blocks(walk, n)).toEqual(blocks(main, n));
    expect(walk).toContain(String(main.match(/^compatibility_date = "[^"]+"/m)?.[0]));
  });
  it("refuses a wrangler.toml with no rules instead of writing a config that fails to build", () => {
    const noRules = main.replace(/\[\[rules\]\][\s\S]*?(?=\[\[durable_objects)/, "");
    expect(() => buildWalkConfig(noRules)).toThrow(/no \[\[rules\]\]/);
  });
  it("uses only fake local values and the guarded walk entry", () => {
    expect(walk).toContain('main = "tools/walk/entry.ts"');
    expect(WALK_VARS.ACCESS_TEAM_DOMAIN).toMatch(/\.invalid$/);
    for (const v of Object.values(WALK_VARS) as string[]) expect(v).not.toMatch(/REPLACE_WITH/);
  });
});

describe("walk ready check", () => {
  it("counts build errors, including wrangler's summary line", () => {
    expect(buildErrors("\x1b[31m✘ [ERROR] Build failed with 20 errors:")).toBe(20);
    expect(buildErrors("[wrangler:info] Ready on http://127.0.0.1:8787")).toBe(0);
  });
  it("needs html for /contacts and the right asset types", () => {
    expect(warmOk("/contacts", 200, "text/html; charset=utf-8")).toBe(true);
    expect(warmOk("/contacts", 200, "application/json")).toBe(false);
    expect(warmOk("/contacts", 500, "text/html")).toBe(false);
    expect(warmOk("/harbor/x.woff2", 200, "font/woff2")).toBe(true);
    expect(warmOk("/harbor/x.webp", 200, "text/plain")).toBe(false);
  });
  const types: Record<string, string> = { "/contacts": "text/html", ".woff2": "font/woff2", ".webp": "image/webp" };
  const ok = (url: string) => new Response("x", { status: 200, headers: { "content-type": Object.entries(types).find(([k]) => url.endsWith(k))?.[1] ?? "" } });
  it("retries connection refusals until every warm path is usable", async () => {
    let calls = 0;
    const fetchFn = async (url: string) => { if (++calls < 3) throw new Error("ECONNREFUSED"); return ok(url); };
    await waitUsable("http://127.0.0.1:1", { fetchFn, sleep: async () => {} });
    expect(calls).toBe(2 + WARM_PATHS.length);
  });
  it("stops at once when the build failed, even if the port answers", async () => {
    await expect(waitUsable("http://x", { fetchFn: async (u: string) => ok(u), failed: () => 20 })).rejects.toThrow(/20 error/);
  });
  it("fails on a real error status and on timeout", async () => {
    await expect(waitUsable("http://x", { fetchFn: async () => new Response("", { status: 403 }), sleep: async () => {} })).rejects.toThrow(/answered 403/);
    let t = 0;
    await expect(waitUsable("http://x", { fetchFn: async () => { throw new Error("refused"); }, timeoutMs: 50, now: () => (t += 20), sleep: async () => {} })).rejects.toThrow(/not usable/);
  });
});

describe("walk entry guard", () => {
  it("runs only with WALK_LOCAL=1 and a .invalid Access team domain", () => {
    expect(walkAllowed({ WALK_LOCAL: "1", ACCESS_TEAM_DOMAIN: "https://walk-team.invalid" })).toBe(true);
    expect(walkAllowed({ WALK_LOCAL: "0", ACCESS_TEAM_DOMAIN: "https://walk-team.invalid" })).toBe(false);
    expect(walkAllowed({ ACCESS_TEAM_DOMAIN: "https://walk-team.invalid" })).toBe(false);
    expect(walkAllowed({ WALK_LOCAL: "1", ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com" })).toBe(false);
    expect(walkAllowed({ WALK_LOCAL: "1", ACCESS_TEAM_DOMAIN: "https://x.invalid.example.com" })).toBe(false);
  });
});
