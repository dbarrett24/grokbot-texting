// The Everyday Harbor look: one plain CSS file (src/harbor.css) inlined into each page's existing <style>, plus the
// Source Serif 4 heading font (OFL 1.1, Latin subset, src/assets/) served by the Worker itself. No CDN, no CSP change:
// /contacts already allows same-origin fonts (default-src 'self'); /direct and /approve/* (default-src 'none') get the
// CSS without the @font-face, so their headings use the Georgia fallback.
import css from "./harbor.css";
import font from "./assets/source-serif-4-latin-600.woff2";
import logo from "./assets/grokbot-logo.svg";
import { HARBOR_LEAVES, type LeavesOption } from "./harbor-leaves";
import cornersL from "./assets/leaves/corners-1024.webp";
import cornersS from "./assets/leaves/corners-640.webp";
import vinesL from "./assets/leaves/vines-1024.webp";
import vinesS from "./assets/leaves/vines-640.webp";
import scatterL from "./assets/leaves/scatter-1024.webp";
import scatterS from "./assets/leaves/scatter-640.webp";
import cornersT from "./assets/leaves/corners-96.webp";
import vinesT from "./assets/leaves/vines-96.webp";
import scatterT from "./assets/leaves/scatter-96.webp";
export { pickerLiveScript } from "./harbor-picker";

export const HARBOR_FONT_PATH = "/harbor/source-serif-4-latin-600.woff2";
const FONT_FACE = /\/\* @font-face:[\s\S]*?\/\* @end font-face \*\//;
const PHOTO = /\/\* @photo:[\s\S]*?\/\* @end photo \*\//;
const minify = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s*\n\s*/g, "").trim();
/** For pages whose CSP allows same-origin fonts. */
export const HARBOR_CSS = minify(css);
/** For pages whose CSP has no font or image source (default-src 'none'): no @font-face, no photo backdrops. */
export const HARBOR_CSS_NO_FONT = minify(css.replace(FONT_FACE, "").replace(PHOTO, ""));

export function harborFont(): Response {
  return new Response(font, {
    headers: { "content-type": "font/woff2", "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff" },
  });
}

export const HARBOR_LOGO_PATH = "/harbor/grokbot-logo.svg";
/** Header mark for /contacts. Same-origin <img>, so the page CSP stays default-src 'self'. Scripts in the file cannot run. */
export function harborLogo(): Response {
  return new Response(logo, {
    headers: {
      "content-type": "image/svg+xml",
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
      "content-security-policy": "script-src 'none'",
    },
  });
}

// Leaf backdrop mockups (draft): original inline SVG (src/harbor-leaves.ts), so no fetch and no CSP change on any page.
// Photo variants (?leaves=photo-corners|photo-vines|photo-scatter): self-served WebP behind a token-coloured scrim.
// Images need an img source in the CSP. /contacts has one (default-src 'self'); /direct and /approve/* have
// default-src 'none', which blocks every image (data: URIs too), so there the photo option falls back to the
// matching SVG option. The picker offers the photos only (the SVG layouts are not choices). The default is the
// vines photo; pages that cannot load images fall back to the vines SVG. Preview any layout with ?leaves=.
type PhotoOption = `photo-${LeavesOption}`;
export const HARBOR_LEAVES_DEFAULT: LeavesOption | PhotoOption | "none" = "photo-vines";
const isLeaves = (v: string | null): v is LeavesOption => v !== null && Object.hasOwn(HARBOR_LEAVES, v);
const PHOTOS: Record<string, ArrayBuffer> = {
  "corners-1024": cornersL, "corners-640": cornersS, "vines-1024": vinesL, "vines-640": vinesS, "scatter-1024": scatterL, "scatter-640": scatterS, "corners-96": cornersT, "vines-96": vinesT, "scatter-96": scatterT,
};
export const HARBOR_PHOTO_PREFIX = "/harbor/leaves/";
/** GET /harbor/leaves/<option>-<width>.webp, or null when the name isn't one of ours. */
export function harborPhoto(path: string): Response | null {
  const m = /^\/harbor\/leaves\/([a-z]+-\d+)\.webp$/.exec(path);
  const bytes = m && Object.hasOwn(PHOTOS, m[1] ?? "") ? PHOTOS[m[1] ?? ""] : undefined;
  if (!bytes) return null;
  return new Response(bytes, { headers: { "content-type": "image/webp", "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff" } });
}
/** The leaf layer markup for this request ("" for none). `images` says whether the page's CSP lets images load. */
export function leavesFor(req: Request, images = false): string {
  const q = new URL(req.url).searchParams.get("leaves") ?? bgCookie(req);
  const photo = q?.startsWith("photo-") ? q.slice(6) : null;
  if (photo !== null && isLeaves(photo)) return images ? `<div class="hl-photo hl-photo-${photo}" aria-hidden=true></div>` : HARBOR_LEAVES[photo];
  const pick = q === "none" ? "none" : isLeaves(q) ? q : HARBOR_LEAVES_DEFAULT;
  if (pick === "none") return "";
  if (pick.startsWith("photo-")) { const o = pick.slice(6) as LeavesOption; return images ? `<div class="hl-photo hl-photo-${o}" aria-hidden=true></div>` : HARBOR_LEAVES[o]; }
  return HARBOR_LEAVES[pick as LeavesOption];
}

