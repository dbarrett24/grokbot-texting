import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { harness, postRequest, approve, csrfOf, BASE, FRIEND, T0, type Harness } from "./helpers";

let h: Harness;
let logSpy: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  h = await harness();
  logSpy = vi.spyOn(console, "log");
});
afterEach(() => logSpy.mockRestore());

// The usual identity shape: email OTP via Cloudflare, no amr claim.
const OTP = { amr: undefined, idp: { id: "test-idp-id", type: "cloudflare" } };

async function newId(text = "otp test") {
  const r = await postRequest(h, { to: FRIEND, text });
  expect(r.status).toBe(202);
  return ((await r.json()) as { id: string }).id;
}
async function logRows() {
  // read the log with a normal passkey (amr) token so reading doesn't depend on the bypass
  await h.setEnv({ REQUIRED_AMR: "test-passkey-amr" });
  const r = await h.relay.fetch(`${BASE}/log`, { headers: { "Cf-Access-Jwt-Assertion": await h.jwt() } });
  return (await r.json()) as any[];
}
const reasons = () => logSpy.mock.calls.map((c: unknown[]) => String(c[0])).filter((s: string) => s.startsWith("access_denied reason="));

describe("ALLOW_EMAIL_OTP temporary bypass", () => {
  it.each([undefined, "0", "true", "yes", " 1", "1 "])("flag %j + email-OTP identity (no amr) → 403", async (flag) => {
    await h.setEnv({ ALLOW_EMAIL_OTP: flag as unknown as string });
    const id = await newId();
    const r = await approve(h, id, "approve", { jwt: await h.jwt(OTP), csrf: await csrfOf(h, id) });
    expect(r.status).toBe(403);
    expect(reasons()).toContain("access_denied reason=access_amr_not_passkey");
  });

  it("flag off + REQUIRED_AMR placeholder still fails closed", async () => {
    await h.setEnv({ ALLOW_EMAIL_OTP: "0", REQUIRED_AMR: "REPLACE_AFTER_SMOKE_TEST" });
    const id = await newId();
    expect((await approve(h, id, "approve", { jwt: await h.jwt(OTP), csrf: await csrfOf(h, id) })).status).toBe(403);
    expect(reasons()).toContain("access_denied reason=access_amr_not_configured");
  });

  it.each([
    ["idp null", { amr: undefined, idp: null }],
    ["idp without type", { amr: undefined, idp: { id: "x" } }],
    ["google idp", { amr: undefined, idp: { id: "x", type: "google" } }],
    ["onetimepin spelled differently", { amr: undefined, idp: { id: "x", type: "Cloudflare" } }],
    ["idp as a string", { amr: undefined, idp: "cloudflare" }],
  ])("flag on + %s + no amr → 403", async (_n, claims) => {
    await h.setEnv({ ALLOW_EMAIL_OTP: "1" });
    const id = await newId();
    expect((await approve(h, id, "approve", { jwt: await h.jwt(claims), csrf: await csrfOf(h, id) })).status).toBe(403);
    expect(h.messagesPosted().filter((m) => m)).toHaveLength(1); // only the notification
  });

  it.each([
    ["wrong email", { email: "someone@example.test" }, "access_wrong_identity"],
    ["wrong aud", { aud: ["other"] }, "access_jwt_aud"],
    ["wrong iss", { iss: "https://evil.cloudflareaccess.com" }, "access_jwt_iss"],
    ["expired", { exp: Math.floor(T0 / 1000) - 5 }, "access_jwt_expired"],
  ])("flag on + idp cloudflare + %s → 403", async (_n, over, code) => {
    await h.setEnv({ ALLOW_EMAIL_OTP: "1" });
    const id = await newId();
    expect((await approve(h, id, "approve", { jwt: await h.jwt({ ...OTP, ...over }), csrf: await csrfOf(h, id) })).status).toBe(403);
    expect(reasons()).toContain(`access_denied reason=${code}`);
  });

  it("flag on + idp cloudflare + bad signature → 403", async () => {
    await h.setEnv({ ALLOW_EMAIL_OTP: "1" });
    const id = await newId();
    const good = await h.jwt(OTP);
    const parts = good.split(".");
    const sig = parts[2];
    const mid = Math.floor(sig.length / 2);
    parts[2] = sig.slice(0, mid) + (sig[mid] === "A" ? "B" : "A") + sig.slice(mid + 1); // flip one signature char (always changes)
    const jwt = parts.join(".");
    expect((await approve(h, id, "approve", { jwt, csrf: await csrfOf(h, id) })).status).toBe(403);
    expect(reasons()).toContain("access_denied reason=access_jwt_signature");
  });

  it("flag on + idp cloudflare + right email → approval works and logs method=email_otp", async () => {
    await h.setEnv({ ALLOW_EMAIL_OTP: "1", REQUIRED_AMR: "REPLACE_AFTER_SMOKE_TEST" });
    const id = await newId("otp approved");
    const r = await approve(h, id, "approve", { jwt: await h.jwt(OTP) });
    expect(await r.json()).toMatchObject({ state: "sent" });
    expect(await h.decrypt(h.messagesPosted().at(-1).textMessage.text)).toBe("otp approved");
    const rows = await logRows();
    const approved = rows.find((x) => x.event === "approved");
    expect(approved.detail).toContain("method=email_otp");
    const via = rows.filter((x) => x.event === "approve_via_email_otp").map((x) => x.detail);
    expect(via).toContain("method=email_otp route=page"); // approve() loads the page for the CSRF value
    expect(via).toContain("method=email_otp route=decide");
    const s = JSON.stringify(rows);
    expect(s).not.toMatch(/eyJ/); // no JWT fragments
    expect(s).not.toContain("test-idp-id");
    expect(reasons()).toHaveLength(0);
  });

  it("passkey (amr) approvals log method=amr, even with the flag on", async () => {
    await h.setEnv({ ALLOW_EMAIL_OTP: "1" });
    const id = await newId();
    expect((await approve(h, id, "approve", { jwt: await h.jwt({ idp: { id: "x", type: "cloudflare" } }) })).status).toBe(200);
    const rows = await logRows();
    expect(rows.find((x) => x.event === "approved").detail).toContain("method=amr");
    expect(rows.some((x) => x.event === "approve_via_email_otp")).toBe(false);
  });

  it("deny logs the method too", async () => {
    await h.setEnv({ ALLOW_EMAIL_OTP: "1" });
    const id = await newId();
    expect((await approve(h, id, "deny", { jwt: await h.jwt(OTP) })).status).toBe(200);
    expect((await logRows()).find((x) => x.event === "denied").detail).toContain("method=email_otp");
  });

  it("console.log carries only the reason code, never the token", async () => {
    await h.setEnv({ ALLOW_EMAIL_OTP: "0" });
    const id = await newId();
    const jwt = await h.jwt(OTP);
    await approve(h, id, "approve", { jwt, csrf: await csrfOf(h, id) });
    const all = logSpy.mock.calls.map((c: unknown[]) => c.map(String).join(" ")).join("\n");
    expect(all).toContain("access_denied reason=access_amr_not_passkey");
    expect(all).not.toContain(jwt.split(".")[1]);
    expect(all).not.toContain("approver@example.test");
  });
});

