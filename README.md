# sms-relay-template

Let your assistant bot send texts from **your own Android phone number** when you tell it to, through a small Cloudflare Worker you own. No texting company is involved: texts leave through your phone and your SIM, using the open-source [SMS Gateway for Android](https://github.com/capcom6/android-sms-gateway) app in its cloud mode.

```
bot --(token)--> your Cloudflare Worker --(encrypted)--> SMS Gateway cloud --> your Android phone --> recipient
you --(email PIN + passkey)--> your private status page (contacts sync, log, approvals)
```

Setup takes about 90 minutes and is written step by step in **[DEPLOY.md](DEPLOY.md)**.

**iPhone?** Set `DELIVERY = "mac"` and an always-on Mac with Messages sends the texts from your number, or `DELIVERY = "shortcut"` for a best-effort iPhone-only path. See **[SETUP-iphone.md](SETUP-iphone.md)**, which also lists what those paths can't do.

## What you get by default
- **Direct send.** You say "text Sam: ...", the bot reads it back, you say yes, and it calls `POST /send`. There is no tap step (`DIRECT_SEND = "1"`).
- **Only people on your list.** The bot can text people in your Google Contacts (synced read-only, daily), numbers you upload, and numbers you list in the `ALLOWLIST` secret. Anything else is refused. One recipient per text; group sends are refused.
- **No daily cap, and links are allowed.** Both are switches you can turn on (`DIRECT_DAILY_CAP`, `BLOCK_LINKS`).
- **A private page** at `https://<APPROVE_HOST>/direct` behind Cloudflare Access: status, per-account contact counts (no numbers), a **Sync contacts now** button, and the log.
- **Tap-to-approve** is still built in. Set `DIRECT_SEND = "0"` and the bot can only file requests (`POST /request`) that you approve on your phone.
- **Nothing readable in the log.** Numbers are HMACs or masked to the last 4 digits, and the message text is never logged.

## Settings
All settings are `[vars]` in `wrangler.toml`; secrets go in with `npx wrangler secret put NAME`. Switches are exact: `"1"` is on, and a typo in a limit or switch makes the relay refuse sends until you fix it (fail closed).

**Required, no default:**
| Var | Meaning |
|---|---|
| `TIMEZONE` | Your IANA zone, e.g. `"Europe/London"`. Used for day boundaries and times in notices. Missing or not a real zone: every route answers 503 `timezone_not_configured` or `timezone_invalid`. |
| `DEFAULT_COUNTRY_CODE` | Country code put in front of contact numbers saved without a `+` (e.g. `"+44"`, `"+1"`), or `"none"` to keep only numbers already written as `+E.164`. A leading trunk `0` is dropped (`0555 555 0100` with `+44` becomes `+445555550100`); `00…` (or `011…` with `+1`) is read as an international number. Missing or invalid: contact sync refuses (`default_country_code_invalid`) and keeps your previous list. Nothing is ever assumed to be `+1`. |
| `REQUEST_HOST`, `APPROVE_HOST` | Your two hostnames (template: `api.example.com`, `app.example.com`). Unset or equal: everything refused. |
| `ACCESS_TEAM_DOMAIN` | `https://<team>.cloudflareaccess.com` |

**Product defaults** (as shipped):
| Var | Default | Meaning |
|---|---|---|
| `DIRECT_SEND` | `"1"` | The bot sends with no tap to people on your list. `"0"` = tap-to-approve only. |
| `ALLOW_EMAIL_OTP` | `"1"` | Normal setting. See "Sign-in and the passkey" below. |
| `REQUIRED_AMR` | `"otp"` | amr values the Worker accepts when a token carries one. |
| `RUNAWAY_PAUSE` / `RUNAWAY_MAX` | `"0"` / `"10"` | `"1"`: more than MAX direct sends in 60 minutes pauses direct send and texts you; resume on `/direct`. |
| `CONTACTS_SNAPSHOT_ONLY` | `"0"` | `"0"` adds the optional `DIRECT_ALLOWLIST` secret to the direct list. |
| `DISABLED` | `"0"` | `"1"` = kill switch: every route refused; the daily alarm only purges old rows. |
| `NOTIFY_MODE` | `"sms"` | Notices (sync failures, tap requests, pauses) go to `OWNER_NUMBER` through your phone, or `"ntfy"` with a token. |

**Opt-in switches** (off when unset):
| Var | Effect |
|---|---|
| `BLOCK_LINKS = "1"` | Refuse links in message text on both flows (400 `links_not_allowed`). URLs, bare domains, IPv4 addresses, and look-alikes with hidden characters or odd dots all count. `"0"` or unset = links allowed. Anything else = 503 config error. Contact names and labels that go into your notices are **always** link-checked, whatever this says. |
| `DIRECT_DAILY_CAP = "25"` | Direct sends per `TIMEZONE` day; past it, 429 `direct_daily_cap_reached`. Unset = no cap. |
| `DIRECT_PER_MINUTE_MAX`, `DIRECT_HOURS = "08:00-21:00"` | Burst limit and quiet hours (window may wrap midnight). |
| `DIRECT_NOTIFY_EACH = "1"` | Texts you the name and first 80 characters of each direct send. |
| `DIRECT_LOOKUP_MAX_PER_HOUR` | Lookups and refusals on `/send` per hour (default 30, `"off"` = none). Sends never count. |

**iPhone delivery** (see [SETUP-iphone.md](SETUP-iphone.md); all unset = android):
| Var | Default | Meaning |
|---|---|---|
| `DELIVERY` | unset (`android`) | `"mac"` or `"shortcut"` queues each checked text for your device to claim. Anything else: every route answers 503 `delivery_invalid`. |
| `DEVICE_TOKEN` (secret) | none | Required for mac/shortcut: 32+ characters, different from `REQUEST_TOKEN`. |
| `NOTIFY_MODE` | must be `"ntfy"` | In mac/shortcut, `"sms"` would send your notices through the device itself, so it's refused: 503 `config_invalid`, reason `notify_mode_must_be_ntfy_for_device_delivery`. |
| `UNCLAIMED_EXPIRY_MINUTES` | `"30"` | A text no device claims within this many minutes is dropped, **not sent**, and you get one notice per dropped text. 1..1440; garbage = 503 `config_invalid`. |
| `DIRECT_DAILY_CAP` | `25` in mac/shortcut | Unset means 25 a day here (Apple ID spam-flag risk); `"off"` removes it. |
| `SHORTCUT_PING`, `PING_FROM`, `PING_TO`, `SHORTCUT_NAME` | `"email"`, none, none, `"Relay Send"` | Shortcut path only: how the iPhone is woken. |

**Tap-to-approve limits** (only used by `POST /request`; unset = the default; garbage or out of range = 503 `config_invalid`):
| Var | Default | Range |
|---|---|---|
| `PENDING_CAP_PER_DAY` | 20 | 1–100000 |
| `SEND_CAP_INITIAL` | 5 a day, for `CAP_RAISE_AFTER_DAYS` days from `CAP_START_DATE` | 1–100000 |
| `SEND_CAP_AFTER` | 10 a day | 1–100000 |
| `CAP_RAISE_AFTER_DAYS` | 14 | 0–3650 |
| `REQUEST_TTL_SECONDS` | 900 | 60–86400 |
| `MIN_SECONDS_BETWEEN_SENDS` | 30 | 0–86400 |
| `MAX_TEXT_CHARS` | 640 (both flows) | 1–10000 |

`CAP_START_DATE` (`YYYY-MM-DD`): an invalid value keeps the tap cap at `SEND_CAP_INITIAL`.

**Secrets:** `REQUEST_TOKEN` (the bot's token), `ACCESS_AUD`, `APPROVER_EMAIL`, `GATEWAY_USER`, `GATEWAY_PASS`, `GATEWAY_DEVICE_ID`, `GATEWAY_PASSPHRASE` (32+ characters), `OWNER_NUMBER` (your own number, `+` and country code), `ALLOWLIST` (`{"+<number>":"Name"}`), `LOG_HASH_KEY` (32+ characters; direct send refuses without it), `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, one `GOOGLE_RT_<LABEL>` per Google account. Optional: `DIRECT_ALLOWLIST`, `NTFY_URL` + `NTFY_TOKEN`, `GATEWAY_PINNED_FINGERPRINT` + `GATEWAY_KEY_VERSION` (device-key mode).

## Sign-in and the passkey (read this)
The private page sits behind Cloudflare Access with **email one-time PIN plus a passkey** (Access's independent MFA). The Worker verifies the Access token again itself: RS256 signature against your team's keys, audience, issuer, expiry, and that the email is `APPROVER_EMAIL`. Those checks are always on.

**What it can't check:** Cloudflare's Access token doesn't say which second factor you used. So with `ALLOW_EMAIL_OTP = "1"` (the normal setting) the Worker accepts a valid Access login for your email without proving a passkey was used. **The passkey requirement then rests on your Access policy alone.** If the Access app allowed PIN-only logins, anyone who can read your email within the PIN window could open the page. That's why DEPLOY.md section 3 must be followed exactly, and section 8 checks that a fresh login asks for the passkey. Logins accepted this way are logged as `method=email_otp` or `method=email_otp_or_policy`. Setting `ALLOW_EMAIL_OTP = "0"` makes the Worker require a matching `amr` value from `REQUIRED_AMR`. Cloudflare's documented Access app token carries no `amr`, so in practice that refuses every login; it is there for setups whose tokens do carry one.

## Endpoints
| Host | Route | Auth | Does |
|---|---|---|---|
| request | `POST /send` | `Bearer REQUEST_TOKEN` | Direct send. Body: exactly one of `to` (E.164), `to_name`, `candidate_id`, plus `body`. `{"to_name":"Sam","resolve":true}` only looks the name up and returns `candidate_id`s (never sends). |
| request | `POST /request` `{to, text}` | `Bearer REQUEST_TOKEN` | Tap flow: stores a pending request and notifies you. Never sends by itself. |
| request | `GET /request/<id>` | `Bearer REQUEST_TOKEN` | State only. |
| approve | `GET /direct`, `POST /direct/sync`, `POST /direct/resume` | Access + same Origin + CSRF | Status page, Sync contacts now, resume after a runaway pause. |
| approve | `GET/POST /approve/<id>` | Access + same Origin + CSRF | Tap approval page. |
| approve | `GET /log` | Access | Last 500 log rows: no text, no full numbers. |
| approve | `POST /contacts` | Access | Optional manual contact upload (`scripts/import-contacts.mjs`). |
| request | `POST /device/next` | `Bearer DEVICE_TOKEN` | `DELIVERY = mac` or `shortcut` only. Claims the oldest queued text (one at a time). The reply carries the number and text: it's the sender. |
| request | `POST /device/result` `{id, lease, outcome}` | `Bearer DEVICE_TOKEN` | One result per claim: `sent`, `sent_unverified`, `not_started` or `uncertain`. Nothing is ever re-queued. |

Answers never contain a phone number, except `/device/next` to your own device. Refusals are JSON `{"error":"<code>"}`.

## How a direct send is checked
```mermaid
flowchart TD
    A[Bot: POST /send + token] --> B{DISABLED? TIMEZONE valid?}
    B -- no --> X1[503, nothing sent]
    B -- ok --> C{token ok? DIRECT_SEND = 1? LOG_HASH_KEY set?}
    C -- no --> X2[401 / 403 / 503]
    C -- ok --> D{body: not empty, under MAX_TEXT_CHARS, and no link if BLOCK_LINKS = 1}
    D -- no --> X3[400]
    D -- ok --> E{recipient on your list? one number?}
    E -- no --> X4[403 recipient_not_on_allowlist, logged as HMAC]
    E -- several names match / resolve --> F[candidate ids, nothing sent]
    E -- yes --> G{opt-in limits: daily cap, per minute, hours, runaway pause}
    G -- over --> X5[429 / 503]
    G -- ok --> H[encrypt text and number, send through your phone]
    H --> I[log: HMACs only]
```

## Safety notes
- **Device token:** with `DELIVERY = mac` or `shortcut`, `DEVICE_TOKEN` can only claim texts that already passed every check; it can't create one. It must differ from `REQUEST_TOKEN`, and each one rotates on its own.
- **Who can send:** anyone holding `REQUEST_TOKEN` can text anyone on your list, with no tap and (by default) no cap. Guard it like a password; the kill switches are in DEPLOY.md section 13.
- **Encryption:** text and number are encrypted end to end to your phone (passphrase mode: AES-256-CBC, PBKDF2-SHA1 at 100,000 iterations, the Workers maximum; the 32+ character passphrase is what makes it strong). If the gateway ever publishes a device key, the relay refuses to send until you pin it.
- **Contacts:** only display name, given name and phone numbers (not fax or pager) are stored. Emails, notes and addresses never are.
- **Retention:** tap request text is deleted after 7 days; log rows (no text) after 12 months.
- **CPU:** a passphrase-mode send costs about 58 ms of CPU inside the Durable Object. If you see error 1102 or "exceeded CPU", move to Workers Paid.

## Development
```sh
npm ci --legacy-peer-deps
npm test             # Worker tests in workerd (gateway, Access and Google mocked; real network blocked) + Node tests
npm run typecheck
npm run mutation     # breaks one guard at a time and requires a test to fail for every one
```
Test data is fake: `TEST-ONLY-…` tokens, `example.com` / `example.test` hosts, and numbers in the fictional 555-01xx range. A scan after every Worker test fails the test if any response, console line or log row contains something shaped like a phone number.

## Roadmap
- iPhone pickup: built (SETUP-iphone.md). The Mac path has not yet been run on a real Mac by the maintainers; treat it as beta until it has.

## License
MIT. See [LICENSE](LICENSE).
