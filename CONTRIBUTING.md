# Contributing

1. Branch from `main`. Never force-push `main`; add commits instead of rewriting shared branches.
2. Write the failing test first (Worker behavior in `test/`, Node-side code in `test-node/`). Use only fake data: `example.com`, 555-01xx numbers.
3. Make it pass with the smallest change that fits the existing design (see `AGENTS.md` rules R1–R10).
4. If you added a guard or refusal, add a mutant to `scripts/mutation-check.mjs`.
5. Run `npm run verify`, and `npm run mutation` if you touched `src/`, `mac/` or `scripts/`.
6. Open the PR with the **prove-it-works** evidence from `AGENTS.md` pasted in the body.

Setup: `npm ci` (Node 20+). For the PII scan locally, set `PII_TERMS_FILE` to a term list kept **outside** the repo
(ask the maintainer); without it the term scan is skipped and only the phone-number scan runs.
For agents, the verification skill is `.agents/skills/verify-sms-relay/SKILL.md`.
