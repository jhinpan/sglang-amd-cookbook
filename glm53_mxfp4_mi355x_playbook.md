# GLM-5.3-MXFP4 on MI355X (gfx950), SGLang 0.5.18 — 4-bit that wins on every shape, and the one thing it costs

Single-node **TP=8** deployment of `OneNexus/GLM-5.3-MXFP4` on **8× AMD Instinct MI355X** with SGLang, the **DSA tilelang** backend, fp8 KV and EAGLE.

> **This is a third-party requantisation of the full GLM-5.3.** It is not [`glm53_fp8_mi355x_playbook.md`](glm53_fp8_mi355x_playbook.md) — that page serves `zai-org/GLM-5.3`, which is *already* fp8 — and it is not [`glm53_flash_playbook.md`](glm53_flash_playbook.md), which is different weights and a different architecture. §1 and §2 transfer from the fp8 page only where this page says so; **§2.2's cap applies unchanged, and §7 does not exist on the fp8 page.**

Against the fp8 release at matched argv, on the same node, the same image and the same instrument:

| | `zai-org/GLM-5.3` (fp8) | `OneNexus/GLM-5.3-MXFP4` |
|---|---|---|
| `quantization_config` | `fp8` / `e4m3`, block `[128,128]` | `quark`, fp4 `per_group` g32, `e8m0` scales |
| safetensors shards | 141 | **282** |
| safetensors bytes | 755,617,140,416 | **438,001,945,864** (−42.04%) |
| weight bytes per GPU | 88.742 GB | **52.309 GB** (−41.05%) |
| weight load / ready | 70.7 s / 309 s | **39.5 s / 222 s** |
| `max_total_num_tokens` | 1,537,536 | **1,960,192** (+27.5%) |
| out tok/s @ 1 / 8 / 32 / 64 | 73.8 / 375.7 / 811.4 / 1047.5 | **83.3 / 467.3 / 958.6 / 1146.9** |
| GSM8K 1319 @ T=0 | 97.27% | **97.50%** (McNemar z=0.55, n.s.) |

**There is no shape in the sweep where fp8 wins.** The disk saving and the memory saving agreeing to within a percentage point is the check that nothing is being silently rematerialised at higher precision.

Read §2.2 before serving anything longer than 23,170 tokens, and read §7 before putting this config in front of real agents.

## 0. Environment (verified)

| Item | Value |
|------|-------|
| GPUs | 8× MI355X (gfx950), single node, full XGMI mesh; 309.2 GB reported per card |
| Image | `rocm/sgl-dev:v0.5.18-rocm724-mi35x-20260829` — stock; the only edit is §2.2's cap, applied at container start |
| | manifest digest `sha256:c0d148e8cd65870ed62fd20b04512ecd368505fa894c76f4fb97fcc2aff6b635`, image id `sha256:95e86f0d9ae3693bf440e0e8df14225040fa5001097703d4d867891a53360a5d` — **different things, same image**; both are quoted in the wild and they do not match each other |
| SGLang | `0.5.18.dev20260829+g4d53767b09`, commit `cdbfe90b4a6c728e03e6520862d792501b3a97bb` |
| AITER | `c16d44b93a528b2a4bfd6d8d3409116d465872a9`, enabled with `SGLANG_USE_AITER=1` |
| Triton / torch / ROCm | `3.7.0+amd.rocm7.2.0.git89002410` / `2.11.0+rocm7.2` / 7.2.4 in image, driver 6.16.6 |
| Weights | `OneNexus/GLM-5.3-MXFP4`, revision `104690ed94d48341ec9de43b1bc12d30f7eaa86e` — 282 shards, 438,001,945,864 B |
| Quark checkpoint format | `0.12.post1+1b229f7` |
| Ready | **268 s** to `/health` on the §2 recipe (warm page cache; not a cold-boot number) |
| Parsers | `--reasoning-parser glm45 --tool-call-parser glm47`, confirmed against `/get_server_info`, not assumed |

