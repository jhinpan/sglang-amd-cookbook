#!/usr/bin/env bash
# Run every check this repo has, in cheapest-first order.
#
# The point of collecting them here is the third one. `--check-models` is what
# proves the published benchmark rows are still structurally equal to the rows
# regenerated from the raw records; left as an optional flag nobody passes, the
# strongest guarantee in the repo silently never runs.
#
#   bash verify.sh              # offline checks, plus row regeneration if the
#                               # raw records are present on this box
#   bash verify.sh --render     # also the jsdom render test (needs npm)
set -uo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")"

failures=0
step() {
  local name="$1"
  shift
  echo
  echo "=== $name"
  if "$@"; then
    echo "--- ok: $name"
  else
    echo "--- FAILED: $name"
    failures=$((failures + 1))
  fi
}

step "offline models.js / glossary / benchmark-row checks" \
  node verify-cookbook.js

step "GLM-5.3 verification regression tests" \
  python3 -m unittest -q test_glm53_verification.py

# Regenerating the rows needs the raw run, which is not in the repo. Skip
# loudly rather than passing quietly when it is absent.
GLM53_RAW="${GLM53_RAW:-/results/glm53-final-20260827T233110Z/bench/glm53}"
if [ -d "$GLM53_RAW" ]; then
  step "glm-5.3-flash rows match the raw records" \
    python3 gen_glm53_mi355x_rows.py --results "$GLM53_RAW" --check-models models.js
else
  echo
  echo "=== glm-5.3-flash rows match the raw records"
  echo "--- SKIPPED: raw records not at $GLM53_RAW (set GLM53_RAW to override)"
fi

if [ "${1:-}" = "--render" ]; then
  step "jsdom render + deep links" node test_render.js
fi

echo
if [ "$failures" -ne 0 ]; then
  echo "$failures check(s) failed"
  exit 1
fi
echo "all checks passed"
