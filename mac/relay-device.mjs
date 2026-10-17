#!/usr/bin/env node
// Mac helper for DELIVERY=mac. It polls the relay over outbound HTTPS only (no inbound port, no tunnel),
// sends each claimed text with `imsg send` (Apple's public Messages AppleScript surface; SIP stays on), and
// reports the outcome once. It never retries a send: one claim, one imsg call, one result.
// Zero dependencies. Node 18+. Config comes from the LaunchAgent (see install.sh); the token from the Keychain.
import { execFile, execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const MIN_IMSG = [0, 14, 0]; // 0.14.0 added the delivery dispositions (not_started / may_have_completed / still_in_flight)
export const IMSG_TIMEOUT_MS = 90_000; // under the relay's 2-minute claim timeout
const HEX32 = /^[a-f0-9]{32}$/;
const E164 = /^\+[1-9]\d{6,14}$/;

/** True when `imsg --version` output is 0.14.0 or newer. */
export function versionOk(out) {
  const m = String(out).match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return false;
  const v = m.slice(1, 4).map(Number);
  for (let i = 0; i < 3; i++) if (v[i] !== MIN_IMSG[i]) return v[i] > MIN_IMSG[i];
  return true;
}

/** RELAY_URL must be https:// with a bare host (the request host). Returns the origin. */
export function relayOrigin(raw) {
  let u;
  try {
    u = new URL(String(raw));
  } catch {
    throw new Error("RELAY_URL must be a URL like https://api.example.com");
  }
  if (u.protocol !== "https:") throw new Error("RELAY_URL must use https://");
  if (u.username || u.password || u.search || u.hash || (u.pathname !== "/" && u.pathname !== "")) throw new Error("RELAY_URL must be just the host, like https://api.example.com");
  return u.origin;
}

/**
 * imsg's result → the relay's outcome. imsg prints {"status":"sent"} (plus id/guid when it saw the row in
 * chat.db) and exits 0 on success. On failure it exits non-zero and names one disposition:
 * not_started (never dispatched), may_have_completed or still_in_flight (unknown; never retry). Where imsg runs
 * its ghost-row / no-row check (chat targets and existing direct chats; not a first text to a new number) it
 * reports may_have_completed, so "sent but not delivered" lands in "uncertain", not "sent". A ghost row imsg
 * doesn't check can still come back as "sent" or "sent_unverified".
 */
export function classify({ code, stdout, stderr, timedOut }) {
  if (timedOut) return { outcome: "uncertain", detail: "imsg_timeout" };
  
  if (code === 0) {
    const lines = String(stdout).trim().split("\n").filter(Boolean);
    let j = null;
    try {
      j = JSON.parse(lines.at(-1) ?? "");
    } catch {
      return { outcome: "uncertain", detail: "imsg_unexpected_output" };
    }
    if (!j || j.status !== "sent") return { outcome: "uncertain", detail: "imsg_unexpected_output" };
    // No row id = imsg couldn't read chat.db (no Full Disk Access), so it couldn't confirm the row.
    return j.id !== undefined || j.guid ? { outcome: "sent", detail: "imsg_row_confirmed" } : { outcome: "sent_unverified", detail: "imsg_no_db_access" };
  }
  const err = String(stderr);
  if (err.includes("(not_started)")) return { outcome: "not_started", detail: "imsg_not_started" };
  if (err.includes("(may_have_completed)")) return { outcome: "uncertain", detail: "imsg_may_have_completed" };
  if (err.includes("(still_in_flight)")) return { outcome: "uncertain", detail: "imsg_still_in_flight" };
  return { outcome: "uncertain", detail: `imsg_exit_${Number.isInteger(code) ? code : "signal"}` };
}

/** Run imsg with a hard timeout. Arguments go straight to the process (no shell), so text can't inject. */
export function imsgRunner(path, timeoutMs = IMSG_TIMEOUT_MS) {
  return (args) =>
    new Promise((resolve) => {
      execFile(path, args, { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
        const timedOut = Boolean(err && (err.killed || err.signal === "SIGKILL")); // only our timeout sends SIGKILL
        const code = err ? (typeof err.code === "number" ? err.code : null) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr), timedOut });
      });
    });
}

