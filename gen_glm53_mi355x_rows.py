#!/usr/bin/env python3
"""Generate verified GLM-5.3-Flash cookbook rows from repeated benchmark JSONL.

The final study writes one file per repeat:

    perf-c{concurrency}-r{repeat}.jsonl
    latency-r{repeat}.jsonl

Every published point is the median of three complete runs.  This script fails
closed on missing repeats, request/token-accounting errors, or more than 5%
total-throughput spread.

Server-config validation is not uniform, and the asymmetry is deliberate:
``sglang.benchmark.serving`` records carry ``server_info``, so the 15 serving
points are checked against the frozen revision, SGLang version and backend
flags.  ``bench_one_batch_server`` emits no ``server_info``, so the nine
latency records are checked on shape only -- batch size, output length and the
three-repeat set -- and rely on living in the same tagged results directory for
provenance.  Do not read "validated" as meaning the same thing for both.

Pass ``--check-models models.js`` to additionally fail unless the published
rows are structurally equal to the ones regenerated here.  ``verify.sh`` runs
that form; a bare invocation only prints.
"""

from __future__ import annotations

import argparse
import json
import re
import statistics
from collections import defaultdict
from pathlib import Path

PERF = re.compile(r"^perf-c(?P<concurrency>\d+)-r(?P<repeat>\d+)\.jsonl$")
LATENCY = re.compile(r"^latency-r(?P<repeat>\d+)\.jsonl$")
CONCURRENCIES = (1, 8, 16, 32, 64)
REPEATS = (1, 2, 3)
ISLS = (1024, 8192, 16384)
EXPECTED_REVISION = "04c4e9e95c5da8862dced7e5056455116f83a7e0"
EXPECTED_SGLANG_VERSION = "0.5.18.dev20260826+g937af8538b"
SOURCE = (
    "glm53_flash_playbook.md section 5 "
    "(median of 3 runs; run 20260827T233110Z; 8x MI355X; "
    "SGLang #36607 9d20876939 + local hybrid-FP8 metadata fix; "
    "AITER #5060 95565e33c8)"
)


def load_last(path: Path) -> dict:
    records = []
    for line in path.read_text().splitlines():
        line = line.strip()
        if line:
            records.append(json.loads(line))
    if not records:
        raise ValueError(f"{path}: no JSON records")
    return records[-1]


def median(records: list[dict], key: str) -> float:
    return statistics.median(record[key] for record in records)


def validate_server(path: Path, record: dict) -> None:
    server = record.get("server_info") or {}
    expected = {
        "revision": EXPECTED_REVISION,
        "version": EXPECTED_SGLANG_VERSION,
        "kv_cache_dtype": "fp8_e4m3",
        "moe_runner_backend": "aiter",
        "dsa_prefill_backend": "tilelang",
        "dsa_decode_backend": "tilelang",
        "linear_attn_backend": "triton",
        "disable_radix_cache": True,
    }
    for key, value in expected.items():
        if server.get(key) != value:
            raise ValueError(
                f"{path}: server_info.{key}={server.get(key)!r}, expected {value!r}"
            )


def load_perf(root: Path) -> dict[int, list[dict]]:
    grouped: dict[int, list[dict]] = defaultdict(list)
    seen = set()
    for path in sorted(root.glob("perf-c*-r*.jsonl")):
        match = PERF.match(path.name)
        if not match:
            continue
        concurrency = int(match["concurrency"])
        repeat = int(match["repeat"])
        record = load_last(path)
        validate_server(path, record)
        prompts = 4 * concurrency
        expected = (prompts, prompts * 8192, prompts * 1024)
        actual = (
            record.get("completed"),
            record.get("total_input_tokens"),
            record.get("total_output_tokens"),
        )
        if actual != expected:
            raise ValueError(f"{path}: accounting {actual}, expected {expected}")
        grouped[concurrency].append(record)
        seen.add((concurrency, repeat))

    expected_seen = {(c, r) for c in CONCURRENCIES for r in REPEATS}
    if seen != expected_seen:
        raise ValueError(
            f"performance run set mismatch: missing={sorted(expected_seen - seen)}, "
            f"extra={sorted(seen - expected_seen)}"
        )
    return grouped


