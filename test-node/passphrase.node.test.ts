// Independent proof with Node's own crypto (node:crypto), NOT the Worker code path, that the
// Worker's passphrase output matches the format at docs.sms-gate.app/privacy/encryption.
import { describe, it, expect } from "vitest";
import nodeCrypto from "node:crypto";
import { encryptFieldPassphrase } from "../src/passphrase";

const PASS = "TEST-ONLY-passphrase-not-real-0123456789";

/** Independent decrypt written from the doc's description. */
function nodeDecrypt(field: string, passphrase: string): string {
  const parts = field.split("$");
  expect(parts).toHaveLength(5);
  expect(parts[0]).toBe("");
  expect(parts[1]).toBe("aes-256-cbc/pbkdf2-sha1");
  const m = parts[2].match(/^i=(\d+)$/);
  expect(m).not.toBeNull();
  const iterations = Number(m![1]);
  // standard base64 with padding
  expect(parts[3]).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
  expect(parts[4]).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
  const salt = Buffer.from(parts[3], "base64");
  expect(salt.length).toBe(16);
  const ct = Buffer.from(parts[4], "base64");
  expect(ct.length % 16).toBe(0); // PKCS#7-padded CBC blocks
  const key = nodeCrypto.pbkdf2Sync(passphrase, salt, iterations, 32, "sha1");
  const d = nodeCrypto.createDecipheriv("aes-256-cbc", key, salt); // salt doubles as IV; PKCS#7 auto-unpad
  return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
}

/** The doc's own Node `Encryptor.Decrypt` example, copied verbatim in logic. */
class DocEncryptor {
  constructor(private passphrase: string, private iterations = 75_000) {}
  Decrypt(input: string): string {
    const parts = input.split("$");
    if (parts.length !== 5) throw new Error("Invalid encrypted text");
    if (parts[1] !== "aes-256-cbc/pbkdf2-sha1") throw new Error("Unsupported algorithm");
    const params = new Map(parts[2].split(",").map((p) => p.split("=") as [string, string]));
    if (!params.has("i")) throw new Error("Missing iteration count");
    const iterations = parseInt(params.get("i")!);
    const salt = Buffer.from(parts[3], "base64");
    const secretKey = nodeCrypto.pbkdf2Sync(this.passphrase, salt, iterations, 32, "sha1");
    const decipher = nodeCrypto.createDecipheriv("aes-256-cbc", secretKey, salt);
    return Buffer.concat([decipher.update(Buffer.from(parts[4], "base64")), decipher.final()]).toString("utf8");
  }
  Encrypt(input: string, salt = nodeCrypto.randomBytes(16)): string {
    const secretKey = nodeCrypto.pbkdf2Sync(this.passphrase, salt, this.iterations, 32, "sha1");
    const c = nodeCrypto.createCipheriv("aes-256-cbc", secretKey, salt);
    const ct = Buffer.concat([c.update(Buffer.from(input, "utf8")), c.final()]);
    return `$aes-256-cbc/pbkdf2-sha1$i=${this.iterations}$${salt.toString("base64")}$${ct.toString("base64")}`;
  }
}

describe("passphrase format, verified with node:crypto", () => {
  it("round-trips text, unicode and a phone number (independent decrypt + doc example decrypt)", async () => {
    for (const pt of ["Running 10 min late, see you soon", "Ünïcødé ✓ 🚗 — ok", "+15555550101", "x".repeat(640)]) {
      const f = await encryptFieldPassphrase(PASS, 100_000, pt);
      expect(f.startsWith("$aes-256-cbc/pbkdf2-sha1$i=100000$")).toBe(true);
      expect(nodeDecrypt(f, PASS)).toBe(pt);
      expect(new DocEncryptor(PASS).Decrypt(f)).toBe(pt);
    }
  }, 60_000);

  it("random salt per field: two encryptions of the same text differ", async () => {
    const a = await encryptFieldPassphrase(PASS, 100_000, "same");
    const b = await encryptFieldPassphrase(PASS, 100_000, "same");
    expect(a).not.toBe(b);
    expect(a.split("$")[3]).not.toBe(b.split("$")[3]);
  }, 60_000);

  it("wrong passphrase does not decrypt", async () => {
    const f = await encryptFieldPassphrase(PASS, 100_000, "secret-ish");
    let out: string | undefined;
    try { out = nodeDecrypt(f, "TEST-ONLY-wrong"); } catch { out = undefined; }
    expect(out).not.toBe("secret-ish");
  }, 60_000);

  it("fixed-vector cross-check: doc-style encrypt with a fixed salt equals an independent CBC computation", () => {
    // The doc publishes no test vector, so this pins one built from its description with Node only.
    const salt = Buffer.from("000102030405060708090a0b0c0d0e0f", "hex");
    const doc = new DocEncryptor(PASS, 100_000).Encrypt("hello", salt);
    const key = nodeCrypto.pbkdf2Sync(PASS, salt, 100_000, 32, "sha1");
    const c = nodeCrypto.createCipheriv("aes-256-cbc", key, salt);
    const ct = Buffer.concat([c.update("hello"), c.final()]).toString("base64");
    expect(doc).toBe(`$aes-256-cbc/pbkdf2-sha1$i=100000$AAECAwQFBgcICQoLDA0ODw==$${ct}`);
    expect(nodeDecrypt(doc, PASS)).toBe("hello");
  });

  it("refuses iterations outside 75000..100000 and passphrases under 32 chars", async () => {
    await expect(encryptFieldPassphrase(PASS, 74_999, "x")).rejects.toThrow("pbkdf2_iterations_out_of_range");
    await expect(encryptFieldPassphrase(PASS, 100_001, "x")).rejects.toThrow("pbkdf2_iterations_out_of_range");
    await expect(encryptFieldPassphrase("TEST-ONLY-too-short", 100_000, "x")).rejects.toThrow("gateway_passphrase_too_short");
    const f = await encryptFieldPassphrase(PASS, 75_000, "floor");
    expect(nodeDecrypt(f, PASS)).toBe("floor");
  });
});
