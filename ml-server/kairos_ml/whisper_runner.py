from __future__ import annotations

import json
import subprocess
from pathlib import Path
from tempfile import NamedTemporaryFile

import torch
from scipy.io import wavfile
from transformers import AutoModelForSpeechSeq2Seq, AutoProcessor, pipeline

from .device import DEVICE

_asr_pipeline = None


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _runtime_config() -> dict:
    runtime_path = _repo_root() / "config" / "runtime.json"
    if not runtime_path.exists():
        return {}
    return json.loads(runtime_path.read_text(encoding="utf-8"))


def _ffmpeg_path() -> str:
    runtime = _runtime_config()
    return str(runtime.get("ffmpegPath") or "ffmpeg")


def _audio_temp_dir() -> Path:
    output = _repo_root() / ".tmp" / "ml-audio"
    output.mkdir(parents=True, exist_ok=True)
    return output


def _extract_audio_wav(media_path: str) -> Path:
    with NamedTemporaryFile(delete=False, suffix=".wav", dir=_audio_temp_dir()) as handle:
        out_path = Path(handle.name)

    subprocess.run(
        [
            _ffmpeg_path(),
            "-i",
            media_path,
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-f",
            "wav",
            "-y",
            str(out_path),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    return out_path


def _get_pipeline():
    global _asr_pipeline
    if _asr_pipeline is not None:
        return _asr_pipeline

    model_id = "openai/whisper-small"
    torch_dtype = torch.float16 if DEVICE == "cuda" else torch.float32
    model = AutoModelForSpeechSeq2Seq.from_pretrained(
        model_id,
        torch_dtype=torch_dtype,
        low_cpu_mem_usage=True,
        use_safetensors=True,
    )
    if DEVICE == "cuda":
        model = model.to("cuda")

    processor = AutoProcessor.from_pretrained(model_id)
    device = 0 if DEVICE == "cuda" else -1
    _asr_pipeline = pipeline(
        "automatic-speech-recognition",
        model=model,
        tokenizer=processor.tokenizer,
        feature_extractor=processor.feature_extractor,
        torch_dtype=torch_dtype,
        device=device,
    )
    return _asr_pipeline


def transcribe(audio_path: str, language: str | None = None) -> list[dict]:
    wav_path = _extract_audio_wav(audio_path)
    try:
        asr = _get_pipeline()
        sample_rate, samples = wavfile.read(str(wav_path))
        if len(samples.shape) > 1:
            samples = samples.mean(axis=1)
        audio_input = {
            "array": samples.astype("float32") / 32768.0,
            "sampling_rate": int(sample_rate),
        }
        generate_kwargs: dict = {"task": "transcribe"}
        if language:
            generate_kwargs["language"] = language
        result = asr(
            audio_input,
            chunk_length_s=30,
            batch_size=8,
            return_timestamps=True,
            generate_kwargs=generate_kwargs,
        )
        chunks = result.get("chunks") or []
        if not chunks:
            text = str(result.get("text") or "").strip()
            if not text:
                return []
            return [{"start": 0.0, "end": 0.0, "text": text}]
        return [
            {
                "start": float((chunk.get("timestamp") or (0.0, 0.0))[0] or 0.0),
                "end": float((chunk.get("timestamp") or (0.0, 0.0))[1] or (chunk.get("timestamp") or (0.0, 0.0))[0] or 0.0),
                "text": str(chunk.get("text") or "").strip(),
            }
            for chunk in chunks
            if str(chunk.get("text") or "").strip()
        ]
    finally:
        wav_path.unlink(missing_ok=True)
