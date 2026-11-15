#!/usr/bin/env bash
# Runs the feature workflow harness under node:test.
# Run: just test (or bash tests/feature.test.sh)
set -uo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
echo "feature:"
node --test --test-reporter=dot "$repo/tests/feature.test.mjs"
