# GLM-5.3 on MI355X (gfx950), SGLang 0.5.18 — same weights shape, one new failure

Single-node **TP=8** deployment of `zai-org/GLM-5.3` on **8× AMD Instinct MI355X** with SGLang and the **DSA tilelang** backend.

> **This is the full GLM-5.3, not [`glm53_flash_playbook.md`](glm53_flash_playbook.md).** Those are different weights and a different architecture — `glm5_next` at 328 GB against `glm_moe_dsa` at 756 GB — and nothing below transfers between them.

GLM-5.3 is a post-training release on GLM-5.2's base. At the pinned revisions below, the two repositories have the same model architecture, quantization layout, shard count, and total safetensors byte count:

| | `zai-org/GLM-5.2-FP8` | `zai-org/GLM-5.3` |
|---|---|---|
| `model_type` / architecture | `glm_moe_dsa` | `glm_moe_dsa` |
| `quantization_config` | `fp8` / `e4m3`, block `[128,128]` | `fp8` / `e4m3`, block `[128,128]` |
| `max_position_embeddings` | 1,048,576 | 1,048,576 |
| revision | `ba978f7d347eaf65d22f1a86833408afdb953541` | `935644c05e76fc198714f4cca449fd8b970ff6d7` |
| safetensors shards | 141 | 141 |
| safetensors bytes | 755,632,050,320 | 755,632,050,320 |

There is **no `zai-org/GLM-5.3-FP8`** — the published repository is already fp8, and asking for the `-FP8` name answers **401**, which reads as a permissions problem and is not one.

So the [`glm52_fp8_mi355x_playbook.md`](glm52_fp8_mi355x_playbook.md) recipes transfer. On the affected AITER/Triton stack verified below, a long cold prefill aborts every rank, including with SGLang's default flags; GLM-5.2-FP8 has the same model-side shape conditions and is exposed on that stack too. This failure is implementation-version-specific, not a property of every `glm_moe_dsa` deployment. §1 has the cause, exact tested scope, boundary arithmetic for each `--chunked-prefill-size`, and the upstream fix.

## 0. Environment (verified)

| Item | Value |
|------|-------|
| GPUs | 8× MI355X (gfx950), 288 GiB each, single node |
| Image | `rocm/sgl-dev:v0.5.18-rocm724-mi35x-20260827` — stock, pulled and run unmodified |
| SGLang | `0.5.18.dev20260827+g20a491d1d3` — no fork, no patch |
| ROCm | 7.2.4 (image); host 7.1.1 / amdgpu 6.16.6 |
| §1 cross-checks | also `…-rocm724-…-20260828` and `…-rocm720-mi35x-20260827`. The last carries ROCm 7.2.0 and torch 2.9.1 against 7.2.4 and torch 2.11.0, and the same Triton 3.7.0 — §1's abort is identical on all three |
| AITER | `c16d44b93a528b2a4bfd6d8d3409116d465872a9`, enabled with `SGLANG_USE_AITER=1` |
| Triton | `3.7.0+amd.rocm7.2.0.git89002410` in the independent boundary and serving revalidation |
| Weights | `zai-org/GLM-5.3` — 703.8 GiB, 141 shards, downloaded with `huggingface_hub` 1.28 at ~385 MB/s |
| Cold start | **~6 min** to `/health` on the `high-throughput` recipe |
| Parsers | `--reasoning-parser glm45 --tool-call-parser glm47`, the same pair GLM-5.2 uses — confirmed against `/get_server_info`, not assumed |

Six minutes to `/health` is worth noting against GLM-5.2's ~19 min on 0.5.17 in the playbook above. Same shard count, same bytes, same filesystem.

## 1. The finding: a cold bulk prefill aborts the affected AITER/Triton stack

Deployed on the `high-throughput` recipe — fp8 KV, `--chunked-prefill-size 32768`, `--mem-fraction-static 0.92` — this pool served sustained real agentic traffic and a full 1→16 concurrency sweep without a fault. Then a single chat completion with a long prompt that was **not already in the prefix cache** took every TP rank down:

```
/__w/triton/triton/llvm-project/llvm/include/llvm/ADT/Sequence.h:275:
llvm::iota_range<unsigned int>::iota_range(T, T, bool) [T = unsigned int]:
Assertion `Begin <= End && "Begin must be less or equal to End."' failed.
Fatal Python error: Aborted
  File ".../sglang/srt/utils/watchdog.py", line 147 in _watchdog_once
