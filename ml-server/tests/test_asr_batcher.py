from pathlib import Path
import sys
import threading
import time
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from kairos_ml import main


class AsrBatcherTests(unittest.TestCase):
    def test_torch_batcher_coalesces_requests(self):
        calls: list[tuple[list[tuple[str, str | None]], int]] = []

        def fake_transcribe_many(requests, preprocess_max_concurrency=1):
            calls.append((list(requests), preprocess_max_concurrency))
            time.sleep(0.01)
            return [
                (
                    [{"start": 0.0, "end": 0.5, "text": f"segment-{index}"}],
                    {"totalMs": 5.0},
                )
                for index, _ in enumerate(requests)
            ]

        results = [None, None]

        with mock.patch("kairos_ml.whisper_runner.transcribe_many", side_effect=fake_transcribe_many), \
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
            _, timing = result
            self.assertTrue(timing["batched"])
            self.assertEqual(timing["batchSize"], 2)

    def test_health_exposes_asr_limits(self):
        payload = main.health()
        self.assertIn("limits", payload)
        self.assertIn("asrBatchMaxItems", payload["limits"])
        self.assertIn("asrMode", payload["limits"])


if __name__ == "__main__":
    unittest.main()
