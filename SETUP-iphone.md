# iPhone setup

Android phones send through the SMS Gateway app ([DEPLOY.md](DEPLOY.md)). An iPhone has no app that can do that, so the Worker stays the same and only the **last hop** changes: each text that passes every check is put in a queue, and a device signed into your Apple ID **claims** it and sends it from your number.

```
bot --(REQUEST_TOKEN)--> your Worker (every check, then queue)
                                  ^
your Mac or iPhone --(DEVICE_TOKEN, outbound HTTPS poll)--+--> Messages --> recipient
```

Two ways to do the claiming:

| | Path | Sends unattended? | You need |
|---|---|---|---|
| **1 (recommended)** | **A Mac that stays on**, running a small helper (`mac/`) | Yes | A Mac (real hardware, not a VM), signed into Messages with your Apple ID, awake and logged in |
| 2 (fallback) | **An iPhone Shortcut** woken by an email | Usually, but **best-effort**: seconds to 15+ minutes, sometimes not at all | iOS 17+, Apple Mail with a push account |
| 2b | The same Shortcut, **one tap per text** | No, you tap a notification | iOS 17+ and ntfy |

Do DEPLOY.md first (sections for Cloudflare, Access, secrets and contacts), but **skip the Android phone and SMS Gateway steps**. Then come back here.

## Worker settings for both paths

In `wrangler.toml`:

```toml
DELIVERY = "mac"                  # or "shortcut"
NOTIFY_MODE = "ntfy"              # required in these modes; see "Notices" below
# UNCLAIMED_EXPIRY_MINUTES = "30" # optional; see below
```

Secrets:

```sh
npx wrangler secret put DEVICE_TOKEN             # 32+ characters, NOT the same as REQUEST_TOKEN
npx wrangler secret put NTFY_URL                 # https://ntfy.sh/<a long random topic> or your own ntfy server
npx wrangler secret put NTFY_TOKEN
```

`GATEWAY_*` secrets aren't used in these modes.

What changes when `DELIVERY` is `mac` or `shortcut`:
- **Every existing check still runs first**: the allowlist, link blocking, quiet hours, per-minute and daily limits, the runaway pause, the kill switch, and your tap approval in the tap flow. Only a text that passes all of them is queued.
- `POST /send` answers **202 `{"state":"queued"}`** instead of 200 `sent`. The outcome shows up in the log (`direct_sent`, `direct_send_failed`, `direct_send_uncertain`). A tap request's state goes `queued_device` → `sent` / `send_failed` / `send_uncertain`.
- **`DIRECT_DAILY_CAP` defaults to 25** a day (unset). Apple can flag an Apple ID that sends a lot of automated iMessages, so a cap is on unless you turn it off with `DIRECT_DAILY_CAP = "off"` or set your own number.
- **One text at a time.** The device claims the oldest queued text. The claim and the hand-out are one step, so a text can be claimed only once, and its words are erased from the Worker's storage at that moment.
- **No retries, ever.** The device reports one result. If it doesn't report within **2 minutes**, the claim times out: logged as `device_claim_timeout`, recorded as *uncertain* (the device may have sent it), and never handed out again. A text nobody claims within **`UNCLAIMED_EXPIRY_MINUTES`** (default 30, allowed 1 to 1440) is dropped (`device_job_expired`) rather than sent late, and **you get a notice for each dropped text** saying who it was for (last 4 digits) and that it was not sent. Ask your bot to send it again once the device is back.
- `GET /direct` on your private page shows the delivery mode, the last poll and how many texts are waiting.

### Notices

Device modes **require `NOTIFY_MODE = "ntfy"`**. With `"sms"` your notices (approval requests, "device offline", "text dropped") would be texts queued for the very device that might be down, so the Worker refuses every route with 503 `config_invalid` (reason `notify_mode_must_be_ntfy_for_device_delivery`) until you switch.

### When the device goes quiet

If the device hasn't polled for **10 minutes** (Mac asleep, logged out after a restart, Wi-Fi down, Shortcut not firing), the Worker logs `device_stale` and sends you **one** notice for that outage through the owner-notice path. When the device polls again it logs `device_back`, and the next outage gets its own notice.

