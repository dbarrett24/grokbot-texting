# Contributing

1. Branch from `main`. Never force-push `main`; add commits instead of rewriting shared branches.
2. Write the failing test first (Worker behavior in `test/`, Node-side code in `test-node/`). Use only fake data: `example.com`, 555-01xx numbers.
3. Make it pass with the smallest change that fits the existing design (see `AGENTS.md` rules R1–R10).
4. If you added a guard or refusal, add a mutant to `scripts/mutation-check.mjs`.
5. Run `npm run verify`, and `npm run mutation` if you touched `src/`, `mac/` or `scripts/`.
6. Open the PR with the **prove-it-works** evidence from `AGENTS.md` pasted in the body.

Setup: `npm ci` (Node 20+). For the PII scan locally, put the term list in a gitignored `.pii-terms` (format: `scripts/ci/pii-terms.example`),
or set `PII_TERMS` / `PII_TERMS_FILE` (ask the maintainer). Without it the scan prints a WARNING and checks only phone numbers and commit emails; CI fails closed.
For agents, the verification skill is `.agents/skills/verify-sms-relay/SKILL.md`.

## Local contacts walk (`npm run walk`)

Clicks through `/contacts` locally with fake data, no Cloudflare account and no secrets:

```
npm install
npm run walk        # prints "walk: ready in N ms -> http://127.0.0.1:8787/contacts" once the page is usable
```

- The config, `walk.local.toml` (git-ignored), is written fresh from `wrangler.toml` on every run by
  `scripts/walk-config.mjs`. Do not hand-copy a walk config: one without the `[[rules]]` blocks (CSS as Text,
  `.woff2`/`.webp` as Data) prints "Ready" and then fails the build with 20 errors, so `/contacts` never loads.
  `test-node/walk.node.test.ts` fails if the generated rules ever differ from `wrangler.toml`.
- It listens on `127.0.0.1`, uses a fresh `.walk-state-<time>` persist dir, stops on any build error, and only prints
  the URL after `/contacts` (200, HTML) and two harbor assets have answered, so the first page view is already warm.
- `tools/walk/entry.ts` signs its own Access token for a fake `.invalid` team domain. It refuses to run unless
  `WALK_LOCAL = "1"`; never deploy it. It maps the page's local Origin (`http://127.0.0.1:<port>`) to the approve
  host, so on/off and stars work; any other Origin is still refused.
- Once the page is usable it loads the fake contacts in `tools/walk/fake-contacts.json` (UK Ofcom drama numbers
  `+44 7700 900xxx`, which the page lets you switch on, plus one 555-01xx example it refuses). Every run loads
  the same list.
- Google is faked in-process (`tools/walk/fake-google.ts`): every Google URL the Worker calls (token, revoke,
  People API) gets fake data, unknown Google paths get 599, and nothing reaches a real Google host. Connect Google
  skips the consent screen and returns to the callback with the same state and a fake code. The walk config sets
  fake, non-secret `GOOGLE_CLIENT_ID` (`123-walkonly.apps.googleusercontent.com`), `GOOGLE_CLIENT_SECRET`
  (`WALK-ONLY-client-secret`) and `GOOGLE_TOKEN_KEY`, so the page's Connect Google button is enabled without
  pasting a secret. Press Connect Google, then Sync now: the fake People list (fictional +44 7700 900xxx numbers
  and one 555-01xx example) loads.
