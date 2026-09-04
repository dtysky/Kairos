from pathlib import Path
from tempfile import TemporaryDirectory
from types import ModuleType, SimpleNamespace
import sys
import unittest
from unittest import mock
import wave

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from kairos_ml import qwen3_asr_transformers_runner as runner


class _FakeAsr:
    def __init__(self):
        self.calls = []

    def transcribe(self, **kwargs):
        self.calls.append(kwargs)
        return [SimpleNamespace(
            text="测试",
            time_stamps=SimpleNamespace(items=[
                SimpleNamespace(text="测", start_time=0.1, end_time=0.2),
                SimpleNamespace(text="试", start_time=0.2, end_time=0.3),
            ]),
        )]


class Qwen3AsrTransformersRunnerTests(unittest.TestCase):
    def tearDown(self):
        runner._asr_model = None
        runner._loaded_refs = None
        runner._loaded_dtype = None

    def test_loads_official_qwen_package_with_required_aligner(self):
        fake_torch = ModuleType("torch")
        fake_torch.bfloat16 = object()
        fake_torch.float16 = object()
        fake_torch.cuda = SimpleNamespace(is_bf16_supported=lambda: True)
        from_pretrained = mock.Mock(return_value=object())
        fake_qwen = ModuleType("qwen_asr")
        fake_qwen.Qwen3ASRModel = SimpleNamespace(from_pretrained=from_pretrained)

        with mock.patch.object(runner, "DEVICE", "cuda"), \
            mock.patch.dict(sys.modules, {"torch": fake_torch, "qwen_asr": fake_qwen}):
            model, dtype_name, _load_ms = runner._get_model("C:/Kairos/models/asr", "C:/Kairos/models/aligner")

        self.assertIsNotNone(model)
        self.assertEqual(dtype_name, "bfloat16")
        from_pretrained.assert_called_once_with(
            "C:/Kairos/models/asr",
            dtype=fake_torch.bfloat16,
            device_map="cuda:0",
            max_inference_batch_size=1,
            max_new_tokens=2048,
            forced_aligner="C:/Kairos/models/aligner",
            forced_aligner_kwargs={
                "dtype": fake_torch.bfloat16,
                "device_map": "cuda:0",
            },
        )

    def test_chunks_audio_and_offsets_forced_aligner_words(self):
        with TemporaryDirectory() as directory:
            wav_path = Path(directory) / "source.wav"
            frame_rate = 16000
            with wave.open(str(wav_path), "wb") as target:
                target.setnchannels(1)
                target.setsampwidth(2)
                target.setframerate(frame_rate)
                target.writeframes(b"\x01\x00" * (frame_rate * 61))

            fake_asr = _FakeAsr()
            segments, words, _inference_ms, _alignment_ms, chunk_count = runner._transcribe_prepared(
                fake_asr,
                {"wav_path": wav_path},
                "Chinese",
                30,
            )

        self.assertEqual(chunk_count, 3)
        self.assertEqual(len(fake_asr.calls), 3)
        self.assertTrue(all("context" not in call for call in fake_asr.calls))
        self.assertEqual([round(word["start"], 1) for word in words], [0.1, 0.2, 30.1, 30.2, 60.1, 60.2])
        self.assertEqual("".join(segment["text"] for segment in segments), "测试测试测试")


if __name__ == "__main__":
    unittest.main()
