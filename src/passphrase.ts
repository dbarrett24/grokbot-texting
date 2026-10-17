// SMSGate legacy passphrase encryption (docs.sms-gate.app/privacy/encryption, "Passphrase Encryption"):
//   $aes-256-cbc/pbkdf2-sha1$i={iterations}${base64(salt)}${base64(ciphertext)}
// - salt: 16 random bytes, fresh per field; the SAME bytes are the AES-CBC IV (as in the doc's PHP/Node/Python examples)
// - key: 32 bytes from PBKDF2-HMAC-SHA1(passphrase UTF-8, salt, iterations)
// - AES-256-CBC with PKCS#7 padding (WebCrypto AES-CBC pads with PKCS#7)
// - base64: standard RFC 4648 alphabet with "=" padding

/** Standard RFC 4648 base64 with "=" padding (same as e2e.b64; kept local so this module stands alone). */
function b64(u: Uint8Array): string {
  let s = "";
  for (const x of u) s += String.fromCharCode(x);
  return btoa(s);
}

/**
 * Production Cloudflare Workers caps WebCrypto PBKDF2 at 100,000 iterations and throws
 * NotSupportedError above it (workerd io/limit-enforcer.h DEFAULT_MAX_PBKDF2_ITERATIONS).
 * Local workerd / Miniflare does NOT enforce that cap, so we enforce it here ourselves.
 * Floor = 75,000, the SMS Gateway app's and the doc's default iteration count.
 */
export const MIN_ITERATIONS = 75_000;
export const MAX_ITERATIONS = 100_000;
export const DEFAULT_ITERATIONS = 100_000;
/** GATEWAY_PASSPHRASE must be at least this long (e.g. `openssl rand -base64 32` = 44 chars). */
export const MIN_PASSPHRASE_CHARS = 32;

/** Config-load check. Throws a stable error code; never echoes the value. */
export function checkPassphrase(p: string | undefined): void {
  if (p === undefined || p === "") return; // not configured: passphrase mode simply unavailable
  if ([...p].length < MIN_PASSPHRASE_CHARS) throw new Error("gateway_passphrase_too_short");
}

export function parseIterations(v: string | undefined): number {
  if (v === undefined || v.trim() === "") return DEFAULT_ITERATIONS;
  if (!/^\d+$/.test(v.trim())) throw new Error("pbkdf2_iterations_invalid");
  const n = Number(v.trim());
  if (n < MIN_ITERATIONS || n > MAX_ITERATIONS) throw new Error("pbkdf2_iterations_out_of_range");
  return n;
}

export async function encryptFieldPassphrase(passphrase: string, iterations: number, plaintext: string): Promise<string> {
  if (!passphrase) throw new Error("passphrase_missing");
  if ([...passphrase].length < MIN_PASSPHRASE_CHARS) throw new Error("gateway_passphrase_too_short");
  if (!Number.isInteger(iterations) || iterations < MIN_ITERATIONS || iterations > MAX_ITERATIONS) throw new Error("pbkdf2_iterations_out_of_range");
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const base = await crypto.subtle.importKey("raw", enc.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-1", salt, iterations },
    base,
    { name: "AES-CBC", length: 256 },
    false,
    ["encrypt"],
  );
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv: salt }, key, enc.encode(plaintext)));
  return `$aes-256-cbc/pbkdf2-sha1$i=${iterations}$${b64(salt)}$${b64(ct)}`;
}
