# AGENTS.md: sms-relay-template

You are probably an agent that has opened only a few files. This page is short on purpose. The repo is built so the
easy path is the right one, and checks catch what the structure can't. Trust order (poteto's inverse pyramid):
**codebase design > static analysis > this prose > human review.** If you find yourself relying on a sentence here,
ask whether it could be a type, an invariant or a check instead, and propose that.

## The one command
```
npm run verify          # both tsc configs, strict-next and .mjs ratchets, lint + lint ratchet, env/doc drift, history guard, PII scan, tests
npm run mutation        # required when you change src/, mac/ or scripts/: every mutant must be killed (a full run takes hours)
```
CI runs a subset of verify and treats some of it as advisory. Verify is the stricter gate, with one exception: CI can run
the personal-data term scan with a secret term list, which you may not have locally. So: green verify is necessary,
not proof that CI is green.

## Prove it works (required in every PR body)
Claims without evidence don't count. Paste, from your final commit:
1. `npm run verify` output (last ~20 lines) and the head SHA it ran on.
2. `npm run mutation` result (`N/N killed`) when src/, mac/ or scripts/ changed, plus the names of mutants you added.
3. For a bug fix: the test that failed before your change and passes after (name it), and the mutant that re-introduces the bug.
4. For a new check: show it failing on a real past mistake (a commit or file from history), not only a toy example.

## Rules and what enforces them
Prefer the higher level. A rule enforced by "prose only" is a candidate for promotion.

| # | Rule | Enforced by | Level |
|---|------|-------------|-------|
| R1 | Save state before any side effect; after a job is queued, never report a retryable failure (F4, F7). Use `deliver(..., onQueued)`. | `deliver`'s `onQueued` callback; tests in test/device.test.ts; mutants `device_tap_state_before_ping`, `device_direct_queued_survives_throw` | design + test |
| R2 | Narrow every outside value (request body, env var, JSON from Google/Access, SQL row) with a parser that returns a typed value or a refusal. No `as unknown as`, no `any`. | lint warnings `relay/no-double-cast`, `typescript/no-unsafe-*`, `no-explicit-any`, held by the lint ratchet; strict-next ratchet | static (ratchet; existing uses remain) |
| R3 | Every `[vars]` key in wrangler.toml is typed in `Env` (error). Every `Env` field is documented (warning: 2 settings undocumented today). | `npm run check:env-docs` | static |
| R4 | argv: pass `--flag=value` as one element, never `"--flag", value` (F2). Put boolean flags after values. | lint warning `relay/argv-flag-value`, held by the lint ratchet | static (ratchet) |
| R5 | No owner data: fixtures use example.com and 555-01xx numbers; no real names, places or numbers in files, commit text or PR text. | `npm run check:pii` (terms from a secret, never in the repo); test/phone-scan.ts | static |
| R6 | Never base work on banned history (746a756, d9811fc). | `npm run check:ancestors` | static |
| R7 | Each new guard or refusal gets a mutant in scripts/mutation-check.mjs that the tests kill. | `npm run mutation` | test |
| R8 | Don't add lint or type findings. New files start at 0; the baselines only go down. | lint errors (eqeqeq, no-misused-promises, await-thenable, switch-exhaustiveness-check) fail `npm run lint`; every other rule is a warning that `lint:ratchet` fails if a (file, rule) count rises; `typecheck:strict-next` and `typecheck:scripts` ratchet tsc errors per (config, file, code) | static |
| R9 | `--dry-run` must not write files (pr4 M1, pr6 N4). | prose only for now; planned: an injected file writer in scripts/setup-lib.mjs | prose |
| R10 | Docs describe what the code does today; when you change behavior, change the doc in the same PR. | R3 covers the settings list; the rest is review | prose |

Ratchet limits: counts are per (file, rule), so a finding can move within a file, or be swapped for another finding of the
same rule, without failing. The baselines are lint-baseline.json, tsc-strict-next-baseline.json and tsc-scripts-baseline.json.
Lower them with `--update` after removing findings. Never raise them to get green.

## Exceptions
A lint exception goes on the offending line, never in config:
`// oxlint-disable-next-line <rule> -- reason: <why>; expires: YYYY-MM-DD; approved-by: <human name>`
Missing parts or a past expiry fail `lint:ratchet`. Agents can't approve exceptions.

## Map
- `src/relay.ts` Durable Object: routes, tap flow, direct send, contacts sync, device queue. `src/env.ts` settings. `src/direct.ts` direct-list rules.
- `mac/` Mac helper. `scripts/` setup and consent helpers; `scripts/ci/` checks. `test/` Worker tests (workerd, network blocked). `test-node/` Node cross-checks.
- Verification skill: `.agents/skills/verify-sms-relay/SKILL.md`. Contributor path: `CONTRIBUTING.md`.
