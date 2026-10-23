import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
// @ts-ignore plain .mjs scripts
import { arrayTables, buildWalkConfig, WALK_VARS } from "../scripts/walk-config.mjs";
// @ts-ignore plain .mjs scripts
import { buildErrors, warmOk, waitUsable, WARM_PATHS, seedContacts, FAKE_CONTACTS } from "../scripts/walk.mjs";

import { walkAllowed } from "../tools/walk/guard";

const main = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
const blocks = (t: string, name: string) => arrayTables(t).filter((b: { name: string }) => b.name === name).map((b: { text: string }) => b.text);

describe("walk config is generated from wrangler.toml", () => {
  const walk = buildWalkConfig(main);
  it("copies every [[rules]] block verbatim (CSS Text, woff2/webp Data)", () => {
    expect(blocks(main, "rules").length).toBeGreaterThan(0);
    expect(blocks(walk, "rules")).toEqual(blocks(main, "rules"));
    expect(walk).toMatch(/"\*\*\/\*\.css", "\*\*\/\*\.svg"/);
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

describe("walk seeds fake contacts", () => {
  it("posts tools/walk/fake-contacts.json to /contacts as JSON and returns the counts", async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const bodyOf = (i: RequestInit | undefined) => (typeof i?.body === "string" ? i.body : "");
    const fetchFn = async (url: string, init?: RequestInit) => { calls.push({ url, init }); return new Response('{"contacts":3,"numbers":4}', { status: 200 }); };
    expect(await seedContacts("http://127.0.0.1:8787", { fetchFn })).toEqual({ contacts: 3, numbers: 4 });
    expect(calls[0]?.url).toBe("http://127.0.0.1:8787/contacts");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(new Headers(calls[0]?.init?.headers).get("content-type")).toBe("application/json");
    expect(JSON.parse(bodyOf(calls[0]?.init))).toEqual(JSON.parse(readFileSync(FAKE_CONTACTS, "utf8")));
  });
  it("is the same body every run (idempotent: the upload replaces the whole list)", async () => {
    const bodies: string[] = [];
    const fetchFn = async (_u: string, init?: RequestInit) => { bodies.push(typeof init?.body === "string" ? init.body : ""); return new Response('{"contacts":3,"numbers":4}'); };
    await seedContacts("http://x", { fetchFn });
    await seedContacts("http://x", { fetchFn });
    expect(bodies[0]).toBe(bodies[1]);
  });
  it("uses fictional numbers only, with at least one the page can switch on", () => {
    const snap = JSON.parse(readFileSync(FAKE_CONTACTS, "utf8")) as { contacts: { numbers: { e164: string }[] }[] };
    const nums = snap.contacts.flatMap((c) => c.numbers.map((n) => n.e164));
    for (const n of nums) expect(n).toMatch(/^(\+447700900\d{3}|\+1\d{3}55501\d\d)$/);
    expect(nums.some((n) => n.startsWith("+447700900"))).toBe(true);
  });
  it("fails loudly when the Worker refuses the list", async () => {
    const fetchFn = async () => new Response('{"error":"contacts_snapshot_invalid_empty"}', { status: 400 });
    await expect(seedContacts("http://x", { fetchFn })).rejects.toThrow(/answered 400/);
  });
});
