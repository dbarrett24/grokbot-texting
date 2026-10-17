// iPhone delivery (DELIVERY = "mac" | "shortcut"): pure rules for the device-poll transport.
// No I/O here. The queue itself lives in the Relay Durable Object (src/relay.ts).
import { Refuse } from "./rules";

/** How a text leaves the relay. "android" = the SMS Gateway app (the default). The other two queue it for a device to claim. */
export type Delivery = "android" | "mac" | "shortcut";
export type DeviceDelivery = Exclude<Delivery, "android">;

/** A claimed job must get its result back within this long, or it fails closed (never re-queued). */
export const CLAIM_TIMEOUT_MS = 2 * 60_000;
/** No poll for this long = the device is stale; the owner gets one notice per outage. */
export const STALE_AFTER_MS = 10 * 60_000;
/** UNCLAIMED_EXPIRY_MINUTES unset: an unclaimed job older than this is dropped (and the owner told), not sent late. */
export const DEFAULT_UNCLAIMED_EXPIRY_MIN = 30;
/** While DELIVERY is a device mode, the alarm runs this often to time out claims and watch the device. */
export const DEVICE_SWEEP_MS = 60_000;
/** DIRECT_DAILY_CAP when it's unset and DELIVERY is a device mode (Apple ID spam-flag risk). "off" removes it. */
export const DEVICE_DEFAULT_DAILY_CAP = 25;

/** DELIVERY: unset or "" = android. Only exact "android", "mac" or "shortcut". Anything else refuses sends (fail closed). */
export function parseDelivery(raw: string | undefined): Delivery {
  if (raw === undefined || raw === "") return "android";
  if (raw === "android" || raw === "mac" || raw === "shortcut") return raw;
  throw new Refuse("delivery_invalid", 503);
}

export const isDevice = (d: Delivery): d is DeviceDelivery => d !== "android";

/** A config refusal that names why (answered as {"error":"config_invalid","reason":...}). */
export class ConfigRefuse extends Refuse {
  constructor(public reason: string) {
    super("config_invalid", 503);
  }
}

/**
 * Device modes need an owner-notice channel that doesn't go through the device: with NOTIFY_MODE=sms the
 * "your device is offline" notice would be queued for the offline device. So only "ntfy" is accepted.
 */
export function checkDeviceNotify(notifyMode: string | undefined): void {
  if (notifyMode !== "ntfy") throw new ConfigRefuse("notify_mode_must_be_ntfy_for_device_delivery");
}

/** UNCLAIMED_EXPIRY_MINUTES: unset/"" = 30; whole minutes 1..1440 as plain digits; anything else is config_invalid. */
export function parseUnclaimedExpiryMs(raw: string | undefined): number {
  if (raw === undefined || raw === "") return DEFAULT_UNCLAIMED_EXPIRY_MIN * 60_000;
  if (!/^[0-9]{1,4}$/.test(raw) || Number(raw) < 1 || Number(raw) > 1440) throw new ConfigRefuse("unclaimed_expiry_minutes_invalid");
  return Number(raw) * 60_000;
}

/** What the device reports back. Only "sent" and "sent_unverified" count as a send; nothing is ever re-queued. */
export type Outcome = "sent" | "sent_unverified" | "not_started" | "uncertain";
export const OUTCOMES: readonly Outcome[] = ["sent", "sent_unverified", "not_started", "uncertain"];

/** Job states. "queued" is the only state a job can be claimed from, and no state leads back to it. */
export type JobState = "queued" | "claimed" | Outcome | "claim_timeout" | "expired";

export function parseOutcome(v: unknown): Outcome {
  if (typeof v === "string" && (OUTCOMES as readonly string[]).includes(v)) return v as Outcome;
  throw new Refuse("outcome_invalid");
}

/** Optional short diagnostic from the device: snake_case, at most 40 chars. Anything else is dropped, never logged. */
export function safeDetail(v: unknown): string | null {
  return typeof v === "string" && /^[a-z][a-z0-9_]{0,39}$/.test(v) ? v : null;
}

/**
 * DEVICE_TOKEN: its own secret, 32+ chars, and never equal to REQUEST_TOKEN. A stolen device token can
 * only claim jobs that already passed every guard; it can't create a send. Returns a refusal code or null.
 */
export function deviceTokenProblem(device: string | undefined, request: string | undefined): string | null {
  if (typeof device !== "string" || device.length < 32) return "device_token_missing_or_short";
  if (device === request) return "device_token_reuses_request_token";
  return null;
}

/** SHORTCUT_PING: how the Shortcut learns a text is waiting. Unset = "email". "tap" = ntfy notification, one tap per text. */
export type ShortcutPing = "email" | "tap";
export function parseShortcutPing(raw: string | undefined): ShortcutPing {
  if (raw === undefined || raw === "" || raw === "email") return "email";
  if (raw === "tap") return "tap";
  throw new Refuse("shortcut_ping_invalid", 503);
}

/** The email ping: a fixed subject and an empty body. It never carries the text or a number. */
export const PING_SUBJECT = "Relay: job waiting";
export const TAP_PING_TEXT = "A text is waiting. Tap to send it.";

export function pingMime(from: string, to: string, messageId: string, date: Date): string {
  return [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${PING_SUBJECT}`,
    `Message-ID: <${messageId}>`,
    `Date: ${date.toUTCString()}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "",
  ].join("\r\n");
}

/** Shortcuts URL scheme for the tap-once variant. The name is the owner's Shortcut, e.g. "Relay Send". */
export function shortcutRunUrl(name: string): string {
  return `shortcuts://run-shortcut?name=${encodeURIComponent(name)}`;
}
