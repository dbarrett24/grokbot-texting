// The Everyday Harbor look: one plain CSS file (src/harbor.css) inlined into each page's existing <style>, plus the
// Source Serif 4 heading font (OFL 1.1, Latin subset, src/assets/) served by the Worker itself. No CDN, no CSP change:
// /contacts already allows same-origin fonts (default-src 'self'); /direct and /approve/* (default-src 'none') get the
// CSS without the @font-face, so their headings use the Georgia fallback.
import css from "./harbor.css";
import font from "./assets/source-serif-4-latin-600.woff2";

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
