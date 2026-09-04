from pathlib import Path
import json
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from kairos_ml import asr_config, asr_router


QWEN_CONFIG = {
    "backend": "qwen3",
}

QWEN_RUNTIME = {
    "mlxModelPath": "models/qwen",
    "mlxAlignerModelPath": "models/aligner",
    "transformersModelPath": "models/qwen-windows",
    "transformersAlignerModelPath": "models/aligner-windows",
}


class AsrRouterTests(unittest.TestCase):
    def test_backend_is_loaded_from_runtime_json(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "runtime.json"
            path.write_text(json.dumps({
                "mlServerUrl": "http://127.0.0.1:8910",
                "asr": {"backend": "qwen3"},
            }), encoding="utf-8")
            with mock.patch.object(asr_config, "config_path", return_value=path):
                self.assertEqual(asr_config.load_config(), {"backend": "qwen3"})

    def test_unavailable_qwen_never_calls_whisper(self):
        with mock.patch.object(asr_router, "load_config", return_value=QWEN_CONFIG), \
            mock.patch.object(asr_router, "qwen3_runtime_config", return_value=QWEN_RUNTIME), \
            mock.patch.object(asr_router, "get_status", return_value={
                "available": False,
                "actualBackend": "qwen3",
                "blocker": "aligner missing",
            }), \
            mock.patch("kairos_ml.whisper_runner.transcribe_many") as whisper:
            with self.assertRaisesRegex(RuntimeError, "aligner missing"):
                asr_router.transcribe_many([("/tmp/audio.wav", "zh")])
            whisper.assert_not_called()

    def test_qwen_route_uses_qwen_runner_only(self):
        expected = [([], [], {"provider": "qwen3"})]
        with mock.patch.object(asr_router, "load_config", return_value=QWEN_CONFIG), \
            mock.patch.object(asr_router, "qwen3_runtime_config", return_value=QWEN_RUNTIME), \
            mock.patch.object(asr_router, "get_status", return_value={
                "available": True,
                "actualBackend": "qwen3",
                "blocker": None,
            }), \
            mock.patch("kairos_ml.qwen3_asr_runner.transcribe_many", return_value=expected) as qwen, \
            mock.patch("kairos_ml.whisper_runner.transcribe_many") as whisper:
            result = asr_router.transcribe_many([("/tmp/audio.wav", "zh")])
            self.assertEqual(result, expected)
            qwen.assert_called_once()
            whisper.assert_not_called()

    def test_windows_cuda_route_uses_transformers_runner_only(self):
        expected = [([], [], {"provider": "qwen3-transformers"})]
        with mock.patch.object(asr_router, "BACKEND", "torch"), \
            mock.patch.object(asr_router, "DEVICE", "cuda"), \
            mock.patch.object(asr_router, "load_config", return_value=QWEN_CONFIG), \
            mock.patch.object(asr_router, "qwen3_runtime_config", return_value=QWEN_RUNTIME), \
            mock.patch.object(asr_router, "get_status", return_value={
                "available": True,
                "actualBackend": "qwen3",
                "blocker": None,
            }), \
            mock.patch("kairos_ml.qwen3_asr_transformers_runner.transcribe_many", return_value=expected) as qwen, \
            mock.patch("kairos_ml.qwen3_asr_runner.transcribe_many") as mlx_qwen, \
            mock.patch("kairos_ml.whisper_runner.transcribe_many") as whisper:
            result = asr_router.transcribe_many([("C:/tmp/audio.wav", "zh")])
            self.assertEqual(result, expected)
            qwen.assert_called_once_with(
                [("C:/tmp/audio.wav", "zh")],
                model_path=str(asr_router.resolve_local_path("models/qwen-windows")),
                aligner_model_path=str(asr_router.resolve_local_path("models/aligner-windows")),
                preprocess_max_concurrency=1,
            )
            mlx_qwen.assert_not_called()
            whisper.assert_not_called()

    def test_windows_cuda_status_reports_transformers_runtime(self):
        with mock.patch.object(asr_router, "BACKEND", "torch"), \
            mock.patch.object(asr_router, "DEVICE", "cuda"), \
            mock.patch.object(asr_router, "qwen3_runtime_config", return_value=QWEN_RUNTIME), \
            mock.patch.object(asr_router, "_complete_model_dir", return_value=(True, None)), \
            mock.patch.object(asr_router.importlib.util, "find_spec", return_value=object()):
            status = asr_router._qwen3_status()
        self.assertTrue(status["available"])
        self.assertEqual(status["provider"], "qwen3-transformers")
        self.assertEqual(status["runtimeVariant"], "transformers-cuda")
        self.assertEqual(status["device"], "cuda")
        self.assertTrue(status["modelRef"].endswith("models/qwen-windows"))


if __name__ == "__main__":
    unittest.main()
