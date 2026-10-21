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
    expect([...HARBOR_CSS.matchAll(/url\(([^)]*)\)/g)].map((m) => m[1])).toEqual([HARBOR_FONT_PATH]);
    expect(HARBOR_CSS_NO_FONT).not.toMatch(/@font-face|url\(/);
    expect(HARBOR_CSS).not.toContain("/*");
    // Backdrop on a fixed layer: never background-attachment:fixed (ignored on iOS Safari, repaints on scroll).
    expect(HARBOR_CSS).not.toContain("background-attachment");
    expect(HARBOR_CSS).toContain('html::before{content:"";position:fixed;inset:0;z-index:-3;background:var(--h-backdrop)');
    expect(new TextEncoder().encode(HARBOR_CSS).length).toBeLessThan(6_000);
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
