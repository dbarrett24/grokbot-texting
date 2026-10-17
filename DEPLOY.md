# Deploy: text from your own Android number, by voice

This setup lets your assistant bot send texts from your own phone number when you tell it to. Texts go out through your Android phone and your SIM. No texting company is involved.

```
bot --(token)--> your Cloudflare Worker --(encrypted)--> SMS Gateway cloud --> your Android phone --> recipient
you --(email PIN + passkey)--> your private status page (contacts sync, log)
```

**How it works by default:**
- You say "text Sam: ...". The bot reads it back, you say yes, and it sends. There is no tap step.
- There is no daily cap, and links are allowed.
- The bot can only text people in your Google Contacts, plus any numbers you list yourself.
- Tap-to-approve, a daily cap and a link block are switches you can turn on (section 12).

**Ground rules:**
- Do every step on **your own computer** (macOS, Linux, or Windows with WSL) and your own phone. Never on a shared computer or one a bot runs on.
- No password, token or key goes into a chat, email, note or ticket. Each one is typed only into a hidden prompt on your computer, or into your bot's secret prompt.
- **HUMAN STEP** marks a step only you can do: installs, sign-ins, codes, consent screens, passkeys and the first deploy. Your bot can walk you through everything else, but it never signs in for you.
- Stop at any failed **Check** and fix it before going on.

Placeholders in this guide:
- `<yourdomain>`: a domain you own.
- `<API_HOST>`: the bot's address, for example `api.<yourdomain>`.
- `<APPROVE_HOST>`: your private page, for example `app.<yourdomain>`.
- `<TEMPLATE_REPO_URL>`: this repository.

Keep the hostnames bland.

