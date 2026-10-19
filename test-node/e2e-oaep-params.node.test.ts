// Independent proof, outside the Worker code path, that device-key fields use the parameters the SMS Gateway
// format requires (docs.sms-gate.app/privacy/encryption): RSA-OAEP with a SHA-256 OAEP digest, MGF1 with SHA-1,
// empty label, wrapping a 32-byte AES-256-GCM key. The decryptor is the openssl CLI with BOTH hashes set
// explicitly, because node:crypto's privateDecrypt has no MGF1 option (OpenSSL then uses the OAEP hash for
// MGF1 too), so it cannot prove MGF1-SHA-1 on its own. A fresh test-only keypair per run; no real keys.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import nodeCrypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// src/e2e.ts is the Worker's own module (checked by the Worker tsconfig, workers-types); load it at run time so
// the Node tsconfig (DOM lib) doesn't re-check it with different BufferSource typings.
type E2E = { encryptField(pub: string, ver: number, text: string): Promise<string>; fingerprint(pub: string): Promise<string> };
const E2E_PATH = "../src/e2e";
let encryptField: E2E["encryptField"];
let fingerprint: E2E["fingerprint"];

let dir = "";
let keyPem = "";
let pubB64 = "";

/** RSA-OAEP decrypt with explicit OAEP and MGF1 hashes. Returns null when the padding check fails. */
function opensslOaepDecrypt(ct: Buffer, oaepMd: string, mgf1Md: string): Buffer | null {
  const ctFile = join(dir, "ct.bin");
  writeFileSync(ctFile, ct);
  const r = spawnSync("openssl", ["pkeyutl", "-decrypt", "-inkey", join(dir, "key.pem"), "-in", ctFile,
    "-pkeyopt", "rsa_padding_mode:oaep", "-pkeyopt", `rsa_oaep_md:${oaepMd}`, "-pkeyopt", `rsa_mgf1_md:${mgf1Md}`]);
  if (r.error) throw r.error;
  return r.status === 0 ? r.stdout : null;
}

/** Splits a device-key field per the documented 7-chunk format and decrypts it with the given MGF1 hash. */
function decryptField(field: string, mgf1Md: string): string | null {
  const c = field.split("$");
  expect(c).toHaveLength(7);
  expect(c[0]).toBe("");
  expect(c[1]).toBe("rsa-oaep-aes-256-gcm");
  expect(c[2]).toBe("v=1");
  expect(c[3]).toMatch(/^k=\d+$/);
  for (const x of c.slice(4)) expect(x).toMatch(/^[A-Za-z0-9+/]+={0,2}$/); // standard base64, padded, no wrap
  const wrapped = Buffer.from(c[4], "base64"), iv = Buffer.from(c[5], "base64"), ctTag = Buffer.from(c[6], "base64");
  expect(wrapped.length).toBe(256);
  expect(iv.length).toBe(12);
  const aesKey = opensslOaepDecrypt(wrapped, "sha256", mgf1Md);
  if (!aesKey) return null;
  expect(aesKey.length).toBe(32);
  const d = nodeCrypto.createDecipheriv("aes-256-gcm", aesKey, iv);
  d.setAuthTag(ctTag.subarray(ctTag.length - 16));
  return Buffer.concat([d.update(ctTag.subarray(0, ctTag.length - 16)), d.final()]).toString("utf8");
}

beforeAll(async () => {
  ({ encryptField, fingerprint } = (await import(/* @vite-ignore */ E2E_PATH)) as E2E);
  dir = mkdtempSync(join(tmpdir(), "oaep-kat-"));
  const kp = nodeCrypto.generateKeyPairSync("rsa", { modulusLength: 2048, publicExponent: 65537 });
  keyPem = kp.privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  writeFileSync(join(dir, "key.pem"), keyPem, { mode: 0o600 });
  pubB64 = (kp.publicKey.export({ type: "spki", format: "der" }) as Buffer).toString("base64"); // X.509 SPKI DER, NO_WRAP
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("device-key field encryption matches the app's documented OAEP parameters", () => {
  it("relay output decrypts with OAEP SHA-256 + MGF1-SHA-1 and carries k=<keyVersion> exactly", async () => {
    const plain = "TEST-ONLY hello \u00e9\u{1F600}";
    const f = await encryptField(pubB64, 7, plain);
    expect(f.split("$")[3]).toBe("k=7");
    expect(decryptField(f, "sha1")).toBe(plain);
  });

  it("relay output does NOT decrypt with MGF1-SHA-256 (it is not the WebCrypto default parameter set)", async () => {
    const f = await encryptField(pubB64, 1, "TEST-ONLY x");
    expect(decryptField(f, "sha256")).toBeNull();
  });

  it("negative control: WebCrypto RSA-OAEP {hash: SHA-256} (MGF1-SHA-256) fails under the documented decryptor", async () => {
    const pub = await crypto.subtle.importKey("spki", Buffer.from(pubB64, "base64"), { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]);
    const aes = crypto.getRandomValues(new Uint8Array(32));
    const ct = Buffer.from(await crypto.subtle.encrypt({ name: "RSA-OAEP" }, pub, aes));
    expect(opensslOaepDecrypt(ct, "sha256", "sha1")).toBeNull();
    expect(opensslOaepDecrypt(ct, "sha256", "sha256")).toEqual(Buffer.from(aes)); // so the decryptor itself works
  });

  it("node privateDecrypt with oaepHash sha256 uses MGF1-SHA-256, so it can't vouch for MGF1-SHA-1", async () => {
    const f = await encryptField(pubB64, 1, "TEST-ONLY y");
    const wrapped = Buffer.from(f.split("$")[4], "base64");
    expect(() => nodeCrypto.privateDecrypt({ key: keyPem, padding: nodeCrypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, wrapped)).toThrow();
  });

  it("fingerprint is SHA-256 of the SPKI DER, upper hex in 16 groups of 4", async () => {
    const want = nodeCrypto.createHash("sha256").update(Buffer.from(pubB64, "base64")).digest("hex").toUpperCase().match(/.{4}/g)!.join(":");
    expect(await fingerprint(pubB64)).toBe(want);
  });
});