```

followed by sglang's watchdog calling `kill_process_tree`. The container exits 0 and costs a full weight load to come back. Reproduced twice with the identical assertion. Depending on when the worker dies, the client sees `HTTP 500` or a connection closed without a response.

It is an **assertion on an inverted computed range**, not an out-of-memory: `Begin > End` in a `iota_range` inside a compiled kernel. Nothing about the failure is gradual and nothing about it is a resource limit.

### Why a well-exercised pool never finds it

The traffic that had been running on this pool is **prefix replay, not prompting**. Over 6,426 recorded served calls the p50 turn carries **76,549 prompt tokens of which 504 are new** — a long agentic turn is a long cache *hit*, and the cold-prefill path it never touches is where this lives. In the recorded incident run, the pool answered `/health`, served a concurrency sweep at 66.97 tok/s, and completed 26 of 27 real agent calls before the first caller ever sent a long prompt in one piece.

If you serve agents, your monitoring will not find this. If you serve documents, it is your first request.

### It is not the flags, and it is not this recipe

The serving command SGLang publishes for these weights differs from `high-throughput` in exactly three places, all on the prefill path, and the leading suspect was `--kv-cache-dtype`:

| flag | published | `high-throughput` |
|---|---|---|
| `--chunked-prefill-size` | 131072 | 32768 |
| `--mem-fraction-static` | 0.80 | 0.92 |
| `--kv-cache-dtype` | *(absent — bf16)* | `fp8_e4m3` |

**The isolating run answered no on all three.** The published command, same image, same weights, same node, aborts at the same length on the same assertion. So does the next image, `v0.5.18-rocm724-mi35x-20260828`. So do both values of `--dsa-prefill-backend` — `aiter` and `tilelang` alike — which is the clue that mattered, because that flag selects the *sparse attention* kernel while the abort is upstream of it.

The scope is nevertheless version-specific. On the same gfx950 node, the direct 23,171² reproducer asserts with AITER `c16d44b9` plus Triton 3.7, but returns with the older AITER `d9e5ef7c` plus Triton 3.7 and with AITER `c16d44b9` plus Triton 3.6. The `BLOCK_M = 2` path used by the failing shape arrived in AITER commit `3679a256`. The boundary and mitigations below therefore describe the affected AITER/Triton combination, not every DSA pool on gfx950.

### What it actually is

The DSA indexer builds a `[num_q x num_k]` **float32** logits tensor and hands it to AITER's `fp8_mqa_logits`, which picks its store instruction from that tensor's size:

```python
# aiter/ops/triton/attention/fp8_mqa_logits.py
BUFFER_LIMIT_BYTES = 2 * 1024 * 1024 * 1024
use_buffer_store = logits.numel() * logits.element_size() < BUFFER_LIMIT_BYTES
```

`buffer_store` addresses its tensor through a 32-bit byte offset, so above 2 GiB the gfx950 Gluon kernel takes a `gl.store` fallback — and **that fallback does not compile** for the shape the indexer asks for. Because it fails inside the Triton compiler rather than at runtime, it aborts the process instead of raising.

Three conditions have to hold together. Each was pinned by a one-unit boundary on this node, calling AITER directly with no model and no server:

| | condition | measured |
|---|---|---|
| 1 | `num_q * num_k * 4 >= 2**31` selects the fallback | 23,170² returns; **23,171²** asserts |
| 2 | `index_n_heads <= 32` selects AITER's `BLOCK_M = 2` | at `num_heads = 64` the same over-2-GiB shape returns |
| 3 | `num_q > 4096`, the other half of that choice | 4,096 × 200,000 returns; **4,097** × 200,000 asserts |

Condition 2 is why this is not unique to GLM-5.3: **`zai-org/GLM-5.2-FP8` declares the same `index_n_heads: 32`, `index_head_dim: 128`, `index_topk: 2048`.** It is exposed to the same wall when served with the affected AITER/Triton stack.

### Where the wall is, for any recipe

`num_q` is the query rows in one prefill chunk and `num_k` the prefix behind them, so a cold prompt of `L` tokens with `--chunked-prefill-size C` puts `min(L, C) * L * 4` bytes in that tensor. The wall follows:

| `--chunked-prefill-size` | longest single-request cold prefill that still answers |
|---|---|
| 2048 | *no abort* — `num_q` never exceeds 2048, so condition 3 fails |
| 4096 | *no abort* — `num_q` never exceeds 4096, so condition 3 fails |
| 8192 | 65,535 |
| **16384 — SGLang's own default on this GPU tier** | **32,767** |
| 32768 (`high-throughput`) | 23,170 |
| 131072 (published) | 23,170 |

Two rows are the ones to read. The default is 16384, so **a deployment using the affected stack aborts on a 32,768-token cold prompt with the default chunk size** — this is not a consequence of the tuning in this playbook. And once `C` is at or above 23,171 the prompt fits one chunk, the tensor is square, and the bound is `sqrt(2**31 / 4)` regardless of how much larger `C` is.

Verified points: 16,384 × 32,767 returns and 16,384 × 32,768 asserts; 2,048 × 262,143 returns and 2,048 × 262,144 takes the fallback and *returns*, because `num_q` is under 4096 there.

### The fix, and what to do without it

SGLang already chunks this tensor — `_should_chunk_mqa_logits` in `sglang/srt/layers/attention/dsa/dsa_indexer.py` exists for exactly that — but it bounds it only against free memory, which on a 288 GiB card measured **4,426,668,441 bytes, 2.06× what the kernel can address**. So the memory budget never binds first and the unchunked call is made. The upstream fix folds the addressing limit into that same budget: [sgl-project/sglang#36960](https://github.com/sgl-project/sglang/pull/36960).

With it applied on this node and nothing else changed, the same prompt that had aborted the pool answered in 2.2 s, and cold prefills of 24,471 / 200,204 / 500,855 / **1,001,869** tokens all answered — the last in 181 s at 5,536 tok/s. An independent 8× MI355X revalidation on ROCm 7.2.0 reproduced the 23,170/23,171 failure boundary and then served cold prompts of 23,171, 32,768, and 1,001,869 tokens after the fix; its 1,001,869-token request took 234.9 s, so the timing is stack-specific.

Until it is in your image:

- **Do not advertise a context window you have not sent a cold prompt to.** `max_req_input_len` reads 1,048,570 on this pool and the server accepts the request; the abort is downstream of admission, and a front door limit cannot tell a cold prompt from a cached one.
- For a single request, **`--chunked-prefill-size 4096` or `2048` avoids this abort** by keeping `num_q` under condition 3; 8192 moves the wall per the table. Smaller chunks cost prefill throughput, and none is a deployment-wide guarantee: the query rows in one indexer call come from the whole prefill batch, not from one request.
- The assertion string is a stable signature to grep a log for: ``Assertion `Begin <= End``.

