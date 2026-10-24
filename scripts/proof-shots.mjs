// @ts-check
// Screenshots and contrast for the v2 pages. Not part of npm test (Chrome is optional).
// Usage: node scripts/proof-shots.mjs
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync, rmSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { build } from "esbuild";

const ROOT = process.cwd();
const HTML_DIR = "/tmp/proof-html";
const OUT = "/opt/cursor/artifacts/screenshots";
const CHROME = "/opt/google/chrome/chrome";
const ENTRY = "/tmp/proof-render.mjs";

const ENTRY_SRC = [
  'import { mkdirSync, writeFileSync } from "node:fs";',
  'import { HARBOR_CSS, leavesFor, pickerFor } from "./src/harbor.ts";',
  'import { countsLine, renderApproveList, renderLog, renderShell } from "./src/pages.ts";',
  'import { renderContactsPage } from "./src/contacts.ts";',
  "const dir = process.argv[2];",
  "if (!dir) throw new Error('dir');",
  "mkdirSync(dir, { recursive: true });",
  'const nonce = "ab".repeat(16);',
  "function leaf(path, q) {",
  "  const req = new Request('https://approve.example.test' + path + '?leaves=' + q);",
  "  const back = path.startsWith('/approve/') ? path : path;",
  "  return leavesFor(req, true) + pickerFor(req, back, true);",
  "}",
  "function write(name, current, path, q, body) {",
  "  const html = renderShell({ nonce, css: HARBOR_CSS, leaves: leaf(path, q), current, body, script: '' });",
  "  writeFileSync(dir + '/' + name + '.html', html);",
  "}",
  "const item = {",
  '  id: "ab".repeat(16), label: "Test Friend", e164: "+15555550101",',
  '  text: "dinner at the usual place", csrf: "cd".repeat(16), open: true,',
  '  status: "expires in 15 min", sha: "ef".repeat(6),',
  "};",
  "const logItem = {",
  '  id: "ab".repeat(16), direction: "in", mask: "\\u20260101", body: "dinner at the usual place", when: "Oct 16, 6:00 PM",',
  "};",
  "const logOut = {",
  '  id: "cd".repeat(16), direction: "out", mask: "\\u20260102", body: null, when: "Oct 16, 6:05 PM",',
  "};",
  "const direct = [",
  "  '<h2>Direct send</h2>',",
  "  '<p><a href=\"/contacts\">Contacts page</a>: choose who the bot may text.</p>',",
  "  '<p><b>DIRECT_SEND:</b> off \\u00b7 <b>runaway guard:</b> on</p>',",
  "  '<p><b>State:</b> running</p>',",
  "  '<p><b>Direct sends in the last hour:</b> 0</p>',",
  "  '<p><b>Delivery:</b> mac</p>',",
  "  '<p><b>last poll:</b> never</p>',",
  "  '<p><b>queued:</b> 0</p>',",
  "  '<p><b>DEFAULT_COUNTRY_CODE:</b> +1</p>',",
  "  '<p><b>Direct list:</b> empty</p>',",
  "].join('');",
  "function writeContacts(tag, q) {",
  "  const html = renderContactsPage({",
  "    leaves: leaf('/contacts', q),",
  "    csrf: 'cd'.repeat(16),",
  "    nonce,",
  "    migratedOn: 0,",
  "    lastError: null,",
  "    canSync: false,",
  "    toast: null,",
  "    hashKeyMissing: false,",
  "    google: { tokenKey: 'ok', client: null, redirectUri: 'https://approve.example.test/contacts/google/callback', accounts: [], leftovers: [], keyStatus: { total: 0, onOld: 0 } },",
  "    googleError: null,",
  "    lastSync: null,",
  "  });",
  "  writeFileSync(dir + '/contacts-' + tag + '.html', html.replace(/<script type=module[\\s\\S]*<\\/script>/, ''));",
  "}",
  "for (const q of ['photo-vines', 'photo-corners']) {",
  "  const tag = q === 'photo-vines' ? 'vines' : 'photo';",
  "  writeContacts(tag, q);",
  "  write('approve-' + tag, 'approve', '/approve', q, countsLine(1, 1) + renderApproveList([item], false));",
  "  write('approve-empty-' + tag, 'approve', '/approve', q, countsLine(0, 0) + renderApproveList([], false));",
  "  write('approve-error-' + tag, 'approve', '/approve', q, countsLine(0, 0) + renderApproveList([], true));",
  "  write('direct-' + tag, 'direct', '/direct', q, direct);",
  "  write('log-' + tag, 'log', '/log', q, renderLog([logItem, logOut], false));",
  "  write('log-empty-' + tag, 'log', '/log', q, renderLog([], false));",
  "  write('log-error-' + tag, 'log', '/log', q, renderLog([], true));",
  "}",
].join("\n");

