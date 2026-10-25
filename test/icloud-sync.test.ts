import { describe, it, expect, beforeEach } from "vitest";
import { inRelay, sql as sqlOf, type Row } from "./google-fixture";
import { harness, API, BASE, type Harness } from "./helpers";
import { vcardToContact, parseICloudCreds, safeUrl, addressBooks, propHref } from "../src/icloud";
import { isLabel } from "../src/google";
import { parseAccounts } from "../src/direct";

// Fake iCloud CardDAV. Every value is TEST-ONLY; numbers are in the fictional 555-01xx range.
const APPLE_ID = "test-only@example.test";
const APP_PW = "abcd-efgh-ijkl-mnop"; // shape of an app-specific password, not a real one
const PW_PARTS = [APP_PW, APP_PW.replace(/-/g, ""), btoa(`${APPLE_ID}:${APP_PW}`)];

const ms = (inner: string) => `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">${inner}</d:multistatus>`;
const card = (lines: string[]) => ["BEGIN:VCARD", "VERSION:3.0", ...lines, "END:VCARD"].join("\r\n");
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

let h: Harness;
let dav: { status?: number; cards: string[][]; books?: number; seen: { method: string; url: string; depth: string | null; auth: string | null }[] };
const sql = (q: string): Promise<Row[]> => sqlOf(h, q);
const sync = () => inRelay(h, (r) => r.syncContacts({ alert: false }));

beforeEach(async () => {
  h = await harness();
  dav = {
    seen: [],
    cards: [[
      card(["FN:Ann Lee", "N:Lee;Ann;;;", "TEL;type=CELL;type=VOICE;type=pref:+15555550121", "TEL;TYPE=FAX:+15555550129"]),
      card(["FN:Neighbor Bo", "N:Bo;Neighbor;;;", "item1.TEL:(555) 555-0122", "item1.X-ABLabel:_$!<Mobile>!$_"]),
    ], [card(["FN:Coach Cy", "N:Cy;Coach;;;", "TEL;TYPE=IPHONE:tel:+15555550123"]), card(["FN:No Phone", "EMAIL:x@example.test"])]],
  };
  await inRelay(h, (inst) => {
    const base = inst.net;
    inst.net = async (req: Request) => {
      const u = new URL(req.url);
      if (!u.host.endsWith("contacts.icloud.com")) return base(req);
      dav.seen.push({ method: req.method, url: req.url, depth: req.headers.get("Depth"), auth: req.headers.get("Authorization") });
      if (req.headers.get("Authorization") !== `Basic ${btoa(`${APPLE_ID}:${APP_PW}`)}`) return new Response("no", { status: 401 });
      if (dav.status) return new Response("err", { status: dav.status });
      const body = await req.text();
      if (req.method === "PROPFIND" && u.host === "contacts.icloud.com" && u.pathname === "/") return new Response(ms(`<d:response><d:href>/</d:href><d:propstat><d:prop><d:current-user-principal><d:href>/123/principal/</d:href></d:current-user-principal></d:prop></d:propstat></d:response>`), { status: 207 });
      if (req.method === "PROPFIND" && u.pathname === "/123/principal/") {
        expect(body).toContain("addressbook-home-set");
        return new Response(ms(`<d:response><d:href>/123/principal/</d:href><d:propstat><d:prop><card:addressbook-home-set><d:href>https://p42-contacts.icloud.com/123/carddavhome/</d:href></card:addressbook-home-set></d:prop></d:propstat></d:response>`), { status: 207 });
      }
      if (req.method === "PROPFIND" && u.host === "p42-contacts.icloud.com" && u.pathname === "/123/carddavhome/") {
        expect(req.headers.get("Depth")).toBe("1");
        const n = dav.books ?? 2;
        const books = Array.from({ length: n }, (_, i) => `<d:response><d:href>/123/carddavhome/book${i}/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/><card:addressbook/></d:resourcetype></d:prop></d:propstat></d:response>`).join("");
        return new Response(ms(`<d:response><d:href>/123/carddavhome/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>${books}`), { status: 207 });
      }
      const m = u.pathname.match(/^\/123\/carddavhome\/book(\d+)\/$/);
      if (req.method === "REPORT" && m) {
        expect(body).toContain("addressbook-query");
        const cs = dav.cards[Number(m[1])] ?? [];
        return new Response(ms(cs.map((c, i) => `<d:response><d:href>/123/carddavhome/book${m[1]}/${i}.vcf</d:href><d:propstat><d:prop><d:getetag>"e${i}"</d:getetag><card:address-data>${esc(c)}</card:address-data></d:prop></d:propstat></d:response>`).join("")), { status: 207 });
      }
      return new Response("unexpected", { status: 404 });
    };
  });
  await h.setEnv({ ICLOUD_APPLE_ID: APPLE_ID, ICLOUD_APP_PASSWORD: APP_PW, DIRECT_SEND: "1" });
});

