# GLM-5.3-Flash on MI355X (gfx950)

**Status: verified for the high-throughput cell.** This report measures
`zai-org/GLM-5.3-Flash` on one 8x MI355X node, compares it with
GLM-5.2-FP8 on the same software stack and workload, and records every
unmerged dependency by immutable commit.

Measurement window: **2026-08-27T23:31:10Z through 2026-08-28 UTC**.
Node: `mia1-p02-g46`, 8x MI355X (gfx950, 288 GiB each).

## 1. Frozen environment

| Component | Frozen value |
|---|---|
| Image | `rocm/sgl-dev:v0.5.18-rocm724-mi35x-20260826` |
| torch / HIP | `2.11.0+rocm7.2` / `7.2.26015` |
| SGLang | `0.5.18.dev20260826+g937af8538b`, source at `9d208769398882e20220cb97722bf610397e66d8` plus `hybrid_fp8_metadata.patch` |
| AITER | image commit `c16d44b93a528b2a4bfd6d8d3409116d465872a9` plus the tuning CSV from `95565e33c8287a8c56bc31a84edf2de3ecc97662` |
| GLM-5.3 weights | `zai-org/GLM-5.3-Flash` revision `04c4e9e95c5da8862dced7e5056455116f83a7e0` |
| GLM-5.2 control | `/models/GLM-5.2-FP8`, index SHA-256 `e0fe7f28c1f853d4824e4d796374e3dacf1fe470988773952c79b063768134bf` |

The GLM-5.3 revision is newer than the `3f1971b7b5f7` revision used by the
upstream performance PR. The two revisions have the same 76,108 tensor keys,
the same shard mapping and the same 328,326,771,576-byte total. The revision is
still pinned because branch names are not provenance.

## 2. GLM-5.3-Flash versus GLM-5.2 on paper

