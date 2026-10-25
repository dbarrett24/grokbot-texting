# Design note: one-time `/token` reveal (gap 9)

Status: design only, not built. No build until Dave says go.

Gap 9: in the target design there is no step where the owner generates `REQUEST_TOKEN` by hand and pastes it. Cloudflare generates the token, and an Access-protected page at `text.<domain>/token` shows it once, with a Copy button. A used flag locks the page after that one view; it can only be shown again after a rotate. This is design only: nothing is built until Dave says go.

**Until it ships**, the template falls back to local keys plus copy-token: `setup-mac.sh keys` makes the token locally in `.relay-local/`, and `copy-token` puts it on the clipboard for the hidden `secret put REQUEST_TOKEN` prompt and the bot's secret prompt (then `clear-clipboard`). No doc tells the owner to make it by hand.

## Goal
Cloudflare (the Worker) generates the token and shows it to the owner exactly once on `text.<domain>/token`, so it never touches a terminal, the owner's computer, or shell history, and is never shown again until a rotate.

## Threat model
- In scope: shoulder-surfing and scrollback (shown once, behind a tap); a stolen Access session after setup (a second reveal is impossible); replay of the reveal request (single-use, CSRF-bound); logs and analytics (the value never reaches a log line, error body, or `console`); a cached page (`Cache-Control: no-store`).
- Out of scope: an attacker who already passes Access as the owner before the first reveal (they could reveal it first; mitigated by the "Already revealed" banner in flow step 4, which tells the owner to press Rotate); a compromised Cloudflare account.

## Flow
1. Owner opens `https://text.<domain>/token` (the Access-protected private host, Access + passkey, same as `/contacts`). The request host returns 404.
2. If no token exists yet: the page shows **Reveal bot token** with a page CSRF value.
3. `POST /token/reveal` (same Origin + CSRF): the Durable Object makes 32 random bytes (hex), stores only `HMAC(TOKEN_HASH_KEY, token)`, sets the used flag (`revealed_at`), and returns the value once in a `no-store` response. The page shows it with a Copy button and "Paste this into your bot's secret prompt as SMS_RELAY_TOKEN. It will not be shown again."
4. The used flag locks the page: any later visit shows the banner "Already revealed on <date>. Not you, or lost it? Press Rotate." and a **Rotate** button, never the value. Rotate makes a new token, revokes the old one at once, and reveals the new one once.
5. Bot auth checks `HMAC(bearer)` against the stored hash (constant-time). A `REQUEST_TOKEN` set by the local-keys fallback keeps working; when both exist, the secret wins until the owner presses **Switch to page token**, so current installs are unchanged.

## Storage
- Durable Object storage: `token_hash` (HMAC-SHA256 under its own Worker secret `TOKEN_HASH_KEY`, 32 random bytes, never equal to `LOG_HASH_KEY`; the Worker refuses the `/token` routes if it is unset or reused), `revealed_at`, `rotated_at`. Never the token, never ciphertext of it.
- No KV, no D1 row, no log line with the value or its hash.

## Rotation
- `TOKEN_HASH_KEY` is used for nothing else, so rotating `LOG_HASH_KEY` (DEPLOY.md section 14) leaves the page token working.
- Rotating `TOKEN_HASH_KEY` itself makes the stored hash unmatchable: the page token stops working at once (bot gets 401). The page then shows **Reveal bot token** again; reveal, paste the new value into the bot. Nothing tries to rebuild the old hash, because the token is never stored.
- If `REQUEST_TOKEN` is still the active secret (no Switch yet), rotating `TOKEN_HASH_KEY` changes nothing for the bot.

## Expiry
- The reveal offer is open for 15 minutes after the first page load that creates it; after that it must be started again (no token exists until reveal).
- The revealed token does not expire on its own; it ends on Rotate, on a local-keys rotation (`keys --new-token`, `copy-token`, `secret put REQUEST_TOKEN`) taking over, or on `DISABLED = "1"`.

## Tests
- Reveal returns a 64-hex value once; a second `POST /token/reveal` is 409 and returns no value.
- Storage after reveal has the hash and timestamps only (scan every stored value for the token: none).
- Responses carry `Cache-Control: no-store`; a missing/wrong CSRF or cross-Origin POST is 403; request host is 404; no Access is 403.
- Bot auth: right token 200, wrong token 401, rotated-out token 401 immediately.
- With `REQUEST_TOKEN` set, the page token is ignored until Switch.
- `LOG_HASH_KEY` rotated: page token still 200. `TOKEN_HASH_KEY` rotated: page token 401, page offers Reveal again. `TOKEN_HASH_KEY` unset or equal to `LOG_HASH_KEY`: `/token` refuses.
- Log capture during all of the above contains neither the token nor its hash.
