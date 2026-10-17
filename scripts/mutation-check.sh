#!/usr/bin/env bash
# Kept for `npm run mutation`; the mutant list lives in scripts/mutation-check.mjs.
cd "$(dirname "$0")/.." && exec node scripts/mutation-check.mjs "$@"
