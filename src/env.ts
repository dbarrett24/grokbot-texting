export interface Env {
  RELAY: DurableObjectNamespace;
  // ---- vars (wrangler.toml) ----
  GATEWAY_BASE_URL: string; // https://api.sms-gate.app/3rdparty/v1
  TIMEZONE: string; // REQUIRED, no default: IANA zone such as "Europe/London". Missing/invalid = every route refuses (timezone_not_configured / timezone_invalid)
  DEFAULT_COUNTRY_CODE?: string; // required for contact sync: "+44", "+1"... for numbers written without "+", or "none" = strict E.164. Unset/invalid = sync refused (default_country_code_invalid)
  // Tap-flow limits. Unset = the default shown; garbage (words, decimals, out of range) = 503 config_invalid.
  CAP_START_DATE: string; // YYYY-MM-DD; SEND_CAP_INITIAL a day for CAP_RAISE_AFTER_DAYS days from here, then SEND_CAP_AFTER. Invalid = stays at SEND_CAP_INITIAL
  PENDING_CAP_PER_DAY?: string; // default "20" (1..100000)
  SEND_CAP_INITIAL?: string; // default "5" (1..100000)
  SEND_CAP_AFTER?: string; // default "10" (1..100000)
  CAP_RAISE_AFTER_DAYS?: string; // default "14" (0..3650)
  REQUEST_TTL_SECONDS?: string; // default "900" (60..86400)
  MIN_SECONDS_BETWEEN_SENDS?: string; // default "30" (0..86400)
  MAX_TEXT_CHARS?: string; // default "640" (1..10000); both flows
  BLOCK_LINKS?: string; // opt-in: "1" = refuse links in message text (tap and direct). Unset/""/"0" = allowed. Anything else = config error. Names/labels are always link-checked
  NOTIFY_MODE: string; // "sms" | "ntfy"
  ACCESS_TEAM_DOMAIN: string; // https://<team>.cloudflareaccess.com
  REQUIRED_AMR: string; // comma list; JWT amr must contain one of these. Empty or placeholder = refuse unless ALLOW_EMAIL_OTP applies
  ALLOW_EMAIL_OTP?: string; // "1" (exact; the template's normal setting) = skip REQUIRED_AMR when idp.type is "cloudflare" (method=email_otp)
  //                             or when the token has no amr and no idp claim at all (method=email_otp_or_policy). The passkey then rests on the Access policy alone
  REQUEST_HOST: string; // hostname serving only POST /request, POST /send and GET /request/:id (no Access)
  APPROVE_HOST: string; // hostname serving only /approve/*, /log, /direct*, /contacts (whole host behind Access)
  DISABLED?: string; // "1" = kill switch: refuse everything (direct sends included)
  // ---- direct send (POST /send). See README "Direct send". ----
  DIRECT_SEND?: string; // "1" (exact; template default) = on. REQUEST_TOKEN can then send WITHOUT approval to numbers on the direct list
  CONTACTS_SNAPSHOT_ONLY?: string; // only gates the DIRECT_ALLOWLIST secret: exact "0" (template default) = included; anything else/unset = excluded. Google sync, upload and the tap ALLOWLIST are always included
  RUNAWAY_PAUSE?: string; // unset = on; only "0" (template default) turns it off. More than RUNAWAY_MAX direct sends in 60 min pauses direct send
  RUNAWAY_MAX?: string; // default "10"
  DIRECT_DAILY_CAP?: string; // opt-in; unset/"off" = no cap; digits 1..100000; garbage = direct refused
  DIRECT_PER_MINUTE_MAX?: string; // optional; same rules
  DIRECT_HOURS?: string; // optional "HH:MM-HH:MM" in TIMEZONE; same rules
  DIRECT_LOOKUP_MAX_PER_HOUR?: string; // optional: /send lookups + refusals per rolling hour (sends never count). unset = 30, "off" = no limit, garbage = direct_config_invalid
  DIRECT_NOTIFY_EACH?: string; // optional "1" = text the owner a copy of each direct send; unset/"0"/"off" = no
  GOOGLE_ACCOUNTS?: string; // var, ordered labels such as "primary,work"; each needs secret GOOGLE_RT_<LABEL>. First listed wins name conflicts
  GOOGLE_CLIENT_ID?: string; // secret: OAuth client (contacts.readonly) used for every account's refresh token
  GOOGLE_CLIENT_SECRET?: string; // secret
  // GOOGLE_RT_<LABEL>: secret refresh token per account, read dynamically (e.g. GOOGLE_RT_PRIMARY)
  LOG_HASH_KEY?: string; // secret, 32+ chars: HMAC key for number and body hashes. Missing = direct send refused (direct_config_invalid); tap log rows fall back to plain SHA-256
  DIRECT_ALLOWLIST?: string; // secret, optional, JSON {"+<E.164>":"name"}; ignored unless CONTACTS_SNAPSHOT_ONLY="0"
  // ---- secrets (wrangler secret put) ----
  REQUEST_TOKEN: string; // request-only bearer token used by the bot
  ACCESS_AUD: string; // Access application AUD tag
  APPROVER_EMAIL: string; // the only identity allowed to approve
  GATEWAY_USER: string;
  GATEWAY_PASS: string;
  GATEWAY_DEVICE_ID: string;
  GATEWAY_PINNED_FINGERPRINT?: string; // required when the device publishes a publicKey (RSA mode); optional in passphrase mode
  GATEWAY_KEY_VERSION?: string; // same as above
  GATEWAY_PASSPHRASE?: string; // passphrase mode; used ONLY when the listed device has no publicKey
  GATEWAY_PBKDF2_ITERATIONS?: string; // var; default 100000 (Workers max); allowed 75000..100000
  // GATEWAY_PASSPHRASE must be >= 32 chars when set, or every send is refused (gateway_passphrase_too_short)
  ALLOWLIST: string; // JSON object {"+<E.164>": "label"}
  OWNER_NUMBER?: string; // E.164; the owner's own number, notice target when NOTIFY_MODE=sms
  NTFY_URL?: string; // https://ntfy.example/topic (private topic) when NOTIFY_MODE=ntfy
  NTFY_TOKEN?: string; // ntfy access token; required for ntfy mode
}
