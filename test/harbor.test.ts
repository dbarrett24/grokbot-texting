import { describe, it, expect, beforeEach } from "vitest";
import { harness, postRequest, API, BASE, FRIEND, type Harness } from "./helpers";
import { HARBOR_CSS, HARBOR_CSS_NO_FONT, HARBOR_FONT_PATH } from "../src/harbor";

// Everyday Harbor look: one CSS file inlined into each page, the heading font served by the Worker. The CSPs must be
// exactly what they were before the look was added.
const STRICT_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'";
let h: Harness;
beforeEach(async () => { h = await harness(); });
const get = async (url: string) => h.relay.fetch(url, { headers: { "Cf-Access-Jwt-Assertion": await h.jwt() } });

describe("Harbor look", () => {
  it("CSS: the approved Harbor picks (CTA 135deg, glow alpha 0.34), no other origin, small", () => {
    expect(HARBOR_CSS).toContain("--h-cta-fill:linear-gradient(135deg,");
    expect(HARBOR_CSS).toContain("rgba(91, 155, 216, 0.34)");
    expect(HARBOR_CSS).not.toContain("0.38)");
    expect([...HARBOR_CSS.matchAll(/url\(([^)]*)\)/g)].map((m) => m[1]).filter((u) => !u?.startsWith("/harbor/leaves/"))).toEqual([HARBOR_FONT_PATH]);
    expect(HARBOR_CSS_NO_FONT).not.toMatch(/@font-face|url\(/);
    expect(HARBOR_CSS).not.toContain("/*");
    // Backdrop on a fixed layer: never background-attachment:fixed (ignored on iOS Safari, repaints on scroll).
    expect(HARBOR_CSS).not.toContain("background-attachment");
    expect(HARBOR_CSS).toContain('html::before{content:"";position:fixed;inset:0;z-index:-3;background:var(--h-backdrop)');
    expect(new TextEncoder().encode(HARBOR_CSS).length).toBeLessThan(8_000); // 6 KB before the leaf + picker mockups
  });

  it("font: served by the Worker on the approve host only, as woff2", async () => {
    const r = await get(`${BASE}${HARBOR_FONT_PATH}`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("font/woff2");
    const b = new Uint8Array(await r.arrayBuffer());
    expect(new TextDecoder().decode(b.slice(0, 4))).toBe("wOF2");
    expect(b.length).toBeLessThan(25_000);
    expect((await h.relay.fetch(`${API}${HARBOR_FONT_PATH}`)).status).toBe(404);
  });

  it("/direct: Harbor CSS without @font-face, CSP unchanged", async () => {
    const r = await get(`${BASE}/direct`);
    const html = await r.text();
    expect(html).toContain(`<style>${HARBOR_CSS_NO_FONT}</style>`);
    expect(html).not.toContain("@font-face");
    expect(r.headers.get("content-security-policy")).toBe(STRICT_CSP);
  });

  it("/approve: Harbor CSS without @font-face, CSP unchanged", async () => {
    const id = ((await (await postRequest(h, { to: FRIEND, text: "hi" })).json()) as { id: string }).id;
    const r = await get(`${BASE}/approve/${id}`);
    const html = await r.text();
    expect(html).toContain(`<style>${HARBOR_CSS_NO_FONT}</style>`);
    expect(html).toContain("<button name=action value=approve>Approve and send</button>");
    expect(r.headers.get("content-security-policy")).toBe(STRICT_CSP);
  });

  it("/contacts: Harbor CSS with the font, in the nonce'd style, CSP unchanged", async () => {
    const r = await get(`${BASE}/contacts`);
    const html = await r.text();
    const csp = r.headers.get("content-security-policy") ?? "";
    const nonce = /'nonce-([a-f0-9]{32})'/.exec(csp)?.[1];
    expect(html).toContain(`<style nonce="${nonce}">\n${HARBOR_CSS}\n</style>`);
    expect(csp).toBe(`default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'nonce-${nonce}'; frame-ancestors 'none'; form-action 'self' https://accounts.google.com; base-uri 'none'`);
  });
});

describe("Harbor leaf mockups (?leaves=)", () => {
  it("default is the vines photo (vines SVG where images are blocked); SVG layouts still render from ?leaves= but are not picker options", async () => {
    const direct = await get(`${BASE}/direct`);
    const plain = await direct.text();
    expect(plain).toContain("<svg class=hl-leaves aria-hidden=true"); // photo-vines falls back to the vines SVG
    expect(plain).toContain('value="photo-vines" checked');
    expect(direct.headers.get("content-security-policy")).toBe(STRICT_CSP);
    const contacts = await (await get(`${BASE}/contacts`)).text();
    expect(contacts).toContain('<div class="hl-photo hl-photo-vines" aria-hidden=true></div>');
    expect(contacts).toContain('value="photo-vines" checked');
    expect(contacts).not.toContain('value="vines"');
    expect(contacts).not.toContain('value="corners"');
    expect(contacts).not.toContain('value="scatter"');
    expect(contacts).not.toContain("(photo)");
    for (const o of ["corners", "vines", "scatter"]) {
      const r = await get(`${BASE}/direct?leaves=${o}`);
      const html = await r.text();
      expect(html).toContain("<svg class=hl-leaves aria-hidden=true");
      expect(/<svg class=hl-leaves[\s\S]*?<\/svg>\n/.exec(html)?.[0]).not.toMatch(/href="(?!#)/); // only in-document <use> refs
      expect(r.headers.get("content-security-policy")).toBe(STRICT_CSP);
      const c = await get(`${BASE}/contacts?leaves=${o}`);
      const ch = await c.text();
      expect(ch).toContain("<svg class=hl-leaves");
      expect(new TextEncoder().encode(ch).length).toBeLessThan(27_000); // mockup: leaves + picker; the default page keeps the 25 KB cap
    }
    const unknown = await (await get(`${BASE}/direct?leaves=__proto__`)).text();
    expect(unknown).not.toContain("__proto__");
    expect(unknown).toContain('value="photo-vines" checked');
  });
});

describe("Harbor photo leaf variants (?leaves=photo-*)", () => {
  it("/contacts gets the photo layer; /direct falls back to the SVG option; CSPs unchanged", async () => {
    for (const o of ["corners", "vines", "scatter"]) {
      const c = await get(`${BASE}/contacts?leaves=photo-${o}`);
      expect(await c.text()).toContain(`<div class="hl-photo hl-photo-${o}" aria-hidden=true></div>`);
      const d = await get(`${BASE}/direct?leaves=photo-${o}`);
      const html = await d.text();
      expect(html).not.toContain("hl-photo-");
      expect(html).toContain("<svg class=hl-leaves");
      expect(d.headers.get("content-security-policy")).toBe(STRICT_CSP);
    }
  });

  it("serves the WebP files from the approve host only; unknown names 404", async () => {
    for (const n of ["corners-1024", "corners-640", "vines-1024", "vines-640", "scatter-1024", "scatter-640"]) {
      const r = await get(`${BASE}/harbor/leaves/${n}.webp`);
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toBe("image/webp");
      const b = new Uint8Array(await r.arrayBuffer());
      expect(new TextDecoder().decode(b.slice(8, 12))).toBe("WEBP");
      expect(b.length).toBeLessThan(25_000);
    }
    expect((await get(`${BASE}/harbor/leaves/nope-1024.webp`)).status).toBe(404);
    expect((await h.relay.fetch(`${API}/harbor/leaves/corners-1024.webp`)).status).toBe(404);
  });
});

describe("Background picker (no JS, cookie)", () => {
  const pick = async (leaves: string, back: string, origin = BASE) =>
    h.relay.fetch(`${BASE}/harbor/background`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", Origin: origin, "Cf-Access-Jwt-Assertion": await h.jwt() }, body: new URLSearchParams({ leaves, back }).toString(), redirect: "manual" });
  it("every page has the radio group; the post sets a cookie and the page then renders that background server-side", async () => {
    for (const p of ["/direct", "/contacts"]) {
      const html = await (await get(`${BASE}${p}`)).text();
      expect(html).toContain('<details class=hb-pick><summary>Background</summary><form method=post action="/harbor/background"><fieldset><legend>Page background</legend>');
      expect((html.match(/type=radio name=leaves/g) ?? []).length).toBe(4);
      expect(html).not.toContain("(photo)");
    }
    const r = await pick("photo-vines", "/direct");
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("/direct");
    const cookie = r.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/^hb_bg=photo-vines; Path=\/; Max-Age=31536000; Secure; HttpOnly; SameSite=Lax$/);
    const d = await h.relay.fetch(`${BASE}/direct`, { headers: { "Cf-Access-Jwt-Assertion": await h.jwt(), cookie: "hb_bg=photo-vines" } });
    const html = await d.text();
    expect(html).toContain("<svg class=hl-leaves");
    expect(html).not.toContain("hl-photo-");
    expect(html).toContain('value="photo-vines" checked');
    expect(d.headers.get("content-security-policy")).toBe(STRICT_CSP);
    const c = await h.relay.fetch(`${BASE}/contacts`, { headers: { "Cf-Access-Jwt-Assertion": await h.jwt(), cookie: "hb_bg=photo-vines" } });
    expect(await c.text()).toContain('<div class="hl-photo hl-photo-vines" aria-hidden=true></div>');
  });
  it("refuses other origins, removed layouts, unknown options and off-site back paths", async () => {
    expect((await pick("photo-vines", "/direct", "https://evil.example")).status).toBe(403);
    expect((await pick("lava", "/direct")).status).toBe(400);
    for (const removed of ["corners", "vines", "scatter"]) expect((await pick(removed, "/direct")).status).toBe(400);
    expect((await pick("photo-vines", "https://evil.example/")).status).toBe(400);
    expect((await pick("photo-vines", "//evil.example")).status).toBe(400);
  });
});
