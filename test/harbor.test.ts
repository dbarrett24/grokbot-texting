import { describe, it, expect, beforeEach } from "vitest";
import { harness, postRequest, API, BASE, FRIEND, type Harness } from "./helpers";
import { scan } from "./phone-scan";
import { HARBOR_CSS, HARBOR_CSS_NO_FONT, HARBOR_FONT_PATH, HARBOR_LOGO_PATH, pickerLiveScript } from "../src/harbor";
import { installPicker } from "../src/harbor-picker";

// Everyday Harbor look. /contacts keeps its CSP byte for byte. Approve, Direct and Log use a nonce policy
// that drops unsafe-inline and allows same-origin images, fonts and the page's own script.
const PAGE_CSP = (nonce: string) => `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src 'self'; font-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'`;
function expectPageCsp(csp: string | null): string {
  const nonce = /'nonce-([a-f0-9]{32})'/.exec(csp ?? "")?.[1] ?? "";
  expect(csp).toBe(PAGE_CSP(nonce));
  expect(nonce).toMatch(/^[a-f0-9]{32}$/);
  return nonce;
}
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
    expect(HARBOR_CSS).toContain(".brand{display:flex;align-items:center;gap:20px;margin:.2em 0 .7em}");
    expect(HARBOR_CSS).toContain(".brand h1.product{margin:0;font-size:2.5em}");
    expect(HARBOR_CSS).toContain(".brand-logo{display:block;flex:none;width:96px;height:96px;max-width:none;max-height:none;border-radius:23%;box-shadow:0 0 0 1px rgb(255 255 255 / .18)}");
    expect(HARBOR_CSS).toContain("@media (max-width:480px){.brand{gap:14px}.brand-logo{width:72px;height:72px}.brand h1.product{font-size:1.9em}}");
    expect(HARBOR_CSS).not.toContain("flex-flow:column");
    expect(HARBOR_CSS).not.toContain("max-width:40px");
    expect(HARBOR_CSS).not.toContain("max-height:40px");
    expect(HARBOR_CSS).toContain("h1.product{font-size:2.15em;line-height:1.15;margin:.1em 0 .35em;color:var(--h-text)}");
    expect(HARBOR_CSS).not.toMatch(/h1\.product\{[^}]*var\(--h-link\)/);
    expect(HARBOR_CSS).toContain(".vh{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}");
    expect(HARBOR_CSS).not.toMatch(/\.vh\{[^}]*display:none/);
    expect(HARBOR_CSS).toContain("input:checked+label.hb-opt");
    expect(HARBOR_CSS).toContain("input:focus-visible+label.hb-opt");
    expect(HARBOR_CSS).toContain("repeat(auto-fill,minmax(8.75rem,1fr))");
    expect(HARBOR_CSS).toContain("width:128px");
    expect(HARBOR_CSS).toContain(".per{display:flex;gap:4px}");
    expect(HARBOR_CSS).toContain("/harbor/leaves/corners-256.webp");
    expect(HARBOR_CSS).not.toContain("96.webp");
    expect(HARBOR_CSS).toContain(".badge[hidden]{display:none}");
    const support = /a\.support\{[^}]*\}/.exec(HARBOR_CSS)?.[0] ?? "";
    const supportHeight = Number(/height:(\d+)px/.exec(support)?.[1]);
    const supportFont = Number(/font-size:(\d+)px/.exec(support)?.[1]);
    expect(supportHeight).toBeGreaterThanOrEqual(28);
    expect(supportHeight).toBeLessThanOrEqual(32);
    expect(supportFont).toBeGreaterThanOrEqual(12);
    expect(supportFont).toBeLessThanOrEqual(13);
    expect(support).toContain("border:1px solid var(--h-border)");
    expect(support).toContain("background:var(--h-solid)");
    expect(support).toContain("color:var(--h-text)");
    expect(HARBOR_CSS).toContain("dialog.ask button{min-height:44px;min-width:44px}");
    expect(HARBOR_CSS).toContain("--h-border:#6b89ad");
    expect(HARBOR_CSS).not.toContain("#56708f");
    expect(new TextEncoder().encode(HARBOR_CSS).length).toBeLessThan(16_800); // contacts toolbar, switch, sync disclosure, dialog, three scene photo rules (measured 16408)
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

  it("logo: the contacts mark, served as SVG on the approve host only", async () => {
    scan.allow.push('viewBox="0 0 288 288"'); // path coordinates are not phone numbers; the scan sees the file as one string
    const r = await get(`${BASE}${HARBOR_LOGO_PATH}`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/svg+xml");
    const text = await r.text();
    expect(text).toContain('viewBox="0 0 288 288"');
    expect(text).toContain("mask-type:luminance"); // the eyes; a renderer that drops luminance masks loses them
    expect(r.headers.get("content-security-policy")).toBe("script-src 'none'");
    expect((await h.relay.fetch(`${API}${HARBOR_LOGO_PATH}`)).status).toBe(404);
  });

  it("/direct: Harbor CSS with the font, nonce CSP, no-store", async () => {
    const r = await get(`${BASE}/direct`);
    const html = await r.text();
    const nonce = expectPageCsp(r.headers.get("content-security-policy"));
    expect(html).toContain(`<style nonce="${nonce}">\n${HARBOR_CSS}\n</style>`);
    expect(html).toContain("@font-face");
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("content-security-policy")).not.toContain("unsafe-inline");
  });

  it("/approve: Harbor CSS with the font, nonce CSP, approve button kept", async () => {
    const id = ((await (await postRequest(h, { to: FRIEND, text: "hi" })).json()) as { id: string }).id;
    const r = await get(`${BASE}/approve/${id}`);
    const html = await r.text();
    const nonce = expectPageCsp(r.headers.get("content-security-policy"));
    expect(html).toContain(`<style nonce="${nonce}">\n${HARBOR_CSS}\n</style>`);
    expect(html).toContain("<button name=action value=approve data-act=approve>Approve and send</button>");
    expect(r.headers.get("cache-control")).toBe("no-store");
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
    expect(plain).toContain('<div class="hl-photo hl-photo-vines" aria-hidden=true></div>');
    expect(plain).toContain('value="photo-vines" checked');
    expectPageCsp(direct.headers.get("content-security-policy"));
    const contacts = await (await get(`${BASE}/contacts`)).text();
    expect(contacts).toContain('<div class="hl-photo hl-photo-vines" aria-hidden=true></div>');
    expect(contacts).toContain('<span class=per><label class=ro for=per>Per page</label><select id=per>');
    expect(contacts).toContain('value="photo-vines" checked');
    expect(contacts).not.toContain('value="vines"');
    expect(contacts).not.toContain('value="corners"');
    expect(contacts).not.toContain('value="scatter"');
    expect(contacts).not.toContain("(photo)");
    for (const o of ["corners", "vines", "scatter"]) {
      const r = await get(`${BASE}/direct?leaves=${o}`);
      const html = await r.text();
      expect(html).toContain("<svg class=hl-leaves aria-hidden=true");
      const svg = html.slice(html.indexOf("<svg class=hl-leaves"), html.indexOf("<header"));
      expect(svg.startsWith("<svg")).toBe(true);
      expect(svg).not.toMatch(/href="(?!#)/); // only in-document <use> refs
      expectPageCsp(r.headers.get("content-security-policy"));
      const c = await get(`${BASE}/contacts?leaves=${o}`);
      const ch = await c.text();
      expect(ch).toContain("<svg class=hl-leaves");
      expect(new TextEncoder().encode(ch).length).toBeLessThan(43_500); // leaves SVG on the contacts shell plus scene CSS and tiles (measured 42631); the default page cap is 39 KB
    }
    const unknown = await (await get(`${BASE}/direct?leaves=__proto__`)).text();
    expect(unknown).not.toContain("__proto__");
    expect(unknown).toContain('value="photo-vines" checked');
  });

  it("offers the three scene photos as picker choices and paints each when picked", async () => {
    for (const [o, label] of [["dock", "Harbor dock"], ["willow", "Willow lake"], ["lantern", "Lantern dock"]] as const) {
      const html = await (await get(`${BASE}/direct?leaves=photo-${o}`)).text();
      expect(html).toContain(`value="photo-${o}" checked`);
      expect(html).toContain(label);
      expect(html).toContain(`<span class="hb-th hb-th-photo-${o}"></span>`);
      expect(html).toContain(`<div class="hl-photo hl-photo-${o}" aria-hidden=true></div>`);
      expect(html).not.toContain("<svg class=hl-leaves");
    }
  });
});