## 2. Launch

The `high-throughput` recipe, verbatim from the GLM-5.2 playbook with the model path and served name changed. **Read §1 before using it for long prompts.**

```bash
docker run -d --name glm53-serve-ht \
  --device=/dev/kfd --device=/dev/dri --ipc=host --shm-size=64g \
  --security-opt seccomp=unconfined --cap-add=SYS_PTRACE --network=host \
  --group-add "$(getent group video | cut -d: -f3)" \
  --group-add "$(getent group render | cut -d: -f3)" \
  -v /data/GLM-5.3:/models/GLM-5.3:ro \
  -e SGLANG_USE_AITER=1 -e PYTORCH_HIP_ALLOC_CONF=expandable_segments:True \
  rocm/sgl-dev:v0.5.18-rocm724-mi35x-20260827 \
  python3 -m sglang.launch_server \
    --model-path /models/GLM-5.3 \
    --served-model-name glm-5.3 \
    --trust-remote-code \
    --tp 8 \
    --dsa-prefill-backend tilelang \
    --dsa-decode-backend tilelang \
    --kv-cache-dtype fp8_e4m3 \
    --reasoning-parser glm45 \
    --tool-call-parser glm47 \
    --watchdog-timeout 1200 \
    --host 0.0.0.0 --port 30000 \
    --chunked-prefill-size 32768 \
    --mem-fraction-static 0.92 \
    --cuda-graph-max-bs 64 \
    --max-running-requests 64 \
    --schedule-policy lpm \
    --num-continuous-decode-steps 2
```

Two notes carried from the GLM-5.2 playbook because they cost time to rediscover. The `--group-add` values must be **numeric**: passing `video` by name resolves against the container's `/etc/group` and grants nothing, `device_count()` still answers 8, and only a real HIP context fails. And on this fleet's four nodes the render gid is **110 on three of them and 109 on the fourth** — read it, do not copy it.

`/get_server_info` on the running pool reports, and these are worth checking rather than assuming:

```
max_total_num_tokens  3735744        max_req_input_len  1048570
tp_size 8             kv_cache_dtype fp8_e4m3           page_size 64
reasoning_parser glm45                tool_call_parser glm47
```

