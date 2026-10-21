// The Everyday Harbor look: one plain CSS file (src/harbor.css) inlined into each page's existing <style>, plus the
// Source Serif 4 heading font (OFL 1.1, Latin subset, src/assets/) served by the Worker itself. No CDN, no CSP change:
// /contacts already allows same-origin fonts (default-src 'self'); /direct and /approve/* (default-src 'none') get the
// CSS without the @font-face, so their headings use the Georgia fallback.
import css from "./harbor.css";
import font from "./assets/source-serif-4-latin-600.woff2";
import { HARBOR_LEAVES, type LeavesOption } from "./harbor-leaves";

export const HARBOR_FONT_PATH = "/harbor/source-serif-4-latin-600.woff2";
const FONT_FACE = /\/\* @font-face:[\s\S]*?\/\* @end font-face \*\//;
const minify = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s*\n\s*/g, "").trim();
/** For pages whose CSP allows same-origin fonts. */
export const HARBOR_CSS = minify(css);
/** For pages whose CSP has no font source (default-src 'none'). */
export const HARBOR_CSS_NO_FONT = minify(css.replace(FONT_FACE, ""));

export function harborFont(): Response {
  return new Response(font, {
    headers: { "content-type": "font/woff2", "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff" },
  });
}

// Leaf backdrop mockups (draft): original inline SVG (src/harbor-leaves.ts), so no fetch and no CSP change on any page.
// Pick one at build time with HARBOR_LEAVES_DEFAULT, or preview with ?leaves=corners|vines|scatter|none.
export const HARBOR_LEAVES_DEFAULT: LeavesOption | "none" = "none";
const isLeaves = (v: string | null): v is LeavesOption => v !== null && Object.hasOwn(HARBOR_LEAVES, v);
/** The leaf layer markup for this request ("" for none). */
export function leavesFor(req: Request): string {
  const q = new URL(req.url).searchParams.get("leaves");
  const pick = q === "none" ? "none" : isLeaves(q) ? q : HARBOR_LEAVES_DEFAULT;
  return pick === "none" ? "" : HARBOR_LEAVES[pick];
}
