---
name: verify-sms-relay
description: Prove a change to grokbot-texting works before asking for review. Use after any edit to src/, mac/, scripts/, tests, config or docs, and before opening or updating a PR.
---

# Verify grokbot-texting (prove it works)

Don't say "done" or "should work". Show evidence from the final commit.

## Steps
1. `git rev-parse --short HEAD`: record the SHA. Everything below must run on it with a clean `git status`.
2. `npm ci` if package-lock.json changed.
3. `npm run verify`. It stops at the first failing step and names the file. Fix the code, not the check.
   Never raise a ratchet baseline to get green. Lowering it after you remove findings is welcome (`--update`).
4. If you touched `src/`, `mac/` or `scripts/`: `npm run mutation`. Required result: every mutant killed, no "PATTERN NOT FOUND".
   If you moved code a mutant targets, update its pattern in the same commit.
5. For a bug fix, prove the test bites: revert only the fix (`git stash` the src change), run the new test, see it fail, restore.
6. Scope check: `git diff --stat origin/main...HEAD` lists only files you meant to change.

## Report (paste into the PR body)
```
Head: <sha>
verify: PASS (<tests passed>/<total>, lint ratchet OK, strict-next OK, scripts OK, env-docs OK (n warnings), ancestors OK, pii OK or SKIPPED)
mutation: <killed>/<total> killed  (new mutants: <names>)  | not required: no src/mac/scripts change
Bites: <test name> fails at <sha without fix>, passes at <head>
Not verified: <anything you could not run, and why>
```
"Not verified" is required, even if it only says "none". An honest gap beats a false pass.