`max_total_num_tokens` 3,735,744 is within 0.5% of GLM-5.2-FP8's 3,717,888 on the same recipe — as it should be, for weights of the same shape and size. Treat the exact allocator result as run-specific: the independent ROCm 7.2.0 revalidation reported 3,735,680.

## 3. Sizing

§3 of the GLM-5.2 playbook applies unchanged, and its arithmetic is the one number to carry away:

```
capacity = floor(KV_pool_tokens / peak_context_tokens)
```

With `max_total_num_tokens` 3,735,744 and this fleet's measured p50 agentic prompt of 76,549 tokens, capacity is **48 concurrent conversations**, and `--max-running-requests 64` is the looser of the two bounds. That ordering is the GLM-5.2 finding and it holds here for the same reason.

A corollary worth stating for GLM-5.3 specifically, because its `max_position_embeddings` invites it: **a 1M-token conversation consumes about 26.8% of this KV pool.** Three full 1M-token conversations fit and leave 735,744 tokens; a fourth would exceed the pool by 264,256 tokens. `--max-running-requests 64` and a million-token context are not simultaneously satisfiable, and the flag will not be what tells you.

## 4. Throughput — indicative only, and not to the standard of this repository's tables

**These are not `sglang.bench_serving` numbers and they are not median-of-3.** They were taken through a serving front door on this fleet with a fixed 256-output-token prompt, single run per point, and they are published here as an order-of-magnitude check that GLM-5.3 costs what GLM-5.2 costs — not as datasheet rows. They are deliberately **not** added to `models.js`.

| concurrency | aggregate tok/s | per-stream tok/s |
|---|---|---|
| 1 | 64.6 | 64.6 |
| 2 | 119.7 | 59.9 |
| 4 | 210.9 | 52.8 |
| 8 | 400.5 | 50.1 |

Against the same instrument on GLM-5.2-FP8 (64.9 / 120.4 / 226.7 / 408.6 aggregate), three of the four GLM-5.3 points are within ~2%; at concurrency 4 it is 6.97% lower (210.9 versus 226.7). These single-run figures still support the same order-of-magnitude comparison, but are not precise enough to motivate recipe tuning.

A 16-wide point was taken and is **withheld** — a real workload was calling the same pool at the time and the number measures the contention, not the pool. A proper `bench_serving` ladder on an idle pool, three repeats, at the shapes §4 of the GLM-5.2 playbook uses, is what belongs in the tables, and it is not what this is.

## 5. Open

§1's two original open items are closed: the abort is isolated to AITER's
over-2-GiB store fallback, and the boundary is a formula rather than a ladder
result. What is still open:

- **A verified `bench_serving` table** at the GLM-5.2 shapes, so GLM-5.3 can join the datasheet properly. §4 is one run per point through a front door and is not it.
- **Throughput with the fix on a long-context recipe.** The numbers in §1 are single cold prefills, not a sweep, and the KV budget of the published command (bf16 KV, `--mem-fraction-static 0.80`) is a fraction of `high-throughput`'s 3,735,744 — a 1M-token conversation may be most of it. `max_total_num_tokens` read 1,538,560 there.
- **The AITER side.** The `gl.store` fallback not compiling for `BLOCK_M = 2` is AITER's own bug and is not fixed by the patch in §1. Filed as [ROCm/aiter#5114](https://github.com/ROCm/aiter/issues/5114), anchored to current `main` rather than to the pinned image: the image's AITER checkout is 11 days behind HEAD, but both files that matter are byte-identical to `main` (md5 `ca0b822a93ccdfc25fabfa7838cccf82` and `df0484d859ded67fbdfa5bd57dea4cc4`) and no commit has touched either since 2026-08-18. Every boundary in §1 was re-run on `…-rocm724-mi35x-20260829`.

  **A second item this section used to list is withdrawn, and the retraction is kept rather than deleted.** It read that `use_buffer_store` tests the *view's* `numel()` while the kernel addresses rows at the 256-aligned stride, so a band under 2 GiB would be gated on a smaller number than the one addressed. The first half is a code fact. The consequence is not: shapes inside that band return bit-identical results — `num_q` 23,301 vs 23,302 at `num_k` 23,000, whose addressed extent straddles 2 GiB, agree exactly. The one case that did differ was an unrelated discrepancy at `num_q >= 2**19`, which reproduces with the addressed extent at 1 GiB as well as at 2 GiB and therefore is not this; it is also out of reach of a SGLang prefill batch. Nothing here is claimed about the padded stride, and the SGLang fix's `2**31 - 1` needs no safety margin because of it.