That notice goes through ntfy, never through the device.

## Path 1: a Mac that stays on (recommended)

The helper (`mac/relay-device.mjs`) runs as a LaunchAgent in your login session. Every 5 seconds it makes an **outbound HTTPS** request to `https://<REQUEST_HOST>/device/next`. There is no inbound port, no tunnel and no Cloudflare login on the Mac. When it gets a text, it sends it with [`imsg`](https://imsg.sh) (0.6.0 or newer), which drives Messages through Apple's public AppleScript surface: **System Integrity Protection stays on**, and no BlueBubbles Private API or other injection is used. Then it reports the result once.

How results are read:
- `sent`: imsg found the outgoing message in the Messages database.
- `sent_unverified`: Messages accepted it, but imsg couldn't read the database to confirm (no Full Disk Access).
- `uncertain`: imsg can't tell if it went out (including macOS 26's "sent but never delivered" ghost-row bug, which imsg 0.6.0+ detects, and a 90-second timeout). Not retried: check Messages before sending again.
- `not_started`: it never left. Also not retried; the bot can send a new one.

### Steps (about 20 minutes)

1. **Messages on the Mac.** Sign in with the same Apple ID as your iPhone. In Messages > Settings > iMessage, set "Start new conversations from" to your **phone number** (imsg can't choose the number per text).
2. **Green-bubble SMS.** On the iPhone: Settings > Apps > Messages > Text Message Forwarding > turn on this Mac, and enter the code. SMS goes Mac → iPhone → carrier, so **the iPhone must be on and online** for SMS. iMessage doesn't need it.
3. **Tools.** `brew install node steipete/tap/imsg`
4. **Install the helper.** From this repo on the Mac: `bash mac/install.sh`. It asks for your relay URL (`https://<REQUEST_HOST>`) and the `DEVICE_TOKEN`, which goes into your **login Keychain** only, never a file. It installs `~/Library/LaunchAgents/org.smsrelay.device.plist` and starts it. Log: `~/Library/Logs/sms-relay-device.log` (job ids and outcomes only, never numbers or text).
5. **Automation permission (required).** The first time a text goes out, macOS asks *"node wants access to control Messages"*. Click **Allow**. Missed it? System Settings > Privacy & Security > Automation > node > Messages on. Until then every send fails (and isn't retried).
6. **Full Disk Access (recommended).** System Settings > Privacy & Security > Full Disk Access > add your `node` binary (install.sh prints its path). This lets imsg confirm each send and catch the ghost-row bug.
7. **Keep it awake.** System Settings > Energy: "Prevent automatic sleeping when the display is off". Leave it plugged in and on the network.
8. **Test.** Ask your bot to text **your own number** something harmless, and watch for `direct_sent` on `https://<APPROVE_HOST>/log`. Then send one to a friend who knows it's a test.

To stop it: `bash mac/uninstall.sh` (add `--forget` to remove the token from the Keychain), or the Worker's `DISABLED = "1"`.

## Path 2: an iPhone Shortcut (no Mac, best-effort)

iOS has no background timer or webhook a Shortcut can listen to. What it can do is run an automation **when an email arrives**, without asking, and that Shortcut can fetch from the Worker and send a message. So the Worker sends you an **empty email** whenever a text is queued, and the Shortcut does the rest.

The email has a fixed subject (`Relay: job waiting`) and **no body: never the text, never a number**.

**Worker settings:**

```toml
DELIVERY = "shortcut"
SHORTCUT_PING = "email"
PING_FROM = "relay@example.com"   # an address on a domain where Cloudflare Email Routing is on
PING_TO = "you@example.com"       # a verified Email Routing destination that your iPhone's Apple Mail gets with PUSH

[[send_email]]
name = "PING_EMAIL"
destination_address = "you@example.com"
```

**Build the Shortcut** (Shortcuts app > + , name it `Relay Send`):
1. **Get Contents of URL**: `https://<REQUEST_HOST>/device/next`, Method **POST**, Header `Authorization` = `Bearer <your DEVICE_TOKEN>`.
2. **Get Dictionary Value** `job` from the result. **If** it has any value:
   - Get `to`, `text`, `id` and `lease` from it.
   - **Send Message** `text` to `to`. Open the action's details and turn **Show When Run off**.
   - **Get Contents of URL**: `https://<REQUEST_HOST>/device/result`, POST, the same header, Request Body JSON: `id`, `lease`, and `outcome` = `sent_unverified` (Shortcuts can't confirm delivery).
3. Run it once by hand and allow the network prompts. If iOS asks, allow Settings > Apps > Shortcuts > Advanced > "Allow Running Scripts".

**Create the automation:** Automation tab > + > **Email** > Sender is `PING_FROM`, Subject contains `Relay: job waiting` > **Run Immediately** (turn off Notify When Run) > run `Relay Send`. If it never fires with an iCloud address, set the account filter to "any account".

Optional safety net: a few **Time of Day** automations (say hourly 8 AM to 9 PM) that run the same Shortcut, so a missed email is picked up later. Unclaimed texts are still dropped after `UNCLAIMED_EXPIRY_MINUTES` (you're told about each one), so raise it if your safety net runs hourly.

**Limits, plainly:**
- Gmail in Apple Mail only *fetches* (about every 15 minutes), and the Gmail app never triggers automations. Use a **push** account (iCloud Mail, or another IMAP IDLE / Exchange account).
- Low Power Mode and Background App Refresh settings delay it.
- iOS has been seen to silently stop an automation until you open and re-save it. The 10-minute stale notice is how you'll find out.
- The device token lives inside the Shortcut, and Shortcuts sync through iCloud. Don't share the Shortcut; if you do by mistake, rotate `DEVICE_TOKEN`.

### 2b: tap once per text

If you'd rather confirm each text, or the email trigger is unreliable for you:

```toml
DELIVERY = "shortcut"
SHORTCUT_PING = "tap"
SHORTCUT_NAME = "Relay Send"
```

The Worker posts an ntfy notification ("A text is waiting. Tap to send it.", no number, no text). Tapping it opens `shortcuts://run-shortcut?name=Relay%20Send`, which runs the same Shortcut. Install the ntfy app and subscribe to your topic with your token. This is the most dependable no-Mac option, at one tap per text.

## Honest limits

- **The Mac must stay awake, logged in and online.** A LaunchAgent can't run before you log in.
- **FileVault and restarts:** with FileVault on (as it should be), a Mac that restarts after a power cut or update waits at the login screen, and nothing sends until you log in. You'll get the stale notice after 10 minutes.
- **macOS 26 send bug:** Messages can report success while writing an empty message that never arrives. imsg 0.6.0+ catches this and the relay records `uncertain`, not `sent`. Re-test after every macOS update.
- **Apple ID spam flags:** Apple can flag an Apple ID that sends automated or bulk iMessages, which blocks new conversations; recovery means contacting Apple. Keep it personal: contacts only, one recipient per text, the 25-a-day default cap, never a VM.
- **SMS needs the iPhone.** Green-bubble texts relay through your iPhone; if it's off or offline they fail.
- **One outgoing number.** If your Apple ID has several numbers, Messages' "Start new conversations from" setting decides which one is used.
- **The Shortcut path is best-effort** by design. If you need texts to go out on time, use the Mac.
- **Not supported:** the BlueBubbles Private API (it needs SIP turned off), Pushcut's automation server on your everyday phone, and number-hosting services (a mobile number can't be hosted without moving it off your iPhone).

## Kill switches

- Everything: `DISABLED = "1"` on the Worker.
- The Mac: `bash mac/uninstall.sh`, or `launchctl bootout gui/$(id -u)/org.smsrelay.device`.
- The Shortcut: set the automation to "Don't Run", or delete it.
- A lost device or leaked Shortcut: `npx wrangler secret put DEVICE_TOKEN` with a new value. `REQUEST_TOKEN` is separate and unaffected.