def load_latency(root: Path) -> dict[int, list[dict]]:
    # No validate_server() here: bench_one_batch_server writes no server_info.
    # These rows are shape-validated only -- see the module docstring.
    grouped: dict[int, list[dict]] = defaultdict(list)
    seen = set()
    for path in sorted(root.glob("latency-r*.jsonl")):
        match = LATENCY.match(path.name)
        if not match:
            continue
        repeat = int(match["repeat"])
        records = [
            json.loads(line)
            for line in path.read_text().splitlines()
            if line.strip()
        ]
        for record in records:
            isl = record["input_len"]
            key = (isl, repeat)
            if record.get("batch_size") != 1 or record.get("output_len") != 1024:
                raise ValueError(f"{path}: unexpected latency shape {record}")
            if key in seen:
                raise ValueError(
                    f"{path}: duplicate latency record for input_len={isl}, "
                    f"repeat={repeat}"
                )
            grouped[isl].append(record)
            seen.add(key)

    expected_seen = {(isl, r) for isl in ISLS for r in REPEATS}
    if seen != expected_seen:
        raise ValueError(
            f"latency run set mismatch: missing={sorted(expected_seen - seen)}, "
            f"extra={sorted(seen - expected_seen)}"
        )
    return grouped


def performance_rows(grouped: dict[int, list[dict]]) -> list[dict]:
    rows = []
    for concurrency in CONCURRENCIES:
        records = grouped[concurrency]
        totals = [record["total_throughput"] for record in records]
        spread = (max(totals) - min(totals)) / statistics.mean(totals)
        if spread > 0.05:
            raise ValueError(
                f"concurrency {concurrency}: total-throughput spread "
                f"{spread:.2%} exceeds 5%"
            )
        tpot = median(records, "median_tpot_ms")
        row = {
            "isl": 8192,
            "osl": 1024,
            "concurrency": concurrency,
            "ttft_ms": round(median(records, "median_ttft_ms"), 2),
            "tpot_ms": round(tpot, 2),
        }
        if concurrency == 1:
            row["decode_tok_s"] = round(1000 / tpot, 1)
        total = median(records, "total_throughput")
        row.update(
            {
                "output_tok_s": round(median(records, "output_throughput"), 2),
                "total_tok_s": round(total, 2),
                "tok_s_per_gpu": round(total / 8, 1),
                "source": SOURCE,
            }
        )
        rows.append(row)
    return rows


def latency_rows(grouped: dict[int, list[dict]]) -> list[dict]:
    rows = []
    for isl in ISLS:
        records = grouped[isl]
        rows.append(
            {
                "isl": isl,
                "osl": 1024,
                "concurrency": 1,
                "prefill_tok_s": round(median(records, "input_throughput"), 2),
                "decode_tok_s": round(median(records, "output_throughput"), 2),
                "source": SOURCE.replace("section 5", "section 6"),
            }
        )
    return rows


def check_models(path: Path, rows: list[dict]) -> None:
    source = path.read_text()
    marker = "window.MODELS = "
    if marker not in source:
        raise ValueError(f"{path}: {marker!r} not found")
    payload = source.split(marker, 1)[1].strip()
    if not payload.endswith(";"):
        raise ValueError(f"{path}: MODELS assignment does not end in a semicolon")
    models = json.loads(payload[:-1])
    model = next((item for item in models if item.get("id") == "glm-5.3-flash"), None)
    if model is None:
        raise ValueError(f"{path}: glm-5.3-flash entry missing")
    cell = next(
        (
            item
            for item in model.get("configs", [])
            if item.get("gfx") == "gfx950"
            and item.get("strategy") == "high-throughput"
        ),
        None,
    )
    if cell is None:
        raise ValueError(f"{path}: gfx950 high-throughput cell missing")
    if cell.get("benchmarks") != rows:
        raise ValueError(f"{path}: benchmark rows differ from generated records")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--results",
        type=Path,
        default=Path("/results/glm53-final-20260827T233110Z/bench/glm53"),
    )
    parser.add_argument(
        "--check-models",
        type=Path,
        help="fail unless this models.js contains the generated rows exactly",
    )
    args = parser.parse_args()
    rows = performance_rows(load_perf(args.results))
    rows.extend(latency_rows(load_latency(args.results)))
    if args.check_models:
        check_models(args.check_models, rows)
    print(json.dumps(rows, indent=2))


if __name__ == "__main__":
    main()
