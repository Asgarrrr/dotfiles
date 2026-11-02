#!/usr/bin/env bash
# Runs the big-feature workflow harness under node:test.
# Run: just test (or bash tests/big-feature.test.sh)
set -uo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
echo "big-feature:"
node --test --test-reporter=dot "$repo/tests/big-feature.test.mjs"
