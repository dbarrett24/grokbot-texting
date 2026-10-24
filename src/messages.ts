// Encrypted message store. LOG_ENC_KEY only: never LOG_HASH_KEY, never GOOGLE_TOKEN_KEY.
// AES-GCM 256, fresh 12-byte IV, associated data bound to the row id and the field.
import { b64, unb64 } from "./e2e";
import { E164, Refuse, parseSwitch } from "./rules";

export const INBOUND_KEEP_MS = 30 * 86_400_000;
export const OUTBOUND_KEEP_MS = 90 * 86_400_000;

const enc = new TextEncoder();

/** 32 raw bytes, or null when the secret is unset. Reuse of LOG_HASH_KEY and any other shape refuse. */
export function parseMessageKeyBytes(raw: string | undefined, hashKey: string | undefined): Uint8Array | null {
  if (raw === undefined || raw.trim() === "") return null;
  if (hashKey !== undefined && raw === hashKey) throw new Refuse("message_enc_key_reused", 503);
  const t = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(t)) return Uint8Array.from({ length: 32 }, (_, i) => parseInt(t.slice(i * 2, i * 2 + 2), 16));
  if (/^[A-Za-z0-9+/]{43}=$/.test(t) || /^[A-Za-z0-9+/]{42}==$/.test(t)) {
    try {
      const b = unb64(t);
      if (b.length === 32) return b;
    } catch {
      throw new Refuse("message_enc_key_invalid", 503);
    }
  }
  throw new Refuse("message_enc_key_invalid", 503);
}

export async function importMessageKey(raw: string | undefined, hashKey: string | undefined): Promise<CryptoKey | null> {
  const bytes = parseMessageKeyBytes(raw, hashKey);
  if (!bytes) return null;
  return crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export const aadNumber = (id: string) => `sms-relay:msg:${id}:number`;
export const aadBody = (id: string) => `sms-relay:msg:${id}:body`;

export async function sealField(key: CryptoKey, plaintext: string, aad: string): Promise<{ ct: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(aad) }, key, enc.encode(plaintext)));
  return { ct: b64(ct), iv: b64(iv) };
}

export async function openField(key: CryptoKey, ct: string, iv: string, aad: string): Promise<string> {
  try {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv), additionalData: enc.encode(aad) }, key, unb64(ct));
    return new TextDecoder().decode(pt);
  } catch {
    throw new Refuse("message_decrypt_failed", 500);
  }
}

export function migrateMessages(exec: (sql: string) => void): void {
  exec(`CREATE TABLE IF NOT EXISTS messages(
    id TEXT PRIMARY KEY,
    created_ms INTEGER NOT NULL,
    direction TEXT NOT NULL CHECK (direction IN ('in','out')),
    number_ct TEXT, number_iv TEXT,
    body_ct TEXT, body_iv TEXT,
    last4 TEXT NOT NULL
  )`);
}

/** STORE_MESSAGE_BODIES: unset/""/"0" off, "1" on, anything else refuses. */
export function storeBodiesOn(raw: string | undefined): boolean {
  return parseSwitch(raw, "store_message_bodies_invalid");
}

/** CAPTURE_INBOUND: unset/""/"0" off, "1" on, anything else refuses. */
export function captureInboundOn(raw: string | undefined): boolean {
  return parseSwitch(raw, "capture_inbound_invalid");
}

export interface InboundBody {
  number: string;
  body: string;
}

export function parseInbound(raw: unknown): InboundBody {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Refuse("body_must_be_object");
  const o = raw as Record<string, unknown>;
  if (Object.keys(o).some((k) => k !== "number" && k !== "body")) throw new Refuse("unknown_fields");
  const number = o["number"];
  const body = o["body"];
  if (typeof number !== "string" || !E164.test(number)) throw new Refuse("recipient_must_be_one_e164_number");
  if (typeof body !== "string" || body.trim() === "") throw new Refuse("empty_text");
  if (body.length > 10000) throw new Refuse("text_too_long");
  return { number, body };
}

/** Owner purge: the body must be exactly {"confirm":"purge-all"}. */
export function parsePurge(raw: unknown): void {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Refuse("body_must_be_object");
  const o = raw as Record<string, unknown>;
  if (Object.keys(o).some((k) => k !== "confirm")) throw new Refuse("unknown_fields");
  if (o["confirm"] !== "purge-all") throw new Refuse("purge_confirm_required", 409);
}

export interface MessageRow {
  id: string;
  created_ms: number;
  direction: "in" | "out";
  number_ct: string | null;
  number_iv: string | null;
  body_ct: string | null;
  body_iv: string | null;
  last4: string;
}

function strOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") throw new Refuse("message_row_invalid", 500);
  return v;
}

export function readMessageRow(row: { readonly [k: string]: unknown }): MessageRow {
  const id = row["id"];
  const created = row["created_ms"];
  const direction = row["direction"];
  const last4 = row["last4"];
  if (typeof id !== "string" || id === "") throw new Refuse("message_row_invalid", 500);
  if (typeof created !== "number" || !Number.isFinite(created)) throw new Refuse("message_row_invalid", 500);
  if (direction !== "in" && direction !== "out") throw new Refuse("message_row_invalid", 500);
  if (typeof last4 !== "string" || !/^\d{0,4}$/.test(last4)) throw new Refuse("message_row_invalid", 500);
  return {
    id,
    created_ms: created,
    direction,
    last4,
    number_ct: strOrNull(row["number_ct"]),
    number_iv: strOrNull(row["number_iv"]),
    body_ct: strOrNull(row["body_ct"]),
    body_iv: strOrNull(row["body_iv"]),
  };
}
