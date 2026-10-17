// SMSGate device-paired end-to-end encryption (RSA-OAEP field encryption, as the gateway app expects).
// Format: $rsa-oaep-aes-256-gcm$v=1$k={ver}${b64(rsa_oaep(aes_key))}${b64(iv12)}${b64(ct||tag16)}
// RSA-OAEP uses SHA-256 for the label hash but MGF1-SHA-1. WebCrypto ties MGF1 to the
// OAEP hash, so the OAEP padding is done by hand here and the RSA step uses BigInt.
const enc = new TextEncoder();

export function b64(u: Uint8Array): string {
  let s = "";
  for (const x of u) s += String.fromCharCode(x);
  return btoa(s);
}
export function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export function hex(u: Uint8Array): string {
  return [...u].map((x) => x.toString(16).padStart(2, "0")).join("");
}
async function digest(alg: "SHA-1" | "SHA-256", data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest(alg, data));
}
export async function sha256Hex(s: string): Promise<string> {
  return hex(await digest("SHA-256", enc.encode(s)));
}

/** HMAC-SHA-256 key for log and lookup hashes (LOG_HASH_KEY). */
export async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}
export async function hmacHex(key: CryptoKey, s: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(s))));
}

/** Same as e2e.fingerprint: SHA-256 of the SPKI DER, upper hex, grouped by 4. */
export async function fingerprint(publicKeyB64: string): Promise<string> {
  const h = hex(await digest("SHA-256", unb64(publicKeyB64))).toUpperCase();
  return h.match(/.{4}/g)!.join(":");
}

// ---- minimal DER reader for SubjectPublicKeyInfo(RSA) ----
function readTLV(b: Uint8Array, off: number): { tag: number; start: number; end: number } {
  const tag = b[off];
  let len = b[off + 1];
  let p = off + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n < 1 || n > 4) throw new Error("bad DER length");
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + b[p++];
  }
  if (p + len > b.length) throw new Error("DER overrun");
  return { tag, start: p, end: p + len };
}
function bytesToBig(b: Uint8Array): bigint {
  return b.length ? BigInt("0x" + hex(b)) : 0n;
}
export function bigToBytes(x: bigint, len: number): Uint8Array {
  const h = x.toString(16).padStart(len * 2, "0");
  if (h.length > len * 2) throw new Error("integer too large");
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}
export function parseSpki(der: Uint8Array): { n: bigint; e: bigint; k: number } {
  const outer = readTLV(der, 0);
  if (outer.tag !== 0x30) throw new Error("SPKI: not a SEQUENCE");
  const alg = readTLV(der, outer.start);
  if (alg.tag !== 0x30) throw new Error("SPKI: bad algorithm");
  const bits = readTLV(der, alg.end);
  if (bits.tag !== 0x03 || der[bits.start] !== 0) throw new Error("SPKI: bad BIT STRING");
  const seq = readTLV(der, bits.start + 1);
  if (seq.tag !== 0x30) throw new Error("RSAPublicKey: not a SEQUENCE");
  const nT = readTLV(der, seq.start);
  const eT = readTLV(der, nT.end);
  if (nT.tag !== 2 || eT.tag !== 2) throw new Error("RSAPublicKey: bad INTEGER");
  const n = bytesToBig(der.subarray(nT.start, nT.end));
  const e = bytesToBig(der.subarray(eT.start, eT.end));
  const k = Math.ceil(n.toString(16).length / 2);
  if (k < 256) throw new Error("RSA key smaller than 2048 bits");
  return { n, e, k };
}
export function modpow(b: bigint, e: bigint, m: bigint): bigint {
  let r = 1n;
  b %= m;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return r;
}
export async function mgf1Sha1(seed: Uint8Array, len: number): Promise<Uint8Array> {
  const out = new Uint8Array(len);
  let off = 0;
  for (let c = 0; off < len; c++) {
    const buf = new Uint8Array(seed.length + 4);
    buf.set(seed);
    new DataView(buf.buffer).setUint32(seed.length, c);
    const h = await digest("SHA-1", buf);
    out.set(h.subarray(0, Math.min(h.length, len - off)), off);
    off += h.length;
  }
  return out;
}
export async function oaepEncrypt(spkiDer: Uint8Array, msg: Uint8Array): Promise<Uint8Array> {
  const { n, e, k } = parseSpki(spkiDer);
  const hLen = 32;
  if (msg.length > k - 2 * hLen - 2) throw new Error("message too long for OAEP");
  const lHash = await digest("SHA-256", new Uint8Array(0));
  const db = new Uint8Array(k - hLen - 1);
  db.set(lHash);
  db[db.length - msg.length - 1] = 1;
  db.set(msg, db.length - msg.length);
  const seed = crypto.getRandomValues(new Uint8Array(hLen));
  const dbMask = await mgf1Sha1(seed, db.length);
  const maskedDb = db.map((x, i) => x ^ dbMask[i]);
  const seedMask = await mgf1Sha1(maskedDb, hLen);
  const maskedSeed = seed.map((x, i) => x ^ seedMask[i]);
  const em = new Uint8Array(k);
  em.set(maskedSeed, 1);
  em.set(maskedDb, 1 + hLen);
  return bigToBytes(modpow(bytesToBig(em), e, n), k);
}

export async function encryptField(publicKeyB64: string, keyVersion: number, plaintext: string): Promise<string> {
  const aesRaw = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey("raw", aesRaw, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(plaintext)));
  const wrapped = await oaepEncrypt(unb64(publicKeyB64), aesRaw);
  return `$rsa-oaep-aes-256-gcm$v=1$k=${Math.trunc(keyVersion)}$${b64(wrapped)}$${b64(iv)}$${b64(ct)}`;
}
