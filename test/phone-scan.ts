// Suite-wide guard: no response body, console line or relay log row may contain a phone number.
// Every harness records its responses; this setup file checks them, plus console output and the
// relay's log table, after EVERY test in the worker project. One hit fails that test.
import { afterEach, beforeEach } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import { looksLikePhone } from "../src/direct";

export const scan = { responses: [] as string[], console: [] as string[], stubs: [] as DurableObjectStub[], allow: [] as string[] };

for (const level of ["log", "error", "warn", "info"] as const) {
  const orig = console[level].bind(console);
  console[level] = (...a: unknown[]) => {
    scan.console.push(a.map(String).join(" "));
    orig(...a);
  };
}

/** Strings only: JSON numbers (timestamps like expires_ms) are values, never phone numbers here. */
function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => strings(x, out));
  return out;
}

export function phoneHits(text: string): string[] {
  let parts: string[];
  try {
    parts = strings(JSON.parse(text));
  } catch {
    parts = [text];
  }
  return parts.filter((p) => looksLikePhone(p));
}

beforeEach(() => {
  scan.responses = [];
  scan.console = [];
  scan.stubs = [];
  scan.allow = [];
});

afterEach(async () => {
  const hits: string[] = [];
  for (const r of scan.responses) hits.push(...phoneHits(r).map((x) => `response: ${x.slice(0, 120)}`));
  for (const c of scan.console) if (looksLikePhone(c)) hits.push(`console: ${c.slice(0, 120)}`);
  for (const s of scan.stubs) {
    const rows = await (runInDurableObject as any)(s, async (i: any) => i.ctx.storage.sql.exec("SELECT event, request_id, recipient, sha256, detail FROM log").toArray());
    for (const row of rows) for (const v of Object.values(row)) if (typeof v === "string" && looksLikePhone(v)) hits.push(`log ${row.event}: ${v.slice(0, 120)}`);
  }
  const real = hits.filter((h) => !scan.allow.some((a) => h.includes(a)));
  if (real.length) throw new Error(`phone-number-like output found:\n${real.join("\n")}`);
});