/** @param {string} cmd @param {string[]} args */
function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    child.stderr.on("data", (b) => { err += String(b); });
    child.on("error", reject);
    child.on("close", (code) => { if (code === 0) resolve(undefined); else reject(new Error(cmd + " " + String(code) + " " + err.slice(0, 400))); });
  });
}

/** @param {number} c */
function lin(c) {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}
/** @param {number[]} rgb */
function lum(rgb) {
  return 0.2126 * lin(rgb[0] ?? 0) + 0.7152 * lin(rgb[1] ?? 0) + 0.0722 * lin(rgb[2] ?? 0);
}
/** @param {number[]} a @param {number[]} b */
function ratio(a, b) {
  const hi = Math.max(lum(a), lum(b));
  const lo = Math.min(lum(a), lum(b));
  return (hi + 0.05) / (lo + 0.05);
}
/** @param {number} b @param {number} s */
function soft(b, s) {
  if (s <= 0.5) return b - (1 - 2 * s) * b * (1 - b);
  const d = b <= 0.25 ? ((16 * b - 12) * b + 4) * b : Math.sqrt(b);
  return b + (2 * s - 1) * (d - b);
}
/** @param {number[]} dst @param {number[]} src @param {number} a */
function over(dst, src, a) {
  return [0, 1, 2].map((i) => (src[i] ?? 0) * a + (dst[i] ?? 0) * (1 - a));
}

/** Lightest card colour over this photo: soft-light on the backdrop, then the glass and the white sheen.
 * @param {number[]} photo */
function cardOver(photo) {
  const bases = [
    [11, 22, 38],
    over([11, 22, 38], [91, 155, 216], 0.34),
    over([11, 22, 38], [227, 179, 65], 0.3),
  ];
  let lightest = [0, 0, 0];
  let best = -1;
  for (const base of bases) {
    const blended = [0, 1, 2].map((i) => soft((base[i] ?? 0) / 255, (photo[i] ?? 0) / 255) * 255);
    const glass = over(blended, [14, 28, 48], 0.42);
    const sheen = over(glass, [255, 255, 255], 0.09);
    const L = lum(sheen);
    if (L > best) { best = L; lightest = sheen; }
  }
  return lightest;
}

async function contrast() {
  /** @type {Record<string, { text: number, ui: number }>} */
  const out = {};
  // #b9c5d3 is --h-muted, the support link. Text must stay at or above 4.5:1.
  const text = [[238, 242, 246], [185, 197, 211], [142, 197, 232], [247, 162, 157], [180, 193, 90]];
  const ui = [[107, 137, 173], [186, 122, 37]];
  for (const name of ["vines-1024.webp", "corners-1024.webp", "vines-640.webp", "corners-640.webp"]) {
    const file = join(ROOT, "src/assets/leaves", name);
    const probe = await probeSize(file);
    const [w, h] = String(probe).split(",").map((n) => Number(n));
    if (!w || !h) throw new Error("size " + name);
    const pixels = await rawRgb(file);
    let textMin = 99;
    let uiMin = 99;
    // #0009 scrim: each channel is the photo scaled by 1 - 0x99/255, matching --hl-scrim.
    const scrim = 1 - 0x99 / 255;
    for (let i = 0; i < pixels.length; i += 3) {
      const photo = [(pixels[i] ?? 0) * scrim, (pixels[i + 1] ?? 0) * scrim, (pixels[i + 2] ?? 0) * scrim];
      const card = cardOver(photo);
      for (const c of text) textMin = Math.min(textMin, ratio(c, card));
      for (const c of ui) uiMin = Math.min(uiMin, ratio(c, card));
    }
    const solid = ratio([238, 242, 246], [18, 34, 58]);
    const mutedSolid = ratio([185, 197, 211], [18, 34, 58]);
    const current = ratio([11, 22, 38], [238, 242, 246]);
    out[name] = { text: Math.min(textMin, solid, mutedSolid, current), ui: uiMin };
    if (out[name].text < 4.5 || out[name].ui < 3) throw new Error(name + " contrast text " + String(out[name].text) + " ui " + String(out[name].ui));
  }
  return out;
}

