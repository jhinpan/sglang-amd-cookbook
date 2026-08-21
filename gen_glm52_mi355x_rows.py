#!/usr/bin/env python3
"""Emit the GLM-5.2-FP8 gfx950 cookbook rows straight from the bench_serving jsonl.

Same reason as gen_cookbook_rows.py: hand-transcribing rows out of logs is how
wrong numbers get published. The artefacts are the ones the study analysed, one
JSON object per run, written by --output-file.

Layout it reads (one directory per server config, one file per point):

    <results>/<config>/<workload>-c<concurrency>.jsonl

    workload  cookbook   random ISL 8192 / OSL 1024   -- the published shape
              lc-8k      random ISL   8192 / OSL 512  -- the ISL ladder
              lc-32k     random ISL  32768 / OSL 512
              lc-128k    random ISL 131072 / OSL 512
              lc-256k    random ISL 262144 / OSL 512

    config    low-latency      NEXTN speculative decode, bf16 KV
              mtp-fp8          NEXTN + fp8_e4m3 KV          -> cell "balanced"
              high-throughput  fp8_e4m3 KV, no speculation

The container's --output-file is append-mode and survives across runs, so a file
holds a point's whole history; the LAST record is the current one. That is why
load() keeps overwriting rather than breaking on the first parse.
"""

import argparse
import json
import re
from pathlib import Path

# workload name -> (isl, osl). The published cell is a concurrency sweep at the
# reference shape plus the ISL ladder at c=1, so both live in one table.
SHAPE = {
    "cookbook": (8192, 1024),
    "lc-8k": (8192, 512),
    "lc-32k": (32768, 512),
    "lc-128k": (131072, 512),
    "lc-256k": (262144, 512),
}
CELL = re.compile(r"^(?P<wl>[a-z0-9-]+)-c(?P<c>\d+)$")


def load(cfg_dir: Path) -> dict:
    out = {}
    for f in sorted(cfg_dir.glob("*.jsonl")):
        m = CELL.match(f.stem)
        if not m or m["wl"] not in SHAPE:
            continue
        rec = None
        for line in f.read_text().splitlines():
            line = line.strip()
            if line:
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    pass
        if rec:
            isl, osl = SHAPE[m["wl"]]
            out[(isl, osl, int(m["c"]))] = rec
    return out


def row(key, rec, source):
    isl, osl, c = key
    total = rec.get("total_throughput")
    tpot = rec.get("mean_tpot_ms")
    out = {
        "isl": isl,
        "osl": osl,
        "concurrency": c,
        "ttft_ms": round(rec.get("mean_ttft_ms", 0), 0),
        "tpot_ms": round(tpot, 2) if tpot else None,
    }
    # The site treats decode_tok_s as a per-stream rate (1000/TPOT) and blanks it
    # above concurrency 1, so only emit it where it means something.
    if c == 1 and tpot:
        out["decode_tok_s"] = round(1000 / tpot, 1)
    out.update({
        "output_tok_s": round(rec.get("output_throughput", 0), 2),
        "total_tok_s": round(total, 2) if total else None,
        "tok_s_per_gpu": round(total / 8, 1) if total else None,
        "source": source,
    })
    return out


IMAGE = "rocm/sgl-dev:v0.5.17-rocm724-mi35x-20260820"
SRC = ("glm52_fp8_mi355x_playbook.md section {sec} (bench_serving, random, "
       "--random-range-ratio 1.0, --flush-cache, warmup burst discarded; "
       + IMAGE + ", sglang 0.5.17.dev20260820+g47fc97d754, aiter d9e5ef7ce)")

CELLS = [
    ("low-latency", "low-latency", "4.1"),
    ("balanced", "mtp-fp8", "4.2"),
    ("high-throughput", "high-throughput", "4.3"),
]


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--results", default="/var/tmp/qwu/test-serv-glm/results",
                   help="directory holding one subdirectory per server config")
    args = p.parse_args()
    root = Path(args.results)

    for strategy, cfg, sec in CELLS:
        recs = load(root / cfg)
        # Concurrency sweep first, then the ISL ladder -- the order the existing
        # gfx950 cell publishes, so the tables read the same way.
        keys = sorted(recs, key=lambda k: (k[1] != 1024, k[0], k[2]))
        print("// ---- gfx950 : %s  (config %s) ----" % (strategy, cfg))
        print(json.dumps([row(k, recs[k], SRC.format(sec=sec)) for k in keys], indent=2))
        print()


if __name__ == "__main__":
    main()
