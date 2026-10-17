import { describe, it, expect, beforeEach } from "vitest";
import { harness, postRequest, approve, FRIEND, OWNER, T0, type Harness } from "./helpers";
import { parseIterations } from "../src/passphrase";

const PASS = "TEST-ONLY-passphrase-not-real-0123456789"; // 40 chars, obvious fake
let h: Harness;
beforeEach(async () => { h = await harness(); });

async function sendOne(text = "passphrase mode hello") {
  const r = await postRequest(h, { to: FRIEND, text });
  expect(r.status).toBe(202);
  const { id } = (await r.json()) as { id: string };
  return approve(h, id);
}
async function securityEvents() {
  const r = await h.relay.fetch("https://approve.example.test/log", { headers: { "Cf-Access-Jwt-Assertion": await h.jwt() } });
  return ((await r.json()) as any[]).filter((x) => x.event === "security_event").map((x) => x.detail);
}

describe("gateway mode selection", () => {
  it("passphrase mode: no publicKey + passphrase → encrypted send with deviceId and isEncrypted", async () => {
    h.device.value = { id: "test-device", name: "phone", publicKey: null, keyVersion: null };
    await h.setEnv({ GATEWAY_PASSPHRASE: PASS, GATEWAY_PINNED_FINGERPRINT: "", GATEWAY_KEY_VERSION: "" });
    const r = await sendOne();
    expect(await r.json()).toMatchObject({ state: "sent" });
    const posted = h.messagesPosted();
    expect(posted).toHaveLength(2); // notification to the owner + the approved text
    for (const m of posted) {
      expect(m.isEncrypted).toBe(true);
      expect(m.deviceId).toBe("test-device");
      expect(m.phoneNumbers).toHaveLength(1);
      expect(m.textMessage.text).toMatch(/^\$aes-256-cbc\/pbkdf2-sha1\$i=100000\$[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]+={0,2}$/);
      expect(m.phoneNumbers[0]).toMatch(/^\$aes-256-cbc\/pbkdf2-sha1\$i=100000\$/);
    }
    expect(await h.decryptPassphrase(posted[0].phoneNumbers[0], PASS)).toBe(OWNER);
    expect(await h.decryptPassphrase(posted[1].phoneNumbers[0], PASS)).toBe(FRIEND);
    expect(await h.decryptPassphrase(posted[1].textMessage.text, PASS)).toBe("passphrase mode hello");
    // fresh salt per field: number and text never share a salt
    const salts = posted.flatMap((m) => [m.textMessage.text, m.phoneNumbers[0]].map((f: string) => f.split("$")[3]));
    expect(new Set(salts).size).toBe(salts.length);
    expect(JSON.stringify(h.calls)).not.toContain(PASS); // passphrase never leaves the Worker
  });

  it("iterations: default 100000, 75000 allowed, refuses <75000 and >100000 (Workers cap)", async () => {
    expect(parseIterations(undefined)).toBe(100000);
    expect(parseIterations("75000")).toBe(75000);
    expect(parseIterations("100000")).toBe(100000);
    expect(() => parseIterations("74999")).toThrow("pbkdf2_iterations_out_of_range");
    expect(() => parseIterations("100001")).toThrow("pbkdf2_iterations_out_of_range");
    expect(() => parseIterations("300000")).toThrow("pbkdf2_iterations_out_of_range");
    expect(() => parseIterations("abc")).toThrow();
    h.device.value = { id: "test-device", publicKey: null, keyVersion: null };
    await h.setEnv({ GATEWAY_PASSPHRASE: PASS, GATEWAY_PBKDF2_ITERATIONS: "300000" });
    expect((await sendOne()).status).toBe(502); // refused before PBKDF2 runs (prod would throw NotSupportedError)
    expect(h.messagesPosted()).toHaveLength(0);
    await h.setEnv({ GATEWAY_PBKDF2_ITERATIONS: "75000" });
    h.setNow(T0 + 60_000);
    expect(await (await sendOne("at the floor")).json()).toMatchObject({ state: "sent" });
    expect(h.messagesPosted().at(-1).textMessage.text).toMatch(/^\$aes-256-cbc\/pbkdf2-sha1\$i=75000\$/);
  });

  it("GATEWAY_PASSPHRASE shorter than 32 chars refuses every send, in both modes, with a clear code", async () => {
    const SHORT = "TEST-ONLY-short-passphrase-31ch"; // 31 chars
    expect(SHORT.length).toBe(31);
    h.device.value = { id: "test-device", publicKey: null, keyVersion: null };
    await h.setEnv({ GATEWAY_PASSPHRASE: SHORT });
    const r = await postRequest(h, { to: FRIEND, text: "hi" });
    expect(((await r.json()) as any).notified).toBe(false); // notification refused too
    const { id } = (await (await postRequest(h, { to: FRIEND, text: "hi again" })).json()) as { id: string };
    expect(await (await approve(h, id)).json()).toMatchObject({ state: "send_failed" });
    expect(h.messagesPosted()).toHaveLength(0);
    // RSA-capable device: still refused while a short passphrase is configured
    h.device.value = { id: "test-device", publicKey: h.spkiB64, keyVersion: 1 };
    h.setNow(T0 + 60_000);
    expect((await sendOne()).status).toBe(502);
    expect(h.messagesPosted()).toHaveLength(0);
    const log = (await (await h.relay.fetch("https://approve.example.test/log", { headers: { "Cf-Access-Jwt-Assertion": await h.jwt() } })).json()) as any[];
    const cfg = log.filter((x) => x.event === "config_error").map((x) => x.detail);
    expect(cfg).toContain("gateway_passphrase_too_short");
    expect(JSON.stringify(log)).not.toContain(SHORT);
    // exactly 32 chars is accepted
    await h.setEnv({ GATEWAY_PASSPHRASE: "TEST-ONLY-passphrase-32-chars-ok" });
    h.setNow(T0 + 120_000);
    h.device.value = { id: "test-device", publicKey: null, keyVersion: null };
    expect(await (await sendOne("exactly 32")).json()).toMatchObject({ state: "sent" });
  });

  it("RSA path unchanged when the device has a publicKey and the pin matches (passphrase ignored)", async () => {
    await h.setEnv({ GATEWAY_PASSPHRASE: PASS });
    expect(await (await sendOne("rsa still works")).json()).toMatchObject({ state: "sent" });
    const last = h.messagesPosted().at(-1);
    expect(last.textMessage.text.startsWith("$rsa-oaep-aes-256-gcm$v=1$k=1$")).toBe(true);
    expect(last.deviceId).toBe("test-device");
    expect(last.isEncrypted).toBe(true);
    expect(await h.decrypt(last.textMessage.text)).toBe("rsa still works");
  });

  it("publicKey present but no pin configured → refused, security event, no passphrase fallback", async () => {
    await h.setEnv({ GATEWAY_PASSPHRASE: PASS, GATEWAY_PINNED_FINGERPRINT: "", GATEWAY_KEY_VERSION: "" });
    expect((await sendOne()).status).toBe(502);
    expect(h.messagesPosted()).toHaveLength(0);
    expect(await securityEvents()).toContain("device_key_present_but_no_pin");
  });

  it("publicKey does not match the pin → refused, security event, no passphrase fallback", async () => {
    await h.setEnv({ GATEWAY_PASSPHRASE: PASS, GATEWAY_PINNED_FINGERPRINT: "0000:1111" });
    expect((await sendOne()).status).toBe(502);
    expect(h.messagesPosted()).toHaveLength(0);
    expect(await securityEvents()).toContain("device_key_pin_mismatch");
  });

  it("key version mismatch → refused", async () => {
    h.device.value = { id: "test-device", publicKey: h.spkiB64, keyVersion: 2 };
    expect((await sendOne()).status).toBe(502);
    expect(await securityEvents()).toContain("device_key_pin_mismatch");
  });

  it("listed device id differs from GATEWAY_DEVICE_ID → refused in both modes", async () => {
    h.device.value = { id: "some-other-device", publicKey: null, keyVersion: null };
    await h.setEnv({ GATEWAY_PASSPHRASE: PASS });
    expect((await sendOne()).status).toBe(502);
    h.device.value = { id: "some-other-device", publicKey: h.spkiB64, keyVersion: 1 };
    h.setNow(T0 + 60_000); // past the 30 s spacing (a refused send still counts)
    expect((await sendOne("second")).status).toBe(502);
    expect(h.messagesPosted()).toHaveLength(0);
    expect(await securityEvents()).toContain("device_id_not_listed");
  });

  it("no publicKey and no passphrase → fail closed", async () => {
    h.device.value = { id: "test-device", publicKey: null, keyVersion: null };
    expect((await sendOne()).status).toBe(502);
    expect(h.messagesPosted()).toHaveLength(0);
    expect(await securityEvents()).toContain("no_device_key_and_no_passphrase");
  });

  it("security events never contain secret values", async () => {
    await h.setEnv({ GATEWAY_PASSPHRASE: PASS, GATEWAY_PINNED_FINGERPRINT: "" });
    await sendOne();
    const r = await h.relay.fetch("https://approve.example.test/log", { headers: { "Cf-Access-Jwt-Assertion": await h.jwt() } });
    const s = await r.text();
    for (const secret of [PASS, "TEST-ONLY-pass", "TEST-ONLY-user", "TEST-ONLY-request-token", h.spkiB64]) expect(s).not.toContain(secret);
  });
});