// ---------- Background picker ----------
// POST /harbor/background stores the pick in a cookie and 303s back. The page reads the cookie server-side, so the
// right background is in the first paint. /contacts also paints the new choice in place on change (src/harbor-picker.ts)
// and posts the same form with fetch. /direct and /approve/* allow no scripts, so the tile itself submits the form.
// form-action 'self' is already in every CSP.
export const BG_COOKIE = "hb_bg";
// SVG layouts (corners, vines, scatter) stay in HARBOR_LEAVES for the no-image fallback and ?leaves= preview.
// They are not picker choices. The three photos are. Labels have no "(photo)" parenthetical.
export const BG_OPTIONS = ["none", "photo-corners", "photo-vines", "photo-scatter"] as const;
type BgOption = (typeof BG_OPTIONS)[number];
const isBg = (v: string | null | undefined): v is BgOption => !!v && (BG_OPTIONS as readonly string[]).includes(v);
function bgCookie(req: Request): string | null {
  const m = /(?:^|;\s*)hb_bg=([a-z-]{1,20})(?:;|$)/.exec(req.headers.get("cookie") ?? "");
  return m && isBg(m[1]) ? (m[1] ?? null) : null;
}
const BACK = /^\/(?:contacts|direct|approve\/[a-f0-9]{32})$/;
const LABELS: Record<BgOption, string> = {
  none: "None", "photo-corners": "Corners", "photo-vines": "Vines", "photo-scatter": "Scatter",
};
const LEAF = (x: number, y: number, r: number, s: number) => `<path transform="translate(${x},${y}) rotate(${r}) scale(${s})" d="M0,0C5,-5,14,-5,22,0C14,5,5,5,0,0Z"/>`;
/** Tiny inline thumbnails (no fetch, so they work under default-src 'none'). */
const MINI: Record<LeavesOption, string> = {
  corners: LEAF(0, 2, 30, 1) + LEAF(2, 0, 70, 0.8) + LEAF(64, 34, 210, 1) + LEAF(62, 36, 250, 0.8) + LEAF(64, 2, 150, 0.9) + LEAF(0, 34, -30, 0.9),
  vines: LEAF(3, 4, 30, 0.6) + LEAF(5, 14, -20, 0.6) + LEAF(3, 24, 30, 0.6) + LEAF(61, 6, 150, 0.6) + LEAF(59, 16, 200, 0.6) + LEAF(61, 26, 150, 0.6),
  scatter: LEAF(6, 6, 40, 0.5) + LEAF(54, 8, 120, 0.5) + LEAF(10, 28, -60, 0.5) + LEAF(50, 28, 200, 0.5) + LEAF(32, 3, 10, 0.4),
};
function thumb(o: BgOption, images: boolean): string {
  if (o === "none") return `<span class=hb-th></span>`;
  const base = o.startsWith("photo-") ? (o.slice(6) as LeavesOption) : (o as LeavesOption);
  if (o.startsWith("photo-") && images) return `<span class="hb-th hb-th-${o}"></span>`;
  return `<span class=hb-th><svg viewBox="0 0 64 36" fill="#a3b04e" fill-opacity=".6">${MINI[base]}</svg></span>`;
}
/**
 * The picker. `images` is true only on /contacts, which can run a nonce'd script and load images:
 * radios (visually hidden, still in the tab and accessibility order) post on change. Other pages
 * have default-src 'none', so each tile is a submit button: one click posts, with no separate Apply.
 * A noscript Apply remains on /contacts for a browser that has scripts turned off.
 */
export function pickerFor(req: Request, back: string, images = false): string {
  const q = new URL(req.url).searchParams.get("leaves");
  const cur: BgOption = isBg(q) ? q : (bgCookie(req) as BgOption | null) ?? (HARBOR_LEAVES_DEFAULT as BgOption);
  const safe = BACK.test(back) ? back : "/contacts";
  const tile = (o: BgOption) => `${thumb(o, images)}<span>${LABELS[o]}</span>`;
  const opts = images
    ? BG_OPTIONS.map((o) => `<input class=vh type=radio name=leaves id="hb-${o}" value="${o}"${o === cur ? " checked" : ""}><label class=hb-opt for="hb-${o}">${tile(o)}</label>`).join("")
    : BG_OPTIONS.map((o) => `<button type=submit class=hb-opt name=leaves value="${o}" aria-pressed=${o === cur}>${tile(o)}</button>`).join("");
  const fallback = images ? "<noscript><button>Apply</button></noscript>" : "";
  return `<details class=hb-pick><summary>Background</summary><form method=post action="/harbor/background"${images ? " id=hb-bg" : ""}><fieldset><legend class=vh>Page background</legend><div class=hb-grid>${opts}</div></fieldset><input type=hidden name=back value="${safe}">${fallback}</form></details>`;
}
/** POST /harbor/background: same-origin form only; sets the cookie and goes back to the page. */
export async function setBackground(req: Request): Promise<Response> {
  const origin = req.headers.get("origin");
  if (origin !== null && origin !== new URL(req.url).origin) return new Response("forbidden", { status: 403 });
  const f = new URLSearchParams(await req.text());
  const v = f.get("leaves");
  const back = f.get("back") ?? "";
  if (!isBg(v) || !BACK.test(back)) return new Response("bad request", { status: 400 });
  return new Response(null, { status: 303, headers: { location: back, "set-cookie": `${BG_COOKIE}=${v}; Path=/; Max-Age=31536000; Secure; HttpOnly; SameSite=Lax`, "cache-control": "no-store" } });
}
