// v2 Approve, Direct and Log: Access, AES-GCM, retention, redaction, and the default-off flags.
import { beforeEach, describe, expect, it } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import { API, BASE, FRIEND, STRANGER, T0, harness, postRequest, type Harness } from "./helpers";
import { scan } from "./phone-scan";
import type { Relay } from "../src/relay";
import { maskNumber } from "../src/rules";
import { pageCsp, SUPPORT_LABEL, SUPPORT_URL } from "../src/pages";

const ENC = "ab".repeat(32);
const HASH = "TEST-ONLY-log-hash-key-not-a-real-secret";
const BODY = "zzvioletquartz";
const DAY = 86_400_000;
const GATED = [
  ["GET", "/approve"],
  ["GET", "/log"],
  ["GET", "/log?format=json"],
  ["GET", "/messages"],
  ["GET", "/messages?full=1"],
  ["GET", "/messages/" + "ab".repeat(16)],
  ["POST", "/messages"],
  ["POST", "/messages/purge"],
] as const;

let h: Harness;
beforeEach(async () => { h = await harness(); });

function jwtHeaders(extra: Record<string, string> = {}): Promise<Record<string, string>> {
  return h.jwt().then((token) => ({ "Cf-Access-Jwt-Assertion": token, ...extra }));
}

async function codeOf(r: Response): Promise<string> {
  const v: unknown = await r.json();
  if (!v || typeof v !== "object") return "";
  const err = (v as Record<string, unknown>)["error"];
  return typeof err === "string" ? err : "";
}

interface View { id: string; direction: string; number: string; body: string | null }

function views(v: unknown): View[] {
  if (!Array.isArray(v)) throw new Error("messages");
  return v.map((row) => {
    if (!row || typeof row !== "object") throw new Error("row");
    const o = row as Record<string, unknown>;
    const id = o["id"];
    const direction = o["direction"];
    const number = o["number"];
    const body = o["body"];
    if (typeof id !== "string" || typeof direction !== "string" || typeof number !== "string") throw new Error("shape");
    if (body !== null && typeof body !== "string") throw new Error("body");
    return { id, direction, number, body };
  });
}

function tally(relay: Harness["relay"]): Promise<{ messages: number; bodies: number; contacts: number; inn: number; out: number }> {
  return runInDurableObject(relay, (inst: Relay, state: DurableObjectState) => {
    const n = (dir: string): number => {
      const v = state.storage.sql.exec("SELECT COUNT(*) AS c FROM messages WHERE direction=?", dir).one()["c"];
      return typeof v === "number" ? v : -1;
    };
    return { ...inst.storedCounts(), inn: n("in"), out: n("out") };
  });
}

async function inbound(number: string, body: string): Promise<Response> {
  return h.relay.fetch(`${BASE}/messages`, {
    method: "POST",
    headers: { ...(await jwtHeaders()), "content-type": "application/json" },
    body: JSON.stringify({ number, body }),
  });
}

async function send(body: string): Promise<Response> {
  return h.relay.fetch(`${API}/send`, {
    method: "POST",
    headers: { Authorization: "Bearer TEST-ONLY-request-token", "content-type": "application/json" },
    body: JSON.stringify({ to: FRIEND, body }),
  });
}

async function arm(extra: Record<string, string> = {}): Promise<void> {
  await h.setEnv({ LOG_ENC_KEY: ENC, STORE_MESSAGE_BODIES: "1", CAPTURE_INBOUND: "1", DIRECT_SEND: "1", ...extra });
}

