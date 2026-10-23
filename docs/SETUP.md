# Set up texting from your phone

Numbered steps for a new copy of this template. Anchors `step-1` … `step-8` stay put; a later edit can change the heading text without moving them. Each `wrangler` command is run from the repository root.

```
bot --(token)--> your Cloudflare Worker --(encrypted)--> SMS Gateway cloud --> your Android phone --> recipient
you --(email PIN + passkey)--> your private status page (contacts, log)
```

By default you say "text Example Owner: …". The bot reads that draft back to you, you say yes, and it sends. There is no tap. The bot can text only people you have switched on, plus numbers you list yourself.

Do every step on your own computer. No password, token, or key goes into a chat, an email, a note, or a file in this repo. Each one is typed only into a hidden prompt on your computer, or into your bot's secret prompt. Stop at any failed check.

Placeholders in this guide are not your values: `example.com` hosts, the fictional UK number `+447700900123`, and names such as `Example Owner`. [DEPLOY.md](../DEPLOY.md) is the same install in section form. Pages in the Worker cite those section numbers (section 5, section 9, section 13, section 14).

<a id="step-1"></a>

## Step 1. Prerequisites and accounts

<a id="step-1-tools"></a>

### Step 1.1 Tools

- Node.js 22 or newer. Wrangler 4.151.1 (the version in `package-lock.json`) declares `engines.node` of `>=22`. CI installs Node 22 (`.github/workflows/ci.yml`). Check with `node -v`.
- npm that ships with that Node. This repo installs with `npm ci --legacy-peer-deps`.
- `git` and `openssl` (`git --version`, `openssl version`).
- Wrangler is a dev dependency. Use `npx wrangler` from this directory after `npm ci`. Do not rely on a global install.

<a id="step-1-cloudflare"></a>

### Step 1.2 Cloudflare account, Workers, and wrangler login

1. Create an email address used only for this. No bot should be able to read it.
2. Sign up at https://dash.cloudflare.com/sign-up with that email. Turn on two-factor sign-in with a passkey or security key: https://developers.cloudflare.com/fundamentals/user-profiles/2fa/
3. The relay is a Cloudflare Worker (a Worker plus one Durable Object, declared in `wrangler.toml`). The free plan can deploy it. A passphrase-mode send costs about 58 ms of CPU inside the Durable Object; error 1102 or "exceeded CPU" means move to Workers Paid (README "CPU").
4. From this repository, after Step 1.7:

```sh
npx wrangler login
npx wrangler whoami
```

`login` opens a browser. Finish it yourself, on the new account. `whoami` must show that account. If it lists more than one, sign in to only the account that will own the Worker.

<a id="step-1-domain"></a>

### Step 1.3 Domain and the two hostnames

