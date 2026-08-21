# GLM-5.2-FP8 on MI355X (gfx950), SGLang 0.5.17 — three recipes

Single-node **TP=8** deployment of `zai-org/GLM-5.2-FP8` on **8× AMD Instinct MI355X** with SGLang and the **DSA tilelang** backend. This is a re-measurement of the gfx950 cell on a newer image, and three things changed at once.

> **This playbook supersedes the gfx950 half of [`glm52_fp8_playbook.md`](glm52_fp8_playbook.md), not the gfx942 half.** MI300X is unaffected by everything below: same flags, no patches, numbers unchanged.

| | 0.5.13.post1 / ROCm 7.2.0 / aiter `7d604afe5` | **0.5.17 / ROCm 7.2.4 / aiter `d9e5ef7ce`** |
|---|---|---|
| Source patches | **2 mandatory** (`bpreshuffle`), else GSM8K ≈ 0.0 | **none** — and applying them now costs ~7% |
| MTP / speculative decode | "not enabled on AMD" | **works**, accept length 3.56 of 4 |
| KV cache dtype | bf16 only ("FP8 KV incompatible") | **bf16 or `fp8_e4m3`** (ROCm only) |
| Verified cells | 1 (`low-latency`) | **3** (`low-latency`, `balanced`, `high-throughput`) |

## 0. Environment (verified)

| Item | Value |
|------|-------|
| GPUs | 8× MI355X (gfx950), 288 GiB each, single node, SPX/NPS1 |
| Image | `rocm/sgl-dev:v0.5.17-rocm724-mi35x-20260820` — stock, pulled and run unmodified |
| SGLang | `0.5.17.dev20260820+g47fc97d754` — **no fork, no patch** |
| ROCm | 7.2.4 (host 7.1.1 / amdgpu 6.16.6) |
| aiter | `d9e5ef7ce`, `SGLANG_USE_AITER=1` |
| tilelang | 0.1.7.post3 |
| Weights | `zai-org/GLM-5.2-FP8` — 717 GB, 141 shards, `model_type=glm_moe_dsa` |
| Cold start | ~19 min to `/health`, dominated by the slowest TP rank's weight load |

## 1. What changed, and why you can check each claim

### 1.1 The two `bpreshuffle` patches are retired

The previous cell required forcing `_use_aiter_bpreshuffle_gfx95 = False` in **two** places, or GSM8K collapsed to 0.0. It also stated its own expiry:

> "Upstream permanent fix is the CK kernel rewrite ROCm/rocm-libraries#8639 (scalar-FMA/VGPR accumulator), which supersedes the disable workaround; **not in aiter 7d604afe5**, so the source workaround is required for now."

That condition is met. This image ships aiter `d9e5ef7ce`, and #8639 is present in its CK submodule — the VGPR anchor `asm volatile("" : "+v"(value))` in `blockwise_gemm_pipeline_xdlops_blockscale_b_preshuffle_v{1,3}.hpp`. SGLang 0.5.17 agrees, gating the flag on the ROCm version rather than disabling it:

```python
# python/sglang/srt/layers/quantization/fp8_utils.py:72
# python/sglang/srt/models/deepseek_common/utils.py:51
_use_aiter_bpreshuffle_gfx95 = _use_aiter_gfx95 and get_hip_version() >= (7, 2, 0)
```

So on ROCm 7.2.4 the flag is **True by default** and the patch is now an opt-out of the fast path. Measured A/B, identical argv, patch the only difference:

| ISL 8192 / OSL 1024 | patched (wall clock) | unpatched | delta |
|---|---|---|---|
| c=8 | 91.8 s | 83.8 s | **-8.8%** |
| c=16 | 123.2 s | 112.7 s | **-8.5%** |
| c=32 | 179.5 s | 163.4 s | **-9.0%** |
| GSM8K (n=200 gate) | 0.980 | 0.980 | no change |

Accuracy is unchanged, so this is not a speed/quality trade — it is a straight loss. Forcing the flag off also costs two things that do not show up in a single number: the image ships the `preshuffle_ON` CK modules prebuilt but **not** the `off` twin, so every start pays an aiter JIT build; and aiter ships `a8w8_blockscale_bpreshuffle_tuned_gemm_glm5.2.csv`, a GLM-5.2-specific tuned table for exactly this kernel, which the patched path never consults.