describe("Access on the v2 pages and every messages route", () => {
  it("missing Access is 401 and a bearer or a bad JWT stays 403", async () => {
    for (const [method, path] of GATED) {
      const missing = await h.relay.fetch(`${BASE}${path}`, { method });
      expect(missing.status, path).toBe(401);
      expect(await codeOf(missing), path).toBe("forbidden");
      const bearer = await h.relay.fetch(`${BASE}${path}`, { method, headers: { Authorization: "Bearer TEST-ONLY-request-token" } });
      expect(bearer.status, path).toBe(403);
      const bad = await h.relay.fetch(`${BASE}${path}`, { method, headers: { "Cf-Access-Jwt-Assertion": "not.a-jwt" } });
      expect(bad.status, path).toBe(403);
    }
    const empty = await h.relay.fetch(`${BASE}/log?format=json`, { headers: { "Cf-Access-Jwt-Assertion": "" } });
    expect(empty.status).toBe(401);
    const home = await h.relay.fetch(`${BASE}/`, { redirect: "manual" });
    expect(home.status).toBe(401);
  });

  it("the request host 404s these routes, and / on the approve host lands on Contacts", async () => {
    for (const [method, path] of GATED) {
      const r = await h.relay.fetch(`${API}${path}`, { method, headers: await jwtHeaders() });
      expect(r.status, path).toBe(404);
    }
    expect((await h.relay.fetch(`${API}/`, { redirect: "manual" })).status).toBe(404);
    expect((await h.relay.fetch(`${API}/cron`, { method: "POST" })).status).toBe(404);
    const home = await h.relay.fetch(`${BASE}/`, { headers: await jwtHeaders(), redirect: "manual" });
    expect(home.status).toBe(302);
    expect(home.headers.get("location")).toBe("/contacts");
    expect(home.headers.get("cache-control")).toBe("no-store");
  });
});

describe("Approve, Direct and Log pages", () => {
  it("shows full numbers in pieces, separate waiting counts, and the nav", async () => {
    expect((await postRequest(h, { to: FRIEND, text: "dinner at the usual place" })).status).toBe(202);
    await runInDurableObject(h.relay, (_inst: Relay, state: DurableObjectState) => {
      state.storage.sql.exec(
        "INSERT INTO device_jobs(id,created_ms,kind,ref,recipient,text,state) VALUES(?,?,?,?,?,?,?)",
        "job1", T0, "direct", "ref1", FRIEND, "queued hello", "queued",
      );
    });
    const page = await h.relay.fetch(`${BASE}/approve`, { headers: await jwtHeaders() });
    const html = await page.text();
    expect(html).toContain("Waiting on you: 1");
    expect(html).toContain("Waiting on the phone: 1");
    expect(html).toContain("<span>+</span><span>155</span><span>555</span><span>501</span><span>01</span>");
    expect(html).not.toContain(FRIEND);
    expect(html).toContain('data-act=copy');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('<nav class=tabs aria-label="Admin pages"><ul><li><a href="/contacts">');
    expect(html).toContain('<li><a href="/approve" aria-current="page"><svg class=ti aria-hidden=true');
    expect(html).not.toContain("<footer>");
    expect(page.headers.get("cache-control")).toBe("no-store");
    const nonce = /'nonce-([a-f0-9]{32})'/.exec(page.headers.get("content-security-policy") ?? "")?.[1] ?? "";
    expect(page.headers.get("content-security-policy")).toBe(pageCsp(nonce));
  });

  it("empty and error states stay fixed strings", async () => {
    const empty = await (await h.relay.fetch(`${BASE}/approve`, { headers: await jwtHeaders() })).text();
    expect(empty).toContain("No texts waiting.");
    expect(empty).toContain("Waiting on you: 0");
    expect(empty).toContain("Waiting on the phone: 0");
    expect(empty).not.toContain("Couldn't load");
    const bad = await (await h.relay.fetch(`${BASE}/approve?error=load_failed`, { headers: await jwtHeaders() })).text();
    expect(bad).toContain("Couldn't load this page. Reload to try again.");
    const ignored = await (await h.relay.fetch(`${BASE}/approve?text=evil`, { headers: await jwtHeaders() })).text();
    expect(ignored).not.toContain("evil");
    const log = await h.relay.fetch(`${BASE}/log`, { headers: { ...(await jwtHeaders()), accept: "text/html" } });
    const html = await log.text();
    expect(html).toContain("No texts yet.");
    expect(html).toContain('data-act=filter data-dir="in"');
    expect(html).toContain('data-act=filter data-dir="out"');
    const logErr = await (await h.relay.fetch(`${BASE}/log?error=load_failed`, { headers: { ...(await jwtHeaders()), accept: "text/html" } })).text();
    expect(logErr).toContain("Couldn't load this page. Reload to try again.");
  });

  it("Direct keeps its status page inside the same shell", async () => {
    const page = await h.relay.fetch(`${BASE}/direct`, { headers: await jwtHeaders() });
    const html = await page.text();
    expect(html).toContain("<h2>Direct send</h2>");
    expect(html).toContain('href="/direct" aria-current="page"');
    expect(html.match(/<nav class=tabs/g)).toEqual(["<nav class=tabs"]);
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(page.headers.get("content-security-policy")).toContain("object-src 'none'");
    expect(page.headers.get("content-security-policy")).not.toContain("unsafe-inline");
  });

  it("every page has one support link and the CSP is unchanged", async () => {
    const headers = await jwtHeaders();
    const pages = await Promise.all([
      h.relay.fetch(`${BASE}/contacts`, { headers }),
      h.relay.fetch(`${BASE}/approve`, { headers }),
      h.relay.fetch(`${BASE}/direct`, { headers }),
      h.relay.fetch(`${BASE}/log`, { headers: { ...headers, accept: "text/html" } }),
    ]);
    for (const r of pages) {
      expect(r.status).toBe(200);
      const html = await r.text();
      expect(SUPPORT_LABEL).toBe("☕ Buy me a drink");
      expect(html).toContain('<a class=support href="https://dave-barrett.kit.com/products/buy-me-a-drink"');
      expect(html).not.toContain("example.com");
      expect(html).toContain(`<h1 class=product>GrokBot Texting</h1><a class=support href="${SUPPORT_URL}" rel="noopener noreferrer"><span aria-hidden=true>☕</span><span>${SUPPORT_LABEL.slice(SUPPORT_LABEL.indexOf(" ") + 1)}</span></a></header>`);
      expect(html.match(/Buy me a drink/g)).toEqual(["Buy me a drink"]);
      expect(html).not.toContain("img.shields.io");
      expect(html).not.toMatch(/cocoa|coffee|hot chocolate|hot-chocolate/i);
      expect(html).not.toContain("unsafe-inline");
    }
    const approveCsp = pages[1]?.headers.get("content-security-policy") ?? "";
    const nonce = /'nonce-([a-f0-9]{32})'/.exec(approveCsp)?.[1] ?? "";
    expect(approveCsp).toBe(pageCsp(nonce));
    const contactsCsp = pages[0]?.headers.get("content-security-policy") ?? "";
    const contactsNonce = /'nonce-([a-f0-9]{32})'/.exec(contactsCsp)?.[1] ?? "";
    expect(contactsCsp).toBe(`default-src 'self'; script-src 'self' 'nonce-${contactsNonce}'; style-src 'nonce-${contactsNonce}'; frame-ancestors 'none'; form-action 'self' https://accounts.google.com; base-uri 'none'`);
  });

  it("the contacts CSP stays the contacts policy", async () => {
    const r = await h.relay.fetch(`${BASE}/contacts`, { headers: await jwtHeaders() });
    const csp = r.headers.get("content-security-policy") ?? "";
    const nonce = /'nonce-([a-f0-9]{32})'/.exec(csp)?.[1] ?? "";
    expect(csp).toBe(`default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'nonce-${nonce}'; frame-ancestors 'none'; form-action 'self' https://accounts.google.com; base-uri 'none'`);
  });
});

