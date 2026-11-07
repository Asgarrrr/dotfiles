#!/usr/bin/env bash
# Runs the feature eval metrics tests on fixture journals.
# Run: just test (or bash tests/feature-eval.test.sh)
set -uo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
echo "feature-eval:"
python3 -I "$repo/tests/feature-eval/test_metrics.py"