describe("iCloud CardDAV sync", () => {
  it("discovers principal, home and books read-only, then parses vCards into the contact model", async () => {
    const r = await sync();
    expect(r).toEqual({ updated: ["ICLOUD"], failed: [] });
    const rows = await sql("SELECT account, name, e164, label FROM contact_sources ORDER BY e164");
    expect(rows).toEqual([
      { account: "ICLOUD", name: "Ann Lee", e164: "+15555550121", label: "mobile" },
      { account: "ICLOUD", name: "Neighbor Bo", e164: "+15555550122", label: "mobile" },
      { account: "ICLOUD", name: "Coach Cy", e164: "+15555550123", label: "iphone" },
    ]);
    expect(dav.seen.map((s) => s.method)).toEqual(["PROPFIND", "PROPFIND", "PROPFIND", "REPORT", "REPORT"]); // never PUT/DELETE
    expect((await sql("SELECT detail FROM log WHERE event='contacts_sync'"))[0]?.detail).toBe("account=ICLOUD contacts=3 numbers=3 dropped_fax_pager=1");
  });

  it("does not widen who can be texted: synced numbers stay OFF until the owner turns them on", async () => {
    await sync();
    await h.relay.fetch(`${BASE}/contacts/list`, { headers: { "Cf-Access-Jwt-Assertion": await h.jwt() } });
    const prefs = await sql("SELECT enabled FROM contact_prefs");
    expect(prefs.length).toBeGreaterThan(0);
    expect(prefs.every((p) => p.enabled === 0)).toBe(true);
    const res = await h.relay.fetch(`${API}/send`, { method: "POST", headers: { Authorization: "Bearer TEST-ONLY-request-token" }, body: JSON.stringify({ to_name: "Ann Lee", body: "hi" }) });
    const j = await res.json() as { state: string };
    expect(j.state).not.toBe("sent");
    expect(["no_match", "not_enabled", "refused", "disabled"]).toContain(j.state);
  });

  it("the app-specific password never reaches logs, console or DO storage", async () => {
    const out: string[] = [];
    const orig = { log: console.log, error: console.error, warn: console.warn };
    for (const k of ["log", "error", "warn"] as const) console[k] = (...a: unknown[]) => void out.push(a.map(String).join(" "));
    try {
      await sync();
      dav.status = 500;
      await sync(); // failure path logs too
      await h.setEnv({ ICLOUD_APP_PASSWORD: "not-a-valid-shape-" + APP_PW });
      await sync();
    } finally {
      Object.assign(console, orig);
    }
    const dump: string[] = await inRelay(h, async (_r, st) => {
      const s: string[] = [];
      for (const t of st.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'").toArray()) {
        if (t.name.startsWith("_cf") || t.name.startsWith("sqlite")) continue;
        s.push(JSON.stringify(st.storage.sql.exec(`SELECT * FROM "${t.name}"`).toArray()));
      }
      s.push(JSON.stringify([...(await st.storage.list()).entries()]));
      return s;
    });
    const all = [...out, ...dump].join("\n");
    expect(all).toContain("icloud_principal_status_500"); // the failure was recorded, as a code
    for (const p of PW_PARTS) expect(all).not.toContain(p);
  });

  it("a failure keeps the previous list (same rule as Google)", async () => {
    await sync();
    dav.status = 503;
    const r = await sync();
    expect(r.failed).toEqual([{ account: "ICLOUD", reason: "icloud_principal_status_503" }]);
    expect((await sql("SELECT COUNT(*) AS c FROM contact_sources WHERE account='ICLOUD'"))[0]?.c).toBe(3);
  });

  it("an empty address book keeps the previous list", async () => {
    await sync();
    dav.cards = [[], []];
    expect((await sync()).failed).toEqual([{ account: "ICLOUD", reason: "icloud_empty_result" }]);
    expect((await sql("SELECT COUNT(*) AS c FROM contact_sources WHERE account='ICLOUD'"))[0]?.c).toBe(3);
  });

  it("wrong password = icloud_auth_failed; one secret alone = icloud_secret_missing; removing both purges the list", async () => {
    await sync();
    await h.setEnv({ ICLOUD_APP_PASSWORD: "zzzz-zzzz-zzzz-zzzz" });
    expect((await sync()).failed).toEqual([{ account: "ICLOUD", reason: "icloud_auth_failed" }]);
    await h.setEnv({ ICLOUD_APP_PASSWORD: "" });
    expect((await sync()).failed).toEqual([{ account: "ICLOUD", reason: "icloud_secret_missing" }]);
    expect((await sql("SELECT COUNT(*) AS c FROM contact_sources WHERE account='ICLOUD'"))[0]?.c).toBe(3);
    await h.setEnv({ ICLOUD_APPLE_ID: "" });
    expect(await sync()).toEqual({ updated: [], failed: [] });
    expect((await sql("SELECT COUNT(*) AS c FROM contact_sources WHERE account='ICLOUD'"))[0]?.c).toBe(0);
  });

  it("refuses to follow an href off iCloud's contacts hosts", () => {
    expect(() => safeUrl("https://evil.example.test/x", "https://contacts.icloud.com/")).toThrow("icloud_foreign_host");
    expect(() => safeUrl("http://p1-contacts.icloud.com/x", "https://contacts.icloud.com/")).toThrow("icloud_foreign_host");
    expect(safeUrl("/1/", "https://p1-contacts.icloud.com/a/")).toBe("https://p1-contacts.icloud.com/1/");
  });
});