describe("message store", () => {
  it("starts empty, and capture is off until the flag is exactly 1", async () => {
    expect(await tally(h.relay)).toMatchObject({ messages: 0, bodies: 0, contacts: 0 });
    const off = await inbound(STRANGER, BODY);
    expect(off.status).toBe(403);
    expect(await codeOf(off)).toBe("capture_inbound_off");
    expect((await tally(h.relay)).messages).toBe(0);
    await h.setEnv({ CAPTURE_INBOUND: "yes" });
    const garbage = await h.relay.fetch(`${BASE}/approve`, { headers: await jwtHeaders() });
    expect(garbage.status).toBe(503);
    expect(await codeOf(garbage)).toBe("capture_inbound_invalid");
  });

  it("refuses a reused or invalid LOG_ENC_KEY and fails closed when the key is missing", async () => {
    await h.setEnv({ LOG_ENC_KEY: HASH, CAPTURE_INBOUND: "1" });
    const reused = await h.relay.fetch(`${BASE}/direct`, { headers: await jwtHeaders() });
    expect(reused.status).toBe(503);
    expect(await codeOf(reused)).toBe("message_enc_key_reused");
    await h.setEnv({ LOG_ENC_KEY: "not-a-key" });
    const invalid = await h.relay.fetch(`${BASE}/direct`, { headers: await jwtHeaders() });
    expect(invalid.status).toBe(503);
    expect(await codeOf(invalid)).toBe("message_enc_key_invalid");
    await h.setEnv({ LOG_ENC_KEY: "" });
    const missing = await inbound(STRANGER, BODY);
    expect(missing.status).toBe(503);
    expect(await codeOf(missing)).toBe("message_enc_key_missing");
    expect((await tally(h.relay)).messages).toBe(0);
    expect((await tally(h.relay)).contacts).toBe(0);
  });

  it("encrypts the number and the body, masks the export, and does not add a contact", async () => {
    await arm();
    const created = await inbound(STRANGER, BODY);
    expect(created.status).toBe(201);
    const masked = views(await (await h.relay.fetch(`${BASE}/messages`, { headers: await jwtHeaders() })).json());
    expect(masked).toHaveLength(1);
    expect(masked[0]?.number).toBe(maskNumber(STRANGER));
    expect(masked[0]?.body).toBe(BODY);
    expect(masked[0]?.direction).toBe("in");
    const html = await (await h.relay.fetch(`${BASE}/log`, { headers: { ...(await jwtHeaders()), accept: "text/html" } })).text();
    expect(html).toContain("<b class=dir>In</b>");
    expect(html).toContain(BODY);
    expect(html).toContain('data-act=copy-num');
    expect(html).toContain('data-act=copy-body');
    expect(html).not.toContain(STRANGER);
    expect(html).not.toContain(FRIEND);
    const stored = await runInDurableObject(h.relay, (_inst: Relay, state: DurableObjectState) => {
      const row = state.storage.sql.exec("SELECT number_ct, body_ct FROM messages").one();
      const numberCt = row["number_ct"];
      const bodyCt = row["body_ct"];
      return `${typeof numberCt === "string" ? numberCt : ""} ${typeof bodyCt === "string" ? bodyCt : ""}`;
    });
    expect(stored).not.toContain(STRANGER);
    expect(stored).not.toContain(BODY);
    expect(await tally(h.relay)).toMatchObject({ messages: 1, bodies: 1, contacts: 0 });
    const logText = await runInDurableObject(h.relay, (_inst: Relay, state: DurableObjectState) => {
      return state.storage.sql.exec("SELECT event, recipient, detail FROM log").toArray().map((row) => {
        const event = row["event"];
        const recipient = row["recipient"];
        const detail = row["detail"];
        return `${typeof event === "string" ? event : ""} ${typeof recipient === "string" ? recipient : ""} ${typeof detail === "string" ? detail : ""}`;
      }).join("\n");
    });
    expect(logText).not.toContain(BODY);
    expect(logText).not.toContain(STRANGER);
    expect(scan.console.join("\n")).not.toContain(BODY);
  });

  it("?full=1 returns the number and the copy endpoint does too", async () => {
    scan.allow.push(STRANGER);
    await arm();
    const created: unknown = await (await inbound(STRANGER, BODY)).json();
    const idVal = created && typeof created === "object" ? (created as Record<string, unknown>)["id"] : "";
    if (typeof idVal !== "string" || idVal === "") throw new Error("id");
    const id = idVal;
    const full = views(await (await h.relay.fetch(`${BASE}/log?format=json&full=1`, { headers: await jwtHeaders() })).json());
    expect(full[0]?.number).toBe(STRANGER);
    expect(full[0]?.body).toBe(BODY);
    const one: unknown = await (await h.relay.fetch(`${BASE}/messages/${id}`, { headers: await jwtHeaders() })).json();
    expect(one).toEqual({ number: STRANGER, body: BODY });
    expect((await h.relay.fetch(`${BASE}/log?format=json&full=1`)).status).toBe(401);
  });

  it("leaves the body out when STORE_MESSAGE_BODIES is off, even with a key", async () => {
    await h.setEnv({ LOG_ENC_KEY: ENC, STORE_MESSAGE_BODIES: "0", DIRECT_SEND: "1" });
    expect((await send(BODY)).status).toBe(200);
    const masked = views(await (await h.relay.fetch(`${BASE}/messages`, { headers: await jwtHeaders() })).json());
    expect(masked[0]?.number).toBe(maskNumber(FRIEND));
    expect(masked[0]?.body).toBeNull();
    expect(await tally(h.relay)).toMatchObject({ messages: 1, bodies: 0 });
    await h.setEnv({ STORE_MESSAGE_BODIES: "maybe" });
    expect((await h.relay.fetch(`${BASE}/direct`, { headers: await jwtHeaders() })).status).toBe(503);
  });

  it("a store failure logs a code and not the body", async () => {
    await h.setEnv({ DIRECT_SEND: "1" });
    await runInDurableObject(h.relay, (_inst: Relay, state: DurableObjectState) => {
      state.storage.sql.exec("DROP TABLE messages");
      state.storage.sql.exec(`CREATE TABLE messages(
        id TEXT PRIMARY KEY, created_ms INTEGER NOT NULL,
        direction TEXT NOT NULL CHECK (direction IN ('nope')),
        number_ct TEXT, number_iv TEXT, body_ct TEXT, body_iv TEXT, last4 TEXT NOT NULL)`);
    });
    const r = await send(BODY);
    expect(r.status).toBe(200);
    expect(await r.text()).not.toContain(BODY);
    expect(scan.console.join("\n")).toContain("MESSAGE_STORE_FAILED");
    expect(scan.console.join("\n")).not.toContain(BODY);
  });

  it("purge-all deletes every row and anything else is refused", async () => {
    await arm();
    expect((await inbound(STRANGER, BODY)).status).toBe(201);
    const no = await h.relay.fetch(`${BASE}/messages/purge`, {
      method: "POST",
      headers: { ...(await jwtHeaders()), "content-type": "application/json" },
      body: JSON.stringify({ confirm: "no" }),
    });
    expect(no.status).toBe(409);
    expect(await codeOf(no)).toBe("purge_confirm_required");
    expect((await tally(h.relay)).messages).toBe(1);
    const cross = await h.relay.fetch(`${BASE}/messages/purge`, {
      method: "POST",
      headers: { ...(await jwtHeaders()), "content-type": "application/json", Origin: "https://evil.example" },
      body: JSON.stringify({ confirm: "purge-all" }),
    });
    expect(cross.status).toBe(403);
    expect((await tally(h.relay)).messages).toBe(1);
    const yes = await h.relay.fetch(`${BASE}/messages/purge`, {
      method: "POST",
      headers: { ...(await jwtHeaders()), "content-type": "application/json" },
      body: JSON.stringify({ confirm: "purge-all" }),
    });
    expect(yes.status).toBe(200);
    expect(yes.headers.get("cache-control")).toBe("no-store");
    expect((await tally(h.relay)).messages).toBe(0);
  });

  it("deletes inbound after 30 days and outbound after 90, only from the internal cron", async () => {
    await arm();
    h.setNow(T0);
    expect((await inbound(STRANGER, BODY)).status).toBe(201);
    expect((await send(BODY)).status).toBe(200);
    expect(await tally(h.relay)).toMatchObject({ inn: 1, out: 1 });
    h.setNow(T0 + 30 * DAY);
    expect((await h.relay.fetch("https://internal/cron", { method: "POST" })).status).toBe(200);
    expect(await tally(h.relay)).toMatchObject({ inn: 1, out: 1 });
    h.setNow(T0 + 30 * DAY + 1);
    expect((await h.relay.fetch(`${BASE}/cron`, { method: "POST" })).status).toBe(404);
    expect((await h.relay.fetch(`${API}/cron`, { method: "POST" })).status).toBe(404);
    expect((await tally(h.relay)).inn).toBe(1);
    expect((await h.relay.fetch("https://internal/cron", { method: "POST" })).status).toBe(200);
    expect(await tally(h.relay)).toMatchObject({ inn: 0, out: 1 });
    h.setNow(T0 + 90 * DAY);
    await h.relay.fetch("https://internal/cron", { method: "POST" });
    expect((await tally(h.relay)).out).toBe(1);
    h.setNow(T0 + 90 * DAY + 1);
    await h.relay.fetch("https://internal/cron", { method: "POST" });
    expect(await tally(h.relay)).toMatchObject({ inn: 0, out: 0 });
  });

  it("the internal cron still purges when the relay is disabled", async () => {
    await arm();
    h.setNow(T0);
    expect((await inbound(STRANGER, BODY)).status).toBe(201);
    await h.setEnv({ DISABLED: "1" });
    h.setNow(T0 + 30 * DAY + 1);
    const cron = await h.relay.fetch("https://internal/cron", { method: "POST" });
    expect(cron.status).toBe(200);
    expect((await tally(h.relay)).messages).toBe(0);
    expect((await h.relay.fetch(`${BASE}/approve`, { headers: await jwtHeaders() })).status).toBe(503);
  });
});
