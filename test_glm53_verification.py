"""Regression tests for the GLM-5.3 verification helpers."""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

import gen_glm53_mi355x_rows as rows

ROOT = Path(__file__).resolve().parent
SHIM = ROOT / "glm53_flash" / "rocminfo_shim.sh"


class LatencyRecordTests(unittest.TestCase):
    @staticmethod
    def _record(input_len: int, value: float) -> dict:
        return {
            "input_len": input_len,
            "batch_size": 1,
            "output_len": 1024,
            "input_throughput": value,
            "output_throughput": value,
        }

    def test_duplicate_input_len_repeat_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for repeat in rows.REPEATS:
                records = [self._record(input_len, float(repeat)) for input_len in rows.ISLS]
                if repeat == 1:
                    records.append(self._record(rows.ISLS[0], 100.0))
                (root / f"latency-r{repeat}.jsonl").write_text(
                    "\n".join(json.dumps(record) for record in records) + "\n",
                    encoding="utf-8",
                )

            with self.assertRaisesRegex(ValueError, "duplicate latency record"):
                rows.load_latency(root)


class RocminfoShimTests(unittest.TestCase):
    def _run_shim(self, amd_smi_body: str) -> subprocess.CompletedProcess[str]:
        with tempfile.TemporaryDirectory() as directory:
            bin_dir = Path(directory)
            python = bin_dir / "python3"
            python.write_text("#!/bin/sh\nprintf 'gfx950 1 256\\n'\n", encoding="utf-8")
            python.chmod(0o755)

            amd_smi = bin_dir / "amd-smi"
            amd_smi.write_text(f"#!/bin/sh\n{amd_smi_body}\n", encoding="utf-8")
            amd_smi.chmod(0o755)

            env = {
                key: value
                for key, value in os.environ.items()
                if not key.startswith("BASH_FUNC_")
            }
            env["PATH"] = f"{bin_dir}:{env['PATH']}"
            return subprocess.run(
                ["bash", str(SHIM)],
                check=False,
                capture_output=True,
                text=True,
                env=env,
            )

    def test_missing_total_vram_fails_closed(self) -> None:
        result = self._run_shim("printf 'GPU 0 metrics unavailable\\n'")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("no numeric TOTAL_VRAM", result.stderr)
        self.assertNotIn("Size:", result.stdout)

    def test_numeric_total_vram_is_emitted(self) -> None:
        result = self._run_shim("printf 'TOTAL_VRAM: 294896 MB\\n'")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Name:                    gfx950", result.stdout)
        self.assertIn("Size:                    301973504(KB)", result.stdout)


if __name__ == "__main__":
    unittest.main()