Add a domain you own to this account (https://developers.cloudflare.com/fundamentals/manage-domains/add-site/), or register one in Cloudflare Registrar. The dashboard should show the domain as Active.

Pick two different hostnames on that domain. This guide calls them:

- `<API_HOST>` — the bot's address, for example `api.example.com`. Not behind Access.
- `<APPROVE_HOST>` — your private page, for example `app.example.com`. The whole host is behind Access.

Do not create the DNS records yourself. The live deploy creates them. Keep the names bland.

<a id="step-1-access"></a>

### Step 1.4 Cloudflare Access on the private page

In Zero Trust (https://one.dash.cloudflare.com/):

1. Pick a team name and the Free plan. Your team URL is `https://<team>.cloudflareaccess.com`.
2. Settings, Authentication, Login methods: keep only One-time PIN. https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/
3. Access settings, Multi-factor authentication: turn on independent MFA. Allow Security key only, with the shortest session. Leave "identity provider MFA / AMR matching" off. https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/independent-mfa/
4. Access, Applications, Add, Self-hosted. Name it something bland (`relay-page`). Destination: the whole `<APPROVE_HOST>`, no path. Session duration: 15 minutes. Login methods: One-time PIN only. Policy: Allow, Include Emails = the email from Step 1.2, MFA custom Security key only. Copy the application's AUD tag.
5. Do not put `<API_HOST>` behind Access, and do not add a WAF or bot rule on it. The bearer token protects it.

With `ALLOW_EMAIL_OTP = "1"` (the shipped default) the Worker checks that the login is your Access app and your email. It cannot check that a passkey was used, because Cloudflare's token does not say which second factor you used. The passkey requirement is this Access policy. DEPLOY.md section 3 is the same list.

<a id="step-1-phone"></a>

### Step 1.5 Phone and gateway requirements

This path sends through an Android phone and its SIM. No texting company is in the middle. The app is SMS Gateway for Android (https://github.com/capcom6/android-sms-gateway), cloud mode.

- The phone stays on, online, and charged, with a SIM that can send SMS.
- Install the newest release that is not marked Pre-release, from that GitHub page's Assets (`.apk`). Confirm the page is `capcom6/android-sms-gateway`. The app shows its version under Settings, Information.
- Group MMS (optional, off by default) needs app v1.74.0 or later.
- v1.77.0 through v1.77.4 cannot decrypt device-key texts. This guide uses passphrase mode, which those versions still decrypt. Device-key mode is opt-in later (DEPLOY.md section 1 step 7 and Known limits).
- Docs: https://docs.sms-gate.app/getting-started/ and the cloud-server page https://docs.sms-gate.app/getting-started/public-cloud-server/

Pairing (permissions, cloud server, passphrase, device id) is Step 7. You need the app installed before Step 7, not before the dry run.

iPhone is a different last hop (`DELIVERY = "mac"` or `"shortcut"`). It is not this walkthrough. See [SETUP-iphone.md](../SETUP-iphone.md).

<a id="step-1-grok"></a>

### Step 1.6 Grok Bot

The bot holds the relay token and speaks to you. The relay does not.

- You will store the token in Grok Bot's secret prompt under the name `SMS_RELAY_TOKEN` (Step 7.9). Never paste it into the chat.
- You will tell the bot the `https://<API_HOST>` address. That address is not a secret.
- Other bots of yours on the same Grok Bot computer can read that secret. Anyone who controls one of those bots can text your list. Keep only bots you trust there.
- The bot's job in the test is: look the name up, read the draft back to you in chat or by voice, wait for your yes, then send. Step 7.6 says what the relay does and does not do during that read-back.

<a id="step-1-code"></a>

### Step 1.7 Get the code

```sh
git clone <TEMPLATE_REPO_URL> texting-relay && cd texting-relay
npm ci --legacy-peer-deps
npm test && npm run typecheck
```

Every test passes and the typecheck is clean before you deploy. Later upgrades, from this same directory: `git pull`, then `npm install --legacy-peer-deps`, then `npm test && npm run typecheck` again. Before deploying, confirm `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are already set (DEPLOY.md section 9, "Before you deploy this version"). `git pull` updates the committed `wrangler.toml` only. It does not create or patch `.relay-local/wrangler.toml` (Step 2).

Optional helpers `scripts/setup-mac.sh` and `scripts/setup-windows.ps1` run the computer steps one at a time (DEPLOY.md). This guide is the commands themselves. It does not write secrets to disk.

<a id="step-2"></a>

## Step 2. Build the local wrangler config

The committed `wrangler.toml` is a template (`name = "sms-relay"`, `main = "src/index.ts"`, placeholder hosts). Leave it that way so `git pull` can update it.

Your deploy config is `.relay-local/wrangler.toml`. That directory is gitignored (`.gitignore`). `git pull` never adds the `[[rules]]` blocks to it, and never fixes `main`. A config in that subfolder must set `main = "../src/index.ts"` so the entry resolves to this repo's `src/index.ts`. The root template's `main = "src/index.ts"` is wrong in the subfolder: Wrangler would look for `.relay-local/src/index.ts`.

Both rules are required, with `fallthrough = false`:

- `type = "Text"`, `globs = ["**/*.css", "**/*.svg"]` — `src/harbor.ts` imports `harbor.css` and the header logo as text. One Text rule only: a second Text rule is ignored once `fallthrough` is false. Without this rule the build reports `Could not resolve "/harbor/..."`.
- `type = "Data"`, `globs = ["**/*.woff2", "**/*.webp"]` — the font and the leaf photos are imported as bytes. Without this rule the build reports `No loader is configured` for `.woff2` and `.webp`.

Missing either rule fails the build with 20 errors (Step 8.2). `npm run check` reads the root `wrangler.toml` and, if the file exists, `.relay-local/wrangler.toml`. It fails if a rule is missing or wrong, or if `main` does not resolve to `src/index.ts`.

Create the file by pasting this block. It is a full placeholder config: dry-run builds it, and it is not ready to go live until you replace the hostnames, the team domain, the country code, and the start date.

<a id="step-2-example"></a>

```sh
mkdir -p .relay-local
cat > .relay-local/wrangler.toml << 'EOF'
# docs/SETUP.md step-2-example
# Local deploy config. Gitignored. git pull does not update this file.
# Subfolder: main is one level up from .relay-local/, at src/index.ts.
name = "sms-relay"
main = "../src/index.ts"
compatibility_date = "2026-10-01"
workers_dev = false

routes = [
  { pattern = "api.example.com", custom_domain = true },
  { pattern = "app.example.com", custom_domain = true },
]

# Harbor assets. Both blocks are required. fallthrough = false on each.
# One Text rule: CSS and the header logo. A second Text rule would be ignored.
[[rules]]
type = "Text"
globs = ["**/*.css", "**/*.svg"]
fallthrough = false

[[rules]]
type = "Data"
globs = ["**/*.woff2", "**/*.webp"]
fallthrough = false

[[durable_objects.bindings]]
name = "RELAY"
class_name = "Relay"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["Relay"]

[vars]
GATEWAY_BASE_URL = "https://api.sms-gate.app/3rdparty/v1"
TIMEZONE = "Europe/London"
DEFAULT_COUNTRY_CODE = "+44"
REQUEST_HOST = "api.example.com"
APPROVE_HOST = "app.example.com"
ACCESS_TEAM_DOMAIN = "https://team.cloudflareaccess.com"
NOTIFY_MODE = "sms"
REQUIRED_AMR = "otp"
ALLOW_EMAIL_OTP = "1"
DISABLED = "0"
DIRECT_SEND = "1"
CONTACTS_SNAPSHOT_ONLY = "0"
RUNAWAY_PAUSE = "0"
RUNAWAY_MAX = "10"
GROUP_MMS = "0"
GOOGLE_ACCOUNTS = ""
CAP_START_DATE = "2026-10-01"
EOF
npm run check
```

`npm run check` prints `check-wrangler: OK (wrangler.toml, .relay-local/wrangler.toml)`.

Before the live deploy in Step 4, edit the local file (not the committed template):

- `routes` patterns, `REQUEST_HOST`, and `APPROVE_HOST` become your two real hostnames. They must match each other, and the two hosts must differ.
- `ACCESS_TEAM_DOMAIN` becomes `https://<team>.cloudflareaccess.com` from Step 1.4.
- `TIMEZONE` is your IANA zone, for example `"Europe/London"`. There is no default. Missing or not a real zone: every route answers 503 `timezone_not_configured` or `timezone_invalid`. List: https://en.wikipedia.org/wiki/List_of_tz_database_time_zones
- `DEFAULT_COUNTRY_CODE` is your calling code (`"+44"`, `"+1"`, …) or `"none"`. It is only applied to contact numbers saved without a `+`. With `"+44"`, `0555 555 0100` becomes `+445555550100`. `"none"` keeps only numbers already written as `+E.164`. Missing or invalid: contact sync refuses (`default_country_code_invalid`) and keeps the previous list. Nothing is assumed to be `+1`.
- `CAP_START_DATE` is today, `YYYY-MM-DD`. It only affects the tap-to-approve cap.
- Leave `compatibility_date` equal to the template's unless you mean to change Worker runtime behavior. After a `git pull`, compare this file's `[[rules]]`, `compatibility_date`, and Durable Object blocks with the template. `npm run check` does not compare the date.
- `workers_dev = false` stays, so the Worker is not also served on a `workers.dev` hostname.
- `GOOGLE_ACCOUNTS` stays `""`. Google accounts are connected on the Contacts page (Step 7.10).

`npm run check` still passes with `example.com` in the file. Those placeholders are a live-deploy problem, not a rules problem. After you put your hosts in:

```sh
grep -nE '^[^#]*(REPLACE|example\.com)' .relay-local/wrangler.toml
```

That prints nothing.

### Vars the Worker reads

Set in `[vars]` of the local file. Secrets are Step 3, not this file. Switches are exact: `"1"` is on, and a typo fails closed (503 `config_invalid` or `direct_config_invalid`). Defaults below are the ones in code when the var is unset. The example above sets the ones the template sets.

| Var | What it is for |
|---|---|
| `GATEWAY_BASE_URL` | SMS Gateway cloud API. Shipped value `https://api.sms-gate.app/3rdparty/v1`. Change it only for your own server. |
| `TIMEZONE` | IANA zone for day boundaries and notice times. Required. No default. |
| `DEFAULT_COUNTRY_CODE` | Prefix for contact numbers that have no `+`, or `"none"`. Required for contact sync. No default. |
| `REQUEST_HOST` | Hostname for `POST /send`, `POST /request`, `GET /request/<id>`. Not behind Access. |
| `APPROVE_HOST` | Hostname for `/direct`, `/log`, `/approve/*`, `/contacts*`. Whole host behind Access. Must differ from `REQUEST_HOST`. |
| `ACCESS_TEAM_DOMAIN` | `https://<team>.cloudflareaccess.com`. |
| `NOTIFY_MODE` | `"sms"` (notices to `OWNER_NUMBER` through your phone) or `"ntfy"`. |
| `REQUIRED_AMR` | `amr` values accepted when a token carries one. Shipped `"otp"`. |
| `ALLOW_EMAIL_OTP` | `"1"` (shipped): the passkey rests on the Access policy. `"0"` requires `REQUIRED_AMR` on the token, which Cloudflare's documented token does not carry. |
| `DISABLED` | `"1"` refuses every route. `"0"` shipped. |
| `DIRECT_SEND` | `"1"` (shipped): the bot sends with no tap. `"0"`: tap-to-approve only. |
| `CONTACTS_SNAPSHOT_ONLY` | Read once, when an old `DIRECT_ALLOWLIST` secret is imported. Leave `"0"` on a fresh deploy. |
| `RUNAWAY_PAUSE` | `"0"` shipped (off). `"1"`: more than `RUNAWAY_MAX` direct sends in 60 minutes pauses direct send. Unset counts as on. |
| `RUNAWAY_MAX` | Default `"10"`. |
| `GROUP_MMS` | `"0"` shipped. `"1"` allows one group MMS. Android only. Needs `OWNER_NUMBER`. |
| `GOOGLE_ACCOUNTS` | Legacy label list. Leave `""`. |
| `CAP_START_DATE` | `YYYY-MM-DD`. Invalid keeps the tap cap at `SEND_CAP_INITIAL`. |
| `PENDING_CAP_PER_DAY` | Tap flow. Default 20. Range 1–100000. |
| `SEND_CAP_INITIAL` | Tap sends per day for the first stretch. Default 5. |
| `SEND_CAP_AFTER` | Tap sends per day after that stretch. Default 10. |
| `CAP_RAISE_AFTER_DAYS` | Days from `CAP_START_DATE` before the tap cap rises. Default 14. |
| `REQUEST_TTL_SECONDS` | How long a tap request can be approved. Default 900. |
| `MIN_SECONDS_BETWEEN_SENDS` | Tap flow gap. Default 30. |
| `MAX_TEXT_CHARS` | Both flows. Default 640. |
| `BLOCK_LINKS` | Unset: links allowed. `"1"` refuses links in message text. |
| `DIRECT_DAILY_CAP` | Unset: no daily cap on Android. A number caps direct sends per `TIMEZONE` day. |
| `DIRECT_PER_MINUTE_MAX` | Optional burst cap. |
| `DIRECT_HOURS` | Optional `HH:MM-HH:MM` window in `TIMEZONE`. |
| `DIRECT_LOOKUP_MAX_PER_HOUR` | Lookups and refusals on `/send` per hour. Default 30. `"off"` removes it. Sends never count. |
| `DIRECT_NOTIFY_EACH` | `"1"`: text yourself the name and first 80 characters of each direct send. |
| `GATEWAY_PBKDF2_ITERATIONS` | Passphrase mode. Default 100000. Allowed 75000–100000. |
| `DELIVERY` | Unset or `"android"`: this guide. `"mac"` or `"shortcut"`: SETUP-iphone.md. Anything else: 503 `delivery_invalid`. |
| `UNCLAIMED_EXPIRY_MINUTES` | mac/shortcut only. Default 30. |
| `SHORTCUT_PING` | shortcut only. `"email"` (default) or `"tap"`. |
| `PING_FROM` | shortcut + email. Sender on your Email Routing domain. |
| `PING_TO` | shortcut + email. The address your iPhone's mail receives. |
| `SHORTCUT_NAME` | shortcut + tap. Default `Relay Send`. |

`RELAY` is the Durable Object binding in the example, not a `[vars]` line.

<a id="step-3"></a>

## Step 3. Secrets

Set a secret only with Wrangler's hidden prompt:

```sh
npx wrangler -c .relay-local/wrangler.toml secret put NAME
```

Type or paste the value when Wrangler asks. Do not put it on the command line, in a file, in `wrangler.toml`, or in chat. `npx wrangler secret list` shows names and never values. The same `-c` flag is required on `secret list`, `secret delete`, `deploy`, `deployments list`, and `rollback`, so the command uses this file's `name` and not the committed template.

The first `secret put` can ask: `There doesn't seem to be a Worker called "sms-relay". Do you want to create a new Worker with that name and add secrets to it?` The quoted name is the `name` in your local file. Answer yes. Wrangler creates an empty placeholder Worker. Step 4's deploy replaces it. Later `secret put` commands do not ask again. (Seen in Wrangler 4.151.1, the version this repo installs.)

Generate a value you must hand to the bot in your own terminal (`openssl rand -hex 32`), paste it into the hidden prompt, then close that terminal. Generate a value you never need to see (`LOG_HASH_KEY`, `GOOGLE_TOKEN_KEY`) the same way: `openssl rand -base64 32`, paste at the prompt, close the terminal. Do not pipe the value into `wrangler`. The one exception is Step 7.10: `node scripts/google-client.mjs --file=<client.json> --config=.relay-local/wrangler.toml` pipes the client id and secret on stdin and discards wrangler's output, so the secret is not printed. `--config=<path>` is required (there is no default Worker) and is passed to both secret puts. It deletes the JSON only after both secret puts succeed. If a put fails, the JSON stays, the script names the secret and how to retry, and it exits non-zero.

Set these now. Gateway secrets wait until Step 7.2, because the values come from the phone.

| Secret | What it is for |
|---|---|
| `REQUEST_TOKEN` | Bearer token the bot sends. `openssl rand -hex 32`. This becomes `SMS_RELAY_TOKEN` in Step 7.9. |
| `ACCESS_AUD` | AUD tag from Step 1.4. |
| `APPROVER_EMAIL` | The email from Step 1.2. The only identity allowed onto the private pages. |
| `OWNER_NUMBER` | Your own number, `+` and country code, no spaces. Notice target when `NOTIFY_MODE` is `sms`. Also required when `GROUP_MMS = "1"`. Example shape: `+447700900123`. |
| `ALLOWLIST` | JSON object `{"+447700900123":"Example Owner"}`. The value is the label Step 7.4 resolves. One entry for your own number is enough for the test text. |
| `LOG_HASH_KEY` | 32+ characters. HMAC key for number and body hashes. Direct send refuses without it (`direct_config_invalid`). |
| `GOOGLE_TOKEN_KEY` | 32 random bytes. Seals the Google client and sign-ins the Worker stores (AES-GCM). Step 7.10 needs it. |
| `GATEWAY_MODE` | Type `passphrase` at the prompt (this guide). `device_key` is the opt-in in DEPLOY.md. |

Check, after those prompts:

```sh
npx wrangler -c .relay-local/wrangler.toml secret list
```

You should see `REQUEST_TOKEN`, `ACCESS_AUD`, `APPROVER_EMAIL`, `OWNER_NUMBER`, `ALLOWLIST`, `LOG_HASH_KEY`, `GOOGLE_TOKEN_KEY`, `GATEWAY_MODE`. Not yet: `GATEWAY_USER`, `GATEWAY_PASS`, `GATEWAY_DEVICE_ID`, `GATEWAY_PASSPHRASE`.

### Every other secret the code reads

Set only the ones that match your setup. Same hidden prompt. Same `-c` flag.

| Secret | What it is for |
|---|---|
| `GATEWAY_USER` | SMS Gateway cloud username (Step 7.1). |
| `GATEWAY_PASS` | SMS Gateway cloud password (Step 7.1). |
| `GATEWAY_DEVICE_ID` | Your phone's `id` from the devices list (Step 7.1). |
| `GATEWAY_PASSPHRASE` | Passphrase mode. 32+ characters. The same string you type into the app. |
| `GATEWAY_PINNED_FINGERPRINT` | Device-key mode only. Stored by `confirm-fingerprint`, not typed. |
| `GATEWAY_KEY_VERSION` | Device-key mode only. Stored with the fingerprint. |
| `GOOGLE_TOKEN_KEY_OLD` | Only while rotating `GOOGLE_TOKEN_KEY`. DEPLOY.md section 14. |
| `GOOGLE_CLIENT_ID` | Set by `node scripts/google-client.mjs` in Step 7.10. Not pasted on the page. |
| `GOOGLE_CLIENT_SECRET` | Set by the same script, with `GOOGLE_CLIENT_ID`. |
| `GOOGLE_RT_<LABEL>` | Legacy refresh token, one secret per label in `GOOGLE_ACCOUNTS`. |
| `DEVICE_TOKEN` | mac/shortcut only. 32+ characters, different from `REQUEST_TOKEN`. |
| `NTFY_URL` | Notice target when `NOTIFY_MODE` is `ntfy`. |
| `NTFY_TOKEN` | ntfy access token. Required in ntfy mode. |
| `DIRECT_ALLOWLIST` | Deprecated. Imported once as flagged legacy contacts, then ignored. Do not set it on a fresh deploy. |

<a id="step-4"></a>

## Step 4. Dry run, then live deploy

Dry run builds the Worker and prints the bindings. It does not upload, and it does not need `wrangler login`. Placeholders in the Step 2 file are enough.

```sh
npx wrangler deploy --dry-run -c .relay-local/wrangler.toml
```

Expect `Total Upload`, a binding list that includes `env.RELAY (Relay)` and your `[vars]` (so you can see `REQUEST_HOST` and `APPROVE_HOST`), and a last line `--dry-run: exiting now`. Wrangler 4.151.1 does not print the worker name in that output. The name and the routes are the `name` and `routes` lines in the file you passed with `-c`. A non-zero exit is a failed build. Step 8.2 is the 20-error case.

Live deploy uploads and creates the DNS records for `routes`. Do this only after Step 1.2's login, Step 1.3's domain, and the host edits in Step 2. You run it and you read the output.

```sh
npx wrangler deploy -c .relay-local/wrangler.toml
```

<a id="step-5"></a>

## Step 5. Test worker and live worker

One local file deploys one Worker: the `name` in that file, onto the `routes` in that file. `REQUEST_HOST` and `APPROVE_HOST` must be those same hostnames. `workers_dev = false` means there is no extra `workers.dev` hostname.

| | Test | Live |
|---|---|---|
| `name` | `sms-relay-test` | `sms-relay` (the template name) |
| `routes` and the two host vars | `relay-test-api.example.com` and `relay-test-app.example.com` | your real `<API_HOST>` and `<APPROVE_HOST>`, for example `api.example.com` and `app.example.com` |

`sms-relay-test` is the worker name the setup helper's tests use. `relay-test-*` is a host prefix you can use on a domain you own so a test Worker cannot answer on the live hostnames. Use your own domain, not `example.com`, for a real deploy. A test Worker and the live Worker are two configs (two `name` lines, two route pairs). Passing `-c` chooses which file, and therefore which Worker, the command talks to. Keep the test file gitignored next to the other one, for example `.relay-local/wrangler.test.toml`, and pass that path to `-c`. Do not point a test `name` at the live hostnames.

How to tell which Worker a command will hit:

1. `name = ` and `routes = ` in the file you are about to pass with `-c`.
2. Dry-run output: `env.REQUEST_HOST` and `env.APPROVE_HOST` are the hosts that file will serve. The last line `--dry-run: exiting now` means it did not upload.
3. After login, `npx wrangler deployments list -c .relay-local/wrangler.toml` lists versions for the `name` in that file. `npx wrangler deployments list -c .relay-local/wrangler.test.toml` lists the other name, when that file exists.

<a id="step-6"></a>

## Step 6. Health checks

There is no `GET /health` route. `src/index.ts` forwards every request to the Durable Object, and `src/relay.ts` answers the routes below. Nothing was added. These curls are the checks.

They run only after Step 4's live deploy, from your computer, not signed in. Replace the hosts. Do not add `-L` (that would follow the Access redirect and hide the 302).

Config is checked before the path. `DISABLED = "1"` → 503 `{"error":"relay_disabled"}`. A bad or missing `TIMEZONE` → 503 `timezone_not_configured` or `timezone_invalid`. Equal or empty hosts → 503 `hosts_not_configured`. A bad `DELIVERY` → 503 `delivery_invalid`. Fix the local file and deploy again before reading the table below.

| Request | Expect |
|---|---|
| `curl -si https://<APPROVE_HOST>/log` | Status **302**. Cloudflare Access redirects to your team domain before the Worker runs. The `location` header contains `.cloudflareaccess.com`. |
| `curl -si https://<API_HOST>/log` | Status **404**, body `{"error":"not_found"}`. `/log` exists only on `APPROVE_HOST`. |
| `curl -si -X POST https://<API_HOST>/send -H "Authorization: Bearer wrong" -H 'content-type: application/json' -d '{}'` | Status **401**, body `{"error":"bad_request_token"}`, once `REQUEST_TOKEN` is set. If that secret is missing, **503** `{"error":"not_configured"}`. |

```sh
curl -si https://<APPROVE_HOST>/log | head -n 1
curl -si https://<API_HOST>/log | head -n 1
curl -si -X POST https://<API_HOST>/send -H "Authorization: Bearer wrong" \
  -H 'content-type: application/json' -d '{}' | head -n 1
```

A 403 from `<API_HOST>` means something in Cloudflare is covering it (Step 1.4.5). A 403 `{"error":"forbidden"}` from `<APPROVE_HOST>` means the request reached the Worker with no valid Access token (the Access app is missing or does not cover that host). Any other host, including a `workers.dev` name if you turned `workers_dev` on, gets 404 `{"error":"unknown_host"}`.

`GET /send` is also 404 `not_found`. Send is `POST` only. Routes on `<API_HOST>`: `POST /send`, `POST /request`, `GET /request/<32 hex chars>`. Routes on `<APPROVE_HOST>`: `GET /log`, `GET /direct`, `POST /direct/sync`, `POST /direct/resume`, `GET` and `POST /approve/<id>`, the `/contacts*` pages, and the harbor font and photos. `/contacts*` on `<API_HOST>` is 404.

<a id="step-7"></a>

## Step 7. Phone and gateway pairing, then the test text

<a id="step-7-pair"></a>

### Step 7.1 Pair SMS Gateway

1. Install the app as in Step 1.5. Grant SMS when asked. Allow notifications. If Android says SMS is a restricted setting: Settings, Apps, SMS Gateway, the top-right menu, Allow restricted settings, then grant SMS again. If that menu is missing, with USB debugging: `adb shell pm grant me.capcom.smsgateway android.permission.SEND_SMS`
2. Battery: Settings, Apps, SMS Gateway, Battery, Unrestricted (some phones say "Don't optimize").
3. In the app, turn Cloud Server ON and Local Server OFF. Tap Offline so it changes to Online. Leave webhooks, SMS forwarding, and the email bridge off.
4. The Cloud Server section shows a username and a password. Leave them on the phone. You will type them into hidden prompts in Step 7.2. The same login opens the gateway dashboard, which can read messages. Treat it like a bank password. Do not paste it into chat.
5. Passphrase (this guide's mode). Encryption background: https://docs.sms-gate.app/privacy/encryption/
   - If Settings, Encryption, Passphrase is already filled in, keep that passphrase. You will type the same string at the Step 7.2 prompt.
   - If it is empty, run `openssl rand -base64 32` on your computer. The line is shown once so you can type it into Settings, Encryption, Passphrase. It must be at least 32 characters. Do not paste it into chat. You will paste it into the hidden prompt in Step 7.2, then close the terminal.
6. Device id. On your computer, this hides the password:

```sh
read -r "U?SMS Gateway username: "; read -rs "P?password (hidden): "; echo
curl -s -u "$U:$P" https://api.sms-gate.app/3rdparty/v1/devices; echo; unset P
```

In bash: `read -r -p "username: " U; read -rs -p "password: " P`. Find your phone by its `name` and copy its `id`. Do not take the first row on trust, and do not paste the response into chat. The `id` is what Step 7.2 stores as `GATEWAY_DEVICE_ID`.

The app shows Online, and the devices list contains your phone.

<a id="step-7-gateway-secrets"></a>

### Step 7.2 Store the gateway secrets

Hidden prompts only. `-c` selects the Worker from Step 2 (or the test file from Step 5).

```sh
npx wrangler -c .relay-local/wrangler.toml secret put GATEWAY_USER
npx wrangler -c .relay-local/wrangler.toml secret put GATEWAY_PASS
npx wrangler -c .relay-local/wrangler.toml secret put GATEWAY_DEVICE_ID
npx wrangler -c .relay-local/wrangler.toml secret put GATEWAY_PASSPHRASE
```

`secret list` now also shows those four names. Values are not shown.

<a id="step-7-one-recipient"></a>

### Step 7.3 One recipient uses `to_name`

`POST /send` takes exactly one of `to`, `to_name`, `candidate_id`, `to_names`, or `candidate_ids`.

- One person by name: `to_name` (a string).
- Two or three people: `to_names` (an array of 2 or 3 strings) or `candidate_ids`.

`to_names` with one entry does not mean one recipient. The length check runs first, including when `resolve` is true, and the Worker answers **400** `{"error":"multi_send_needs_2_to_3"}`. Nothing is sent.

```json
{"to_name":"Example Owner","resolve":true}
```

```json
{"to_names":["Example Owner"],"resolve":true}
```

The second body is the 400. Use `to_name` for the test text.

<a id="step-7-allowlist"></a>

### Step 7.4 Allow-list labels

An `ALLOWLIST` entry is matched on the string you saved (the JSON value), after the same normalization as other names: case, extra spaces, and diacritics. For that entry the Worker stores no separate given name. A query that is a longer name than the saved string is `no_match`, and nothing is sent.

Saved label `Example Owner`:

- `{"to_name":"Example Owner","resolve":true}` → `{"state":"one","candidates":[{"candidate_id":"…","label":"Example Owner (unlabeled)"}]}`
- `{"to_name":"Example Owner Person","resolve":true}` → `{"state":"no_match","candidates":[]}`

The first word of a multi-word saved string also matches, the same way the first word of a contact's display name matches. Prefer the exact saved string.

How to see the saved string:

- It is the value you typed in the `ALLOWLIST` prompt. `secret list` does not show it.
- On `https://<APPROVE_HOST>/contacts`, a number that is only on the allow list is a read-only row. The name on that row is the saved string. The badge is `always on (ALLOWLIST)`.
- A resolve answer's `candidates[].label` for that number looks like `Example Owner (unlabeled)`. The saved string is the part before ` (unlabeled)`. Put that string in `to_name`, not the parenthesis part.

A number that is also an enabled contact keeps the contact's name (display name, given name, or first word). The allow-list string is not used for that number. The Contacts page still badges the row `always on (ALLOWLIST)`. Your own test number is usually only on the allow list, so the saved string is the one that matches.

<a id="step-7-draft"></a>

### Step 7.5 Draft

Write the text you want sent. Put a blank line between the greeting, the ask, and any link. In JSON a line break is `\n`.

Example body, not yet sent:

```text
Hi,

This is a relay test. Would you reply OK when you see it?

https://example.com
```

<a id="step-7-read-back"></a>

### Step 7.6 Read-back

The read-back is the bot, in chat or by voice. It repeats the draft and the resolved name, word for word.

The relay plays no audio and returns no read-back text. It has no audio route. `resolve: true` returns JSON (`state`, `candidates`, `expires_in_s`) and does not send. `POST /send` returns JSON (`id`, `state`, `method`, `to`). `to` is the matched name, not the message. The message text is not in the response.

If you are running the curls yourself, you are the one checking the draft. The relay still does not read it back.

<a id="step-7-yes"></a>

### Step 7.7 Yes

The bot waits for your yes on that exact draft and those exact people. Any edit to the words or the people needs a fresh read-back and a fresh yes. On voice, one text at a time. The bot does not send before that yes.

<a id="step-7-send"></a>

### Step 7.8 Send

Lookup first. Nothing is sent by this call. The token is read into the shell and passed as a header. It is not placed in the URL and not printed.

```sh
read -rs "RT?Bot token (hidden): "; echo
API=https://<API_HOST>
curl -sS -X POST "$API/send" -H @<(printf 'Authorization: Bearer %s\n' "$RT") -H 'content-type: application/json' \
  -d '{"to_name":"Example Owner","resolve":true}'
```

Expect `"state":"one"` and a `candidate_id`. `no_match` means the string is not the saved label (Step 7.4). `ambiguous` means more than one match; pick the `candidates` entry by its `label`.

After the yes, send with that id. Replace `CID` with the id from the lookup. Then unset both variables.

```sh
CID=<candidate_id>
curl -sS -X POST "$API/send" -H @<(printf 'Authorization: Bearer %s\n' "$RT") -H 'content-type: application/json' \
  -d "{\"candidate_id\":\"$CID\",\"body\":\"Hi,\n\nThis is a relay test. Would you reply OK when you see it?\n\nhttps://example.com\"}"
unset RT CID
```

Expect HTTP 200 and `"state":"sent"`. `"to"` is the saved label (`Example Owner`), not the phone number. The text arrives on your phone with blank lines between the parts. `"sent"` means the SMS Gateway cloud accepted the encrypted text for your phone and returned an id. It is not a delivery receipt. The phone sends it when it is Online. The app shows the real status. `https://<APPROVE_HOST>/log` shows `direct_sent` with hashes only.

The bot does the same two calls, and it is the one that speaks the draft in Step 7.6. It stops and tells you on anything other than `sent`. It does not retry a partial multi-send by itself.

<a id="step-7-bot"></a>

### Step 7.9 Hand the token to Grok Bot

Give the bot the token from Step 3 only through its secret prompt, stored as `SMS_RELAY_TOKEN`. Tell it `https://<API_HOST>`. Close the terminal that showed the token.

The bot's rules:

- Look every name up first (`resolve: true`), then send by `candidate_id` (or `candidate_ids` for 2–3 people).
- One person is `to_name`. `to_names` is 2–3 people. A one-entry `to_names` is `multi_send_needs_2_to_3`.
- Resolve an allow-list number by the exact saved label (Step 7.4).
- Read every text back word for word with the resolved names. Wait for your yes on that exact text. The relay will not do the read-back.
- Up to 3 people per text, as separate copies, and the read-back says "separate copies".
- Follow the blank-line formatting in Step 7.5.
- Stop and tell you on anything other than `sent`.

Have the bot run Step 7.5 through Step 7.8. The text arrives, and the bot waited for your yes.

<a id="step-7-google"></a>

### Step 7.10 Google Contacts

Your own test used `ALLOWLIST`. Other people come from Google Contacts, switched on one by one. Everyone starts off. The Contacts page is `https://<APPROVE_HOST>/contacts` (Step 1.4's login: email PIN, then the passkey). Sign out at `https://<APPROVE_HOST>/cdn-cgi/access/logout` and open `/direct` again. It must ask for the PIN and the passkey. If the PIN alone works, fix Step 1.4 before going on.

On the phone, open `https://<APPROVE_HOST>/direct` once and enroll the passkey when asked. The page shows `DIRECT_SEND: on` and `State: running`.

Connect Google on the Contacts page. No `secret put` per account, and the page does not ask for the client id or secret. One Worker, your own Google Cloud project, no shared database.

The standard web client this Worker needs (`….apps.googleusercontent.com`) is created in the console. `gcloud iam oauth-clients create` is not that client: [Manage OAuth application](https://docs.cloud.google.com/iam/docs/workforce-manage-oauth-app) (last updated 2026-10-22 UTC) says "These steps and the `projects.locations.oauthClients` API are only for Workforce Identity Federation. To create and manage standard OAuth 2.0 client IDs for Google Cloud users or services, go to the Google Cloud console, then go to APIs & Services > Credentials."

1. Create a project named `contacts-relay`: https://console.cloud.google.com/projectcreate
2. Enable the People API: https://console.cloud.google.com/flows/enableapi?apiid=people.googleapis.com (if that errors, open https://console.cloud.google.com/apis/library/people.googleapis.com and press Enable).
3. Branding (https://console.cloud.google.com/auth/overview/create): app name `Contacts relay`, your email, audience **External**. If Google Auth Platform is already set up, the link opens the overview; open Branding there.
4. Create an OAuth client (https://console.cloud.google.com/auth/clients/create): type **Web application**. Under Authorized redirect URIs add exactly `https://<APPROVE_HOST>/contacts/google/callback` with no trailing slash. Download the client JSON.
5. Audience (https://console.cloud.google.com/auth/audience): **Publish app (In production)**. This is required. Testing mode limits access to the Google accounts you list as test users, and refresh tokens expire after 7 days, so sync stops. A published but unverified app shows "Google hasn't verified this app". That's your own app; click Advanced, then Go to (app name). A work or school Google account may have an admin rule that blocks unverified apps.
6. From this repo: `node scripts/google-client.mjs --file=<that-file.json> --config=.relay-local/wrangler.toml`. `--config=<path>` is one argument and is required: there is no default path, so both puts go to the Worker in that file and cannot land on a different one. It runs `npx wrangler secret put` for `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, passing that same `--config=<path>` to both and each value on stdin. A missing or unreadable config fails before any put and the JSON stays. It deletes the JSON only after both puts succeed. If a put fails, the JSON stays, the script names that secret and the retry (`node scripts/google-client.mjs --file=<path> --config=<path>`), does not print the secret, and exits non-zero. `GOOGLE_TOKEN_KEY` from Step 3 must already be set.
7. Open the Contacts page and press **Connect Google**. Allow read-only contacts only. Anything else is revoked.
8. Press Sync now. A daily sync runs after that. A failed sync keeps the last good list.
9. Turn on the people the bot may text. Turning someone on asks you to confirm the last 4 digits.

Error codes and the fix text on the page are DEPLOY.md section 9. `default_country_code_invalid` is Step 2's `DEFAULT_COUNTRY_CODE`.

<a id="step-8"></a>

## Step 8. Rollback and troubleshooting

<a id="step-8-rollback"></a>

### Step 8.1 Rollback

Any one of these stops texting:

- Fastest, no deploy: Cloudflare dashboard, Workers & Pages, your Worker, Settings, Variables, set `DISABLED` to `1`. Then set `DISABLED = "1"` in `.relay-local/wrangler.toml` too, or the next deploy turns it back on.
- `DISABLED = "1"` (everything) or `DIRECT_SEND = "0"` (direct sends only) in the local file, then `npx wrangler deploy -c .relay-local/wrangler.toml`.
- `npx wrangler -c .relay-local/wrangler.toml secret put REQUEST_TOKEN` with a new value, typed at the prompt. The bot's old token stops at once. Update `SMS_RELAY_TOKEN` the same way, through the bot's secret prompt.
- On the phone: tap Online so it goes Offline, or turn off Cloud Server.

Roll back a bad deploy. `-c` must be the file whose `name` you deployed:

```sh
npx wrangler deployments list -c .relay-local/wrangler.toml
npx wrangler rollback -c .relay-local/wrangler.toml <version-id>
```

Docs: https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/

Rollback does not undo secrets or stored contacts. After a kill, a test send gets `relay_disabled`, `direct_send_off`, or `bad_request_token`, and nothing arrives.

To redeploy the previous source instead of `rollback`: check out that commit, rebuild `.relay-local/wrangler.toml` if `main` or the `[[rules]]` blocks changed, run `npm run check`, dry-run, then `npx wrangler deploy -c .relay-local/wrangler.toml`.

<a id="step-8-build"></a>

### Step 8.2 Build failed with 20 errors

`npx wrangler deploy --dry-run -c .relay-local/wrangler.toml` (or the live deploy) prints `Build failed with 20 errors`. The lines are two kinds:

- `Could not resolve "/harbor/source-serif-4-latin-600.woff2"` and `Could not resolve "/harbor/leaves/….webp"`, pointing at `src/harbor.css` `url(/harbor/...)`.
- `No loader is configured for ".woff2" files` and `No loader is configured for ".webp" files`, pointing at the imports in `src/harbor.ts`.

The local config is missing one or both `[[rules]]` blocks, or a block has the wrong `type`, the wrong globs, or `fallthrough` not `false`. `git pull` does not add them, because `.relay-local/wrangler.toml` is not in git. Copy both blocks from Step 2 (one Text rule for `**/*.css` and `**/*.svg`, one Data rule for `**/*.woff2` and `**/*.webp`, both `fallthrough = false`). A subfolder file also needs `main = "../src/index.ts"`.

```sh
npm run check
npx wrangler deploy --dry-run -c .relay-local/wrangler.toml
```

`npm run check` names the file and the rule it wanted. Dry-run then ends with `--dry-run: exiting now`.

### Step 8.3 Send and login failures

| What you see | What to do |
|---|---|
| 503 `timezone_not_configured` or `timezone_invalid` | Set `TIMEZONE` in the local file to a real IANA zone and deploy. |
| 503 `hosts_not_configured` | `REQUEST_HOST` and `APPROVE_HOST` are missing or equal. |
| 503 `not_configured` on `/send` | `REQUEST_TOKEN` is unset. Step 3. |
| 401 `bad_request_token` | The bearer token is not `REQUEST_TOKEN`. |
| 400 `multi_send_needs_2_to_3` | One person was sent as `to_names`. Use `to_name` (Step 7.3). |
| 200 `no_match` | The string is not the saved allow-list label, or the contact is switched off. Step 7.4 and the Contacts page. |
| 403 `recipient_not_on_allowlist` | That number is not on the allow list and not switched on. |
| 503 `direct_config_invalid` | `LOG_HASH_KEY` missing or shorter than 32 characters, or a bad direct-send switch. |
| 502 `send_failed` | The phone is not Online, or the gateway secrets do not match the app. DEPLOY.md section 10 lists the `fix=` hints (`device_key_present_but_no_pin`, passphrase mismatch, and the rest). |
| The app says "can't send message, key store operation failed" after the relay said `sent` | Device-key decrypt failed on the phone. This guide uses passphrase mode. DEPLOY.md Known limits. |
| Error 1102 or "exceeded CPU" | Workers Paid. |
| `npm run check` says `main = "src/index.ts" does not exist` and the path is under `.relay-local/` | The subfolder file needs `main = "../src/index.ts"`. |

<a id="step-9"></a>

## Step 9. Switches, rotation, and teardown

Optional switches are `[vars]` in `.relay-local/wrangler.toml`, then `npx wrangler deploy -c .relay-local/wrangler.toml`. The list (tap-to-approve, group MMS, daily cap, link block, quiet hours) is DEPLOY.md section 12. A typo fails closed.

Rotate a secret with `secret put` and the hidden prompt, then update the bot's secret prompt when the token changes. The long Google key rotation is DEPLOY.md section 14. Do it when a phone, computer, or bot that held a secret is lost.

Remove the relay: `npx wrangler delete -c .relay-local/wrangler.toml`, delete the Access application, remove leftover DNS, disconnect the Google app and shut down that Cloud project, uninstall SMS Gateway, delete `SMS_RELAY_TOKEN` in Grok Bot. DEPLOY.md section 15 is the same list.