The GLM-5.3 figures below come from the
[model card](https://huggingface.co/zai-org/GLM-5.3-Flash) and
[Z.ai launch report](https://z.ai/blog/glm-5.3-flash). GLM-5.2 geometry comes
from its pinned checkpoint.

| | GLM-5.3-Flash | GLM-5.2-FP8 |
|---|---:|---:|
| Total parameters | 320B | 743B |
| Advertised active parameters | 18B | 39B |
| Checkpoint size | 305.8 GiB | 703.7 GiB |
| Text layers | 45 | 78 |
| Attention | 34 KDA linear + 11 NoPE sparse-MLA/DSA | MLA/DSA, no linear-attention layers |
| Routed experts / selected | 288 / 8 | 256 / 8 |
| Context | 1,048,576 | 1,048,576 |
| Multimodal | text, image, video | text |

The smaller active set is not the full memory argument. Reading only
safetensors headers and weighting eight routed experts per token gives:

| Decode weight stream | GLM-5.3-Flash | GLM-5.2-FP8 |
|---|---:|---:|
| Always-active text + shared experts + active routed experts | 23.68 GB | 43.29 GB |
| Less the one-row embedding lookup | **22.42 GB** | **41.38 GB** |
| Effective bytes / advertised active parameter | **1.25** | **1.06** |

The lm head remains included because every decode step evaluates the full
vocabulary. The embedding matrix is excluded because only one row is read. This
predicts a 1.85x memory-bound decode advantage for GLM-5.3; the measured
ISL-8192 single-stream gain is 1.78x.

The vendor's model-quality comparison is separate from this serving study:
Terminal-Bench 2.1 is 84.3 vs 81.0, DeepSWE v1.1 is 63.4 vs 46.2,
Toolathlon Verified is 78.4 vs 59.9, and AutomationBench is 48.8 vs 26.2
for GLM-5.3 versus GLM-5.2. Those are reported results under their own
harnesses, not numbers reproduced here. Section 7 is the controlled comparison
run on this node.

## 3. PR stack and timestamp

These states were captured at `2026-08-27T23:31:10Z` and then frozen for the
whole run:

| Role | PR | Frozen head | State |
|---|---|---|---|
| Model implementation | [sglang#36507](https://github.com/sgl-project/sglang/pull/36507) | `c4d5d45e506d` | open |
| AMD enablement and optimized kernels | [sglang#36607](https://github.com/sgl-project/sglang/pull/36607) | `9d2087693988` | open |
| gfx950 BF16 GEMM tuning | [ROCm/aiter#5060](https://github.com/ROCm/aiter/pull/5060) | `95565e33c828` | open |
| Upstream AMD recipe reference | [sglang#36732](https://github.com/sgl-project/sglang/pull/36732) | `8c0d81f9cf30` | open |

PR #36607 is stacked on #36507 and therefore contains both runtime changes.
PR #36732 is documentation only and was not applied to the runtime.

The stack moved while the measurements were running. At the final status
snapshot, `2026-08-28T06:29:56Z`, #36607 had been merged into the #36507
feature branch at `c821c425c31b` (not into `main`), #36507 remained open at
`aa8c950a3df6`, AITER #5060 remained open at `95565e33c828`, and #36732
remained open at `8c0d81f9cf30`. Those newer SGLang commits are not silently
mixed into this dataset; the launch helper checks that the measured
`9d2087693988` commit remains an ancestor and checks it out directly.

One additional local patch is required:
[`glm53_flash/hybrid_fp8_metadata.patch`](glm53_flash/hybrid_fp8_metadata.patch).
Under concurrent variable-prefix requests, the FP8-KV MHA fallback asked
`get_attn_backend().forward_metadata`, but a hybrid KDA model returns
`HybridLinearAttnBackend`; the DSA metadata lives on its `full_attn_backend`
child. Without the unwrap, GSM8K aborts with:

```text
AttributeError: 'HybridLinearAttnBackend' object has no attribute
'forward_metadata'
```

The patch routes all model-side MHA helper lookups through the existing
`resolve_attn_backend()` boundary and was validated by the full performance and
accuracy runs below.

## 4. Verified launch

Run [`glm53_flash/setup_pr.sh`](glm53_flash/setup_pr.sh) first. It hard-checks
the SGLang and AITER heads, applies the local metadata patch idempotently, and
overlays only AITER #5060's tuning CSV so the image's compiled AITER source is
not replaced.

```bash
export SGLANG_USE_AITER=1
export PYTORCH_HIP_ALLOC_CONF=expandable_segments:True
python3 -m sglang.launch_server \
  --model-path zai-org/GLM-5.3-Flash \
  --revision 04c4e9e95c5da8862dced7e5056455116f83a7e0 \
  --served-model-name glm-5.3-flash \
  --tp-size 8 --ep-size 1 \
  --trust-remote-code \
  --attention-backend dsa \
  --dsa-prefill-backend tilelang \
  --dsa-decode-backend tilelang \
  --linear-attn-backend triton \
  --kv-cache-dtype fp8_e4m3 \
  --quantization fp8 \
  --moe-runner-backend aiter \
  --cuda-graph-backend-decode full \
  --cuda-graph-backend-prefill disabled \
  --cuda-graph-bs-decode 1 32 \
  --disable-radix-cache \
  --chunked-prefill-size 8192 \
  --max-running-requests 64 \
  --reasoning-parser glm45 \
  --tool-call-parser glm47 \
  --watchdog-timeout 1200 \
  --host 0.0.0.0 --port 30000
```

Startup took 86.1 seconds with warm filesystem cache. Per rank:

- weights: 38.02 GB;
- FP8 KV pool: 211.16 GB / 32,006,720 tokens;
- KDA state pool for 64 requests: 0.04 GB conv + 1.08 GB SSM;
- decode graphs: 1.15 GB;
- free after capture: 23.16 GB.

The log confirms all intended paths on all eight ranks:
`Shared experts fusion optimization enabled`,
`Using AITER gfx950 mHC pre/post kernels`, and
`Using fused AITER mHC attention-to-FFN boundary`. The AITER config merge also
names `glm53_bf16_tuned_gemm.csv`.

## 5. Online throughput

`sglang.benchmark.serving`, random token IDs, ISL 8192 / OSL 1024,
`--random-range-ratio 1.0`, temperature 0, seed 42, infinite request rate,
cache flush and one concurrency-wide warmup per point. Each point uses `4*C`
measured prompts and is the median of three complete runs.

| conc | GLM-5.3 TTFT ms | TPOT ms | output tok/s | total tok/s | tok/s/GPU | GLM-5.2 total | 5.3 / 5.2 |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 199.49 | 6.95 | 139.93 | 1,259.36 | 157.4 | 703.83 | **1.79x** |
| 8 | 955.25 | 9.81 | 744.60 | 6,701.38 | 837.7 | 3,657.26 | **1.83x** |
| 16 | 1,624.32 | 10.80 | 1,292.46 | 11,632.14 | 1,454.0 | 5,940.07 | **1.96x** |
| 32 | 2,945.24 | 12.70 | 2,054.79 | **18,493.13** | **2,311.6** | 8,434.38 | **2.19x** |
| 64 | 5,555.98 | 69.45 | 828.73 | 7,458.58 | 932.3 | 10,557.68 | **0.71x** |

Request and token accounting passed for all 30 model/point/repeat records. The
largest total-throughput spread was 0.87% for GLM-5.3 and 0.13% for GLM-5.2.

Concurrency 64 is an execution-boundary result, not a saturation result.
GLM-5.3 captures full decode graphs only at batch sizes 1 and 32; batches wider
than 32 run eager, so throughput falls 60% from the c32 peak. Add 64 to
`--cuda-graph-bs-decode` and revalidate before operating that wide.

The same-stack GLM-5.2 control uses an 8192-token prefill chunk. Its published
0.5.17 high-throughput recipe uses 32768, but on this 0.5.18 head that setting
aborted on the first c8 warmup while lazily compiling aiter
`fp8_mqa_logits`, inside Triton/LLVM:

```text
llvm::iota_range<unsigned int>::iota_range:
Assertion `Begin <= End && "Begin must be less or equal to End."' failed.
```

Reducing only the chunk to 8192 made c8 and the complete sweep stable. The
control therefore removes node, engine and workload differences, while this
one recorded flag difference from the published GLM-5.2 cell remains explicit.

## 6. Single-stream latency

`bench_one_batch_server`, BS=1, OSL 1024, three runs per input length:

| ISL | GLM-5.3 E2E s | prefill tok/s | decode tok/s | GLM-5.2 E2E s | prefill tok/s | decode tok/s | decode gain |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 1,024 | 7.12 | 9,986.94 | 145.88 | 11.74 | 8,085.47 | 88.15 | **1.66x** |
| 8,192 | 7.30 | 43,329.00 | 144.03 | 13.06 | 19,383.98 | 81.03 | **1.78x** |
| 16,384 | 7.49 | 46,039.27 | 143.64 | 13.64 | 19,380.22 | 80.02 | **1.80x** |

The ISL-8192 decode gain, 1.78x, is close to the 1.85x ratio predicted from the
two checkpoints' active weight streams.

## 7. Accuracy

GSM8K uses the in-tree `run_eval` path shared with the GLM-5.2 cookbook:
thinking enabled, temperature 0, 8192 output-token cap and 32 threads. Although
`--num-examples 1319` was requested, this evaluator revision materialized 1,314
examples; both models scored the identical set.

| model | correct / n | score | wall time |
|---|---:|---:|---:|
| GLM-5.3-Flash | 1,281 / 1,314 | **97.49%** | 219.0 s |
| GLM-5.2-FP8 | 1,281 / 1,314 | **97.49%** | 773.2 s |

AIME25 uses `sgl-eval`, never in-tree `run_eval`: 30 problems x 16 repeats,
temperature 1.0, top-p 0.95, thinking enabled, 64K output cap and 32 threads.

| model | pass@1 | SEM | pass@16 | majority@16 | stop | truncated | errors |
|---|---:|---:|---:|---:|---:|---:|---:|
| GLM-5.3-Flash | **93.75%** | 0.42 pp | 100% | 100% | 96.04% | 3.96% (19/480) | 0% |
| GLM-5.2-FP8 | **90.83%** | 0.89 pp | 100% | 95% | 99.79% | 0.21% (1/480) | 0% |

GLM-5.3's 19 capped outputs make 93.75% a lower bound under this fixed
comparison protocol. Raising the cap would answer a different question and
must be reported as a separate row, not silently mixed with GLM-5.2's 64K
baseline. GLM-5.3 is +2.92 percentage points, about 3.0 combined standard
errors, despite the higher truncation rate. GLM-5.2 also produced three
no-answer samples, one of which was the truncated output.

## 8. Correctness and determinism boundary

The old bring-up state generated incorrect, degenerate text and produced 24
different continuations from 24 identical greedy requests. PR #36607 fixes the
deterministic error: the final AITER recipe scores 99/100 on the gate and
97.49% on full GSM8K.

It does not make AITER MoE bitwise deterministic. Three prompts x eight serial
greedy repeats, with a cache flush between calls, produced six exact strings.
Changing only `--moe-runner-backend aiter` to `triton` produced one exact
string per prompt across all 24 requests. All AITER variants remained
semantically correct. The residual is the last-bit reduction noise already
isolated by `repro_aiter_moe_nondet.py`; it is no longer catastrophically
amplified into wrong answers.

SGLang's `--enable-deterministic-inference` cannot substitute here: this head
rejects the DSA attention backend before launch. Exact replay therefore
requires the slower Triton-MoE validation configuration; the published
high-throughput cell is explicitly numerically, not bitwise, stable.

## 9. Reproducing and evidence

The canonical scripts are:

```bash
bash glm53_flash/start_container.sh
bash glm53_flash/setup_pr.sh
bash glm53_flash/serve_glm53.sh
bash glm53_flash/eval.sh smoke 20260827T233110Z
bash glm53_flash/bench.sh sanity 20260827T233110Z
bash glm53_flash/bench.sh main 20260827T233110Z
bash glm53_flash/bench.sh lat 20260827T233110Z
bash glm53_flash/eval.sh gsm8k 20260827T233110Z
bash glm53_flash/eval.sh aime25 20260827T233110Z
```

[`gen_glm53_mi355x_rows.py`](gen_glm53_mi355x_rows.py) reads the 15 serving
JSON records and nine latency records, validates the frozen server config and
request/token accounting, enforces the three-repeat set and 5% spread limit,
then emits the `models.js` rows.

Compact evidence for the frozen run is in
[`glm53_flash/results/20260827T233110Z/`](glm53_flash/results/20260827T233110Z/):

- `manifest.json` -- node, image, SGLang/AITER commits, model revision, both
  launch configurations, the correctness gates, the two observed failures, and
  the four upstream PRs at both freeze time and the final status snapshot.
- `performance.json` -- all 15 serving points and nine latency points per model,
  three repeats each, with the observed spread.
- `accuracy.json` -- GSM8K and AIME25 aggregates for both models, the AIME25
  difference in combined standard errors, and the determinism probes.

Large prediction files and server logs stay off-repo. `manifest.json` carries the
sha256 of the two compact artifacts and of each model's AIME prediction set, so
the published numbers can be tied back to the raw run.

## 10. Unmeasured

- MTP/NEXTN on ROCm: the checkpoint has one draft layer, but k-pool target
  verification was not validated in this study.
- Decode graph batch size 64: the current row measures the eager fallback.
- Long-context speed and accuracy past ISL 16,384.
- Image and video quality through the 24-layer vision encoder.

## 11. Pitfalls

Everything here cost real debugging time on this cell. None of it is visible
in the launch command.

### 11.1 One broken `rocminfo` silently mis-targets your kernels

Re-launching the frozen recipe on the same node a day later failed in three
different places. All three trace back to `rocminfo` aborting inside
`libhsa-runtime64`:

```text
rocminfo: ./src/core/runtime/amd_memory_region.cpp:173:
Assertion `GetPhysicalSize() <= GetVirtualSize()' failed.
```

It aborts with `ROCR_VISIBLE_DEVICES` empty as well, so the failing agent is a
CPU system-memory agent, not a GPU. `amd-smi` was clean, torch saw 8 gfx950
devices, and matmuls returned correct results the whole time. **A healthy
`amd-smi` does not mean a healthy `rocminfo`, and four independent consumers
parse the latter's text output:**

| Consumer | What it greps | Failure mode |
|---|---|---|
| `aiter/jit/utils/chip_info.py` | first `gfx\w+`, and `Compute Unit:` | raises -- loud |
| `sglang/srt/utils/common.py` | `Pool 1` ... `Size:` in KB | raises -- loud |
| `tilelang/contrib/rocm.py` | `Name:\s+gfx\d+` | **silently returns `gfx900`** |
| `rocm_agent_enumerator -name` | `Name: amdgcn-amd-amdhsa--gfx<n>` | **silently yields nothing** |

The two silent ones are the expensive ones.

`tilelang` falling back to `gfx900` makes HIP compile decode kernels for the
wrong target, and CUDA-graph capture dies with a `hipcc ... --offload-arch=gfx900`
compilation error that names a memory limit as the likely cause. It is not a
memory problem; do not lower `--mem-fraction-static` chasing it.

The fourth is worse, because the server comes up clean. `flydsl.runtime.device`
reads `rocm_agent_enumerator -name`, gets nothing, and falls back to `gfx942`.
In `aiter/ops/flydsl/kernels/splitk_hgemm.py` that flips `DMA_BYTES` from 16 to
4, which quadruples `LDG_WAIT_COUNT` and trips

```text
assert ((STAGES - 2) * LDG_WAIT_COUNT) < 63
```

while JIT-compiling a BF16 GEMM. The scheduler takes a `SIGQUIT` on the **first
real request** -- after `/health` has already returned 200 and after every
optimization banner has printed. On this model the shape is `n=4096, k=512`,
the `kv_lora_rank=512` projection in the 11 DSA layers, and the tuned table
routes `M >= 48` there through flydsl. So it survives a batch-1 smoke test and
kills the server under load.

Check all four detectors agree before trusting a run:

```bash
rocminfo | grep -m1 gfx                     # aiter, sglang, tilelang
rocm_agent_enumerator -name | head -1       # flydsl -- must NOT be empty
python3 -c "from flydsl.runtime.device import get_rocm_arch; print(get_rocm_arch())"
python3 -c "import torch; print(torch.cuda.get_device_properties(0).gcnArchName)"
```

If they disagree, [`glm53_flash/rocminfo_shim.sh`](glm53_flash/rocminfo_shim.sh)
is a drop-in replacement that reports the same facts from `torch` and
`amd-smi`. It is a node workaround, not part of the recipe: the
20260827T233110Z measurements ran with a working `rocminfo`, and the shim was
only needed to reproduce them afterwards. Confirm the GPUs are actually healthy
before installing it.

### 11.2 `resolve_attn_backend()` now unwraps for every caller

`hybrid_fp8_metadata.patch` puts the `full_attn_backend` unwrap inside the
shared `resolve_attn_backend()` in `forward_mha.py`, not at the one call site
that crashed. That is deliberate -- every model-side MLA hook in that file
wants the DSA child, and a non-hybrid model has no `full_attn_backend`
attribute so the `getattr` fallback returns the backend unchanged. Worth
knowing before adding a caller that genuinely needs the *parent* backend: it
will silently get the child instead.

### 11.3 A tie on GSM8K is not a null result

GLM-5.3 and the GLM-5.2 control both score exactly 1281/1314. The gate is
saturated at this level and does not separate the two models; AIME25 does
(93.75% vs 90.83%, 2.98 combined standard errors). Do not read the GSM8K tie
as evidence the models are equivalent, and do not tune against it.

### 11.4 The evidence trail has one gap by construction

`gen_glm53_mi355x_rows.py` re-validates the frozen server config out of each
serving record's `server_info`. `bench_one_batch_server` does not emit
`server_info` at all, so the nine latency records are validated on shape only
(batch size, output length, the three-repeat set) and rely on directory
provenance for which server produced them. Keep latency runs inside the same
tagged results directory as the serving runs, or that link is lost.

## 12. Why a 25% kernel win can be a 0% serving win

`ROCm/aiter#5069` retuned the GLM-5.2 a8w8 and BF16 GEMM configs for gfx950 and
reported, from its own measurement, 49 shapes going 3606.4us -> 2702.1us
(**-25.08%**), median +22.76% per shape, zero regressions. We A/B'd it on one
8x MI355X node with the same image, SGLang worktree, recipe and bench protocol,
changing **only the four tuning CSVs**:

| conc | GLM-5.2 delta | GLM-5.3 delta |
|---:|---:|---:|
| 1 | +0.06% | -0.01% |
| 8 | -0.05% | +0.05% |
| 16 | -0.02% | +0.08% |
| 32 | -0.05% | -0.00% |
| 64 | -0.09% | +0.15% |

Ten points, all inside a 0.04-0.35% noise floor. Both arms passed the GSM8K
gate. Before reading anything into a null result, we falsified it twice:

- **The arms really were different.** Each arm records the sha256 of what it
  deployed: a8w8 `b453...` vs `a361...`, bf16 `c84f...` vs `01da...`.
- **The change really did engage.** GLM-5.2's BF16 lookup misses fell
  **1256 -> 616**, exactly the `N=256, K=6144` half that the PR added rows for.

So the tuning worked and the serving throughput did not move. That is not bad
luck; it is structural.

### 12.1 Almost nothing in the model reads the tuned-GEMM table

`aiter.tuned_gemm.tgemm` has three call sites in SGLang, and one of them
(`kernels/ops/attention/dsv4/gemm.py`) is CUDA-only, i.e. dead on ROCm. For a
GLM-5.x FP8 checkpoint the live ones are:

| Module | Shape | Route |
|---|---|---|
| MoE router / gate | `N = n_routed_experts`, `K = hidden` | `tgemm.mm` |
| DSA indexer `weights_proj` (no `quant_config`, so bf16) | `N = n_heads`, `K = hidden` | `tgemm.mm` |

Everything else goes elsewhere: `qkv_a` / `q_b` / `o_proj` / `gate_up` /
`down_proj` / shared experts / KDA projections all land on
`aiter_w8a8_block_fp8_linear` -> `gemm_a8w8_blockscale*`; routed experts go to
`aiter.fused_moe` and `tuned_fmoe.csv`; `lm_head` is a plain `torch.matmul` in
`logits_processor.py`. Three different tuning tables, and the recipe's headline
GEMMs are in none of the ones this PR touched.

The serving logs agree exactly: across both A/B arms the only `(N,K)` pairs that
ever reach the BF16 table are `(256, 6144)` and `(32, 6144)` -- the router and
the indexer. Both are tiny.

Worse, half the PR is unreachable in this configuration. The non-block-scale
`gemm_a8w8_bpreshuffle` that `a8w8_bpreshuffle_tuned_gemm_glm5.2.csv` feeds is
only reached when `SGLANG_USE_AITER_FP8_PER_TOKEN` is set. GLM-5.2-FP8 is block
quantized (`weight_block_size: [128, 128]`), so it takes `gemm_a8w8_blockscale*`
instead. **Ninety-nine of the PR's 189 changed gfx950 rows are never read.**

### 12.2 The tuner optimises M values that serving never produces

Which shapes get tuned is decided entirely by the `*_untuned_gemm*.csv` shape
list. Those lists are a geometric ladder:

```
bf16 : 1 2 4 8 16 24 32 48 64 96 128 192 256 384 512 768 1024 1536 2048 3072 4096 8192 16384 32768
a8w8 : 1 2 4 8 16 32 64 128 256 512 1024 2048 4096 8192 16384 32768
```

Serving produces dense, arbitrary M -- chunked prefill and continuous batching
do not round to powers of two:

```
320 384 448 640 704 768 832 896 960 1024 1216 1984 6016 6528 6848 7104 7109 7168 7448 ...
```

Lookup does soften this. `get_GEMM_A16W16_config` probes three times: exact M,
then `getPaddedM(M,N,K,0)` (round up to a multiple of 16/32/64/128 by size
band), then `getPaddedM(M,N,K,1)` (`nextPow2`), then gives up. So `M=6016` runs
the kernel tuned for `M=8192`, and anything just past a power of two can be
served by a config tuned for nearly twice its size.

AITER already ships the fix for the shape list: `AITER_TUNE_GEMM=1` appends
every shape a real workload actually executes to the untuned CSV. A ladder of
powers of two is what you get when that step is skipped.

### 12.3 Even a perfect GEMM win is capped by what GEMM costs

A torch-profiler capture of the published GLM-5.3 cell (concurrency 32, ISL
8192) is worth reading carefully, because the raw numbers lie.
`aiter::cross_device_reduce_2stage` appears to own **97.4%** of GPU time -- but
6 of its 182 calls account for 98.9% of that, the longest running 2.35 seconds,
against a median of 282us. Those are ranks waiting at the collective, not
reducing. With the waits removed:

| Bucket | Share of real GPU compute |
|---|---:|
| TP all-reduce (genuine) | **29.9%** |
| MoE (`tuned_fmoe.csv`) | 18.8% |
| GEMM, **all** backends including blockscale | 17.3% |
| Other | 11.8% |
| mHC fusion | 10.1% |
| KDA linear attention | 6.1% |
| DSA attention | 1.7% |

Even if the retuned shapes were the entire GEMM bucket, 25% off 17.3% is 4.3%
end to end. They are instead the router and indexer slivers inside it.

### 12.4 What the coverage census actually found

`AITER_LOG_TUNED_CONFIG=1` logs the row each lookup resolves to. Running it
under a representative load on the published GLM-5.3 recipe:

| | |
|---|---:|
| Distinct shapes that hit the BF16 table | 104 |
| Distinct shapes that missed | **1616** |
| Misses that fell through to plain `torch` `F.linear` | 1608 |
| Hits at exactly the tuned M | 69.2% |
| Hits padded up, by up to 2.0x | 30.8% |

The gfx950 half of the `glm53_bf16_tuned_gemm.csv` this cookbook pins covers
**M = 1 and M = 32 only** -- precisely the two captured decode graph tiers.
Chunked prefill drives M to 8192. So the BF16 path runs unoptimised PyTorch for
the overwhelming majority of distinct shapes, and the interesting work is not
"retune the rows we have" but "the table is nearly empty for this workload".

### 12.5 What to demand of a tuning claim

An op-level speedup is a hypothesis about serving, not evidence of it. Before
believing one, ask for three things:

1. **Route proof** -- does the model read the table that changed? Check the
   call site, not the filename. `/tmp/aiter_configs/` shows which merged tables
   the process actually materialised; `AITER_LOG_TUNED_CONFIG=1` shows which
   rows resolve. Note the merge is keyed on `(gfx, cu_num, M, N, K, ...)` and
   drops the model name entirely, so a row tuned for one model will be selected
   for another whenever the shape matches.
2. **Mechanism proof** -- did the change engage? A hit/miss census before and
   after, so a null result cannot be confused with a no-op deployment.
3. **End-to-end A/B** -- same node, same image, same recipe, one variable, three
   repeats, correctness gate before timing, and a significance bar set from the
   arms' own spread. `verify.sh` and the harness conventions in section 9 are
   the shape of it.

Report the null results too. A 25% kernel win that does not move serving is a
useful fact about where the time actually goes.