**Keep the patches on an older image, or on any ROCm below 7.2.** The two sources disagree about *which* ROCm miscompiles — the older cell says ROCm 7.2 drops `-mllvm -amdgpu-coerce-illegal-types` (#28685); the 0.5.17 source comment says ROCm 7.0 (#23319). #8639 removes the need for that pass either way, which is why GSM8K, not source archaeology, is the arbiter here. Run it before trusting any of this: the miscompile was **M-tile sensitive**, so `bs=1` can look perfect while batched decode returns garbage.

### 1.2 MTP / NEXTN speculative decoding works

`GlmMoeDsaForCausalLMNextN` is in `models/glm4_moe.py`; `model_config.py` swaps `GlmMoeDsaForCausalLM` → `GlmMoeDsaForCausalLMNextN` for the draft, and `speculative_hook.py` sets `--speculative-draft-model-path` to the model path itself and auto-chooses `(num_steps, eagle_topk, num_draft_tokens) = (3, 1, 4)`.

**The draft rides in the same checkpoint — there is no second model to download.** One flag:

```bash
--speculative-algorithm NEXTN
```

**What it costs, measured against one flag.** Speculation accelerates decode and taxes prefill, and the size of both is worth knowing before you turn it on for long prompts. This is `low-latency` against the same config with `--speculative-algorithm NEXTN` removed and nothing else changed — same image, same `--chunked-prefill-size`, same `--mem-fraction-static`, same graph width:

| ISL / OSL, c=1 | TTFT ms off | TTFT ms on | prefill cost | decode tok/s off | decode tok/s on | decode gain |
|---|---|---|---|---|---|---|
| 8,192 / 1,024 *(random)* | 558 | 591 | **1.06×** | 77.7 | 200.4 | **2.58×** |
| 8,192 / 512 *(random)* | 560 | 588 | **1.05×** | 77.7 | 201.5 | **2.59×** |
| 32,768 / 512 *(random)* | 2379 | 2461 | **1.03×** | 75.0 | 196.5 | **2.62×** |
| 131,072 / 512 *(random)* | 11777 | 12152 | **1.03×** | 66.3 | 178.7 | **2.69×** |
| 262,144 / 512 *(random)* | 28516 | 29394 | **1.03×** | 57.7 | 159.1 | **2.76×** |
| **ShareGPT — real text** | 120 | 129 | **1.08×** | 84.0 | 144.7 | **1.72×** |

Prefill is barely charged at all — 1.03-1.06x at every length, so speculation is close to free on the input side. What decides the benefit is **output entropy**, not input length: the synthetic rows show 2.6x because a random prompt drives the model into a loop a draft predicts almost perfectly, while the ShareGPT row is what real traffic gets. Size from the ShareGPT row.

Two things to know. Enabling speculation silently resets `--max-running-requests` to 48 when you have not set it. And the DSA MTP metadata precompute still falls back to a non-fused path on ROCm (`if _is_cuda and not _is_hip:` in `dsa_backend_mtp_precompute.py`), so the accept path is not yet running its fastest kernel — the numbers below are a floor, not a ceiling.

**Accept length is a property of the workload, and `--dataset-name random` overstates it** — the same trap [`degeneracy_probe.py`](degeneracy_probe.py) documents for Kimi-K3. Measured on GLM-5.2:

| workload | accept length (of 4) | note |
|---|---|---|
| `--dataset-name random`, ISL 8192 | 3.994 | unique-token ratio 0.0176, most-repeated 8-gram ×27 |
| ShareGPT, real chat text | **2.969** | single stream |
| GSM8K, n=1319 | **3.5565** | greedy, structured math |

The random rows in §4 are kept because they are what makes this table comparable to the cell it replaces — but size speculative decoding from the two real-text figures.

### 1.3 `fp8_e4m3` KV is legal on the tilelang DSA path — on ROCm only

```python
# _check_tilelang_dsa_fp8_kv raises only when `not hip`.
# Docstring: "tilelang's fp8 KV path is ROCm-only; the CUDA kernel hardcodes bfloat16."
```

`tilelang_sparse_fwd` has a real `is_fp8_kv` branch into `sparse_mla_fwd_decode_partial_fp8` with gfx950 tuning. MLA/DSA keeps one compressed latent per token (512 nope + 64 rope), so halving its width is a clean ~2× cut in bytes per token:

| cell | `--kv-cache-dtype` | `--mem-fraction-static` | pool (tokens) | capacity @ 8k ctx | capacity @ 76k ctx |
|---|---|---|---|---|---|
| `low-latency` | bfloat16 | 0.85 | 1,645,440 | 200 | 19 |
| `balanced` | fp8_e4m3 | 0.85 | 3,194,368 | 389 | 37 |
| `high-throughput` | fp8_e4m3 | 0.92 | 3,717,888 | 453 | 43 |

The "FP8 KV is incompatible with tilelang" note from the previous cell is a **CUDA** rule and is stale for ROCm on 0.5.17.

**Gate it on accuracy before you believe it.** GSM8K moved +0.0 pp (0 of 200 problems), and speculative accept length moved −0.38% (3.5474 bf16 → 3.5340 fp8) — quantising the cache does not degrade drafting. **But GSM8K prompts are ~300 tokens.** Quantisation error accumulates with context, and long-context accuracy under fp8 KV is **not verified here**. §6.4 says what to run.

## 2. Launch — three recipes

All three are the same command with three groups of flags moved. Nothing else differs: no patches, no fork, same image.

### 2.1 `low-latency` — MTP, bf16 KV

```bash
# gfx950 / MI355X, low-latency: MTP speculative decode, bf16 KV.
# NO source patches on this image (ROCm 7.2.4 + aiter d9e5ef7ce) -- the two
# bpreshuffle disables the 0.5.13 recipe required are now counter-productive.
# The NextN draft rides in the same checkpoint; there is no second download.
export SGLANG_USE_AITER=1
export PYTORCH_HIP_ALLOC_CONF=expandable_segments:True
python3 -m sglang.launch_server \
  --model-path zai-org/GLM-5.2-FP8 \
  --served-model-name glm-5.2 \
  --trust-remote-code \
  --tp 8 \
  --dsa-prefill-backend tilelang \
  --dsa-decode-backend tilelang \
  --kv-cache-dtype bfloat16 \
  --speculative-algorithm NEXTN \
  --chunked-prefill-size 16384 \
  --mem-fraction-static 0.85 \
  --cuda-graph-max-bs 32 \
  --max-running-requests 32 \
  --reasoning-parser glm45 \
  --tool-call-parser glm47 \
  --watchdog-timeout 1200 \
  --host 0.0.0.0 \
  --port 30000
```

### 2.2 `balanced` — MTP **and** fp8 KV

```bash
# gfx950 / MI355X, balanced: MTP speculative decode ON TOP OF an fp8_e4m3 KV
# cache. fp8 KV is ROCm-only on the tilelang DSA path. mem-fraction is 0.88
# and not higher on purpose -- see the lazy-kernel gotcha.
export SGLANG_USE_AITER=1
export PYTORCH_HIP_ALLOC_CONF=expandable_segments:True
python3 -m sglang.launch_server \
  --model-path zai-org/GLM-5.2-FP8 \
  --served-model-name glm-5.2 \
  --trust-remote-code \
  --tp 8 \
  --dsa-prefill-backend tilelang \
  --dsa-decode-backend tilelang \
  --kv-cache-dtype fp8_e4m3 \
  --speculative-algorithm NEXTN \
  --chunked-prefill-size 16384 \
  --mem-fraction-static 0.85 \
  --cuda-graph-max-bs 32 \
  --max-running-requests 48 \
  --schedule-policy lpm \
  --reasoning-parser glm45 \
  --tool-call-parser glm47 \
  --watchdog-timeout 1200 \
  --host 0.0.0.0 \
  --port 30000
```

### 2.3 `high-throughput` — fp8 KV, no speculation, widest batch

```bash
# gfx950 / MI355X, high-throughput: fp8_e4m3 KV, no speculation, widest batch.
# --schedule-policy lpm is what keeps this survivable once the pool is full.
export SGLANG_USE_AITER=1
export PYTORCH_HIP_ALLOC_CONF=expandable_segments:True
python3 -m sglang.launch_server \
  --model-path zai-org/GLM-5.2-FP8 \
  --served-model-name glm-5.2 \
  --trust-remote-code \
  --tp 8 \
  --dsa-prefill-backend tilelang \
  --dsa-decode-backend tilelang \
  --kv-cache-dtype fp8_e4m3 \
  --chunked-prefill-size 32768 \
  --mem-fraction-static 0.92 \
  --cuda-graph-max-bs 64 \
  --max-running-requests 64 \
  --schedule-policy lpm \
  --num-continuous-decode-steps 2 \
  --reasoning-parser glm45 \
  --tool-call-parser glm47 \
  --watchdog-timeout 1200 \
  --host 0.0.0.0 \
  --port 30000
```

## 3. Sizing: the one number worth carrying away

**Concurrency is the wrong knob. Tokens are.** The admission ceiling is

```
capacity = floor(KV_pool_tokens / peak_context_tokens)
```

and `concurrency / capacity` ordered **every** point measured, across six configs, both KV dtypes and every pool size — 14 of 14 healthy below 1.0, 5 of 5 collapsed above it, with a 4.5× gap and nothing in between:

| over-subscription | config | conc / capacity | policy | E2E p50 | aggregate tok/s |
|---|---|---|---|---|---|
| 0.19× | `high-throughput` | 8 / 43 |  | 10.9 s | 285 |
| 0.21× | `mtp-fp8` | 8 / 39 |  | 5.9 s | 404 |
| 0.37× | `high-throughput` | 16 / 43 |  | 13.1 s | 395 |
| 0.38× | `balanced` | 8 / 21 |  | 6.7 s | 332 |
| 0.40× | `baseline-prod` | 8 / 20 |  | 12.3 s | 234 |
| 0.41× | `mtp-fp8` | 16 / 39 |  | 8.1 s | 486 |
| 0.42× | `low-latency` | 8 / 19 |  | 6.5 s | 330 |
| 0.42× | `nopatch` | 8 / 19 |  | 11.5 s | 252 |
| 0.74× | `high-throughput` | 32 / 43 |  | 17.8 s | 484 |
| 0.76× | `balanced` | 16 / 21 |  | 8.4 s | 408 |
| 0.80× | `baseline-prod` | 16 / 20 |  | 15.4 s | 308 |
| 0.82× | `mtp-fp8` | 32 / 39 |  | 11.3 s | 577 |
| 0.84× | `low-latency` | 16 / 19 |  | 8.7 s | 412 |
| 0.84× | `nopatch` | 16 / 19 |  | 14.5 s | 331 |
| **— capacity 1.0 —** |  |  |  | **cliff** |  |
| 1.49× | `high-throughput` | 64 / 43 | lpm | 31.2 s | 413 |
| 1.52× | `balanced` | 32 / 21 | lpm | 80.7 s | 165 |
| 1.60× | `baseline-prod` | 32 / 20 | fcfs | 294.9 s | 71 |
| 1.64× | `mtp-fp8` | 64 / 39 | lpm | 343.5 s | 103 |
| 1.68× | `low-latency` | 32 / 19 | fcfs | 225.8 s | 79 |
| 1.68× | `nopatch` | 32 / 19 | fcfs | 277.5 s | 76 |

The policy column is blank below the ceiling on purpose: the queue is empty there, so `--schedule-policy` never runs. Above it, it is the whole story — the two `lpm` rows are the two least-bad collapses.

Both inputs are known before you serve a request: read `max_total_num_tokens` from `/get_server_info` at startup, and take the peak context off your own traffic. You do not need to benchmark to know which side of the cliff you are on.

Two corollaries:

- **`--max-running-requests` is an upper bound, not the binding one.** Whichever of it and `capacity` is smaller decides. At real context lengths on this model it is almost never the flag.
- **Past the ceiling, `--schedule-policy` decides how much it hurts.** Both `lpm` configs beat every `fcfs` config by 2.8–11× on comparable points. `lpm` admits by longest prefix match, which is exactly the right thing when the pool is thrashing. The ratio tells you *whether* you are exposed; the policy tells you *how bad*.

## 4. Throughput — `sglang.bench_serving`

Shape is the one the previous cell published, so the rows are comparable: `--dataset-name random --random-input-len 8192 --random-output-len 1024 --random-range-ratio 1.0`, plus an ISL ladder at `--random-output-len 512` and concurrency 1. `--flush-cache` per point, and the first burst after a start is discarded — it pays JIT and a cold radix tree.

```bash
# one point
python3 -m sglang.bench_serving --backend sglang --dataset-name random \
  --random-input-len 8192 --random-output-len 1024 --random-range-ratio 1.0 \
  --num-prompts $((C*4)) --max-concurrency $C --warmup-requests $C \
  --flush-cache --seed 42 --port 30000
```

> In this image `python3 -m sglang.bench_serving` is shadowed by a namespace package. Run `cd /sgl-workspace/sglang/python && python3 -m sglang.benchmark.serving` instead, and run it **inside** the server container — it imports `aiter`, which needs a visible GPU.

### 4.1 `low-latency`

| ISL / OSL | conc | TTFT ms | TPOT ms | decode tok/s | output tok/s | total tok/s | tok/s/GPU |
|---|---|---|---|---|---|---|---|
| 8,192 / 1,024 | 1 | 591 | 5.0 | **200.4** | 180 | 1618 | 202 |
| 8,192 / 1,024 | 8 | 1450 | 10.2 | — | 676 | 6084 | 760 |
| 8,192 / 1,024 | 16 | 2318 | 15.1 | — | 872 | 7852 | 982 |
| 8,192 / 1,024 | 32 | 4321 | 24.0 | — | 1087 | 9779 | 1222 |
| 8,192 / 1,024 | 64 | 29079 | 25.9 | — | 1099 | 9890 | 1236 |
| 8,192 / 512 | 1 | 588 | 5.0 | **201.5** | 164 | 2783 | 348 |
| 32,768 / 512 | 1 | 2461 | 5.1 | **196.5** | 101 | 6571 | 821 |
| 131,072 / 512 | 1 | 12152 | 5.6 | **178.7** | 34 | 8764 | 1096 |
| 262,144 / 512 | 1 | 29394 | 6.3 | **159.1** | 16 | 8055 | 1007 |

### 4.2 `balanced`

| ISL / OSL | conc | TTFT ms | TPOT ms | decode tok/s | output tok/s | total tok/s | tok/s/GPU |
|---|---|---|---|---|---|---|---|
| 8,192 / 1,024 | 1 | 444 | 4.9 | **204.0** | 188 | 1688 | 211 |
| 8,192 / 1,024 | 8 | 1150 | 9.3 | — | 727 | 6539 | 817 |
| 8,192 / 1,024 | 16 | 1662 | 13.2 | — | 1001 | 9008 | 1126 |
| 8,192 / 1,024 | 32 | 3053 | 19.7 | — | 1328 | 11956 | 1495 |
| 8,192 / 1,024 | 64 | 20312 | 47.1 | — | 922 | 8295 | 1037 |
| 8,192 / 512 | 1 | 450 | 4.8 | **207.5** | 176 | 2984 | 373 |
| 32,768 / 512 | 1 | 1776 | 5.0 | **198.5** | 118 | 7644 | 956 |

### 4.3 `high-throughput`

| ISL / OSL | conc | TTFT ms | TPOT ms | decode tok/s | output tok/s | total tok/s | tok/s/GPU |
|---|---|---|---|---|---|---|---|
| 8,192 / 1,024 | 1 | 423 | 12.4 | **80.9** | 78 | 705 | 88 |
| 8,192 / 1,024 | 8 | 1970 | 16.8 | — | 428 | 3850 | 481 |
| 8,192 / 1,024 | 16 | 3594 | 20.1 | — | 678 | 6100 | 762 |
| 8,192 / 1,024 | 32 | 6785 | 27.2 | — | 947 | 8522 | 1065 |
| 8,192 / 1,024 | 64 | 13089 | 37.4 | — | 1276 | 11485 | 1436 |
| 8,192 / 512 | 1 | 422 | 12.4 | **80.8** | 76 | 1289 | 161 |
| 32,768 / 512 | 1 | 1982 | 12.8 | **78.0** | 60 | 3896 | 487 |
| 131,072 / 512 | 1 | 8906 | 14.6 | **68.7** | 31 | 8049 | 1006 |
| 262,144 / 512 | 1 | 22909 | 16.8 | **59.6** | 16 | 8339 | 1042 |

### 4.4 Side by side

| cell (output tok/s, ISL 8192 / OSL 1024) | c=1 | c=8 | c=16 | c=32 | c=64 |
|---|---|---|---|---|---|
| `low-latency` | 180 | 676 | 872 | 1087 | 1099 |
| `balanced` | 188 | 727 | 1001 | 1328 | 922 |
| `high-throughput` | 78 | 428 | 678 | 947 | 1276 |

Reference: the 0.5.13 recipe carried onto this image scores 532 output tok/s at c=16, against the 535.7 published for it on 0.5.13 — the harness reproduces the previous cell to within 0.7%.

## 5. Accuracy

```bash
# GSM8K (chat + thinking). 32-wide on purpose: the bpreshuffle failure mode was
# M-tile sensitive, and a serial eval is the one shape that would miss it.
python3 -m sglang.test.run_eval --port 30000 --eval-name gsm8k \
  --thinking-mode glm-45 --max-tokens 8192 --temperature 0 \
  --num-examples 1319 --num-threads 32
```

| cell | KV dtype | speculation | GSM8K (n=1319) | accept length |
|---|---|---|---|---|
| `low-latency` | bfloat16 | NEXTN | **97.1%** | 3.5565 |
| `balanced` | fp8_e4m3 | NEXTN | **97.3%** | 3.5545 |
| `high-throughput` | fp8_e4m3 | off | **97.2%** | — |
| _0.5.13 cell, patched, no spec_ | bfloat16 | off | _97.7%_ | — |

**AIME25 is not re-measured here.** The 91.5% in the cookbook cell was taken on the 0.5.13 image with the no-speculation recipe. Speculative decoding verifies exactly and fp8 KV did not move GSM8K, so it should hold — but that is an argument, not a measurement. When you run it, use `sgl-eval`, **not** in-tree `run_eval`, whose strict first-match `Answer:` regex badly undercounts this thinking model (62.5% vs 90.6% on the same outputs).

## 6. Gotchas that cost real time here

### 6.1 `--mem-fraction-static 0.92` fails in the most misleading way available

On a speculative **and** fp8 config, 0.92 aborts the process on the **first long-context prefill**:

```
Triton kernel '_gluon_fp8_mqa_logits_kernel' device-loaded after serving started
(free device mem: 0.00 GiB). Pre-load it during engine init to avoid CUDA OOM.
...
Fatal Python error: Aborted
```

The fp8 DSA indexer kernel is loaded **lazily, on first use** — and first use means the first long prompt, not engine init. Before that the server starts normally, answers `/health`, and completes a full 200-problem GSM8K at 0.970 and the fastest eval throughput in the study. Every signal a deployment pipeline checks is green until a real request arrives. Measured free memory at that moment: `high-throughput` had 0.06–0.18 GiB and survived; adding MTP's graphs (the draft graph alone is 0.72 GB) took it to 0.00. **Use 0.88 on the speculative fp8 recipe.**

### 6.2 `--cuda-graph-max-bs` is a hard ceiling, not a hint

Every decode batch wider than it runs **eager**. On the `balanced` recipe at concurrency 64: 0 of 50 batches eager at `running-req <= 32`, **88 of 88** eager above it. That cost 31% of aggregate throughput at 17% pool usage — where contention explains nothing. If you intend to run wider than the value, raise it with the width.

### 6.3 Keep `--chunked-prefill-size` at or below 32768

An unchunked long prefill trips the tilelang DSA tile limit.

### 6.4 fp8 KV is **not** cleared for long-context accuracy

The ISL ladder in §4 measures speed at long context, not correctness. Before trusting `fp8_e4m3` on long prompts, run the same server twice differing only in `--kv-cache-dtype`, replay a few hundred of **your own** long requests at temperature 0 through both, and diff. A short-prompt eval cannot substitute.

## 7. Reproducing

Every number here comes from `bench_serving`'s own JSON, not from a log transcription. [`gen_glm52_mi355x_rows.py`](gen_glm52_mi355x_rows.py) turns those records into the `models.js` rows, the same way [`gen_cookbook_rows.py`](gen_cookbook_rows.py) does for Kimi-K3.

```bash
python3 gen_glm52_mi355x_rows.py --results /path/to/results
```

## 8. Teardown

```bash
pkill -f 'sglang.launch_server.*GLM-5.2-FP8'
rocm-smi --showmeminfo vram | grep "Total Used"   # confirm the pool is released, not just the port
```

Weights plus KV pool are allocated at startup and held for the process lifetime, so VRAM reads ~87% whether or not traffic is flowing. An idle-looking `rocm-smi --showuse` next to a nearly full `--showmeminfo` is the normal resting state, not a leak — the only way the pool comes back is exiting the server.
