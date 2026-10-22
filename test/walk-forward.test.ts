// The local walk forwards browser requests from 127.0.0.1 to the approve host (tools/walk/forward.ts).
// Page actions must pass the Worker's same-Origin check in walk mode, and a foreign Origin must still fail.
// Numbers: UK Ofcom drama range (+44 7700 900xxx, reserved for fiction). TEST-ONLY.
import { describe, it, expect, beforeEach } from "vitest";
import { harness, type Harness } from "./helpers";
import { walkForward } from "../tools/walk/forward";

const LOCAL = "http://127.0.0.1:8787";
const APPROVE = "approve.example.test";
const SNAP = { generated_at: "2026-10-01T12:00:00Z", contacts: [{ name: "Walk Riley", given: "Riley", numbers: [{ e164: "+447700900101", label: "mobile" }] }] };
let h: Harness;
beforeEach(async () => { h = await harness(); });

const viaWalk = async (path: string, init: RequestInit = {}) =>
  h.relay.fetch(walkForward(new Request(LOCAL + path, init), await h.jwt(), APPROVE));

describe("walk forwarding", () => {
  it("maps the local Origin to the approve host and drops Authorization", async () => {
    const f = walkForward(new Request(LOCAL + "/contacts/prefs", { method: "POST", headers: { Origin: LOCAL, Authorization: "Bearer x" } }), "jwt", APPROVE);
    expect(f.url).toBe(`https://${APPROVE}/contacts/prefs`);
    expect(f.headers.get("Origin")).toBe(`https://${APPROVE}`);
    expect(f.headers.get("Authorization")).toBeNull();
    expect(f.headers.get("Cf-Access-Jwt-Assertion")).toBe("jwt");
  });

  it("a page action (switch a person on) succeeds in walk mode; a foreign Origin is still refused", async () => {
    const up = await viaWalk("/contacts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(SNAP) });
    expect(up.status).toBe(200);
    const html = await (await viaWalk("/contacts")).text();
    const csrf = html.match(/const CSRF="([a-f0-9]{32})"/)?.[1] ?? "";
    const people = ((await (await viaWalk("/contacts/list")).json()) as { people: { key: string; enabled: boolean }[] }).people;
    const key = people[0]?.key ?? "";
    const prefs = (origin: string) => viaWalk("/contacts/prefs", { method: "POST", headers: { "content-type": "application/json", Origin: origin }, body: JSON.stringify({ csrf, changes: [{ key, enabled: true }] }) });
    const bad = await prefs("http://evil.example.test");
    expect(bad.status).toBe(403);
    expect(await bad.json()).toEqual({ error: "bad_origin" });
    const ok = await prefs(LOCAL);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ updated: 1 });
    const after = ((await (await viaWalk("/contacts/list")).json()) as { people: { enabled: boolean }[] }).people;
    expect(after[0]?.enabled).toBe(true);
  });
});
