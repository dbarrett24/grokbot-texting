// Wrangler module rules (wrangler.toml [[rules]]): .css and .svg import as text, .woff2/.webp as bytes.
declare module "*.css" { const text: string; export default text; }
declare module "*.svg" { const text: string; export default text; }
declare module "*.woff2" { const bytes: ArrayBuffer; export default bytes; }
declare module "*.webp" { const bytes: ArrayBuffer; export default bytes; }
