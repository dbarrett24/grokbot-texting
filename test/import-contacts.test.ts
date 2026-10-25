// Drag-in import (POST /import-contacts) and allowlist proposals (one tap on /approve/import/<id>), plus the
// one-person add request (POST /allowlist-request). Numbers: UK +44 7700 900xxx (fiction range) for people who
// may be switched on, 555-01xx for the example-number guard. All TEST-ONLY.
import { describe, it, expect, beforeEach } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import { harness, API, BASE, type Harness } from "./helpers";
import type { Relay } from "../src/relay";
import appleV3 from "./fixtures/apple-contacts-v3.vcf?raw";
import appleV4 from "./fixtures/apple-contacts-v4.vcf?raw";
import outlookCsv from "./fixtures/outlook-contacts.csv?raw";
import { isLabel } from "../src/google";
import { contactsFromCsv, contactsFromVcf, parseCsv, parseImport, parseImportBody, proposeDiff, PROPOSAL_TTL_MS, type ImportStats } from "../src/import";

const RILEY = "+447700900142", SAM = "+447700900151", ALEX = "+447700900161", JO = "+447700900171";
const st = (): ImportStats => ({ droppedType: 0, invalid: 0, duplicates: 0 });
let h: Harness;
let now = Date.parse("2026-10-20T12:00:00Z");
const bot = (path: string, body: unknown) =>
  h.relay.fetch(`${API}${path}`, { method: "POST", headers: { Authorization: "Bearer TEST-ONLY-request-token", "content-type": "application/json" }, body: JSON.stringify(body) });
