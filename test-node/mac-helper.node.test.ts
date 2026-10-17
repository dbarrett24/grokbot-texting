import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error plain .mjs script, no types
import { versionOk, relayOrigin, classify, imsgRunner, pollOnce } from "../mac/relay-device.mjs";

// The Mac helper, exercised off the Mac: a fake `imsg` executable (a node script) stands in for the real one,
// and a fake relay answers /device/next and /device/result. Nothing here can send a real message.
const JOB = { id: "a".repeat(32), lease: "b".repeat(32), to: "+15555550101", text: "see you at 6", result_by_ms: 0 };
let dir: string;
let fakeImsg: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-device-"));
  fakeImsg = join(dir, "imsg");
  // Behaviour comes from FAKE_MODE in a side file; every call's argv is appended to calls.jsonl.
  writeFileSync(fakeImsg, `#!/usr/bin/env node
const fs = require("fs");
fs.appendFileSync(${JSON.stringify(join(dir, "calls.jsonl"))}, JSON.stringify(process.argv.slice(2)) + "\\n");
const mode = fs.readFileSync(${JSON.stringify(join(dir, "mode"))}, "utf8").trim();
if (mode === "sent") { console.log(JSON.stringify({ status: "sent", id: 42, guid: "G-1" })); process.exit(0); }
if (mode === "sent_nodb") { console.log(JSON.stringify({ status: "sent" })); process.exit(0); }
if (mode === "ghost") { console.error("applescript send failed (may_have_completed): no outgoing row joined the chat. The operation may execute or may already have executed; retry is not safe."); process.exit(1); }
if (mode === "not_started") { console.error("applescript send failed (not_started): target resolution failed. The operation did not start; retry is safe."); process.exit(1); }
if (mode === "hang") { setTimeout(() => {}, 60000); }
`);
  chmodSync(fakeImsg, 0o755);
});
const setMode = (m: string) => writeFileSync(join(dir, "mode"), m);
const imsgCalls = () => (existsSync(join(dir, "calls.jsonl")) ? readFileSync(join(dir, "calls.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const resetCalls = () => writeFileSync(join(dir, "calls.jsonl"), "");

function fakeRelay(opts: { job?: unknown; resultStatus?: number[] } = {}) {
  const posts: { url: string; auth: string | null; body: any }[] = [];
  const statuses = [...(opts.resultStatus ?? [200])];
  const f = async (url: string, init: { headers: Record<string, string>; body?: string }) => {
    posts.push({ url, auth: init.headers.Authorization, body: init.body ? JSON.parse(init.body) : null });
    if (url.endsWith("/device/next")) return new Response(JSON.stringify({ job: opts.job === undefined ? JOB : opts.job }), { status: 200 });
    return new Response("{}", { status: statuses.shift() ?? 200 });
  };
  return { f, posts, results: () => posts.filter((p) => p.url.endsWith("/device/result")).map((p) => p.body) };
}

describe("imsg version gate (0.6.0+, for the macOS 26 ghost-row check)", () => {
  it.each([["0.6.0", true], ["imsg 0.17.0", true], ["1.0.0", true], ["0.5.9", false], ["0.5.10", false], ["garbage", false]])("%j → %s", (v, ok) => {
    expect(versionOk(v)).toBe(ok);
  });
});

describe("RELAY_URL: outbound HTTPS to the bare request host only", () => {
  it("accepts https://host", () => expect(relayOrigin("https://api.example.com")).toBe("https://api.example.com"));
  it.each(["http://api.example.com", "https://api.example.com/device/next", "https://u:p@api.example.com", "api.example.com", "https://api.example.com/?x=1"])("refuses %j", (u) => {
    expect(() => relayOrigin(u)).toThrow();
  });
});

describe("imsg result → relay outcome", () => {
  it("sent with a confirmed row = sent", () => expect(classify({ code: 0, stdout: '{"status":"sent","id":7}\n', stderr: "", timedOut: false }).outcome).toBe("sent"));
  it("sent without chat.db access = sent_unverified", () => expect(classify({ code: 0, stdout: '{"status":"sent"}', stderr: "", timedOut: false }).outcome).toBe("sent_unverified"));
  it("ghost row / no row (may_have_completed) = uncertain, never sent", () =>
    expect(classify({ code: 1, stdout: "", stderr: "applescript send failed (may_have_completed): x", timedOut: false })).toEqual({ outcome: "uncertain", detail: "imsg_may_have_completed" }));
  it("still_in_flight = uncertain", () => expect(classify({ code: 1, stdout: "", stderr: "(still_in_flight)", timedOut: false }).outcome).toBe("uncertain"));
  it("not_started = not_started", () => expect(classify({ code: 1, stdout: "", stderr: "failed (not_started): y", timedOut: false }).outcome).toBe("not_started"));
  it("timeout = uncertain", () => expect(classify({ code: null, stdout: "", stderr: "", timedOut: true }).outcome).toBe("uncertain"));
  it("an unknown failure is uncertain, not safe to retry", () => expect(classify({ code: 2, stdout: "", stderr: "boom", timedOut: false })).toEqual({ outcome: "uncertain", detail: "imsg_exit_2" }));
  it("exit 0 with odd output is uncertain", () => expect(classify({ code: 0, stdout: "sent", stderr: "", timedOut: false }).outcome).toBe("uncertain"));
});

describe("pollOnce against a fake relay and a fake imsg process", () => {
  it("claims, runs imsg once with the job's number and text, and reports sent", async () => {
    setMode("sent");
    resetCalls();
    const relay = fakeRelay();
    const logs: string[] = [];
    const r = await pollOnce({ origin: "https://api.example.test", token: "TEST-ONLY-device", fetch: relay.f, runImsg: imsgRunner(fakeImsg), log: (m: string) => logs.push(m) });
    expect(r.state).toBe("done");
    expect(imsgCalls()).toEqual([["send", "--to", JOB.to, "--text", JOB.text, "--service", "auto", "--json"]]);
    expect(relay.results()).toEqual([{ id: JOB.id, lease: JOB.lease, outcome: "sent", detail: "imsg_row_confirmed" }]);
    expect(relay.posts.every((p) => p.auth === "Bearer TEST-ONLY-device")).toBe(true);
    // Log lines never carry the number or the text.
    expect(logs.join("\n")).not.toContain("5555550101");
    expect(logs.join("\n")).not.toContain("see you");
  });

  it.each([["ghost", "uncertain"], ["not_started", "not_started"], ["sent_nodb", "sent_unverified"]])("imsg %s → reports %s, imsg ran once", async (mode, outcome) => {
    setMode(mode);
    resetCalls();
    const relay = fakeRelay();
    await pollOnce({ origin: "https://api.example.test", token: "t", fetch: relay.f, runImsg: imsgRunner(fakeImsg) });
    expect(imsgCalls()).toHaveLength(1);
    expect(relay.results()[0].outcome).toBe(outcome);
  });

  it("a hung imsg is killed at the timeout and reported uncertain", async () => {
    setMode("hang");
    resetCalls();
    const relay = fakeRelay();
    const r = await pollOnce({ origin: "https://api.example.test", token: "t", fetch: relay.f, runImsg: imsgRunner(fakeImsg, 500) });
    expect(r).toMatchObject({ outcome: "uncertain", detail: "imsg_timeout" });
  });

  it("no retry: when reporting fails, the report is retried but the send never is", async () => {
    setMode("sent");
    resetCalls();
    const relay = fakeRelay({ resultStatus: [502, 502, 502] });
    const r = await pollOnce({ origin: "https://api.example.test", token: "t", fetch: relay.f, runImsg: imsgRunner(fakeImsg) });
    expect(r.state).toBe("report_failed");
    expect(imsgCalls()).toHaveLength(1);
    expect(relay.results()).toHaveLength(3);
  }, 20_000);

  it("409 (already recorded or timed out) closes the job without another send", async () => {
    setMode("sent");
    resetCalls();
    const relay = fakeRelay({ resultStatus: [409] });
    expect((await pollOnce({ origin: "https://api.example.test", token: "t", fetch: relay.f, runImsg: imsgRunner(fakeImsg) })).state).toBe("done");
    expect(imsgCalls()).toHaveLength(1);
  });

  it("an empty queue never runs imsg", async () => {
    resetCalls();
    const relay = fakeRelay({ job: null });
    expect((await pollOnce({ origin: "https://api.example.test", token: "t", fetch: relay.f, runImsg: imsgRunner(fakeImsg) })).state).toBe("idle");
    expect(imsgCalls()).toHaveLength(0);
  });

  it("a malformed job (number not E.164) is reported not_started and imsg never runs", async () => {
    resetCalls();
    const relay = fakeRelay({ job: { ...JOB, to: "Mom" } });
    await pollOnce({ origin: "https://api.example.test", token: "t", fetch: relay.f, runImsg: imsgRunner(fakeImsg) });
    expect(imsgCalls()).toHaveLength(0);
    expect(relay.results()[0]).toMatchObject({ outcome: "not_started", detail: "helper_bad_job" });
  });
});