Pin the revision. An unpinned `snapshot_download` of a 408 GB checkpoint is not a reproducible input, and unauthenticated Hub downloads are rate-limited with a `429` that kills `snapshot_download` mid-flight — run it under `--restart unless-stopped` and let it resume.

## 1. What "MXFP4" actually quantises — and what it does not

Read off the safetensors headers of all 282 shards. A tensor is quantised **iff** it carries a `weight_scale*` companion; that one-line test is more reliable than either model card's prose, and it contradicts both.

| module class | fp8 | MXFP4 | |
|---|---|---|---|
| routed experts | 684.17 GiB | **376.59 GiB** | the 92.3% that matters |
| MLA attention | 12.14 GiB | **24.28 GiB** | **BF16 in MXFP4, fp8 in the baseline — it goes UP** |
| DSA indexer | 0.20 GiB | **0.38 GiB** | also BF16 |
| dense MLP (layers 0–2) | 0.63 GiB | **1.27 GiB** | also BF16 |
| shared expert | 2.67 GiB | 1.47 GiB | MXFP4 in 75 of 76 MoE layers |
| **total** | **703.72 GiB** | **407.91 GiB** | |

So the name is misleading in a useful direction: the experts save 307.6 GiB, while **attention, indexer and dense MLPs give 12.9 GiB back by staying BF16**. Net saving 295.8 GiB. §5 argues that conservatism is why accuracy held. §7 is the bill for it.

Three things this table settles that reading prose could not:

- **The DSA indexer exists in only 22 of 79 layer indices** (0, 1, 2, then every 4th). That is the architecture — `indexer_types` plus `index_topk_freq: 4` — and the fp8 checkpoint has the **identical 22 layers**. It is not something quantisation changed.
- The MXFP4 card claims dense **and shared** MLP projections stay BF16. **The shared experts do not** — they carry `weight_scale` in 225 of 228 cases. The cause is the exclude pattern: `fnmatch('...mlp.shared_experts.gate_proj', '*mlp.gate_proj')` is `False`. The checkpoint is fine; only the prose is wrong.
- **The MTP layer is free unless you use it.** Layer 78 is BF16 and 18.54 GiB against fp8's 9.34 GiB, but SGLang does not load it without speculative decoding. Predicted weight/GPU excluding layer 78 is 52.260 GB and the server reports **52.309**. With EAGLE on it costs 2.49 GB/GPU against fp8's 1.25.