const imp = async (filename: string, content: string, allowlist?: string) => bot("/import-contacts", { filename, content, ...(allowlist ? { allowlist } : {}) });
const send = (to: string) => bot("/send", { to, body: "x" });
const sendable = async (to: string) => (await send(to)).status === 200;
async function people(): Promise<{ name: string; enabled: boolean; key: string; source: string }[]> {
  const r = await h.relay.fetch(`${BASE}/contacts/list`, { headers: { "Cf-Access-Jwt-Assertion": await h.jwt() } });
  return ((await r.json()) as { people: { name: string; enabled: boolean; key: string; source: string }[] }).people;
}
async function proposalPage(id: string) {
  const r = await h.relay.fetch(`${BASE}/approve/import/${id}`, { headers: { "Cf-Access-Jwt-Assertion": await h.jwt() } });
  const html = await r.text();
  return { r, html, csrf: html.match(/name=csrf value="([a-f0-9]{32})"/)?.[1] ?? "" };
}
async function decide(id: string, action: string, csrf?: string) {
  const c = csrf ?? (await proposalPage(id)).csrf;
  return h.relay.fetch(`${BASE}/approve/import/${id}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "Cf-Access-Jwt-Assertion": await h.jwt(), Origin: BASE },
    body: new URLSearchParams({ csrf: c, action }).toString(),
  });
}
const sql = (q: string, ...a: unknown[]) =>
  runInDurableObject(h.relay, (_i: Relay, state: DurableObjectState) => state.storage.sql.exec(q, ...a).toArray());
const noFullNumbers = (s: string) => { for (const n of [RILEY, SAM, ALEX, JO, "7700900"]) expect(s).not.toContain(n); };

const VCF = "\uFEFFBEGIN:VCARD\r\nVERSION:3.0\r\nFN:Riley\r\n  Moore\r\nN:Moore;Riley;;;\r\nTEL;TYPE=CELL;TYPE=PREF:+44 7700 900142\r\nTEL;TYPE=\"work,voice\":+44 7700\r\n 900151\r\nTEL;TYPE=FAX:+44 7700 900199\r\nEND:VCARD\r\nBEGIN:VCARD\r\nVERSION:2.1\r\nN:Ray;Alex\r\nTEL;CELL:+447700900161\r\nitem1.TEL:tel:+447700900142\r\nEND:VCARD\r\n";

beforeEach(async () => {
  h = await harness();
  now = Date.parse("2026-10-20T12:00:00Z");
  h.setNow(now);
  await h.setEnv({ DIRECT_SEND: "1", DIRECT_LOOKUP_MAX_PER_HOUR: "off" });
});

describe("parsing", () => {
  it("vCard: BOM, folded lines, multiple TELs, quoted TYPE, 2.1 bare type, tel: URI, fax dropped, dedupe across cards", () => {
    const s = st();
    const c = contactsFromVcf(VCF, s, "+1");
    expect(c[0]).toEqual({ name: "Riley Moore", given: "Riley", numbers: [{ e164: RILEY, label: "mobile" }, { e164: SAM, label: "work" }] });
    expect(c[1]?.name).toBe("Alex Ray");
    expect(s.droppedType).toBe(1);
    const all = parseImport({ format: "vcard", content: VCF }, "+1");
    expect(all.numbers).toBe(3);
    expect(all.stats.duplicates).toBe(1);
  });
  it("CSV: BOM, quoted commas and quotes, Google ':::' cells, Outlook columns, headerless name,phone, default country code", () => {
    expect(parseCsv('\uFEFFa,"b, c","say ""hi"""\r\n\r\nd,e,f')).toEqual([["a", "b, c", 'say "hi"'], ["d", "e", "f"]]);
    const g = contactsFromCsv('Name,Given Name,Phone 1 - Type,Phone 1 - Value\n"Moore, Riley",Riley,* Mobile,+44 7700 900142 ::: +44 7700 900151\n', st(), "+1");
    expect(g[0]?.name).toBe("Moore, Riley");
    expect(g[0]?.numbers.map((n) => n.e164)).toEqual([RILEY, SAM]);
    const s = st();
    const o = contactsFromCsv("First Name,Last Name,Mobile Phone,Business Phone,Business Fax\nAlex,Ray,+447700900161,+447700900171,+447700900199\n", s, "+1");
    expect(o[0]).toEqual({ name: "Alex Ray", given: "Alex", numbers: [{ e164: ALEX, label: "mobile" }, { e164: JO, label: "work" }] });
    expect(s.droppedType).toBe(0); // a "... Fax" column is not a phone column at all
    const plain = contactsFromCsv("Jo Bloggs,(202) 555-0143\nnot,a phone\n", st(), "+1");
    expect(plain).toEqual([{ name: "Jo Bloggs", numbers: [{ e164: "+12025550143", label: "unlabeled" }] }]);
  });
  it("real Apple Contacts 3.0 export: item1.TEL + X-ABLabel (built-in and custom), fax label dropped, PHOTO base64 skipped", () => {
    const s = st();
    const c = contactsFromVcf(appleV3, s, "+1");
    expect(c).toEqual([
      { name: "Pat Sample", given: "Pat", numbers: [
        { e164: "+12025550101", label: "mobile" }, { e164: "+12025550102", label: "work" }, { e164: "+12025550103", label: "boat" },
      ] },
      { name: "Robin Example", given: "Robin", numbers: [{ e164: "+12025550105", label: "mobile" }, { e164: "+12025550101", label: "main" }] },
    ]);
    expect(s).toMatchObject({ droppedType: 1, invalid: 0 });
    expect(parseImport({ format: "vcard", content: appleV3 }, "+1")).toMatchObject({ numbers: 4, stats: { duplicates: 1 } });
  });
  it("real Apple Contacts 4.0 export: tel: URIs with VALUE/PREF/ext, quoted TYPE, grouped X-ABLabel, data: PHOTO skipped", () => {
    const s = st();
    expect(contactsFromVcf(appleV4, s, "+1")).toEqual([{ name: "Casey Placeholder", given: "Casey", numbers: [
      { e164: "+12025550106", label: "mobile" }, { e164: "+12025550107", label: "home" }, { e164: "+12025550108", label: "work" },
    ] }]);
    expect(s).toMatchObject({ droppedType: 0, invalid: 0 });
  });
  it("real Outlook CSV export (full header set): Mobile, Business and Home Phone; fax/pager columns ignored; quoted commas", () => {
    const r = parseImport({ format: "csv", content: outlookCsv }, "+1");
    expect(r.contacts).toEqual([
      { name: "Jordan Sample", given: "Jordan", numbers: [
        { e164: "+12025550113", label: "home" }, { e164: "+12025550112", label: "work" }, { e164: "+12025550111", label: "mobile" },
      ] },
      { name: "Taylor Example", given: "Taylor", numbers: [{ e164: "+12025550115", label: "home" }] },
    ]);
    expect(r).toMatchObject({ numbers: 4, stats: { duplicates: 1, invalid: 0 } });
  });
  it("IMPORT is a reserved source name (no Google account label may take it)", () => {
    expect(isLabel("IMPORT")).toBe(false);
    expect(isLabel("WORK")).toBe(true);
  });
  it("body checks and diff rules", () => {
    expect(() => parseImportBody({ filename: "x.txt", content: "hi" })).toThrow();
    expect(() => parseImportBody({ filename: "x.csv", content: "a", extra: 1 })).toThrow();
    expect(parseImportBody({ filename: "x", content: "BEGIN:VCARD\n" }).format).toBe("vcard");
    expect(proposeDiff("add", ["a", "b", "c"], new Set(["a"]), new Set(["c"]))).toEqual({ adds: ["b"], removes: [] });
    expect(proposeDiff("replace", ["a"], new Set(["a", "z"]), new Set())).toEqual({ adds: [], removes: ["z"] });
    expect(proposeDiff("none", ["a"], new Set(), new Set())).toEqual({ adds: [], removes: [] });
  });
});

describe("import → address book, allowlist only after confirmation", () => {
  it("adds to the address book OFF, dedupes, files a proposal; nothing sendable until approved", async () => {
    const r = await imp("contacts.vcf", VCF);
    expect(r.status).toBe(200);
    const text = await r.text();
    noFullNumbers(text);
    const j = JSON.parse(text) as { imported: { numbers: number; added: number; duplicates: number }; proposal: { id: string; adds: number; approve_url: string } };
    expect(j.imported).toMatchObject({ numbers: 3, added: 3, duplicates: 1 });
    expect(j.proposal.adds).toBe(3); // one switch per number
    expect(j.proposal.approve_url).toContain(`/approve/import/${j.proposal.id}`);
    const ps = (await people()).filter((p) => p.source === "IMPORT");
    expect([...new Set(ps.map((p) => p.name))].sort()).toEqual(["Alex Ray", "Riley Moore"]);
    expect(ps).toHaveLength(3);
    expect(ps.every((p) => !p.enabled)).toBe(true);
    expect(await sendable(RILEY)).toBe(false);
    // re-import is a no-op for the book; a second pending proposal is still only a proposal
    const again = (await (await imp("contacts.vcf", VCF)).json()) as { imported: { added: number; already_known: number } };
    expect(again.imported).toMatchObject({ added: 0, already_known: 3 });
    const page = await proposalPage(j.proposal.id);
    expect(page.r.status).toBe(200);
    expect(page.html).toContain("Approve these 3");
    expect(page.html).toContain("ends 0142");
    noFullNumbers(page.html);
    expect(await sendable(RILEY)).toBe(false);
    const ok = await decide(j.proposal.id, "approve");
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ state: "approved", enabled: 3 });
    expect(await sendable(RILEY)).toBe(true);
    expect(await sendable(SAM)).toBe(true);
    expect(await sendable(ALEX)).toBe(true);
    expect((await decide(j.proposal.id, "approve", page.csrf)).status).toBe(409);
  });
  it("deny and expiry change nothing; bad csrf refused; replace proposes removals", async () => {
    const a = (await (await imp("c.csv", `Name,Mobile\nAlex Ray,${ALEX}\nJo Lin,${JO}\n`)).json()) as { proposal: { id: string } };
    expect((await decide(a.proposal.id, "approve", "0".repeat(32))).status).toBe(403);
    expect((await decide(a.proposal.id, "deny")).status).toBe(200);
    expect(await sendable(ALEX)).toBe(false);
    const b = (await (await imp("c.csv", `Name,Mobile\nAlex Ray,${ALEX}\nJo Lin,${JO}\n`)).json()) as { proposal: { id: string } };
    const { csrf } = await proposalPage(b.proposal.id);
    h.setNow(now + PROPOSAL_TTL_MS + 1);
    expect((await decide(b.proposal.id, "approve", csrf)).status).toBe(410);
    expect(await sendable(ALEX)).toBe(false);
    h.setNow(now);
    const c = (await (await imp("c.csv", `Name,Mobile\nAlex Ray,${ALEX}\nJo Lin,${JO}\n`)).json()) as { proposal: { id: string } };
    await decide(c.proposal.id, "approve");
    expect(await sendable(JO)).toBe(true);
    const d = (await (await imp("only.csv", `Alex Ray,${ALEX}\n`, "replace")).json()) as { proposal: { id: string; adds: number; removes: number } };
    expect(d.proposal).toMatchObject({ adds: 0, removes: 1 });
    expect(await sendable(JO)).toBe(true);
    await decide(d.proposal.id, "approve");
    expect(await sendable(JO)).toBe(false);
    expect(await sendable(ALEX)).toBe(true);
  });
  it("a number back inside the 30-day gone window returns OFF and needs a new approval", async () => {
    const a = (await (await imp("c.csv", `Name,Mobile\nAlex Ray,${ALEX}\n`)).json()) as { proposal: { id: string } };
    await decide(a.proposal.id, "approve");
    expect(await sendable(ALEX)).toBe(true);
    // Alex leaves every source; the next sync marks the pref row gone but keeps it (enabled=1) for 30 days
    await sql("DELETE FROM contact_sources WHERE e164=?", ALEX);
    await imp("j.csv", `Jo Lin,${JO}\n`, "none");
    const gone = await sql("SELECT enabled, gone_ms FROM contact_prefs WHERE gone_ms IS NOT NULL");
    expect(gone).toHaveLength(1);
    expect(await sendable(ALEX)).toBe(false);
    h.setNow(now + 86_400_000);
    const back = (await (await imp("c.csv", `Alex Ray,${ALEX}\n`)).json()) as { proposal: { id: string; adds: number } | null };
    expect(await sendable(ALEX)).toBe(false); // no silent re-enable
    expect(back.proposal).toMatchObject({ adds: 1 });
    expect(await sql("SELECT enabled FROM contact_prefs WHERE gone_ms IS NULL AND enabled=1")).toHaveLength(0);
    if (!back.proposal) throw new Error("expected a proposal");
    await decide(back.proposal.id, "approve");
    expect(await sendable(ALEX)).toBe(true);
  });
  it("replace never proposes an ALLOWLIST-secret number for OFF; the page shows it staying on", async () => {
    const a = (await (await imp("c.csv", `Name,Mobile\nAlex Ray,${ALEX}\nJo Lin,${JO}\n`)).json()) as { proposal: { id: string } };
    await decide(a.proposal.id, "approve");
    await h.setEnv({ ALLOWLIST: JSON.stringify({ [JO]: "Jo Lin" }) });
    const d = (await (await imp("only.csv", `Name,Mobile\nAlex Ray,${ALEX}\nRiley Moore,${RILEY}\n`, "replace")).json()) as { proposal: { id: string; adds: number; removes: number } };
    expect(d.proposal).toMatchObject({ adds: 1, removes: 0 });
    const page = await proposalPage(d.proposal.id);
    expect(page.html).toContain("Stays on (secret ALLOWLIST) (1)");
    expect(page.html).toMatch(/<ul id=kept><li>Jo Lin · [^<]* · ends 0171<\/li><\/ul>/);
    expect(page.html).not.toContain("Switch off");
    expect(page.html).toContain("Approve these 1");
    noFullNumbers(page.html);
    await decide(d.proposal.id, "approve");
    expect(await sendable(JO)).toBe(true);
    expect(await sendable(RILEY)).toBe(true);
  });
  it("allowlist_proposals storage holds only number hashes, never raw numbers", async () => {
    await imp("c.csv", `Name,Mobile\nAlex Ray,${ALEX}\nJo Lin,${JO}\n`);
    const b = (await (await imp("c.csv", `Name,Mobile\nRiley Moore,${RILEY}\n`)).json()) as { proposal: { id: string } };
    await decide(b.proposal.id, "approve");
    await h.setEnv({ ALLOWLIST: JSON.stringify({ [RILEY]: "Riley Moore" }) });
    await imp("s.csv", `Sam Lee,${SAM}\n`, "replace");
    const rows = await sql("SELECT * FROM allowlist_proposals");
    expect(rows.length).toBe(3);
    const dump = JSON.stringify(rows);
    noFullNumbers(dump);
    expect(dump).not.toMatch(/\+\d{6,}/);
    for (const r of rows) for (const col of ["adds", "removes", "kept"]) {
      const keys = JSON.parse(r[col] as string) as string[];
      for (const k of keys) expect(k).toMatch(/^[a-f0-9]{64}$/);
    }
    const last = rows[2]?.["kept"];
    expect(typeof last === "string" ? (JSON.parse(last) as string[]) : null).toHaveLength(1);
  });
  it("allowlist none files nothing; example numbers are never proposed; needs the bot token", async () => {
    const n = (await (await imp("c.csv", `Alex Ray,${ALEX}\n`, "none")).json()) as { proposal: unknown };
    expect(n.proposal).toBeNull();
    const e = (await (await imp("c.csv", "Ex Ample,+1 202 555 0123\n")).json()) as { proposal: unknown };
    expect(e.proposal).toBeNull();
    const r = await h.relay.fetch(`${API}/import-contacts`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ filename: "c.csv", content: "a,b" }) });
    expect(r.status).toBe(401);
  });
});

describe("one-person add request", () => {
  beforeEach(async () => { await imp("c.csv", `Name,Mobile\nAlex Ray,${ALEX}\nJo Lin,${JO}\n`, "none"); });
  const ask = async (to_name: string) => bot("/allowlist-request", { to_name });
  const status = async (id: string) => ((await (await h.relay.fetch(`${API}/allowlist-request/${id}`, { headers: { Authorization: "Bearer TEST-ONLY-request-token" } })).json()) as { state: string }).state;
  it("pending is not sendable; approve makes exactly that person sendable", async () => {
    const r = await ask("Alex Ray");
    expect(r.status).toBe(202);
    const text = await r.text();
    noFullNumbers(text);
    const j = JSON.parse(text) as { id: string; adds: number; state: string };
    expect(j).toMatchObject({ adds: 1, state: "pending" });
    expect(await status(j.id)).toBe("pending");
    expect(await sendable(ALEX)).toBe(false);
    expect((await proposalPage(j.id)).html).toContain("Approve these 1");
    expect((await decide(j.id, "approve")).status).toBe(200);
    expect(await status(j.id)).toBe("approved");
    expect(await sendable(ALEX)).toBe(true);
    expect(await sendable(JO)).toBe(false);
    expect(await (await ask("Alex Ray")).json()).toMatchObject({ state: "already_on" });
  });
  it("reject changes nothing", async () => {
    const j = (await (await ask("Jo Lin")).json()) as { id: string };
    const { csrf } = await proposalPage(j.id);
    expect((await decide(j.id, "deny", csrf)).status).toBe(200);
    expect(await status(j.id)).toBe("denied");
    expect(await sendable(JO)).toBe(false);
    expect((await decide(j.id, "approve", csrf)).status).toBe(409);
    expect(await sendable(JO)).toBe(false);
  });
  it("expired changes nothing", async () => {
    const j = (await (await ask("Jo Lin")).json()) as { id: string };
    const { csrf } = await proposalPage(j.id);
    h.setNow(now + PROPOSAL_TTL_MS);
    expect(await status(j.id)).toBe("expired");
    expect((await decide(j.id, "approve", csrf)).status).toBe(410);
    expect(await sendable(JO)).toBe(false);
  });
  it("refuses unknown, phone-number and bad input", async () => {
    expect((await ask("Nobody Here")).status).toBe(404);
    expect((await ask(JO)).status).toBe(400);
    expect((await bot("/allowlist-request", { to_name: "Jo Lin", e164: JO })).status).toBe(400);
  });
});
