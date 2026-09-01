#!/usr/bin/env bash
# Overlay the frozen GLM-5.3 model + ROCm stack onto the nightly image's editable
# checkouts. PR #36607 is stacked on #36507, so its head contains both.
#
# AITER #5060 adds only a tuning CSV. Keep the image's compiled AITER commit and
# overlay that exact file; checking out the whole newer AITER tree would mix it
# with extensions compiled from the image's older source.
set -euo pipefail

NAME="${NAME:-glm53-flash}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
RESULTS="${RESULTS:-$HOME/glm53-flash-results}"
SGLANG_PR="${SGLANG_PR:-36607}"
SGLANG_HEAD="${SGLANG_HEAD:-9d208769398882e20220cb97722bf610397e66d8}"
AITER_PR="${AITER_PR:-5060}"
AITER_HEAD="${AITER_HEAD:-95565e33c8287a8c56bc31a84edf2de3ecc97662}"
PATCH="${PATCH:-/results/hybrid_fp8_metadata.patch}"
TUNING_PATH="aiter/configs/model_configs/glm53_bf16_tuned_gemm.csv"
TUNING_SHA256="bc4c88d602e773f0bbb13cdaaf8650dfbaa7a506bbc987c77fe57e13aa0df90c"

mkdir -p "$RESULTS"
install -m 0644 "$SCRIPT_DIR/hybrid_fp8_metadata.patch" \
  "$RESULTS/hybrid_fp8_metadata.patch"

docker exec "$NAME" bash -lc "
set -euo pipefail
cd /sgl-workspace/sglang
echo '--- before ---'
git log -1 --format='%H %ci %s'
# The assertion here used to be 'the measured commit is still an ancestor of the
# PR head'. That broke on 2026-08-31 when #36507 was rebased: the commit is fine,
# the branch just no longer descends from it, and setup failed at step one.
# Fetching the exact object pins the tree just as tightly and survives a rebase.
git fetch --no-tags origin '${SGLANG_HEAD}' 2>/dev/null \
  || git fetch --no-tags origin 'pull/${SGLANG_PR}/head'
git cat-file -e '${SGLANG_HEAD}^{commit}' || exit 1
git checkout -q --detach '${SGLANG_HEAD}'
git merge-base --is-ancestor '${SGLANG_HEAD}' FETCH_HEAD 2>/dev/null \
  || echo 'note: measured commit is no longer an ancestor of the PR head (rebased upstream); the tree checked out above is still exactly the measured one'
echo '--- after ---'
git log -1 --format='%H %ci %s'

if git apply --reverse --check '${PATCH}' >/dev/null 2>&1; then
  echo 'hybrid FP8 metadata patch already applied'
else
  git apply --check '${PATCH}'
  git apply '${PATCH}'
fi

git -C /sgl-workspace/aiter fetch --no-tags origin 'pull/${AITER_PR}/head'
test \"\$(git -C /sgl-workspace/aiter rev-parse FETCH_HEAD)\" = '${AITER_HEAD}'
git -C /sgl-workspace/aiter show \
  '${AITER_HEAD}:${TUNING_PATH}' \
  > '/sgl-workspace/aiter/${TUNING_PATH}'
echo '${TUNING_SHA256}  /sgl-workspace/aiter/${TUNING_PATH}' | sha256sum -c -

echo '--- model registered? ---'
python3 -c \"
from sglang.srt.configs.glm5_next import Glm5NextConfig
print('Glm5NextConfig.model_type =', Glm5NextConfig.model_type)
import sglang.srt.models.glm5_next as m
print('glm5_next module ok:', m.__file__)
print('arch classes:', [n for n in dir(m) if n.startswith('Glm5Next') and n.endswith(('CausalLM','Generation'))])
\"
"