No `--quantization` flag is needed: `quant_method: quark` is auto-detected and dispatches to `QuarkFusedMoEMethod`. The `GlmMoeDsaForCausalLM` weight loader already handles this checkpoint's BF16 `kv_b_proj` — it quantises it to per-tensor `e4m3fn` to match `forward_mla_rocm`'s dtype gate — so the DeepSeek-only gfx950 Quark-MXFP4 attention path below it is never needed. [sgl-project/sglang#28734](https://github.com/sgl-project/sglang/pull/28734) (MXFP4 weights + PTPC-FP8 attention) is **not** applicable here: all 395 attention projections are BF16, and `_is_block_scale_fp8()` returns False on its first line for a BF16 weight.

## 2. Launch

### 2.1 The container

```bash
VIDEO_GID=$(getent group video  | cut -d: -f3)
RENDER_GID=$(getent group render | cut -d: -f3)

docker run -d --name glm53-serve-mxfp4 \
  --network host --ipc host --shm-size 64g \
  --device /dev/kfd --device /dev/dri \
  --group-add "$VIDEO_GID" --group-add "$RENDER_GID" \
  --cap-add CAP_SYS_PTRACE \
  --security-opt seccomp=unconfined --security-opt label=disable \
  -v /data/GLM-5.3-MXFP4:/model:ro \
  -v /var/tmp/mxfp4-eval:/work \
  -e HIP_VISIBLE_DEVICES=0,1,2,3,4,5,6,7 \
  -e SGLANG_USE_AITER=1 \
  -e PYTORCH_HIP_ALLOC_CONF=expandable_segments:True \
  -e SGLANG_OPT_USE_TOPK_V2=false \
  -e MQA_CAP=patch \
  --entrypoint /work/serve-inner.sh \
  rocm/sgl-dev:v0.5.18-rocm724-mi35x-20260829 \
  --model-path /model --served-model-name glm-5.3 --trust-remote-code \
  --tp 8 --kv-cache-dtype fp8_e4m3 \
  --speculative-algorithm EAGLE --speculative-num-steps 3 \
  --speculative-eagle-topk 1 --speculative-num-draft-tokens 4 \
  --page-size 64 \
  --dsa-prefill-backend tilelang --dsa-decode-backend tilelang \
  --reasoning-parser glm45 --tool-call-parser glm47 \
  --chat-template /model/chat_template.jinja --enable-cache-report \
  --chunked-prefill-size 131072 --mem-fraction-static 0.80 \
  --cuda-graph-max-bs 64 --max-running-requests 64 \
  --watchdog-timeout 1200 --host 0.0.0.0 --port 30000
```

`--group-add` must be **numeric**. A group passed as `video` resolves against the *container's* `/etc/group`, silently grants nothing, and `torch.cuda.device_count()` still answers 8 — only a real HIP context fails. The render gid is not uniform across a fleet; read it per node rather than copying a number out of this file.

`--entrypoint <script>` with `exec python3 -m sglang.launch_server "$@"` at the end of it is not decoration. The alternative — `sleep infinity` plus `docker exec` — makes `docker ps` report `Up` forever, `docker logs` empty, and a container restart re-run `sleep infinity` instead of the server. That shape accumulated 4,108 zombie `[sglang::detoken]` processes on a sibling pool.

`--cap-add CAP_SYS_PTRACE` and `seccomp=unconfined` exist so `py-spy dump --native` works from outside the container. When a rank dies here, that is the tool that finds it; a plain dump costs 18 ms and `--native` 470 ms, so you can sample at 10 Hz through a 7-second window.

### 2.2 The MQA-logits 2 GiB cap — mandatory

`MQA_CAP=patch` above is load-bearing. **Without it this pool dies on any cold prompt over 23,170 tokens**, and it takes all 8 ranks with it.

The DSA indexer materialises a `[num_q × num_k]` **float32** MQA-logits tensor. On ROCm that tensor is written by AITER's `fp8_mqa_logits`, which selects an AMD `buffer_store` only while the tensor fits a 32-bit byte offset, and above 2 GiB takes a `gl.store` fallback **that does not compile**:

```python
# aiter/ops/triton/attention/fp8_mqa_logits.py:225-227
BUFFER_LIMIT_BYTES = 2 * 1024 * 1024 * 1024
use_buffer_store = logits.numel() * logits.element_size() < BUFFER_LIMIT_BYTES
```

The failure is an `abort()`, not an exception — uncatchable, every rank gone, and a 408 GB reload to come back. Measured on this checkpoint: **23,168 tokens → 200 in 2.1 s; 23,175 tokens → all 8 ranks abort, HTTP 500 in 5.9 s**, on `fp8_mqa_logits.py:228` ← `dsa_indexer.py:1117`. The wall is `sqrt(2**31 / 4) = 23,170.48`.

`_should_chunk_mqa_logits` already exists to bound this tensor but bounds it only by **free memory** — 4,426,668,441 bytes on this card, 2.06× what the kernel can address — so it never binds first. The entrypoint script therefore caps the budget by the addressing limit and **refuses to launch if the constant is absent after patching**:

```bash
if [[ "${MQA_CAP:-none}" == "patch" ]]; then
    # cap the budget by AITER's addressing limit, not by free memory
    #   _MQA_LOGITS_MAX_BYTES_ROCM = 2**31 - 1
    # inserted after the _MQA_LOGITS_TOTAL_MEM_FRACTION anchor, and applied to
    # the budget the indexer computes per forward.
    ...
    grep -q "_MQA_LOGITS_MAX_BYTES_ROCM" "$SRT/layers/attention/dsa/dsa_indexer.py" || {
        echo "[serve] REFUSING: patch reported success but the constant is absent." >&2; exit 1; }
fi
```

**EAGLE, HiCache, fp8 KV and TP4 all leave the wall exactly where it is** — re-confirmed on a TP4/EP4 + EAGLE + HiCache + fp8 KV recipe run verbatim: same two rungs, 4 ranks dead. That is what the mechanism predicts, because the tensor is fp32 `[num_q × num_k]` and `index_n_heads` is not TP-sharded.

Three ways to bound it, and they are not equivalent:

| method | cost at a 1M cold prefill |
|---|---|
| the source patch above | **245.7 s** — no penalty |
| `SGLANG_DSA_MQA_LOGITS_FREE_MEM_FRACTION=0.034`, no source edit | **299.6 s — 22% slower.** It bounds by free memory (~1.37 GB) rather than the addressing limit (2.147 GB), so it chunks ~1.6× more often |
| `--chunked-prefill-size 4096` | no abort at any length — `num_q` never exceeds 4096 — but it is a prefill-throughput decision, not a fix |

Upstream: [sgl-project/sglang#36960](https://github.com/sgl-project/sglang/pull/36960) is the upstream-shaped form of the patch and **is merged to `main`** — but it is in neither `…-20260828` nor `…-20260829`, so on those images the patch is still required. Delete it rather than retune it once it reaches an image you use. The kernel bug underneath is [ROCm/aiter#5114](https://github.com/ROCm/aiter/issues/5114); if that lands first the fallback compiles and none of this is needed.

The wall moves with `--chunked-prefill-size`, because `num_q` is the query rows in one prefill chunk:

| `--chunked-prefill-size` | longest cold prefill that answers |
|---|---|
| 4096 | *no abort* |
| 8192 | 65,535 |
| 16384 | 32,767 |
| 32768 / 131072 | 23,170 |

## 3. Sizing

The pool at §2's argv reports `max_total_num_tokens` **3,681,216**.

```
capacity = floor(KV_pool_tokens / peak_context_tokens)
```

At a p50 agentic prompt of 76,549 tokens that is **48 concurrent conversations**, and `--max-running-requests 64` is the looser of the two bounds — which is why it is set there and not higher. A single 1M-token conversation is 27% of the pool. `--max-running-requests` and a million-token context are not simultaneously satisfiable, and the flag will not be what tells you.

**Set that flag from the pool, not from a guess.** A published recipe for this checkpoint pins `--max-running-requests 2` against a KV pool of 2.2M tokens. Holding client load at 32 concurrent and changing *only* that flag to 64 moved throughput **356 → 1,162 tok/s (+226%)** and TTFT **83.3 s → 9.7 s**, with single-stream unchanged.

**But do not size to the quotient either — leave the prefix cache room to exist.** On a long agentic run, pushing concurrency to the arithmetic limit produced 53 minutes with zero completions:

```
Prefill batch, #new-token: 105088, #cached-token: 128,
token usage: 0.99, #running-req: 19, #queue-req: 2, #pending-token: 378071
```

`token usage 0.99` with 105,088 new tokens hitting 128 cached is a **dead prefix cache**: every agent step had become a 100k-token cold prefill. Backing concurrency off restored it:

```
Prefill batch, #new-token: 1024, #cached-token: 148160,
token usage: 0.59, #running-req: 12, #queue-req: 0, #pending-token: 0
```

Cache hit went **~0.1% → 99.3%** and the queue emptied. **Size concurrency at 50–60% KV utilisation.** Two corollaries: judge pool health from its live log, not from an average over completed requests — that average is survivorship-biased, because the requests that finished did so *before* saturation; and on a benchmark with a per-task wall clock, this failure mode manufactures fake model failures rather than merely being slow.

## 4. Throughput — `sglang.bench_serving`, random ISL 8192 / OSL 1024, median of 3, spread ≤0.7%

### 4.1 Against fp8 at matched argv

Both precisions back to back, same node, same image, same argv, so nothing here is a tuning decision:

| conc | fp8 — TTFT ms / TPOT ms / out tok/s | MXFP4 — TTFT ms / TPOT ms / out tok/s | Δ out tok/s |
|---|---|---|---|
| 1 | 579.7 / 12.95 / 73.8 | 554.6 / 11.47 / **83.3** | **+12.8%** |
| 8 | 2713.1 / 18.67 / 375.7 | 2568.8 / 14.64 / **467.3** | **+24.4%** |
| 32 | 9493.1 / 30.20 / 811.4 | 9017.2 / 24.66 / **958.6** | **+18.1%** |
| 64 | 17624.4 / 44.14 / 1047.5 | 16876.0 / 39.39 / **1146.9** | **+9.5%** |

The gain peaks in the middle and narrows at 64, which is what the mechanism predicts: batch-1 decode is bandwidth-bound and 4-bit weights help directly, and by 64 the MoE is compute-bound and dequantisation starts to cost.

Cold prefill, same comparison: 24.5k in **2.5 s / 10,003 tok/s** against fp8's 2.6 s / 9,511; 1M in **245.7 s / 4,086 tok/s** against fp8's 250.8 s / 4,002.

> **Do not compare a cold-prefill table across nodes — it does not reproduce.** The same argv on the same fp8 weights gave 181.0 s at 1M on one node and 250.8 s on another, 38% apart. That gap nearly shipped as "MXFP4 regresses 39% at 1M context". **When a comparison matters, re-measure both sides on the machine you are on**, even when one side is already written down.

### 4.2 The three flags that earned their place

Each addition measured on its own before it went in — MXFP4, TP8, patched cap, same instrument:

| config | c1 out tok/s | c32 out tok/s | KV tokens | |
|---|---|---|---|---|
| matched-argv baseline, bf16 KV | 83.3 | 958.6 | 1,960,192 | |
| `--ep-size 8` | 76.7 | 920.7 | 1,947,904 | **rejected** |
| `--enable-w4a4-mxfp4-megamoe` | 83.1 | 958.3 | 1,959,168 | **rejected** |
| `--kv-cache-dtype fp8_e4m3` | 88.3 | 1150.9 | **3,803,904** | kept |
| **+ EAGLE 3/1/4, graph/running 64** | **255.6** | **1575.9** | 3,681,216 | kept |

- **fp8 KV is free money**: +20.1% at concurrency 32, the KV pool nearly doubles, and accuracy is untouched — 393/400 GSM8K both ways, 99.75% answer agreement.
- **EAGLE is the big one**: single-stream decode 88.3 → 255.6 tok/s, ~2.9×. It costs 120K KV tokens and 42 s of startup. Note the spread at concurrency 1 is **14%**, because acceptance rate varies; by 32 it is 1.5%.
- **`--ep-size 8` loses** to plain TP8 here. This ran with `moe_a2a_backend: none`; DeepEP might change it. EP is not automatically right for this model.
- **`--enable-w4a4-mxfp4-megamoe` is a no-op on ROCm.** Not "didn't help" — the flag's entire effect is setting `DG_USE_FP4_ACTS` and `DG_USE_MXF4_KIND`, both DeepGEMM (CUDA) variables. Don't spend time on it on MI355X.
- **HiCache was tried and rejected on startup, not on throughput**: 1923 s to ready against 253 s with it off and nothing else changed, nearly all of it registering 151 GB of host pool per rank (605 GB total, four processes pegged at 100% CPU — `docker exec` would not attach). The device/host trade is fair; the startup is not, for a pool that must restart fast.

Final config against the fp8 pool it replaced: **255.6 / 980.6 / 1575.9 / 1828.0** out tok/s at concurrency 1 / 8 / 32 / 64 against **73.8 / 375.7 / 811.4 / 1047.5** — 3.46× / 2.61× / 1.94× / 1.75× — with 2.40× the KV pool.

## 5. Accuracy

GSM8K, all 1,319 questions, temperature 0, `max_tokens` 3072, through the chat door. **The aggregate alone cannot settle this**: at n=1319 and p≈0.975 the standard error is ~0.43pp, wider than any difference here. The paired view is what matters.

| comparison | correct | McNemar | per-question agreement |
|---|---|---|---|
| fp8 vs MXFP4, matched argv | 1283 vs **1286** | z=0.55, n.s. | **99.54%** |
| MXFP4 vs MXFP4 + EAGLE + fp8 KV | 1286 vs 1281 | z=1.03, n.s. | 99.23% |
| fp8 pool vs the §2 config | 1283 vs 1281 | z=0.22, n.s. | 99.01% |

Neither the quantisation nor the two flags on top cost measurable accuracy. MXFP4 emits **~6% more completion tokens** (mean 250 vs 236), which matters for cost estimates and is consistent with the checkpoint's own higher truncation counts on longer-form benchmarks.

**The 1286 must not be cited as a reproduction of the model card**, even though it happens to equal the number there. Eight settings differ — TP8/EP1 vs TP4/EP4, bf16 vs fp8 KV, no speculation vs EAGLE, no HiCache, a different harness, 3072 vs 16384 max tokens, no `reasoning_effort`, and a different oracle precision. At this n, landing on any particular nearby value has ~7% probability.

An agentic downstream check on 113 tasks × 4 rollouts, paired per task, agrees that the two are indistinguishable: **68.8% vs 70.8%, difference −1.99pp, paired-bootstrap 95% CI [−7.37, +3.32]**, Wilcoxon p=0.512, McNemar 12:12 p=1.000. For scale, the same checkpoint's own spread across its four rollouts of the same benchmark is 9.5–11.9pp — **wider than the difference being tested.**

## 6. Gotchas that cost real time here

- **`--chat-template` is mandatory.** This checkpoint's `tokenizer_config.json` carries no template, and neither does upstream's. The consequence is semantic, not cosmetic: the `reasoning_effort` default is encoded *in the template*, so without it the effort semantics vanish silently. Measured at `max_tokens=4000`, `reasoning_tokens` were **2,033 / 20 / 40 / 4,003** for not-passed / `low` / `high` / `max`. Do not generalise the rule — GLM-5.3-Flash *does* ship its template in `tokenizer_config.json`. Check each checkpoint.
- **Both parser flags are load-bearing and their absence is silent.** Without `--tool-call-parser glm47` the server answers 200 and hands the tool call back as prose, which is a format error on every step of an agent run and a score of zero. Without `--reasoning-parser glm45` there is no `reasoning_content`. Verify with one request that asserts `finish_reason: tool_calls`, JSON-parseable `arguments`, and `usage.reasoning_tokens > 0` — do not assume.
- **`max_tokens: 16` returns empty content.** All 16 went to `reasoning_tokens`. Nothing is wrong; it is a reasoning model spending its budget on reasoning first. Give a real budget before concluding anything about output quality.
- **A prefix-cache hit will fake a refutation.** The first attempt at the 23,175-token probe in §2.2 returned 200 in 0.5 s and looked like the wall was not there. Both probes had drawn from the same seeded word pool, so the second prompt was the first plus eight tokens and the *extend* was tiny. Flush the cache and use a disjoint seed. The same effect is why a busy pool never finds the abort at all: over 6,426 recorded calls the p50 turn carries 76,549 prompt tokens of which 504 are new, so a long agentic turn is a long cache *hit*.
- **Resolve the boundary against the real tokenizer, on the CPU, before sending anything.** A words-per-token estimate cannot resolve a 0.05% margin. And run ladders **ascending**: one that stops at the first failure costs one reload, a descending one costs many, at ~4 minutes of weight load each.
- **A tag is not an identity.** One `rocm/sgl-dev` tag has been measured as four different images across four nodes. Pin the digest, or check inside the container. A one-day image step is not neutral either: [#36852](https://github.com/sgl-project/sglang/pull/36852) and [#36915](https://github.com/sgl-project/sglang/pull/36915) both landed 2026-08-28 and are in `…-20260829` but not `…-20260828`.
- **Verify the checkpoint before feeding it to GPUs.** A failed load costs minutes; safetensors self-validation costs seconds — the first 8 bytes of each shard are the header length, and `8 + header + max(data_offsets[1])` must equal the file size. Cross-check the index for missing shards while you are there.
- **Read `/get_server_info` rather than assuming.** `max_total_num_tokens`, `kv_cache_dtype`, `page_size` and both parsers are all there.

## 7. Open

**This configuration has an unresolved serving fault, and it is not on the fp8 page.** Under a real heterogeneous long-context agent workload at 32 concurrent sessions — not a fixed-shape sweep — this pool ran normally for about 24 minutes and then took a GPU memory access fault on two ranks:

```
Memory access fault by GPU node-8 (Agent handle: 0x...) on address 0x... Reason: Unknown.
Subprocess scheduler_4 (pid=...) crashed with exit code -6. Triggering SIGQUIT for cleanup...
```

It is **not** §2.2's abort: that one is an LLVM `iota_range` assertion, the cap was active, and the signature is different. Filed as [sgl-project/sglang#37648](https://github.com/sgl-project/sglang/issues/37648). What is known so far:

- A fixed-shape `bench_serving` sweep at concurrency 64, ISL 8192 / OSL 1024 had already **passed** on the same pool. The varied long-context workload is what exposed it, so a fixed-shape sweep is not a screen for this.
- The nearest prior report, [#23784](https://github.com/sgl-project/sglang/issues/23784), is the same signature on MI355X with EAGLE at high concurrency. It is closed as `completed` with **zero comments and no linked PR or commit** — treat it as closed-stale, not closed-fixed.
- The `[aiter] ... not found tuned config ... will use default config!` lines immediately preceding the fault are **noise, not signal**. A pool that ran 47 minutes without faulting emitted 203,644 of them, and the fallback they name is `using torch solution:0` — plain `torch.matmul`, not an AITER assembly kernel.
- A `Memory access fault` is delivered **asynchronously**. The Python traceback printed at the abort shows where the host thread was at its next synchronisation point, not the kernel that faulted, so #23784's stack frame is suggestive rather than a localisation. `AMD_SERIALIZE_KERNEL=3` is what turns it into one.

Until it is understood, run this config with a supervisor that restarts the pool, and do not assume a clean fixed-shape sweep means a clean agent deployment.

Also still open, and smaller:

- **No long-context accuracy** for either precision. GSM8K only; the 1M path is exercised for liveness, not correctness.
- **EAGLE acceptance rate has not been measured on *this* checkpoint.** A same-argv measurement on the fp8 checkpoint gave **accept len 2.93 of 4** (accept rate 0.69–0.73) over 386 sampled decode batches at concurrency 32 on real agentic context. Treat it as an order-of-magnitude expectation for MXFP4, not a measurement of it.
- **MI350X untested.** Everything here is MI355X. If a census figure of 270.6 GB/GPU for MI350X holds against MI355X's 309.2, KV pools there are ~20% smaller than every number on this page.
- **Should the MTP layer be quantised?** It is BF16 and costs 2.49 GB/GPU under the §2 config, against fp8's 1.25.

## 8. Reproducing

1. Download the pinned revision under a restart policy; verify the shards locally before loading them.
2. Start §2.1 verbatim. Confirm `MQA_CAP=patch` reported `applied`, and that the container refused nothing.
3. `GET /get_server_info` — expect `max_total_num_tokens` 3,681,216, `kv_cache_dtype` `fp8_e4m3`, `page_size` 64, both parsers present.
4. One chat request with `max_tokens` ≥ 600: expect the right answer and a populated `reasoning_content`. One tool-call request: expect `finish_reason: tool_calls`.
5. The §2.2 boundary, with a **disjoint** seed and a flushed cache: 23,168 tokens must answer, and with `MQA_CAP=none` 23,175 must kill the pool. Do this before trusting the cap, not after.
6. `sglang.bench_serving --dataset-name random --random-input 8192 --random-output 1024`, three repeats, at concurrency 1 / 8 / 32 / 64.
7. For §7, a fixed-shape sweep is not sufficient. Drive it with growing, mutually disjoint, heterogeneously-sized conversations until the scheduler log shows sustained `#running-req` in the high 20s with `#queue-req: 0` and a prefix-cache hit above 97%.
