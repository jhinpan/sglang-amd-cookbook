#!/usr/bin/env python3
"""Which tuned GEMM tables does this model actually consult, and how far does
padded_M drift from the real M?

Section 12 of glm53_flash_playbook.md is the write-up; this is the tool. It
answers the question an op-level speedup claim cannot: does the model read the
table that changed at all, and at which shapes.

Usage:

    # launch the server with the lookup logger on
    AITER_LOG_TUNED_CONFIG=1 python3 -m sglang.launch_server ... > server.log
    # drive a representative load, then
    python3 coverage_report.py server.log

AITER's lookup is lru_cached, so it logs once per distinct shape key: this is a
coverage census, not a call census. For time-weighting, join the reported
kernelName against a torch-profiler capture.

Caveat: AITER_LOG_TUNED_CONFIG only instruments the a16w16 (BF16) path. The
block-scale FP8 and fused-MoE tables have their own tables and their own logs;
absence of a table here is not proof it went unconsulted -- check which merged
CSVs the process materialised under /tmp/aiter_configs/ as well.
"""
import re, sys, collections
from pathlib import Path

HIT = re.compile(
    r"shape is M:(?P<M>\d+), N:(?P<N>\d+), K:(?P<K>\d+).*?"
    r"found padded_M: (?P<pM>\d+).*?is tuned on cu_num = (?P<cu>\d+) in "
    r"(?P<file>\S+?), libtype is (?P<lib>\w+)")
MISS = re.compile(
    r"shape is M:(?P<M>\d+), N:(?P<N>\d+), K:(?P<K>\d+).*?"
    r"not found tuned config in (?P<file>\S+?),.*?using (?P<lib>\w+) solution")

hits, misses = [], []
for line in Path(sys.argv[1]).read_text(errors="replace").splitlines():
    m = HIT.search(line)
    if m:
        hits.append(m.groupdict()); continue
    m = MISS.search(line)
    if m:
        misses.append(m.groupdict())

def base(f): return f.rsplit("/", 1)[-1]

print(f"{len(hits)} distinct shapes hit, {len(misses)} distinct shapes missed\n")
print("=== distinct shapes per table ===")
tbl = collections.Counter(base(h["file"]) for h in hits)
tbl_m = collections.Counter(base(h["file"]) for h in misses)
for f in sorted(set(tbl) | set(tbl_m)):
    print(f"  {f:<48} hit {tbl.get(f,0):>4}  miss {tbl_m.get(f,0):>5}")

print("\n=== on a hit, how far padded_M is inflated over the real M ===")
buckets = collections.Counter()
worst = []
for h in hits:
    M, pM = int(h["M"]), int(h["pM"])
    r = pM / M
    worst.append((r, M, pM, int(h["N"]), int(h["K"]), h["lib"]))
    buckets["1.00 (exact)" if r == 1 else
            "<=1.25" if r <= 1.25 else
            "<=1.5" if r <= 1.5 else
            "<=2.0" if r <= 2.0 else ">2.0"] += 1
for k in ("1.00 (exact)", "<=1.25", "<=1.5", "<=2.0", ">2.0"):
    if buckets.get(k):
        print(f"  {k:<13} {buckets[k]:>4} shapes ({buckets[k]/len(hits):>5.1%})")
worst.sort(reverse=True)
print("\n  worst 8:")
for r, M, pM, N, K, lib in worst[:8]:
    print(f"    M={M:<6} -> padded {pM:<6} ({r:.2f}x)  N={N:<6} K={K:<6} {lib}")

print("\n=== missed shapes by (N,K) ===")
for (n, k, f), c in collections.Counter(
        (h["N"], h["K"], base(h["file"])) for h in misses).most_common(10):
    print(f"  N={n:<6} K={k:<6} {c:>5} distinct M   {f}")
