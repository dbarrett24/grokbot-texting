#!/usr/bin/env node
// LEGACY (google-connect): new deploys connect Google on the Contacts page instead (DEPLOY.md section 9),
// with the token sealed in the Worker. This script stays for deploys that use GOOGLE_RT_<LABEL> secrets.
// Run this on your own computer (macOS, Linux or Windows) once per Google account. It prints Google's
// consent link (read-only contacts scope) and tries to open it in your browser, catches the answer on a 127.0.0.1 loopback port, swaps the code for a refresh token, and pipes
// that token straight into `npx wrangler secret put GOOGLE_RT_<LABEL>`. The token is never printed and
// never written to disk.
//
//   export GOOGLE_CLIENT_ID=<client id from Google Cloud console>
//   export GOOGLE_CLIENT_SECRET=<typed at a hidden prompt; see DEPLOY.md>
//   node scripts/google-consent.mjs primary                     # sign in with the account for this label
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mainKind } from "./is-main.mjs";

export const SCOPE = "https://www.googleapis.com/auth/contacts.readonly";

export function labelToSecret(label) {
  const L = String(label ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9_]+$/.test(L) || L === "UPLOAD" || L.length > 32) throw new Error("label must be letters, digits or _ (and not UPLOAD)");
  return `GOOGLE_RT_${L}`;
}

export function authUrl({ clientId, redirect, challenge, state }) {
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  u.search = new URLSearchParams({
    client_id: clientId, redirect_uri: redirect, response_type: "code", scope: SCOPE,
    access_type: "offline", prompt: "consent select_account", code_challenge: challenge, code_challenge_method: "S256", state,
  }).toString();
  return u.toString();
}

/**
 * One-shot loopback listener on 127.0.0.1 for Google's redirect. Resolves with the code, or rejects on a
 * state mismatch, an error from Google, or after timeoutMs (default 5 minutes). The port is always closed.
 */
export function waitForCode({ state, onListening, timeoutMs = 5 * 60_000 }) {
  return new Promise((resolve, reject) => {
    let timer;
    const done = (fn, v) => { clearTimeout(timer); srv.close(); fn(v); };
    const srv = createServer((req, res) => {
      const u = new URL(req.url, "http://127.0.0.1");
      if (u.pathname !== "/cb") return res.writeHead(404).end();
      res.end("Done. You can close this tab.");
      if (u.searchParams.get("state") !== state) return done(reject, new Error("state mismatch"));
      const c = u.searchParams.get("code");
      c ? done(resolve, c) : done(reject, new Error(u.searchParams.get("error") || "no code"));
    }).listen(0, "127.0.0.1", () => onListening(`http://127.0.0.1:${srv.address().port}/cb`));
    timer = setTimeout(() => done(reject, new Error(`no answer from Google within ${Math.round(timeoutMs / 1000)} s; nothing was saved. Run it again.`)), timeoutMs);
  });
}

/**
 * Check Google's token response before anything is stored: the granted scope must be exactly
 * contacts.readonly (no more, no less, e.g. if the consent screen or client was changed), and there must
 * be a refresh token. Returns the refresh token; throws without echoing any token value.
 */
export function refreshTokenFrom(j) {
  if (!j || typeof j !== "object") throw new Error("token response was not JSON; nothing was saved");
  const granted = typeof j.scope === "string" ? j.scope.split(/\s+/).filter(Boolean) : [];
  if (granted.length !== 1 || granted[0] !== SCOPE) {
    const shown = granted.map((g) => g.replace(/[^\w:/.-]/g, "?").slice(0, 80)).join(" ") || "(none)";
    throw new Error(`Google granted scope "${shown}", not exactly ${SCOPE}; nothing was saved`);
  }
  if (typeof j.refresh_token !== "string" || !j.refresh_token) throw new Error("Google returned no refresh token; remove the app's access at myaccount.google.com/permissions and retry");
  return j.refresh_token;
}

/**
 * The command that opens a URL in the default browser on this platform: open (macOS), xdg-open (Linux and
 * other Unix), or cmd's start (Windows; the URL is quoted so its & characters reach the browser intact).
 */
export function openerFor(platform, url) {
  if (platform === "darwin") return { cmd: "open", args: [url], opts: {} };
  if (platform === "win32") return { cmd: "cmd", args: ["/d", "/s", "/c", `start "" "${url}"`], opts: { windowsVerbatimArguments: true } };
  return { cmd: "xdg-open", args: [url], opts: {} };
}

/**
 * Always print the URL first (works on any machine, including one with no desktop browser), then try to
 * open it. A failed opener is not an error: the printed link is the fallback. Returns true if it opened.
 */
export function showConsentUrl(url, { platform = process.platform, log = console.log, run = spawnSync } = {}) {
  log("Open this link in your browser to continue (it is also being opened for you):");
  log(url);
  const o = openerFor(platform, url);
  let r;
  try {
    r = run(o.cmd, o.args, { stdio: "ignore", ...o.opts });
  } catch {
    r = null;
  }
  const ok = !!r && !r.error && r.status === 0;
  if (!ok) log(`(Couldn't start ${o.cmd}; copy the link above into a browser on this computer.)`);
  return ok;
}

async function main() {
  const secretName = labelToSecret(process.argv[2]);
  const clientId = process.env.GOOGLE_CLIENT_ID, clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in this shell first");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(16).toString("hex");
  let redirect = "";
  const code = await waitForCode({
    state,
    onListening: (r) => {
      redirect = r;
      console.log(`Google consent for ${secretName}. Sign in with the account you want for this label.`);
      showConsentUrl(authUrl({ clientId, redirect: r, challenge, state }));
    },
  });
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirect, code_verifier: verifier }),
  });
  if (!r.ok) throw new Error(`token exchange failed: HTTP ${r.status}`);
  const rt = refreshTokenFrom(await r.json().catch(() => null));
  await new Promise((resolve, reject) => {
    const p = spawn("npx", ["wrangler", "secret", "put", secretName], { stdio: ["pipe", "inherit", "inherit"] });
    p.on("exit", (c) => (c === 0 ? resolve() : reject(new Error(`wrangler exit ${c}`))));
    p.stdin.end(rt);
  });
  console.log(`${secretName} set. Add the label to GOOGLE_ACCOUNTS in wrangler.toml if it isn't there yet.`);
}

if (mainKind(import.meta.url) === "main") main().catch((e) => { console.error(e.message); process.exit(1); });
