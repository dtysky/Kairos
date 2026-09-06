from pathlib import Path
import sys
import threading
import time
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from kairos_ml import main


class AsrBatcherTests(unittest.TestCase):
    def setUp(self):
        with main._asr_worker_state_lock:
            main._asr_worker_released = False
            main._last_asr_worker_status = {}

    def test_torch_batcher_coalesces_requests(self):
        calls: list[tuple[list[tuple[str, str | None]], int]] = []

        def fake_transcribe_many(requests, preprocess_max_concurrency=1):
            calls.append((list(requests), preprocess_max_concurrency))
            time.sleep(0.01)
            return [
                (
                    f"raw-{index}",
                    [{"start": 0.0, "end": 0.5, "text": f"segment-{index}"}],
                    [{"start": 0.0, "end": 0.5, "text": f"word-{index}"}],
                    {"totalMs": 5.0},
                )
                for index, _ in enumerate(requests)
            ]

        results = [None, None]

        with mock.patch("kairos_ml.asr_router.transcribe_many", side_effect=fake_transcribe_many), \
            mock.patch.object(main, "BACKEND", "torch"):
            batcher = main._AsrBatcher(max_items=4, max_wait_ms=40, preprocess_max_concurrency=3)

            def worker(index: int, audio_path: str):
                results[index] = batcher.submit(audio_path, None)

            threads = [
                threading.Thread(target=worker, args=(0, "/tmp/a.wav")),
                threading.Thread(target=worker, args=(1, "/tmp/b.wav")),
            ]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join()

        self.assertEqual(len(calls), 1)
        self.assertEqual(len(calls[0][0]), 2)
        self.assertEqual(calls[0][1], 3)
        for result in results:
            self.assertIsNotNone(result)
            raw_text, _, _, timing = result
            self.assertTrue(raw_text.startswith("raw-"))
            self.assertTrue(timing["batched"])
            self.assertEqual(timing["batchSize"], 2)

    def test_health_exposes_asr_limits(self):
        with mock.patch.object(main, "CASR_WORKER_URL", ""):
            payload = main.health()
        self.assertIn("limits", payload)
        self.assertIn("asrBatchMaxItems", payload["limits"])
        self.assertIn("asrMode", payload["limits"])
        self.assertIn("asr", payload)
        self.assertIn("configuredBackend", payload["asr"])

    def test_gateway_uses_remote_asr_worker(self):
        payload = {
            "rawText": "测试",
            "segments": [],
            "words": [{"start": 0, "end": 0.2, "text": "测"}],
            "timing": {"provider": "qwen3-transformers"},
        }
        with mock.patch.object(main, "CASR_WORKER_URL", "http://127.0.0.1:8911"), \
            mock.patch.object(main, "_worker_json", return_value=payload) as worker:
            response = main.asr(main.AsrRequest(audio_path="C:/a.wav", language="zh"))
        self.assertEqual(response, payload)
        worker.assert_called_once()

    def test_gateway_health_marks_the_isolated_worker_runtime(self):
        worker_health = {
            "asr": {
                "configuredBackend": "qwen3",
                "actualBackend": "qwen3",
                "available": True,
                "runtimeVariant": "transformers-cuda",
            },
            "limits": {"asrMode": "qwen3-transformers"},
        }
        with mock.patch.object(main, "CASR_WORKER_URL", "http://127.0.0.1:8911"), \
            mock.patch.object(main, "_worker_json", return_value=worker_health):
            response = main.health()
        self.assertEqual(response["asr"]["runtimeVariant"], "transformers-cuda-worker")
        self.assertEqual(response["asr"]["workerRuntimeVariant"], "transformers-cuda")
        self.assertEqual(response["asr"]["lifecycleState"], "ready")

    def test_gateway_unloads_and_stops_remote_asr_worker(self):
        with mock.patch.object(main, "CASR_WORKER_URL", "http://127.0.0.1:8911"), \
            mock.patch.object(main, "_worker_json", return_value={"unloaded": True}) as worker:
            response = main.asr_unload()
        self.assertEqual(response, {"unloaded": True, "workerStopped": True})
        worker.assert_called_once_with("/asr/shutdown", {})

    def test_gateway_unload_is_idempotent_after_worker_has_stopped(self):
        with mock.patch.object(main, "CASR_WORKER_URL", "http://127.0.0.1:8911"), \
            mock.patch.object(main, "_worker_json", side_effect=ConnectionError("worker gone")):
            response = main.asr_unload()

        self.assertEqual(response, {"unloaded": True, "workerStopped": True})

    def test_gateway_health_reports_intentional_worker_release_without_blocker(self):
        with main._asr_worker_state_lock:
            main._asr_worker_released = True
            main._last_asr_worker_status = {
                "provider": "qwen3-transformers",
                "modelRef": "C:/models/Qwen3-ASR",
                "alignerModelRef": "C:/models/Qwen3-ForcedAligner",
            }
        with mock.patch.object(main, "CASR_WORKER_URL", "http://127.0.0.1:8911"), \
            mock.patch.object(main, "_worker_json", side_effect=ConnectionError("worker gone")):
            response = main.health()

        self.assertEqual(response["asr"]["lifecycleState"], "released")
        self.assertFalse(response["asr"]["available"])
        self.assertNotIn("blocker", response["asr"])
        self.assertEqual(response["asr"]["provider"], "qwen3-transformers")


if __name__ == "__main__":
    unittest.main()
