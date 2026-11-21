#!/usr/bin/env bash
set -euo pipefail

test -s .svelte-kit/cloudflare/_worker.js
test -n "$(find .svelte-kit/cloudflare/_app/immutable -type f -name '*.js' -size +0c -print -quit)"
