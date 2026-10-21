// Wrangler module rules (wrangler.toml [[rules]]): .css imports as text, .woff2 as bytes.
declare module "*.css" { const text: string; export default text; }
declare module "*.woff2" { const bytes: ArrayBuffer; export default bytes; }
declare module "*.webp" { const bytes: ArrayBuffer; export default bytes; }
