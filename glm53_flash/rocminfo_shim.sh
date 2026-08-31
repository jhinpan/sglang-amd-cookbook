#!/usr/bin/env bash
# Workaround for a node whose rocminfo aborts while the GPUs themselves are fine.
#
# Symptom, seen on mia1-p02-g46 after the 20260827T233110Z run:
#
#   rocminfo: ./src/core/runtime/amd_memory_region.cpp:173:
#   rocr::AMD::MemoryRegion::MemoryRegion(...):
#   Assertion `GetPhysicalSize() <= GetVirtualSize()' failed.
#
# It aborts with ROCR_VISIBLE_DEVICES empty too, so the failing agent is a CPU
# (system-memory) agent, not a GPU. torch/HIP on the same node stays healthy:
# 8 visible devices, gfx950, kernels run and return correct results. Only the
# assertion-enabled rocminfo binary dies.
#
# That single broken binary degrades three independent consumers, two of them
# SILENTLY -- see section 11 of glm53_flash_playbook.md:
#
#   1. aiter/jit/utils/chip_info.py  greps the first /gfx\w+/ token, and also
#      "Compute Unit:" per GPU agent. Raises loudly, so the server will not start.
#   2. sglang/srt/utils/common.py    greps "Pool 1" ... "Size:" in KB per GPU
#      agent for get_amdgpu_memory_capacity(). Raises loudly.
#   3. tilelang/contrib/rocm.py      greps "Name: gfx...", and on failure returns
#      the default "gfx900" WITHOUT raising -- HIP then compiles for the wrong
#      target and CUDA-graph capture fails.
#   4. rocm_agent_enumerator -name   parses "Name: amdgcn-amd-amdhsa--gfx<n>"
#      ISA lines. flydsl.runtime.device reads it and, on failure, silently
#      falls back to "gfx942". That flips DMA_BYTES from 16 to 4 in
#      aiter/ops/flydsl/kernels/splitk_hgemm.py, which trips
#      `assert ((STAGES - 2) * LDG_WAIT_COUNT) < 63` while JIT-compiling a
#      BF16 GEMM. The server starts, serves /health, and then dies on the
#      first real request.
#
# Architecture, device count, compute units and VRAM are read live from torch
# and amd-smi. The marketing name is intentionally fixed because this shim is
# only for the homogeneous MI355X nodes described above.
#
# Install (container-local, reversible):
#   mv  /opt/rocm/bin/rocminfo /opt/rocm/bin/rocminfo.rocr-broken
#   install -m 0755 glm53_flash/rocminfo_shim.sh /opt/rocm/bin/rocminfo
#
# Do NOT use this to paper over a genuinely sick GPU. Confirm first that
# `amd-smi metric` is clean and that a torch matmul returns correct results.
set -euo pipefail

read -r arch count cus <<<"$(python3 -c '
import torch
p = torch.cuda.get_device_properties(0)
print(p.gcnArchName.split(":")[0], torch.cuda.device_count(), p.multi_processor_count)
')"

echo "ROCk module is loaded"
echo "*** rocminfo shim -- see glm53_flash/rocminfo_shim.sh for why ***"

idx=0
while [ "$idx" -lt "$count" ]; do
  if ! vram_mb="$(amd-smi metric -g "$idx" 2>/dev/null | awk '/TOTAL_VRAM:/{print $2; exit}')"; then
    echo "ERROR: amd-smi metric failed for GPU $idx" >&2
    exit 1
  fi
  if [[ ! "$vram_mb" =~ ^[0-9]+$ ]]; then
    echo "ERROR: amd-smi metric returned no numeric TOTAL_VRAM for GPU $idx" >&2
    exit 1
  fi
  vram_kb=$(( vram_mb * 1024 ))
  cat <<AGENT
Agent $((idx + 2))
*******
  Name:                    $arch
  Marketing Name:          AMD Instinct MI355X
  Device Type:             GPU
  Compute Unit:            $cus
  Pool 1
    Segment:                 GLOBAL; FLAGS: COARSE GRAINED
    Size:                    $vram_kb(KB)
    Allocatable:             TRUE
    Alloc Granule:           4KB
    Alloc Alignment:         4KB
  ISA Info:
    ISA 1
      Name:                    amdgcn-amd-amdhsa--$arch
AGENT
  idx=$((idx + 1))
done
