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

**Numbered steps:** a new install follows **[docs/SETUP.md](docs/SETUP.md)** (`step-1` through `step-9`). The deploy config is `.relay-local/wrangler.toml` (gitignored), not the committed template. Commands below that talk to the Worker take `-c .relay-local/wrangler.toml`. This file's section numbers are what the Worker pages cite.

**Ground rules:**
- Do every step on **your own computer** (macOS, Linux, or Windows with WSL) and your own phone. Never on a shared computer or one a bot runs on.
- No password, token or key goes into a chat, email, note or ticket. Each one is typed only into a hidden prompt on your computer, or into your bot's secret prompt.
- **HUMAN STEP** marks a step only you can do: installs, sign-ins, codes, consent screens, passkeys and the first deploy. Your bot can walk you through everything else, but it never signs in for you.
- Stop at any failed **Check** and fix it before going on.
- **Setup scripts:** `scripts/setup-mac.sh` (macOS) and `scripts/setup-windows.ps1` (Windows) run the computer steps of this guide one at a time (install Node, get the code, test, make keys, deploy, store secrets, test text). Your bot can run them for you on your computer, with your OK on each command. Keys they make stay in `.relay-local/` in your copy of the code (never committed) and go to Cloudflare without being shown. Run a step with no arguments to see what it needs. Group texts (`config --group-mms 1`) are Android only at launch. The Node download is checked against nodejs.org's own SHA256 list, fetched over HTTPS from the same site. That catches a corrupted download, not a compromised nodejs.org. Before deploying, the `claim` step refuses a Worker name or hostname that's already in use. It reuses a name only for a Worker it deployed itself, in the same Cloudflare account (sign in to just the one account).

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
   - Versions that matter (from the app's changelog, https://github.com/capcom6/android-sms-gateway/blob/master/CHANGELOG.md): **v1.74.0** or later is needed for group MMS (optional, section 12). **v1.77.0** and later publish a device key, so step 9 below applies; the newest release does. The app shows its version in its Settings, under Information.
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
7. **Encryption: passphrase (the default for now) or device key (opt-in).** SMS Gateway v1.77.0–v1.77.4 can’t decrypt device-key texts (its decrypt code asks the Android Keystore for MGF1-SHA-256, against its own published format; the phone shows "key store operation failed"; see Known limits). Until a fixed app release, setup uses **passphrase mode**, which the app still decrypts on a phone that has a device key (it picks the decryptor by the text's prefix). Leave the app's device key alone; nothing here needs it removed.
   - To opt in to device-key mode once your app decrypts it: `config --gateway-mode device-key`, then step 9. To go back: `config --gateway-mode passphrase`, then `keys` and `secrets` (they remove the pin from the Worker).
   - **Passphrase:**
     - If the app **already has** a passphrase (Settings, Encryption, Passphrase is filled in), keep it: run `scripts/setup-mac.sh ask GATEWAY_PASSPHRASE` and type that same value at the hidden prompt. Setup never replaces a passphrase you already have.
     - If not, `keys` makes one; `show GATEWAY_PASSPHRASE` shows it once so you can type it into **Settings**, **Encryption**, **Passphrase** in the app. (The screen names come from the app's source, v1.77.x.) The relay refuses passphrases shorter than 32 characters.
   - Background: https://docs.sms-gate.app/privacy/encryption/
8. **Device id.** On your computer, run this. `read -s` hides what you type:
   ```sh
   read -r "U?SMS Gateway username: "; read -rs "P?password (hidden): "; echo
   curl -s -u "$U:$P" https://api.sms-gate.app/3rdparty/v1/devices; echo; unset P
   ```
   (In bash, use `read -r -p "username: " U; read -rs -p "password: " P`.) Find **your** phone in the output by its `name` and note its `id`, and whether that entry shows a `publicKey` and a `keyVersion`. Never take the first entry of the list on trust, and don't pin a key by hand: `gateway-check` stores the id once and from then on only reads the entry with that `id` (it fails with `device_id_changed` if that phone is gone), and `confirm-fingerprint` shows the device id and name next to the fingerprint.
9. **Run `gateway-check`** (`scripts/setup-mac.sh <step>` on a Mac, `scripts\setup-windows.ps1 <step>` on Windows; run `ask GATEWAY_USER` and `ask GATEWAY_PASS` first). It reads your phone's listing and prints `RELAY_STATUS step=gateway_mode result=ok reason=passphrase` (the default, step 7) or `reason=device_key` if you opted in. In passphrase mode you're done here.
   - **Device-key mode only (opt-in): then `confirm-fingerprint`.** The relay refuses to send until the device key is pinned, so a server that swapped it can't read your texts. https://docs.sms-gate.app/privacy/encryption/ ("Trust model and key verification")
   - `gateway-check` reads `publicKey` and `keyVersion`, computes the fingerprint and holds it until you confirm. You never copy the fingerprint or the key version anywhere.
   - `confirm-fingerprint` opens a window showing the first two and last two groups big, the full value smaller. **HUMAN STEP:** in the app open **Settings**, **Device…**, **Device Key**, **Key fingerprint** and compare those groups by eye. Same: **Yes, it matches**. Different: **No, different**, and stop.
   - After **Yes**, the pin and key version are saved; if the relay is already deployed from this computer, they go straight to the Worker too (and an old `GATEWAY_PASSPHRASE` there is removed). Not deployed yet: `secrets` sends them after section 7.
   - In the same **Device Key** section, set **Automatic key rotation** to **Disabled**. Every new key (rotated by hand or automatically) stops the relay until you confirm it again (section 14).

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

**Upgrading later:** from the same folder, `git pull`, then `npm install --legacy-peer-deps` (a new version can change the dependencies, and the old `node_modules` won't match), then `npm test && npm run typecheck` before you deploy again.

## 5. Local wrangler config (no secrets go in this file)

Build `.relay-local/wrangler.toml` as [docs/SETUP.md](docs/SETUP.md) Step 2. It is gitignored, so `git pull` never adds the two `[[rules]]` blocks and never sets `main`. The subfolder file needs `main = "../src/index.ts"`, one Text rule for `**/*.css` and `**/*.svg`, and a Data rule for `**/*.woff2` and `**/*.webp`, both with `fallthrough = false`. `npm run check` fails when a rule is missing or wrong, or when `main` does not resolve to `src/index.ts`. Leave the committed `wrangler.toml` as the template.

In that local file, set `routes` to your two hostnames (`custom_domain = true`) and set these under `[vars]`:
   ```toml
   TIMEZONE = "America/New_York"                 # REQUIRED: your IANA zone (list: https://en.wikipedia.org/wiki/List_of_tz_database_time_zones)
   DEFAULT_COUNTRY_CODE = "+1"                   # REQUIRED: your country code, or "none" (see below)
   REQUEST_HOST = "<API_HOST>"
   APPROVE_HOST = "<APPROVE_HOST>"
   ACCESS_TEAM_DOMAIN = "https://<team>.cloudflareaccess.com"
   CAP_START_DATE = "YYYY-MM-DD"                 # today; only used if you turn on tap-to-approve
   ```
   `GOOGLE_ACCOUNTS` can stay `""`: Google accounts are now connected on the Contacts page (section 9). It's kept for deploys that already use `GOOGLE_RT_<LABEL>` secrets.
Leave the rest as shipped: `DIRECT_SEND = "1"`, `ALLOW_EMAIL_OTP = "1"`, `REQUIRED_AMR = "otp"`, `NOTIFY_MODE = "sms"`, `RUNAWAY_PAUSE = "0"`, `GROUP_MMS = "0"`, `DISABLED = "0"`, `workers_dev = false`.

**TIMEZONE** has no default. If it's missing or misspelled, the relay refuses everything with `timezone_not_configured` or `timezone_invalid` until you fix it.

**DEFAULT_COUNTRY_CODE** has no default either. Google usually gives each number in `+` form already; this code is used only for numbers saved without one. With `"+44"`, `0555 555 0100` becomes `+445555550100`. With `"none"`, numbers without a `+` are skipped. If it's missing, contact sync refuses (`default_country_code_invalid`) and keeps your previous list.

**Labels:** letters, digits or `_`, with `UPLOAD` reserved. The first label wins when two accounts have the same number.

**Check:** `npm run check` prints `check-wrangler: OK`, and `grep -nE '^[^#]*(REPLACE|example\.com)' .relay-local/wrangler.toml` prints nothing once your real hosts are in.

## 6. Sign in to Cloudflare and store the secrets
Each `secret put` asks for its value at a hidden prompt. Type or paste it there, nowhere else.

The Worker doesn't exist yet, so the **first** `secret put` asks: `There doesn't seem to be a Worker called "sms-relay". Do you want to create a new Worker with that name and add secrets to it?` Answer **yes**. Wrangler creates an empty placeholder Worker (it answers nothing useful) and adds the secret; section 7's deploy replaces it with the relay. The later `secret put` lines don't ask again. (Cloudflare's docs don't describe this prompt; it is in Wrangler's own code, checked in Wrangler 4.151.1, the version this repo installs.)
```sh
npx wrangler login                 # HUMAN STEP: browser sign-in to the NEW account, with your passkey
npx wrangler whoami                # must show the new account
openssl rand -hex 32               # this is your bot token. Keep this window open until section 11
npx wrangler -c .relay-local/wrangler.toml secret put REQUEST_TOKEN
npx wrangler -c .relay-local/wrangler.toml secret put ACCESS_AUD           # AUD tag from 3.4
npx wrangler -c .relay-local/wrangler.toml secret put APPROVER_EMAIL       # email from 2.1
npx wrangler -c .relay-local/wrangler.toml secret put GATEWAY_USER         # from the app (1.6)
npx wrangler -c .relay-local/wrangler.toml secret put GATEWAY_PASS         # from the app (1.6)
npx wrangler -c .relay-local/wrangler.toml secret put GATEWAY_DEVICE_ID    # from 1.8
npx wrangler -c .relay-local/wrangler.toml secret put GATEWAY_PASSPHRASE   # passphrase mode, the default (1.7); skip in device-key mode
npx wrangler -c .relay-local/wrangler.toml secret put GATEWAY_MODE   # type passphrase at the prompt; or device_key if you opted in (1.7)
npx wrangler -c .relay-local/wrangler.toml secret put OWNER_NUMBER         # YOUR OWN number, + and country code, no spaces
npx wrangler -c .relay-local/wrangler.toml secret put ALLOWLIST            # {"+<your number>":"Your Name"}: your own number, so you can test
openssl rand -base64 32 | tr -d '\n' | npx wrangler -c .relay-local/wrangler.toml secret put LOG_HASH_KEY   # made and stored without showing it
openssl rand -base64 32 | tr -d '\n' | npx wrangler -c .relay-local/wrangler.toml secret put GOOGLE_TOKEN_KEY   # seals Google sign-ins stored by the Worker (section 9)
```
Device-key mode (opt-in): don't type the pin: run `gateway-check` then `confirm-fingerprint` (section 1, step 9). They store `GATEWAY_PINNED_FINGERPRINT` and `GATEWAY_KEY_VERSION` for you (on the Worker too, once it's deployed); `secrets` sends them otherwise.

**Check:** `npx wrangler -c .relay-local/wrangler.toml secret list` shows these names (values are never shown): REQUEST_TOKEN, ACCESS_AUD, APPROVER_EMAIL, GATEWAY_USER, GATEWAY_PASS, GATEWAY_DEVICE_ID, GATEWAY_MODE, GATEWAY_PASSPHRASE (device-key mode: GATEWAY_PINNED_FINGERPRINT and GATEWAY_KEY_VERSION instead), OWNER_NUMBER, ALLOWLIST, LOG_HASH_KEY, GOOGLE_TOKEN_KEY.

## 7. First deploy
```sh
npx wrangler deploy -c .relay-local/wrangler.toml                # HUMAN STEP: you run it and read the output
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
Read-only access to your contacts' names and numbers. Emails, notes and addresses are never stored. Everything happens on `https://<APPROVE_HOST>/contacts`, in the **Google accounts** panel. No terminal and no `wrangler secret put` per account.

You use **your own** Google Cloud project and your own Worker. There is no shared database. The standard web OAuth client (`….apps.googleusercontent.com`) is created in the console; `gcloud` cannot create it (README, "Google Cloud client", cites Google's workforce OAuth page). The Contacts page does not ask for the client id or secret.

1. **HUMAN STEP:** Create a project named `contacts-relay`: https://console.cloud.google.com/projectcreate
2. Enable the People API: https://console.cloud.google.com/flows/enableapi?apiid=people.googleapis.com (if that page errors, https://console.cloud.google.com/apis/library/people.googleapis.com and press Enable).
3. Branding (https://console.cloud.google.com/auth/overview/create; if Google Auth Platform is already set up, open Branding from the overview):
   - User type: **External**. App name `Contacts relay`, and your email.
4. Create an OAuth client (https://console.cloud.google.com/auth/clients/create): Application type **Web application**. Under **Authorized redirect URIs**, add exactly `https://<APPROVE_HOST>/contacts/google/callback`. No trailing slash. Download the client JSON.
   - Optional: Audience (https://console.cloud.google.com/auth/audience), **Publish app (In production)**. Staying in **Testing** works if you add each Google account as a test user, but access then expires after **7 days** and sync stops.
   - A published but unverified app shows "Google hasn't verified this app". That's your own app; click Advanced, then Go to (app name). https://support.google.com/cloud/answer/15549945
   - A work or school Google account may have an admin rule that blocks unverified apps.
5. On your computer: `node scripts/google-client.mjs --file=<downloaded-client.json>`. It puts `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` with `npx wrangler secret put` and `--config=.relay-local/wrangler.toml` (values on stdin, never printed) and then deletes the JSON. `GOOGLE_TOKEN_KEY` (section 6) must already be set before you press Connect Google.
6. **HUMAN STEP:** Type a name for the account (for example `primary` or `work`) and press **Connect Google**. Pick the Google account and allow **read-only contacts** only. Back on the page it shows "Connected PRIMARY". The Worker refuses, and revokes at Google, if anything other than read-only contacts was granted.
   - "Google sent no long-lived token": remove the app at https://myaccount.google.com/connections, then Connect again.
   - Repeat for each Google account. The first connected account wins when two accounts have the same number. Accounts in `GOOGLE_ACCOUNTS` come first.
7. Press **Sync now**. After that, a daily sync runs on its own. A failed sync keeps the last good list and texts you once. The Contacts page shows the last sync error next to **Sync**.
8. **HUMAN STEP:** on the same page, turn on the people you want the bot to text (see "Contacts page" below). Everyone starts **off**.

**Reconnect** signs in again for the same name (use it after `google_token_status_400`). **Disconnect** asks first, then revokes the access at Google and deletes the stored sign-in and that account's contacts. If Google doesn't confirm the revoke, it still deletes and tells you; remove it at https://myaccount.google.com/connections. Disconnect also stops the old fallback: an account still listed in `GOOGLE_ACCOUNTS` (with a `GOOGLE_RT_<LABEL>` secret) is no longer synced from the secret. The page then shows a note to remove it from `GOOGLE_ACCOUNTS`, deploy, and run `npx wrangler -c .relay-local/wrangler.toml secret delete GOOGLE_RT_<LABEL>`. Connecting that name again clears this.

**Upgrading a relay that uses `GOOGLE_RT_<LABEL>` secrets:** nothing breaks. Those accounts keep syncing from the secrets and show as "legacy" on the page, and `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` still work. A sign-in or client saved on the page wins over the secret. To move over: add `GOOGLE_TOKEN_KEY` (section 6), add the redirect URI from step 4 to your client (a Desktop client can't take one, so create a Web client), press Reconnect for each account, then delete the old secrets with `npx wrangler -c .relay-local/wrangler.toml secret delete GOOGLE_RT_<LABEL>`. `scripts/google-consent.mjs` (setup step `google`) is **legacy**. It still works for the secret-based setup, but new deploys don't need it.

**Check:** the page says "Sync finished". A failed sync shows the error and its fix next to **Sync**. (`/direct` still lists each account's number count and "last good" time, and has a **Sync contacts now** button that answers `{"updated":["PRIMARY"],"failed":[]}`.)

| `failed` reason | Fix |
|---|---|
| `missing_secret_GOOGLE_RT_<LABEL>` | A `GOOGLE_ACCOUNTS` label with no secret and no sign-in: press Reconnect for it (or remove it from `GOOGLE_ACCOUNTS`) |
| `google_client_not_configured` | Step 5: `node scripts/google-client.mjs` |
| `google_token_key_missing` | `GOOGLE_TOKEN_KEY` is unset or isn't the key the sign-in was saved with (section 6, section 14) |
| `google_token_decrypt_failed` | The stored sign-in can't be read: press Reconnect |
| `default_country_code_invalid` | Set `DEFAULT_COUNTRY_CODE` (section 5) and deploy |
| `google_people_status_403` | People API not enabled (step 2) |
| `google_token_status_400` | Access expired (Testing mode) or revoked. Publish the app, then press Reconnect |
| `empty_result` | No contacts with a phone number in that account |

Sign-in errors come back to the page as a red line with the fix: `google_scope_not_exact`, `google_no_refresh_token`, `google_state_expired` (more than 10 minutes on Google's pages), `google_consent_denied`, `google_token_status_<n>` (usually a redirect URI that doesn't match step 4).

The same codes show next to **Sync** on the Contacts page, with this fix text.

### Contacts page (who the bot may text)
`https://<APPROVE_HOST>/contacts`, behind Access like the rest of that host. The title is **GrokBot Texting**, with the logo beside it. It lists everyone from Google sync, the manual upload and the old `DIRECT_ALLOWLIST`, with name, label and **only the last 4 digits**, 25 at a time (10/25/50/100). **Enable all shown** still means the current search and filter, not only the page on screen. The page is the contact list, **Sync**, and **Connect Google**. Per-account counts stay on `/direct`. The bot can text a person only when they are switched **on** here, or listed in the `ALLOWLIST` secret (shown read-only, "always on (ALLOWLIST)").

- **New people start off.** That includes a new number added to someone who is already on: each number is its own switch.
- **Turning someone on** asks "Text Riley at •••• 0142?" so you check the last 4 first. **Enable all shown** acts on the current search and filter, and asks with a count.
- **Star** the people you text most: they sort first and get a **Starred** filter. A star never turns anyone on.
- **Sync now** pulls Google right away; the daily sync keeps running. The last sync error, when there is one, is shown next to **Sync** with its fix. Per-account counts stay on `/direct`.
- Name lookup (`POST /send` with `resolve`, or `POST /contacts/preview`) still reports "one", "ambiguous", or "no match". The Contacts page does not show a resolve-preview form.
- Numbers like `555-0100`…`555-0199`, and 555 followed by `1234`, are documentation examples, and the page refuses to turn them on.
- **Upgrading an existing relay:** everyone who could be texted before the update stays on and is flagged as migrated. A banner says how many; **Review migrated** filters to them, and **Turn all migrated off** switches them all off at once. Nothing is turned on by the upgrade that wasn't textable before.
- **`DIRECT_ALLOWLIST` is deprecated.** On the first request after the update its entries are imported once as the `ALLOWLIST_LEGACY` source and flagged: on only when this is an upgrade of a Worker that had already run and `CONTACTS_SNAPSHOT_ONLY` was `"0"` (the old default, so they were textable); off otherwise. A fresh deploy never switches anyone on. After that the secret is ignored. Review them on the page, then delete it: `npx wrangler -c .relay-local/wrangler.toml secret delete DIRECT_ALLOWLIST`. `CONTACTS_SNAPSHOT_ONLY` is only read by that one-time import; leave it as shipped for this release.
- The page only reads from Google (`contacts.readonly`) and stores everything in your own Worker. It loads nothing from other sites. The bot's token gets 404 for every `/contacts` path on `<API_HOST>`, so the bot can never turn anyone on.

| You see | Fix |
|---|---|
| `recipient_not_on_allowlist` or `no_match` for someone in your contacts | They're probably off. Open `/contacts`, search the name, check the last 4 and turn them on. `POST /send` with `resolve`, or `POST /contacts/preview`, confirms the match. |
| "this looks like a documentation example" | That number is a 555-01xx (or 555 + 1234) example, not a real person. Fix the contact in Google, then **Sync now**. |
| "LOG_HASH_KEY is missing or short" on the page | Run setup steps `keys` then `secrets` (section 6). |
| `bad_csrf` | The page was open more than 15 minutes. Reload it. |
| A banner about migrated people | Expected after the upgrade. Review them, or press **Turn all migrated off**. |

## 10. Test text to yourself
Your own number is on the list through `ALLOWLIST` (your own contact card usually isn't in the sync).

**Your bot can run this test for you** once it holds the token (section 11): it does the lookup, reads the test text back to you, sends it after your yes, and reads you the answer. Then skip the curl commands below and use the same **Check**. To run it yourself instead:
```sh
read -rs "RT?Bot token (hidden): "; echo
API=https://<API_HOST>
curl -sS -X POST "$API/send" -H @<(printf 'Authorization: Bearer %s\n' "$RT") -H 'content-type: application/json' \
  -d '{"to_name":"Your Name","resolve":true}'
```
- Expect `"state":"one"` with a `candidate_id`. Nothing is sent by this call.
- One person is `to_name`. `to_names` is an array of 2 or 3. `to_names` with one entry is 400 `multi_send_needs_2_to_3`, including when `resolve` is true, and nothing is sent.
- Allow-list entries match the saved JSON label (and the first word of that label). A longer name than the label is `no_match`. The label is the name on the Contacts page row badged `always on (ALLOWLIST)`, and the part before ` (unlabeled)` in a resolve candidate. `secret list` does not show it.
- The read-back is the bot, in chat or by voice. The relay plays no audio and returns no read-back text. `resolve` and `/send` answers are JSON only.
- If you get `ambiguous`, pick from the `candidates` by label. If you get `no_match`, use the exact saved label, not a longer name.

Then send it, using the formatting rule (below):
```sh
CID=<candidate_id>
curl -sS -X POST "$API/send" -H @<(printf 'Authorization: Bearer %s\n' "$RT") -H 'content-type: application/json' \
  -d "{\"candidate_id\":\"$CID\",\"body\":\"Hi,\n\nThis is a relay test. Would you reply OK when you see it?\n\nhttps://example.com\"}"
unset RT CID
```

**Check:**
- The answer has `"state":"sent"`, and the text arrives on your phone with blank lines between the parts.
- `"sent"` means SMS Gateway's cloud accepted the encrypted text for your phone and gave it an id. It is not a delivery receipt: the phone sends it when it picks it up (right away if it's Online), and the app shows the real status.
- `https://<APPROVE_HOST>/log` shows `direct_sent` with hashes only, never a number or the text.
- A number on no list gets 403 `recipient_not_on_allowlist`.
- If you get HTTP 502 `send_failed`: `test-send` and `smoke` print a `fix=` hint for the gateway side. Also look in `/log`. Check the phone is Online.
  | In `/log` or `fix=` | Fix |
  |---|---|
  | `device_key_present_but_no_pin` | The phone has a device key, the Worker has no pin and no `GATEWAY_MODE`. Run `config --gateway-mode passphrase`, `keys`, `secrets` (the default, step 7), or for device-key mode `gateway-check` then `confirm-fingerprint`. |
  | `gateway_mode_passphrase_but_no_passphrase` / `gateway_mode_device_key_but_no_device_key` | The Worker's `GATEWAY_MODE` and its secrets disagree. Run `gateway-check`, then `keys` and `secrets`. |
  | `device_key_pin_mismatch` | The phone's key changed (rotation). Run `gateway-check` then `confirm-fingerprint`. |
  | `no_device_key_and_no_passphrase` | The reverse: the phone has no device key and the Worker has no passphrase. Update the app to v1.77+ and run `gateway-check`, or set the passphrase (section 1 step 7). |
  | `device_id_not_listed` | Run `gateway-check` (the phone id changed). |
  | The app shows **"can't send message, key store operation failed"** after the relay said `sent` | The phone couldn't decrypt the text. Update SMS Gateway (section 1 step 1), force-stop it (Settings, Apps, SMS Gateway, Force stop), open it and retry. If it still fails, rotate the device key (app: **Settings**, **Device…**, **Device Key**, **Rotate device key**), then run `gateway-check` and `confirm-fingerprint`. Still failing on v1.77.0–v1.77.4: switch to passphrase mode (`config --gateway-mode passphrase`, `keys`, `secrets`, and set that passphrase in the app, step 7); see Known limits. |
- Error 1102 or "exceeded CPU" means upgrade to Workers Paid.

**Formatting rule (standard):** put a line break (a blank line) between the greeting, the ask and any link. No wall of text, and soft asks ("Would you be able to..."), not commands. In JSON, a line break is `\n`.

## 11. Connect your bot
1. **HUMAN STEP:** Give the bot the token from section 6 **only through its secret prompt**. Never paste it into chat.
   - On Grok Bot, store it as the secret named **`SMS_RELAY_TOKEN`**. Be aware that other bots of yours running on the same Grok Bot computer can read that secret too, so anyone who controls one of those bots can text your list. Keep only bots you trust there, and rotate the token (section 14) if that changes.
   - Tell the bot the `<API_HOST>` address.
   - Close the terminal that showed the token.
2. The bot's rules:
   - Look every name up first (`resolve: true`), then send by `candidate_id` (or `candidate_ids`).
   - Read every text back word for word with the resolved names. Wait for your yes on that exact text. On voice, one text at a time.
   - Any edit to the words or the people needs a fresh yes.
   - Up to 3 people per text, sent as **separate copies**, and the read-back says "separate copies". A group thread (`"group": true`) only if you turned on `GROUP_MMS` and asked for a group. Not on the iPhone paths: there a group request is refused (`group_mms_unsupported_delivery`).
   - Follow the formatting rule in section 10.
   - Stop and tell you on anything other than `sent`. On a partial multi-send, say who got it and who didn't; never retry by itself.
3. Have the bot run the section 10 test now.

**Check:** the bot's section 10 test passes: it reads the test back, waits for your yes, sends it, and the text arrives.

## 12. Optional switches
Each one is a `[vars]` line in `.relay-local/wrangler.toml`, followed by `npx wrangler deploy -c .relay-local/wrangler.toml`.

| Want | Set | Effect |
|---|---|---|
| **Tap-to-approve** | `DIRECT_SEND = "0"` | The bot can no longer send directly. It files a request (`POST /request`) by contact name or by number, you get a text, and you approve on your phone after the PIN and passkey. By name, anyone on your list can be chosen (needs `LOG_HASH_KEY`); by number, only `ALLOWLIST` numbers. Limits below. |
| **Group MMS** | `GROUP_MMS = "1"` | Lets the bot send one group text (a shared thread) to 2–3 people instead of separate copies. Needs `OWNER_NUMBER` set (section 6) and app v1.74.0+, with mobile data on. Live-test first: one group to two numbers you control, then check each phone shows one thread and a reply reaches everyone (README "Group MMS"). Android (SMS Gateway) only: with `DELIVERY = "mac"` or `"shortcut"` (SETUP-iphone.md) every group send is refused with 409 `group_mms_unsupported_delivery`, and nothing is sent. |
| **Daily cap** | `DIRECT_DAILY_CAP = "25"` (any whole number) | Sends past the cap that day (in `TIMEZONE`) are refused with `direct_daily_cap_reached`. |
| **Link block** | `BLOCK_LINKS = "1"` | Texts containing a link (URL, domain, IP address, including disguised ones) are refused with `links_not_allowed`, on both flows. |
| Per-minute cap | `DIRECT_PER_MINUTE_MAX = "5"` | Limits bursts. |
| Quiet hours | `DIRECT_HOURS = "08:00-21:00"` | Refuses outside the window (`direct_outside_hours`). |
| Runaway pause | `RUNAWAY_PAUSE = "1"`, `RUNAWAY_MAX = "10"` | More than MAX sends in 60 minutes pauses sending and texts you. You resume on `/direct`. |
| Copy of each send | `DIRECT_NOTIFY_EACH = "1"` | Texts you the name and the first 80 characters of each send. |
| Tap limits | `PENDING_CAP_PER_DAY` (20), `SEND_CAP_INITIAL` (5), `SEND_CAP_AFTER` (10), `CAP_RAISE_AFTER_DAYS` (14), `REQUEST_TTL_SECONDS` (900), `MIN_SECONDS_BETWEEN_SENDS` (30), `MAX_TEXT_CHARS` (640, both flows) | Defaults in brackets. The tap send cap is `SEND_CAP_INITIAL` a day for `CAP_RAISE_AFTER_DAYS` days from `CAP_START_DATE`, then `SEND_CAP_AFTER`. |

**Two more settings, normally left as shipped:**
- `GATEWAY_BASE_URL` (default `https://api.sms-gate.app/3rdparty/v1`, set in wrangler.toml): the SMS Gateway cloud API the Worker sends through. Change it only if you run your own SMS Gateway server. Its host must answer `/devices` and `/messages` the way the public one does.
- `GATEWAY_PBKDF2_ITERATIONS` (passphrase mode only; default `100000`, allowed `75000`–`100000`): the key-stretching rounds for each encrypted text. 100000 is the most a Cloudflare Worker allows. The phone reads the value from each message, so the app needs no change. A value outside the range refuses every send.

A typo in one of these (a word, `0` where it isn't allowed, a decimal, an out-of-range number) makes the relay refuse sends with `config_invalid` or `direct_config_invalid` until you fix it. That's on purpose. Contact names and labels that reach your notices are always link-checked, whatever `BLOCK_LINKS` says.

## 13. Kill switch and rollback
Any one of these stops texting:
- **Fastest, no deploy:** Cloudflare dashboard, Workers & Pages, your Worker, Settings, Variables: set `DISABLED` to `1`. Then put `DISABLED = "1"` in wrangler.toml too, or the next deploy turns it back on.
- `DISABLED = "1"` (everything) or `DIRECT_SEND = "0"` (direct sends only) in `.relay-local/wrangler.toml`, then `npx wrangler deploy -c .relay-local/wrangler.toml`.
- `npx wrangler -c .relay-local/wrangler.toml secret put REQUEST_TOKEN` with a new value. The bot's token stops working at once.
- **On the phone:** tap **Online** so it goes **Offline**, or turn off Cloud Server.

**Rollback** after a bad deploy:
```sh
npx wrangler deployments list -c .relay-local/wrangler.toml         # find the last good version id
npx wrangler rollback -c .relay-local/wrangler.toml <version-id>
```
Docs: https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/

Rollback doesn't undo secrets or stored data.

**Check:** after a kill, a test send gets an error (`relay_disabled`, `direct_send_off` or `bad_request_token`) and nothing arrives.

## 14. Rotating secrets
| What | How |
|---|---|
| Bot token | `openssl rand -hex 32`, then `npx wrangler -c .relay-local/wrangler.toml secret put REQUEST_TOKEN`, then give the new one to the bot's secret prompt |
| Gateway password | Regenerate it in the app's Cloud Server settings, then `npx wrangler -c .relay-local/wrangler.toml secret put GATEWAY_PASS` |
| Passphrase (no device key only) | New `openssl rand -base64 32`. Set it in the app **and** with `npx wrangler -c .relay-local/wrangler.toml secret put GATEWAY_PASSPHRASE` right after. Texts fail until both match |
| Log key | `openssl rand -base64 32 \| tr -d '\n' \| npx wrangler -c .relay-local/wrangler.toml secret put LOG_HASH_KEY` (stored contacts are re-hashed on the next send) |
| Device key | In the app, Settings, Device…, Device Key, **Rotate device key**. Then run `gateway-check` then `confirm-fingerprint` (section 1 step 9); they update the Worker. Sends refuse until you confirm |
| Google access | **Disconnect** the account on the Contacts page (revokes at Google and deletes it), then **Connect Google** again. Legacy secret accounts: remove the app at https://myaccount.google.com/connections, then press Reconnect |
| Google client secret | In the console's Clients page, add a new secret, download the client JSON, run `node scripts/google-client.mjs --file=<that-file.json>`, then delete the old secret in the console |
| `GOOGLE_TOKEN_KEY` | `npx wrangler -c .relay-local/wrangler.toml secret put GOOGLE_TOKEN_KEY_OLD` with the **current** value, then `openssl rand -base64 32 \| tr -d '\n' \| npx wrangler -c .relay-local/wrangler.toml secret put GOOGLE_TOKEN_KEY`. The old key still decrypts, and each stored sign-in is re-sealed under the new key at the next sync, and the client at the next sync or Contacts page visit. Delete the old one **only after every stored sign-in has been re-sealed**: press **Sync now** on the Contacts page, reload it, and check that the Google accounts panel reads "All N stored Google sign-ins are on the current GOOGLE_TOKEN_KEY" (while any are left it says "X of N … are still on the old GOOGLE_TOKEN_KEY"). Then `npx wrangler -c .relay-local/wrangler.toml secret delete GOOGLE_TOKEN_KEY_OLD`. An account whose sync failed isn't re-sealed, so fix it first or Reconnect it. Without `_OLD`, stored sign-ins fail with `google_token_key_missing` until you Reconnect. If the stored client can't be read either, run `node scripts/google-client.mjs` again |

Do it right away if a phone, computer or bot that held one is lost or compromised.

## 15. Teardown (remove everything)
1. `npx wrangler delete -c .relay-local/wrangler.toml` (removes the Worker and its stored contacts and log). Confirm in the dashboard that it's gone.
2. Zero Trust: delete the Access application and its policy.
3. DNS: remove any records left for `<API_HOST>` and `<APPROVE_HOST>`.
4. Google: remove the app at https://myaccount.google.com/connections for each account, then delete the Cloud project (https://console.cloud.google.com/, IAM & Admin, Settings, Shut down).
5. Phone: go Offline, turn off Cloud Server, then uninstall SMS Gateway.
6. Bot: delete the stored token (`SMS_RELAY_TOKEN` on Grok Bot).
7. Optional: cancel the domain and close the Cloudflare account and the dedicated email.

**Check:** `curl -si https://<API_HOST>/send` no longer reaches the relay, and https://myaccount.google.com/connections no longer lists the app.

## Known limits
- **iPhone is BETA.** See [SETUP-iphone.md](SETUP-iphone.md). Android is the tested path.
- **Group texts are Android only at launch,** and only after your own group test passes.
- **`sent` is not delivered.** It means SMS Gateway's cloud accepted the text for your phone (section 10).
- **Device-key mode (opt-in):** with `GATEWAY_MODE = device_key`, or with no `GATEWAY_MODE` when the `devices` call shows a `publicKey`, the relay refuses to send until `GATEWAY_PINNED_FINGERPRINT` and `GATEWAY_KEY_VERSION` match it (section 1 step 9). A rotated key stops sending until you re-pin. That's deliberate. `gateway-check` stores the full fingerprint; `confirm-fingerprint` shows the first two and last two groups (64 bits) for the by-eye check. In this mode you don't set a passphrase, and setup never makes one.
- **SMS Gateway v1.77.0–v1.77.4 device-key decrypt:** the format's docs say RSA-OAEP with SHA-256 and **MGF1-SHA-1** (the only MGF1 hash an Android Keystore key allows before Android 15), and the relay sends exactly that (`test-node/e2e-oaep-params.node.test.ts` proves it with an independent decryptor). The app's own decrypt code in those releases asks the Keystore for MGF1-SHA-256 instead (`RSAEncryptionProvider.kt`). If your phone shows "key store operation failed" for every device-key text, that's the likely cause; it's on the app side. That's why setup defaults to passphrase mode (`GATEWAY_MODE = passphrase`): the app chooses the decryptor by the text's prefix, so passphrase texts still decrypt on a phone with a device key (`EncryptionService.kt`, v1.77.4). Opt in to device key with `config --gateway-mode device-key` once a fixed app release is out.
- **The phone is the sender.** If it's off, offline, or Android kills the app, texts wait in the cloud queue. The app checks in at least every 15 minutes.
- **Who can send:** anyone with the bot token can text anyone on your list with no tap. Guard the token like a password, and use section 13 if it leaks.
- **Sign-in:** with `ALLOW_EMAIL_OTP = "1"` the passkey requirement rests on your Access policy alone (section 3).
