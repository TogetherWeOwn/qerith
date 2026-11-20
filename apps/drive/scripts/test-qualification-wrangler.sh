#!/usr/bin/env bash
set -euo pipefail

name='pinned Wrangler resolves both private migrations in local mode'
log=$(mktemp)
trap 'rm -f "$log"' EXIT
DRIVE_QUALIFICATION_WRANGLER_LOCAL=1 timeout --signal=TERM --kill-after=10s 60s \
  node --test --test-reporter tap --test-name-pattern "^${name}$" \
  scripts/staging-qualification-migrations.test.mjs | tee "$log"
# Node can succeed without a match. Require the specific case to pass, not skip.
if ! grep -Eq "^ok [0-9]+ - ${name}$" "$log"; then
  printf '%s\n' 'The pinned Wrangler migration case did not pass.' >&2
  exit 1
fi