/** @param {string} file @returns {Promise<string>} */
function probeSize(file) {
  return new Promise((resolve, reject) => {
    const child = spawn("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", file], { stdio: ["ignore", "pipe", "pipe"] });
    let buf = "";
    child.stdout.on("data", (/** @type {Buffer} */ b) => { buf += String(b); });
    child.on("error", reject);
    child.on("close", (code) => { if (code === 0) resolve(buf.trim()); else reject(new Error("ffprobe")); });
  });
}

/** @param {string} file @returns {Promise<Buffer>} */
function rawRgb(file) {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", ["-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { stdio: ["ignore", "pipe", "pipe"] });
    /** @type {Buffer[]} */
    const chunks = [];
    child.stdout.on("data", (/** @type {Buffer} */ b) => { chunks.push(b); });
    child.on("error", reject);
    child.on("close", (code) => { if (code === 0) resolve(Buffer.concat(chunks)); else reject(new Error("ffmpeg")); });
  });
}

/** @param {number} port @returns {Promise<import("node:http").Server>} */
function serve(port) {
  /** @type {Record<string, string>} */
  const types = { ".html": "text/html", ".svg": "image/svg+xml", ".webp": "image/webp", ".woff2": "font/woff2" };
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const path = decodeURIComponent(new URL(req.url ?? "/", "http://127.0.0.1").pathname);
      let file = "";
      if (path.startsWith("/harbor/leaves/")) file = join(ROOT, "src/assets/leaves", path.slice("/harbor/leaves/".length));
      else if (path === "/harbor/grokbot-logo.svg") file = join(ROOT, "src/assets/grokbot-logo.svg");
      else if (path === "/harbor/source-serif-4-latin-600.woff2") file = join(ROOT, "src/assets/source-serif-4-latin-600.woff2");
      else if (path.endsWith(".html")) file = join(HTML_DIR, path.slice(1));
      const rel = normalize(file);
      if (!file || (!rel.startsWith(HTML_DIR) && !rel.startsWith(join(ROOT, "src/assets")))) { res.writeHead(404); res.end("no"); return; }
      try {
        const body = readFileSync(rel);
        res.writeHead(200, { "content-type": types[extname(rel)] ?? "application/octet-stream", "cache-control": "no-store" });
        res.end(body);
      } catch { res.writeHead(404); res.end("missing"); }
    });
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

const pages = ["contacts", "approve", "approve-empty", "approve-error", "direct", "log", "log-empty", "log-error"];
const bgs = ["vines", "photo"];
const widths = [1280, 375];

await build({
  stdin: { contents: ENTRY_SRC, resolveDir: ROOT, loader: "js", sourcefile: "proof-render.js" },
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: ENTRY,
  loader: { ".css": "text", ".svg": "text", ".woff2": "binary", ".webp": "binary" },
  logLevel: "silent",
});
rmSync(HTML_DIR, { recursive: true, force: true });
await run("node", [ENTRY, HTML_DIR]);
mkdirSync(OUT, { recursive: true });
const contrastRatios = await contrast();
const server = await serve(8765);
/** @type {string[]} */
const shots = [];
try {
  for (const page of pages) for (const bg of bgs) for (const width of widths) {
    const name = page + "-" + bg + "-" + String(width) + ".png";
    const dest = join(OUT, name);
    await run(CHROME, [
      "--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu",
      "--hide-scrollbars", "--force-device-scale-factor=1",
      "--user-data-dir=/tmp/chrome-proof-" + name,
      "--window-size=" + String(width) + ",900", "--virtual-time-budget=2500",
      "--screenshot=" + dest, "http://127.0.0.1:8765/" + page + "-" + bg + ".html",
    ]);
    if (statSync(dest).size < 1000) throw new Error("empty shot " + name);
    shots.push(name);
  }
} finally {
  server.close();
}
const summary = { shots, contrast: contrastRatios };
writeFileSync("/opt/cursor/artifacts/proof-shots.json", JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify(summary, null, 2));
