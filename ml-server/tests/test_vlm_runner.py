from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from kairos_ml import vlm_runner


class VlmRunnerTests(unittest.TestCase):
    def test_strip_reasoning_output_removes_think_block(self):
        output = "<think>\nreasoning\n</think>\n\n{\"scene\":\"lake\"}"
        self.assertEqual(vlm_runner._strip_reasoning_output(output), '{"scene":"lake"}')

    def test_default_local_model_path_prefers_qwen35_directory(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            repo_root = Path(temp_dir)
            models_dir = repo_root / "models"
            (models_dir / "Qwen3_5-9B").mkdir(parents=True)
            (models_dir / "Qwen3-VL-4B-Instruct").mkdir(parents=True)

            with mock.patch.object(vlm_runner, "_repo_root", return_value=repo_root):
                resolved = vlm_runner._default_local_model_path()

        self.assertEqual(resolved, models_dir / "Qwen3_5-9B")

    def test_windows_safe_transformers_global_workers_uses_single_worker_on_windows_cuda(self):
        with mock.patch.object(vlm_runner.os, "name", "nt"), \
             mock.patch.object(vlm_runner, "DEVICE", "cuda"), \
             mock.patch.object(vlm_runner, "CWINDOWS_SAFE_GLOBAL_WORKERS", 1):
            self.assertEqual(vlm_runner._windows_safe_transformers_global_workers(), 1)

    def test_windows_safe_transformers_global_workers_skips_non_windows(self):
        with mock.patch.object(vlm_runner.os, "name", "posix"), \
             mock.patch.object(vlm_runner, "DEVICE", "cuda"):
            self.assertIsNone(vlm_runner._windows_safe_transformers_global_workers())


if __name__ == "__main__":
    unittest.main()