describe("Harbor photo leaf variants (?leaves=photo-*)", () => {
  it("/contacts and /direct both get the photo layer; CSPs stay their own", async () => {
    for (const o of ["corners", "vines", "scatter", "dock", "willow", "lantern"]) {
      const c = await get(`${BASE}/contacts?leaves=photo-${o}`);
      expect(await c.text()).toContain(`<div class="hl-photo hl-photo-${o}" aria-hidden=true></div>`);
      const d = await get(`${BASE}/direct?leaves=photo-${o}`);
      const html = await d.text();
      expect(html).toContain(`<div class="hl-photo hl-photo-${o}" aria-hidden=true></div>`);
      expectPageCsp(d.headers.get("content-security-policy"));
    }
  });

  it("serves the WebP files from the approve host only; unknown names 404", async () => {
    for (const n of ["corners-1024", "corners-640", "corners-256", "vines-1024", "vines-640", "vines-256", "scatter-1024", "scatter-640", "scatter-256", "dock-1280", "dock-640", "dock-256", "willow-1280", "willow-640", "willow-256", "lantern-1280", "lantern-640", "lantern-256"]) {
      const r = await get(`${BASE}/harbor/leaves/${n}.webp`);
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toBe("image/webp");
      const b = new Uint8Array(await r.arrayBuffer());
      expect(new TextDecoder().decode(b.slice(8, 12))).toBe("WEBP");
      expect(b.length).toBeLessThan(n.startsWith("dock") || n.startsWith("willow") || n.startsWith("lantern") ? 100_000 : 25_000); // scene photos are full-frame (largest 76.6 KB)
    }
    expect((await get(`${BASE}/harbor/leaves/nope-1024.webp`)).status).toBe(404);
    expect((await h.relay.fetch(`${API}/harbor/leaves/corners-1024.webp`)).status).toBe(404);
  });
});

