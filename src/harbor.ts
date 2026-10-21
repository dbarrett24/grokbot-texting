// The Everyday Harbor look: one plain CSS file (src/harbor.css) inlined into each page's existing <style>, plus the
// Source Serif 4 heading font (OFL 1.1, Latin subset, src/assets/) served by the Worker itself. No CDN, no CSP change:
// /contacts already allows same-origin fonts (default-src 'self'); /direct and /approve/* (default-src 'none') get the
// CSS without the @font-face, so their headings use the Georgia fallback.
import css from "./harbor.css";
import font from "./assets/source-serif-4-latin-600.woff2";
import { HARBOR_LEAVES, type LeavesOption } from "./harbor-leaves";
import cornersL from "./assets/leaves/corners-1024.webp";
import cornersS from "./assets/leaves/corners-640.webp";
import vinesL from "./assets/leaves/vines-1024.webp";
import vinesS from "./assets/leaves/vines-640.webp";
import scatterL from "./assets/leaves/scatter-1024.webp";
import scatterS from "./assets/leaves/scatter-640.webp";

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

// Leaf backdrop mockups (draft): original inline SVG (src/harbor-leaves.ts), so no fetch and no CSP change on any page.
// Photo variants (?leaves=photo-corners|photo-vines|photo-scatter): self-served WebP behind a token-coloured scrim.
// Images need an img source in the CSP. /contacts has one (default-src 'self'); /direct and /approve/* have
// default-src 'none', which blocks every image (data: URIs too), so there the photo option falls back to the
// matching SVG option. Pick one at build time with HARBOR_LEAVES_DEFAULT, or preview with ?leaves=.
type PhotoOption = `photo-${LeavesOption}`;
export const HARBOR_LEAVES_DEFAULT: LeavesOption | PhotoOption | "none" = "none";
const isLeaves = (v: string | null): v is LeavesOption => v !== null && Object.hasOwn(HARBOR_LEAVES, v);
const PHOTOS: Record<string, ArrayBuffer> = {
  "corners-1024": cornersL, "corners-640": cornersS, "vines-1024": vinesL, "vines-640": vinesS, "scatter-1024": scatterL, "scatter-640": scatterS,
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
  const q = new URL(req.url).searchParams.get("leaves");
  const photo = q?.startsWith("photo-") ? q.slice(6) : null;
  if (photo !== null && isLeaves(photo)) return images ? `<div class="hl-photo hl-photo-${photo}" aria-hidden=true></div>` : HARBOR_LEAVES[photo];
  const pick = q === "none" ? "none" : isLeaves(q) ? q : HARBOR_LEAVES_DEFAULT;
  if (pick === "none") return "";
  if (pick.startsWith("photo-")) { const o = pick.slice(6) as LeavesOption; return images ? `<div class="hl-photo hl-photo-${o}" aria-hidden=true></div>` : HARBOR_LEAVES[o]; }
  return HARBOR_LEAVES[pick as LeavesOption];
}