describe("bypass log rows name the route", () => {
  it("a log read with an email-OTP token is logged as route=log, not as an approval", async () => {
    await h.setEnv({ ALLOW_EMAIL_OTP: "1", REQUIRED_AMR: "REPLACE_AFTER_SMOKE_TEST" });
    const r = await h.relay.fetch(`${BASE}/log`, { headers: { "Cf-Access-Jwt-Assertion": await h.jwt({ amr: undefined, idp: undefined }) } });
    expect(r.status).toBe(200);
    const rows = await logRows();
    expect(rows.filter((x) => x.event === "approve_via_email_otp_or_policy").map((x) => x.detail)).toEqual(["method=email_otp_or_policy route=log"]);
    expect(rows.some((x) => x.event === "approved")).toBe(false);
  });
});

describe("ALLOW_EMAIL_OTP fallback: no amr AND no idp → method=email_otp_or_policy", () => {
  const NONE = { amr: undefined, idp: undefined }; // JSON.stringify drops both claims entirely

  it("flag on + no amr + no idp + right email → approval works, logs method=email_otp_or_policy", async () => {
    await h.setEnv({ ALLOW_EMAIL_OTP: "1", REQUIRED_AMR: "REPLACE_AFTER_SMOKE_TEST" });
    const id = await newId("policy approved");
    expect(await (await approve(h, id, "approve", { jwt: await h.jwt(NONE) })).json()).toMatchObject({ state: "sent" });
    const rows = await logRows();
    expect(rows.find((x) => x.event === "approved").detail).toContain("method=email_otp_or_policy");
    expect(rows.some((x) => x.event === "approve_via_email_otp_or_policy")).toBe(true);
    expect(rows.some((x) => x.event === "approve_via_email_otp")).toBe(false);
  });

  it.each([undefined, "0", "true", "1 "])("flag %j + no amr + no idp → 403", async (flag) => {
    await h.setEnv({ ALLOW_EMAIL_OTP: flag as unknown as string });
    const id = await newId();
    expect((await approve(h, id, "approve", { jwt: await h.jwt(NONE), csrf: await csrfOf(h, id) })).status).toBe(403);
    expect(reasons()).toContain("access_denied reason=access_amr_not_passkey");
  });

  it.each([
    ["wrong email", { email: "someone@example.test" }, "access_wrong_identity"],
    ["wrong aud", { aud: ["other"] }, "access_jwt_aud"],
    ["wrong iss", { iss: "https://evil.cloudflareaccess.com" }, "access_jwt_iss"],
    ["expired", { exp: Math.floor(T0 / 1000) - 5 }, "access_jwt_expired"],
    ["not yet valid", { nbf: Math.floor(T0 / 1000) + 3600 }, "access_jwt_not_yet_valid"],
  ])("flag on + no amr + no idp + %s → 403", async (_n, over, code) => {
    await h.setEnv({ ALLOW_EMAIL_OTP: "1" });
    const id = await newId();
    expect((await approve(h, id, "approve", { jwt: await h.jwt({ ...NONE, ...over }), csrf: await csrfOf(h, id) })).status).toBe(403);
    expect(reasons()).toContain(`access_denied reason=${code}`);
  });

  it("flag on + no amr + no idp + tampered signature → 403", async () => {
    await h.setEnv({ ALLOW_EMAIL_OTP: "1" });
    const id = await newId();
    const parts = (await h.jwt(NONE)).split(".");
    const mid = Math.floor(parts[2].length / 2);
    parts[2] = parts[2].slice(0, mid) + (parts[2][mid] === "A" ? "B" : "A") + parts[2].slice(mid + 1);
    expect((await approve(h, id, "approve", { jwt: parts.join("."), csrf: await csrfOf(h, id) })).status).toBe(403);
    expect(reasons()).toContain("access_denied reason=access_jwt_signature");
  });

  it.each([
    ["google idp", { amr: undefined, idp: { id: "x", type: "google" } }],
    ["oidc idp", { amr: undefined, idp: { id: "x", type: "oidc" } }],
    ["idp null", { amr: undefined, idp: null }],
    ["no idp but non-matching amr", { amr: ["pwd"], idp: undefined }],
    ["no idp but empty amr array", { amr: [], idp: undefined }],
  ])("flag on + %s → still requires REQUIRED_AMR → 403", async (_n, claims) => {
    await h.setEnv({ ALLOW_EMAIL_OTP: "1" });
    const id = await newId();
    expect((await approve(h, id, "approve", { jwt: await h.jwt(claims), csrf: await csrfOf(h, id) })).status).toBe(403);
    expect(reasons()).toContain("access_denied reason=access_amr_not_passkey");
  });

  it("idp cloudflare still logs email_otp and matching amr still logs amr", async () => {
    await h.setEnv({ ALLOW_EMAIL_OTP: "1" });
    const a = await newId("a");
    expect((await approve(h, a, "approve", { jwt: await h.jwt({ amr: undefined, idp: { id: "x", type: "cloudflare" } }) })).status).toBe(200);
    h.setNow(T0 + 60_000);
    const b = await newId("b");
    expect((await approve(h, b, "approve", { jwt: await h.jwt({ idp: undefined }) })).status).toBe(200);
    const details = (await logRows()).filter((x) => x.event === "approved").map((x) => x.detail);
    expect(details.some((d) => d.includes("method=email_otp "))).toBe(true);
    expect(details.some((d) => d.includes("method=amr "))).toBe(true);
  });
});