describe("iCloud helpers", () => {
  it("parses folded lines, escaped names, given name and Apple labels; drops pager", () => {
    const stats = { dropped: 0 };
    const c = vcardToContact(card(["FN:Dee\\, Jr.", "N:Dee;Dana;;;", "TEL;TYPE=PAGER:+15555550131", "item2.TEL;type=pref:+1555555", " 0132", "item2.X-ABLabel:Gym"]), stats, "+1");
    expect(c).toEqual({ name: "Dee, Jr.", given: "Dana", numbers: [{ e164: "+15555550132", label: "gym" }] });
    expect(stats.dropped).toBe(1);
  });
  it("creds: both or neither; app-specific password shape", () => {
    expect(parseICloudCreds(undefined, undefined)).toBeNull();
    expect(() => parseICloudCreds(APPLE_ID, undefined)).toThrow("icloud_secret_missing");
    expect(() => parseICloudCreds(APPLE_ID, "hunter2")).toThrow("icloud_password_invalid");
    expect(parseICloudCreds(APPLE_ID, APP_PW)).toEqual({ appleId: APPLE_ID, password: APP_PW });
  });
  it("reads prefixed or default-namespace multistatus", () => {
    const x = `<multistatus xmlns="DAV:"><response><href>/h/</href><propstat><prop><resourcetype><collection/><addressbook xmlns="urn:ietf:params:xml:ns:carddav"/></resourcetype></prop></propstat></response></multistatus>`;
    expect(addressBooks(x)).toEqual(["/h/"]);
    expect(propHref(`<D:multistatus xmlns:D="DAV:"><D:response><D:href>/</D:href><D:propstat><D:prop><D:current-user-principal><D:href>/9/principal/</D:href></D:current-user-principal></D:prop></D:propstat></D:response></D:multistatus>`, "current-user-principal")).toBe("/9/principal/");
  });
  it("ICLOUD is a reserved source label", () => {
    expect(isLabel("ICLOUD")).toBe(false);
    expect(parseAccounts("icloud,work")).toEqual({ valid: ["WORK"], invalid: ["icloud"] });
  });
});