describe("Background picker (cookie, live on /contacts)", () => {
  const pick = async (leaves: string, back: string, origin = BASE) =>
    h.relay.fetch(`${BASE}/harbor/background`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", Origin: origin, "Cf-Access-Jwt-Assertion": await h.jwt() }, body: new URLSearchParams({ leaves, back }).toString(), redirect: "manual" });
  it("every page posts the same cookie form; Contacts, Direct and Approve use radios, with Apply only inside noscript", async () => {
    for (const p of ["/direct", "/contacts"]) {
      const html = await (await get(`${BASE}${p}`)).text();
      expect(html).toContain('<form method=post action="/harbor/background"');
      expect(html).toContain("<legend class=vh>Page background</legend>");
      expect(html).not.toContain("(photo)");
    }
    const direct = await (await get(`${BASE}/direct`)).text();
    expect(direct.replace(/<noscript>[\s\S]*?<\/noscript>/g, "")).not.toContain("Apply");
    expect(direct).toContain("<noscript><button>Apply</button></noscript>");
    expect((direct.match(/class=vh type=radio name=leaves/g) ?? []).length).toBe(7);
    expect(direct).toContain(pickerLiveScript());
    const contacts = await (await get(`${BASE}/contacts`)).text();
    expect(contacts.replace(/<noscript>[\s\S]*?<\/noscript>/g, "")).not.toContain("Apply");
    expect(contacts).toContain("<noscript><button>Apply</button></noscript>");
    expect((contacts.match(/class=vh type=radio name=leaves/g) ?? []).length).toBe(7);
    expect(contacts).toContain(pickerLiveScript());
    const r = await pick("photo-vines", "/direct");
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("/direct");
    const cookie = r.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/^hb_bg=photo-vines; Path=\/; Max-Age=31536000; Secure; HttpOnly; SameSite=Lax$/);
    const d = await h.relay.fetch(`${BASE}/direct`, { headers: { "Cf-Access-Jwt-Assertion": await h.jwt(), cookie: "hb_bg=photo-vines" } });
    const html = await d.text();
    expect(html).toContain('<div class="hl-photo hl-photo-vines" aria-hidden=true></div>');
    expect(html).toContain('value="photo-vines" checked');
    expectPageCsp(d.headers.get("content-security-policy"));
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

  it("a selection change updates the background and posts the choice, with no Apply step", () => {
    const script = pickerLiveScript();
    expect(script).not.toContain("Apply");
    expect(script).not.toContain("onchange=");
    expect(script).toContain("function applyPickerChoice");
    expect(script).toContain('installPicker(document,document.querySelector("#hb-bg"),FormData,fetch.bind(globalThis))');
    type El = { className: string; removed?: boolean; setAttribute: (n: string, v: string) => void; remove: () => void };
    const run = (start: string) => {
      const listeners: Record<string, () => void> = {};
      const form = {
        tagName: "FORM", action: "/harbor/background",
        values: { leaves: start, back: "/contacts" } as Record<string, string>,
        addEventListener(type: string, fn: () => void) { listeners[type] = fn; },
      };
      const photo: El = { className: "hl-photo hl-photo-vines", setAttribute() {}, remove() { photo.removed = true; } };
      let current: El | null = photo;
      const doc = {
        querySelector(sel: string) {
          if (sel === ".hl-photo") return current && !current.removed ? current : null;
          return null;
        },
        querySelectorAll() { return []; },
        createElement(): El {
          const created: El = { className: "", setAttribute() {}, remove() { created.removed = true; } };
          return created;
        },
        body: { prepend(node: El) { current = node; } },
      };
      class FD {
        constructor(_form: object) { /* the live script passes the form; this fake reads the closed-over values */ }
        get(k: string) { return form.values[k] ?? null; }
        forEach(fn: (val: string, key: string) => void) { for (const [k, v] of Object.entries(form.values)) fn(v, k); }
      }
      const calls: { method: string; body: URLSearchParams }[] = [];
      const fetchFn = (_url: string, init: { method: string; body: URLSearchParams }) => { calls.push(init); return Promise.resolve(); };
      installPicker(doc, form, FD, fetchFn);
      return { form, photo, listeners, calls };
    };
    const live = run("photo-vines");
    live.form.values["leaves"] = "photo-scatter";
    live.listeners["change"]?.();
    expect(live.photo.className).toBe("hl-photo hl-photo-scatter");
    expect(live.calls).toHaveLength(1);
    expect(live.calls[0]?.method).toBe("POST");
    expect(live.calls[0]?.body.get("leaves")).toBe("photo-scatter");
    expect(live.calls[0]?.body.get("back")).toBe("/contacts");
    const refused = run("photo-vines");
    refused.form.values["leaves"] = "photo-nope";
    refused.listeners["change"]?.();
    expect(refused.photo.className).toBe("hl-photo hl-photo-vines");
    expect(refused.calls[0]?.body.get("leaves")).toBe("photo-nope");
    const cleared = run("photo-vines");
    cleared.form.values["leaves"] = "none";
    cleared.listeners["change"]?.();
    expect(cleared.photo.removed).toBe(true);
  });
});