## 0. What you need
- An Android phone with a SIM that can send SMS. It stays on, online and charged.
- A computer with Node.js 20 or newer (https://nodejs.org/), `git` and `openssl`. Check with `node -v`.
- A domain, or about $10 to buy one in Cloudflare.
- A Google account whose contacts you want the bot to be able to text.
- About 90 minutes.

Commands are written for zsh (the macOS default); bash equivalents are given where they differ. `read -rs "X?prompt"` reads a hidden value into `X` in zsh; in bash it's `read -rs -p "prompt" X`. On Windows, run the commands in WSL.

## 1. Phone: SMS Gateway for Android
1. **HUMAN STEP:** Install the app. On the phone, open https://github.com/capcom6/android-sms-gateway/releases.
   - Pick the newest release **not** marked Pre-release and download the `.apk` under Assets. Check that the page belongs to `capcom6/android-sms-gateway`.
   - Allow your browser to install apps when Android asks, then turn that permission back off after installing.
   - Docs: https://docs.sms-gate.app/getting-started/
2. **HUMAN STEP:** Grant the SMS permission when asked. Allow notifications.
   - If Android says SMS is a **restricted setting**: open Settings, Apps, SMS Gateway, ⋮ (top right), **Allow restricted settings**, then grant SMS again.
   - If that option is missing, connect the phone to your computer with USB debugging on and run:
     `adb shell pm grant me.capcom.smsgateway android.permission.SEND_SMS`
3. Battery: Settings, Apps, SMS Gateway, Battery, **Unrestricted** (on some phones, "Don't optimize"). Without this, Android stops the app and texts sit in a queue.
4. In the app, turn **Cloud Server** ON and **Local Server** OFF. Then tap **Offline** so it changes to **Online**. (Cloud mode works anywhere without opening your phone to the internet.) https://docs.sms-gate.app/getting-started/public-cloud-server/
5. Leave webhooks, SMS forwarding and the email bridge **off**.
6. The Cloud Server section now shows a **username** and **password**. Leave them on screen; you'll type them into hidden prompts in section 6. The same login opens dashboard.sms-gate.app, which can read your messages, so treat it like a bank password.
7. **Encryption passphrase.** On your computer, run `openssl rand -base64 32`. It prints 44 characters.
   - **HUMAN STEP:** In the app's settings, enter that exact value as the **encryption passphrase**.
   - Keep the terminal window open; you'll paste the same value in section 6. The relay refuses passphrases shorter than 32 characters.
   - Background: https://docs.sms-gate.app/privacy/encryption/
8. **Device id.** On your computer, run this. `read -s` hides what you type:
   ```sh
   read -r "U?SMS Gateway username: "; read -rs "P?password (hidden): "; echo
   curl -s -u "$U:$P" https://api.sms-gate.app/3rdparty/v1/devices; echo; unset P
   ```
   (In bash, use `read -r -p "username: " U; read -rs -p "password: " P`.) Note your phone's `id` from the output. If the output shows a `publicKey`, see "Known limits".

**Check:** the app shows **Online**, and the `devices` call lists exactly one device: yours.

## 2. Cloudflare account and domain
1. **HUMAN STEP:** Create a **new email address** used only for this. No bot or assistant should be able to read it.
2. **HUMAN STEP:** Sign up at https://dash.cloudflare.com/sign-up with that email.
   - Turn on two-factor sign-in with a **passkey or security key** right away: https://developers.cloudflare.com/fundamentals/user-profiles/2fa/
   - Use a fresh account, not one you use for anything else.
3. **HUMAN STEP:** Add your domain to this account (https://developers.cloudflare.com/fundamentals/manage-domains/add-site/), or buy one in Cloudflare Registrar (https://developers.cloudflare.com/registrar/get-started/register-domain/).
4. Pick the two hostnames: `<API_HOST>` and `<APPROVE_HOST>`. They must be different. Don't create DNS records; the deploy does that.

**Check:** dash.cloudflare.com shows the domain as **Active**.

## 3. Lock the private page with Cloudflare Access
In the dashboard, open **Zero Trust** (https://one.dash.cloudflare.com/).

1. **HUMAN STEP:** Pick a team name and the Free plan. Your team URL is `https://<team>.cloudflareaccess.com`.
2. Settings, Authentication, Login methods: keep only **One-time PIN**, a code sent to your email. Add no Google or other provider. https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/
3. Access settings, Multi-factor authentication: turn on **independent MFA**. Allow **Security key** only (this is the passkey type), with the shortest session. Leave "identity provider MFA / AMR matching" off. https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/independent-mfa/
4. Access, Applications, Add, **Self-hosted** (https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/):
   - Name: something bland, for example `relay-page`.
   - Destination: the whole `<APPROVE_HOST>`, with no path.
   - Session duration: **15 minutes**.
   - Login methods: **One-time PIN only**.
   - Policy: Action **Allow**, Include **Emails** = the email from step 2.1. MFA: Custom, **Security key** only.
   - Copy the application's **AUD tag** from its overview page.
5. Do **not** put `<API_HOST>` behind Access, and add no WAF or bot rules to it. The token protects it.

**Why this section matters so much:** with `ALLOW_EMAIL_OTP = "1"` (the normal setting, section 5), the Worker checks that the login came from your Access app and your email, but it **cannot** check that a passkey was used, because Cloudflare's login token doesn't say which second factor you used. The passkey requirement rests on these Access settings alone. Section 8 checks it.

**Check:** the app lists `<APPROVE_HOST>` and has one policy with only your email.

## 4. Get the code
```sh
git clone <TEMPLATE_REPO_URL> texting-relay && cd texting-relay
npm ci --legacy-peer-deps
npm test && npm run typecheck
```

**Check:** every test passes and the typecheck is clean. If anything fails, stop and don't deploy.

## 5. Edit wrangler.toml (no secrets go in this file)
1. Uncomment `routes` and put in your two hostnames (`custom_domain = true` stays).
2. Set these under `[vars]`:
   ```toml
   TIMEZONE = "America/New_York"                 # REQUIRED: your IANA zone (list: https://en.wikipedia.org/wiki/List_of_tz_database_time_zones)
   DEFAULT_COUNTRY_CODE = "+1"                   # REQUIRED: your country code, or "none" (see below)
   REQUEST_HOST = "<API_HOST>"
   APPROVE_HOST = "<APPROVE_HOST>"
   ACCESS_TEAM_DOMAIN = "https://<team>.cloudflareaccess.com"
   CAP_START_DATE = "YYYY-MM-DD"                 # today; only used if you turn on tap-to-approve
   GOOGLE_ACCOUNTS = "primary"                   # one label per Google account, e.g. "primary,work"
   ```
3. Leave the rest as shipped: `DIRECT_SEND = "1"`, `ALLOW_EMAIL_OTP = "1"`, `REQUIRED_AMR = "otp"`, `NOTIFY_MODE = "sms"`, `CONTACTS_SNAPSHOT_ONLY = "0"`, `RUNAWAY_PAUSE = "0"`, `DISABLED = "0"`, `workers_dev = false`.

**TIMEZONE** has no default. If it's missing or misspelled, the relay refuses everything with `timezone_not_configured` or `timezone_invalid` until you fix it.

**DEFAULT_COUNTRY_CODE** has no default either. Google usually gives each number in `+` form already; this code is used only for numbers saved without one. With `"+44"`, `0555 555 0100` becomes `+445555550100`. With `"none"`, numbers without a `+` are skipped. If it's missing, contact sync refuses (`default_country_code_invalid`) and keeps your previous list.

**Labels:** letters, digits or `_`, with `UPLOAD` reserved. The first label wins when two accounts have the same number.

**Check:** `grep -nE '^[^#]*(REPLACE|example\.com)' wrangler.toml` prints nothing.

## 6. Sign in to Cloudflare and store the secrets
Each `secret put` asks for its value at a hidden prompt. Type or paste it there, nowhere else.
```sh
npx wrangler login                 # HUMAN STEP: browser sign-in to the NEW account, with your passkey
npx wrangler whoami                # must show the new account
openssl rand -hex 32               # this is your bot token. Keep this window open until section 11
npx wrangler secret put REQUEST_TOKEN
npx wrangler secret put ACCESS_AUD           # AUD tag from 3.4
npx wrangler secret put APPROVER_EMAIL       # email from 2.1
npx wrangler secret put GATEWAY_USER         # from the app (1.6)
npx wrangler secret put GATEWAY_PASS         # from the app (1.6)
npx wrangler secret put GATEWAY_DEVICE_ID    # from 1.8
npx wrangler secret put GATEWAY_PASSPHRASE   # the same 44 characters you put in the app (1.7)
npx wrangler secret put OWNER_NUMBER         # YOUR OWN number, + and country code, no spaces
npx wrangler secret put ALLOWLIST            # {"+<your number>":"Your Name"}: your own number, so you can test
openssl rand -base64 32 | tr -d '\n' | npx wrangler secret put LOG_HASH_KEY   # made and stored without showing it
```

**Check:** `npx wrangler secret list` shows these names (values are never shown): REQUEST_TOKEN, ACCESS_AUD, APPROVER_EMAIL, GATEWAY_USER, GATEWAY_PASS, GATEWAY_DEVICE_ID, GATEWAY_PASSPHRASE, OWNER_NUMBER, ALLOWLIST, LOG_HASH_KEY.

## 7. First deploy
```sh
npx wrangler deploy                # HUMAN STEP: you run it and read the output
```
Then, from your computer and not signed in:
```sh
curl -si https://<APPROVE_HOST>/log | head -n 1                            # expect a redirect (302) to Access
curl -si https://<API_HOST>/log | head -n 1                                # expect 404
curl -si -X POST https://<API_HOST>/send -H "Authorization: Bearer wrong" \
  -H 'content-type: application/json' -d '{}' | head -n 1                  # expect 401
```

**Check:** all three answers match. A 403 from `<API_HOST>` means something in Cloudflare is covering it (section 3.5). A 503 means a required setting is missing: the body names it (for example `timezone_not_configured`).

## 8. Check the private page
1. **HUMAN STEP:** On your phone, open `https://<APPROVE_HOST>/direct`. Enter the email PIN, then **enroll your passkey** when asked. Every later sign-in should ask for the PIN **and** the passkey.
2. The page shows `DIRECT_SEND: on`, `State: running`, your `DEFAULT_COUNTRY_CODE`, and one line per Google label (`never loaded` for now).

**Check:**
- Sign out (`https://<APPROVE_HOST>/cdn-cgi/access/logout`) and open `/direct` again. It must ask for the PIN **and** the passkey.
- If it accepts the PIN alone, fix section 3.3 and 3.4 before going on. With the normal `ALLOW_EMAIL_OTP = "1"`, the Worker would accept that PIN-only login.

## 9. Google Contacts (who the bot may text)
Read-only access to your contacts' names and numbers. Emails, notes and addresses are never stored.

1. **HUMAN STEP:** Sign in to https://console.cloud.google.com/ with your own Google account and create a project (for example `contacts-relay`): https://console.cloud.google.com/projectcreate
2. Enable the People API: https://console.cloud.google.com/apis/library/people.googleapis.com
3. Google Auth Platform, Branding / Audience (https://console.cloud.google.com/auth/overview):
   - User type: **External**. Give it an app name and your email.
   - Audience: either **Publish app (In production)**, or stay in **Testing** and add each Google account you'll connect as a test user.
   - In Testing, access expires after **7 days** and sync stops, so publishing is better.
   - A published but unverified app shows "Google hasn't verified this app". That's your own app; click Advanced, then Go to (app name). https://support.google.com/cloud/answer/15549945
   - A work or school Google account may have an admin rule that blocks unverified apps.
4. Clients, Create client, Application type **Desktop app** (https://console.cloud.google.com/auth/clients). Copy the Client ID and Client secret, then:
   ```sh
   npx wrangler secret put GOOGLE_CLIENT_ID
   npx wrangler secret put GOOGLE_CLIENT_SECRET
   ```
5. **HUMAN STEP:** Consent, once per label in `GOOGLE_ACCOUNTS`. Run this in the code folder, on the same computer as your browser:
   ```sh
   read -r "GOOGLE_CLIENT_ID?Client ID: "; export GOOGLE_CLIENT_ID
   read -rs "GOOGLE_CLIENT_SECRET?Client secret (hidden): "; echo; export GOOGLE_CLIENT_SECRET
   node scripts/google-consent.mjs primary      # prints a link and opens it; pick the account for this label; allow contacts (read-only)
   unset GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET
   ```
   - The script always prints the link, then tries to open it (`open` on macOS, `xdg-open` on Linux, `start` on Windows). If no browser opens, or the page that opens shows an error (on Windows, `start` can mangle a link containing `%`), copy the printed link into a browser on the same computer: Google sends the answer back to a one-time `127.0.0.1` port there, which closes after 5 minutes.
   - It stores the access straight into the secret `GOOGLE_RT_PRIMARY`; it is never shown or saved to a file.
   - It refuses if Google granted anything other than read-only contacts.
   - "no refresh token": remove the app at https://myaccount.google.com/permissions and run it again.
6. Load the contacts now: open `https://<APPROVE_HOST>/direct` and press **Sync contacts now**. After that, a daily sync runs on its own. A failed sync keeps the last good list and texts you once.

**Check:** the result reads `{"updated":["PRIMARY"],"failed":[]}`, and `/direct` shows a number count for each label.

| `failed` reason | Fix |
|---|---|
| `missing_secret_GOOGLE_RT_<LABEL>` | Run step 5 for that label |
| `google_client_not_configured` | Step 4 secrets missing |
| `default_country_code_invalid` | Set `DEFAULT_COUNTRY_CODE` (section 5) and deploy |
| `google_people_status_403` | People API not enabled (step 2) |
| `google_token_status_400` | Access expired (Testing mode) or revoked. Publish the app, then redo step 5 |
| `empty_result` | No contacts with a phone number in that account |

## 10. Test text to yourself
Your own number is on the list through `ALLOWLIST` (your own contact card usually isn't in the sync).
```sh
read -rs "RT?Bot token (hidden): "; echo
API=https://<API_HOST>
curl -sS -X POST "$API/send" -H @<(printf 'Authorization: Bearer %s\n' "$RT") -H 'content-type: application/json' \
  -d '{"to_name":"Your Name","resolve":true}'
```
- Expect `"state":"one"` with a `candidate_id`. Nothing is sent by this call.
- If you get `ambiguous`, pick from the `candidates` by label. If you get `no_match`, use the exact name from `ALLOWLIST`.

Then send it, using the formatting rule (below):
```sh
CID=<candidate_id>
curl -sS -X POST "$API/send" -H @<(printf 'Authorization: Bearer %s\n' "$RT") -H 'content-type: application/json' \
  -d "{\"candidate_id\":\"$CID\",\"body\":\"Hi,\n\nThis is a relay test. Would you reply OK when you see it?\n\nhttps://example.com\"}"
unset RT CID
```

**Check:**
- The answer has `"state":"sent"`, and the text arrives on your phone with blank lines between the parts.
- `https://<APPROVE_HOST>/log` shows `direct_sent` with hashes only, never a number or the text.
- A number on no list gets 403 `recipient_not_on_allowlist`.
- If you get HTTP 502 `send_failed`: look in `/log`. Check the phone is Online and the passphrase matches the app exactly.
- Error 1102 or "exceeded CPU" means upgrade to Workers Paid.

**Formatting rule (standard):** put a line break (a blank line) between the greeting, the ask and any link. No wall of text, and soft asks ("Would you be able to..."), not commands. In JSON, a line break is `\n`.

## 11. Connect your bot
1. **HUMAN STEP:** Give the bot the token from section 6 **only through its secret prompt**. Never paste it into chat.
   - Tell the bot the `<API_HOST>` address.
   - Close the terminal that showed the token.
2. The bot's rules:
   - Read every text back word for word with the resolved name (`resolve: true` first, then send by `candidate_id`).
   - Wait for your yes on that exact text. On voice, one text at a time.
   - Any edit needs a fresh yes.
   - One recipient per text.
   - Follow the formatting rule in section 10.
   - Stop and tell you on anything other than `sent`.

**Check:** ask the bot to text you "test". It reads it back, waits for your yes, sends it, and the text arrives.

## 12. Optional switches
Each one is a `[vars]` line in `wrangler.toml`, followed by `npx wrangler deploy`.

| Want | Set | Effect |
|---|---|---|
| **Tap-to-approve** | `DIRECT_SEND = "0"` | The bot can no longer send directly. It files a request (`POST /request`), you get a text, and you approve on your phone after the PIN and passkey. Add every allowed recipient to the `ALLOWLIST` secret. Limits below. |
| **Daily cap** | `DIRECT_DAILY_CAP = "25"` (any whole number) | Sends past the cap that day (in `TIMEZONE`) are refused with `direct_daily_cap_reached`. |
| **Link block** | `BLOCK_LINKS = "1"` | Texts containing a link (URL, domain, IP address, including disguised ones) are refused with `links_not_allowed`, on both flows. |
| Per-minute cap | `DIRECT_PER_MINUTE_MAX = "5"` | Limits bursts. |
| Quiet hours | `DIRECT_HOURS = "08:00-21:00"` | Refuses outside the window (`direct_outside_hours`). |
| Runaway pause | `RUNAWAY_PAUSE = "1"`, `RUNAWAY_MAX = "10"` | More than MAX sends in 60 minutes pauses sending and texts you. You resume on `/direct`. |
| Copy of each send | `DIRECT_NOTIFY_EACH = "1"` | Texts you the name and the first 80 characters of each send. |
| Tap limits | `PENDING_CAP_PER_DAY` (20), `SEND_CAP_INITIAL` (5), `SEND_CAP_AFTER` (10), `CAP_RAISE_AFTER_DAYS` (14), `REQUEST_TTL_SECONDS` (900), `MIN_SECONDS_BETWEEN_SENDS` (30), `MAX_TEXT_CHARS` (640, both flows) | Defaults in brackets. The tap send cap is `SEND_CAP_INITIAL` a day for `CAP_RAISE_AFTER_DAYS` days from `CAP_START_DATE`, then `SEND_CAP_AFTER`. |

A typo in one of these (a word, `0` where it isn't allowed, a decimal, an out-of-range number) makes the relay refuse sends with `config_invalid` or `direct_config_invalid` until you fix it. That's on purpose. Contact names and labels that reach your notices are always link-checked, whatever `BLOCK_LINKS` says.

## 13. Kill switch and rollback
Any one of these stops texting:
- **Fastest, no deploy:** Cloudflare dashboard, Workers & Pages, your Worker, Settings, Variables: set `DISABLED` to `1`. Then put `DISABLED = "1"` in wrangler.toml too, or the next deploy turns it back on.
- `DISABLED = "1"` (everything) or `DIRECT_SEND = "0"` (direct sends only) in wrangler.toml, then `npx wrangler deploy`.
- `npx wrangler secret put REQUEST_TOKEN` with a new value. The bot's token stops working at once.
- **On the phone:** tap **Online** so it goes **Offline**, or turn off Cloud Server.

**Rollback** after a bad deploy:
```sh
npx wrangler deployments list         # find the last good version id
npx wrangler rollback <version-id>
```
Docs: https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/

Rollback doesn't undo secrets or stored data.

**Check:** after a kill, a test send gets an error (`relay_disabled`, `direct_send_off` or `bad_request_token`) and nothing arrives.

## 14. Rotating secrets
| What | How |
|---|---|
| Bot token | `openssl rand -hex 32`, then `npx wrangler secret put REQUEST_TOKEN`, then give the new one to the bot's secret prompt |
| Gateway password | Regenerate it in the app's Cloud Server settings, then `npx wrangler secret put GATEWAY_PASS` |
| Passphrase | New `openssl rand -base64 32`. Set it in the app **and** with `npx wrangler secret put GATEWAY_PASSPHRASE` right after. Texts fail until both match |
| Log key | `openssl rand -base64 32 \| tr -d '\n' \| npx wrangler secret put LOG_HASH_KEY` (stored contacts are re-hashed on the next send) |
| Google access | Remove the app at https://myaccount.google.com/permissions, then rerun section 9 step 5 |

Do it right away if a phone, computer or bot that held one is lost or compromised.

## 15. Teardown (remove everything)
1. `npx wrangler delete` (removes the Worker and its stored contacts and log). Confirm in the dashboard that it's gone.
2. Zero Trust: delete the Access application and its policy.
3. DNS: remove any records left for `<API_HOST>` and `<APPROVE_HOST>`.
4. Google: remove the app at https://myaccount.google.com/permissions for each account, then delete the Cloud project (https://console.cloud.google.com/, IAM & Admin, Settings, Shut down).
5. Phone: go Offline, turn off Cloud Server, then uninstall SMS Gateway.
6. Bot: delete the stored token.
7. Optional: cancel the domain and close the Cloudflare account and the dedicated email.

**Check:** `curl -si https://<API_HOST>/send` no longer reaches the relay, and https://myaccount.google.com/permissions no longer lists the app.

## Known limits
- **Android only.** iPhone pickup is planned.
- **Device-key mode:** if the `devices` call in 1.8 ever shows a `publicKey`, the relay refuses to send until you set `GATEWAY_PINNED_FINGERPRINT` and `GATEWAY_KEY_VERSION` from the app. That's deliberate.
- **The phone is the sender.** If it's off, offline, or Android kills the app, texts wait in the cloud queue. The app checks in at least every 15 minutes.
- **Who can send:** anyone with the bot token can text anyone on your list with no tap. Guard the token like a password, and use section 13 if it leaks.
- **Sign-in:** with `ALLOW_EMAIL_OTP = "1"` the passkey requirement rests on your Access policy alone (section 3).