/** The device token, from the login Keychain (install.sh puts it there). Never from a file or the environment. */
export function keychainToken(service) {
  return execFileSync("/usr/bin/security", ["find-generic-password", "-s", service, "-w"], { encoding: "utf8" }).trim();
}

/**
 * One poll: claim at most one job, send it once, report once. Returns what happened, for the log line.
 * Log lines carry the job id prefix and the outcome only: never the number or the text.
 */
export async function pollOnce({ origin, token, fetch: f = fetch, runImsg, log = () => {} }) {
  const headers = { Authorization: `Bearer ${token}`, "content-type": "application/json" };
  const r = await f(`${origin}/device/next`, { method: "POST", headers });
  if (!r.ok) {
    log(`poll_status_${r.status}`);
    return { state: "poll_failed", status: r.status };
  }
  const body = await r.json();
  const job = body && body.job;
  if (!job) return { state: "idle" };
  if (!HEX32.test(job.id ?? "") || !HEX32.test(job.lease ?? "")) {
    log("bad_job_ids");
    return { state: "bad_job" };
  }
  let res;
  if (typeof job.to !== "string" || !E164.test(job.to) || typeof job.text !== "string" || !job.text) {
    res = { outcome: "not_started", detail: "helper_bad_job" }; // imsg never ran
  } else {
    // "--opt=value": imsg takes everything after the first "=" verbatim, so a text starting with "-" (or "--")
    // is never read as an option.
    res = classify(await runImsg(["send", `--to=${job.to}`, `--text=${job.text}`, "--service", "auto", "--json"]));
  }
  const report = JSON.stringify({ id: job.id, lease: job.lease, outcome: res.outcome, detail: res.detail });
  // Reporting can be repeated safely (the relay records one result per claim); the SEND is never repeated.
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const rr = await f(`${origin}/device/result`, { method: "POST", headers, body: report });
      if (rr.ok || rr.status === 409) {
        log(`job_id=${job.id.slice(0, 8)} outcome=${res.outcome} detail=${res.detail}${rr.status === 409 ? " report=already_closed" : ""}`);
        return { state: "done", ...res };
      }
      log(`job_id=${job.id.slice(0, 8)} report_status_${rr.status}`);
      if (rr.status < 500) break;
    } catch {
      log(`job_id=${job.id.slice(0, 8)} report_network_error attempt=${attempt}`);
    }
    await new Promise((s) => setTimeout(s, 2000 * attempt));
  }
  return { state: "report_failed", ...res };
}

async function main() {
  const log = (m) => console.log(`${new Date().toISOString()} ${m}`);
  if (process.platform !== "darwin") throw new Error("this helper runs on macOS only");
  const origin = relayOrigin(process.env.RELAY_URL);
  const imsg = process.env.IMSG_PATH || "imsg";
  const service = process.env.KEYCHAIN_SERVICE || "sms-relay-device-token";
  const pollMs = Math.max(2, Number(process.env.POLL_SECONDS) || 5) * 1000;
  const version = execFileSync(imsg, ["--version"], { encoding: "utf8" });
  if (!versionOk(version)) throw new Error(`imsg ${version.trim()} is too old; 0.14.0 or newer is required (brew upgrade imsg)`);
  if (process.argv.includes("--check")) {
    keychainToken(service); // throws if the token isn't in the Keychain
    log(`ok: imsg ${version.trim()}, token found, relay ${origin}`);
    return;
  }
  const runImsg = imsgRunner(imsg);
  log(`started: relay ${origin}, imsg ${version.trim()}, poll every ${pollMs / 1000}s`);
  for (;;) {
    let wait = pollMs;
    try {
      const token = keychainToken(service); // read each time, so rotating the Keychain item takes effect
      const r = await pollOnce({ origin, token, runImsg, log });
      if (r.state === "done") wait = 0; // more may be queued
      if (r.state === "poll_failed") wait = r.status === 401 || r.status === 503 ? 60_000 : 15_000;
    } catch (e) {
      log(`error ${e instanceof Error ? e.name : "unknown"}`); // never the message: it could quote a reply
      wait = 30_000;
    }
    await new Promise((s) => setTimeout(s, wait));
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => {
    console.error(`relay-device: ${e instanceof Error ? e.message : e}`);
    process.exit(78); // EX_CONFIG: launchd's KeepAlive throttles restarts
  });
}
