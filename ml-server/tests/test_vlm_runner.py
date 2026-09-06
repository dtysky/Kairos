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

    def test_resolve_mlx_ref_prefers_qwen35_mlx_directory(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            repo_root = Path(temp_dir)
            models_dir = repo_root / "models"
            (models_dir / "Qwen3.5-9B-MLX-8bit").mkdir(parents=True)
            (models_dir / "Qwen3-VL-4B-Instruct-8bit").mkdir(parents=True)

            with mock.patch.object(vlm_runner, "_repo_root", return_value=repo_root), \
                 mock.patch.object(vlm_runner, "CMODEL_PATH", None), \
                 mock.patch.object(vlm_runner, "CMODEL_ID", ""):
                resolved = vlm_runner._resolve_mlx_ref()

        self.assertEqual(resolved, str(models_dir / "Qwen3.5-9B-MLX-8bit"))

    def test_resolve_mlx_ref_falls_back_to_legacy_qwen3_vl_directory(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            repo_root = Path(temp_dir)
            models_dir = repo_root / "models"
            (models_dir / "Qwen3-VL-4B-Instruct-8bit").mkdir(parents=True)

            with mock.patch.object(vlm_runner, "_repo_root", return_value=repo_root), \
                 mock.patch.object(vlm_runner, "CMODEL_PATH", None), \
                 mock.patch.object(vlm_runner, "CMODEL_ID", ""):
                resolved = vlm_runner._resolve_mlx_ref()

        self.assertEqual(resolved, str(models_dir / "Qwen3-VL-4B-Instruct-8bit"))

    def test_is_qwen35_ref_matches_dot_and_underscore_names(self):
        self.assertTrue(vlm_runner._is_qwen35_ref("mlx-community/Qwen3.5-9B-MLX-8bit"))
        self.assertTrue(vlm_runner._is_qwen35_ref("/models/Qwen3_5-9B"))
        self.assertFalse(vlm_runner._is_qwen35_ref("/models/Qwen3-VL-4B-Instruct-8bit"))

    def test_windows_safe_transformers_global_workers_uses_single_worker_on_windows_cuda(self):
        with mock.patch.object(vlm_runner.os, "name", "nt"), \
             mock.patch.object(vlm_runner, "DEVICE", "cuda"), \
             mock.patch.object(vlm_runner, "CWINDOWS_SAFE_GLOBAL_WORKERS", 1):
            self.assertEqual(vlm_runner._windows_safe_transformers_global_workers(), 1)

    def test_windows_safe_transformers_global_workers_skips_non_windows(self):
        with mock.patch.object(vlm_runner.os, "name", "posix"), \
             mock.patch.object(vlm_runner, "DEVICE", "cuda"):
            self.assertIsNone(vlm_runner._windows_safe_transformers_global_workers())

    def test_generate_text_uses_qwen_without_image_inputs(self):
        with mock.patch.object(vlm_runner, "BACKEND", "torch"), \
             mock.patch.object(vlm_runner, "_load_transformers", return_value=(12.0, "qwen-text")), \
             mock.patch.object(vlm_runner, "_analyze_transformers", return_value=('{"items":[]}', {"loadMs": 0.0})) as analyze:
            text, timing = vlm_runner.generate_text("生成素材模式", max_tokens=128, temperature=0.2)

        analyze.assert_called_once_with([], "生成素材模式", max_tokens=128, temperature=0.2)
        self.assertEqual(text, '{"items":[]}')
        self.assertEqual(timing["loadMs"], 12.0)
        self.assertEqual(timing["modelRef"], "qwen-text")


if __name__ == "__main__":
    unittest.main()
