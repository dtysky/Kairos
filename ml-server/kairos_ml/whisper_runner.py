"""
ASR runner with two backends:
  - MLX:   mlx-whisper  (Apple Silicon, no PyTorch)
  - Torch: transformers pipeline  (CUDA / CPU)
"""
from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from tempfile import NamedTemporaryFile

from .device import DEVICE, BACKEND

CDEFAULT_MLX_WHISPER = "mlx-community/whisper-large-v3-turbo"
CWHISPER_MODEL = os.getenv("KAIROS_WHISPER_MODEL", "")


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _runtime_config() -> dict:
    runtime_path = _repo_root() / "config" / "runtime.json"
    if not runtime_path.exists():
        return {}
    return json.loads(runtime_path.read_text(encoding="utf-8"))


def _ffmpeg_path() -> str:
    return str(_runtime_config().get("ffmpegPath") or "ffmpeg")


def _audio_temp_dir() -> Path:
    output = _repo_root() / ".tmp" / "ml-audio"
    output.mkdir(parents=True, exist_ok=True)
    return output


def _extract_audio_wav(media_path: str) -> Path:
    with NamedTemporaryFile(delete=False, suffix=".wav", dir=_audio_temp_dir()) as h:
        out_path = Path(h.name)
    subprocess.run(
        [_ffmpeg_path(), "-i", media_path,
         "-vn", "-ac", "1", "-ar", "16000", "-f", "wav", "-y", str(out_path)],
        check=True, capture_output=True, text=True,
    )
    return out_path


# ── MLX backend (mlx-whisper) ────────────────────────────────

def _transcribe_mlx(wav_path: Path, language: str | None) -> list[dict]:
    import mlx_whisper  # type: ignore

    model_ref = CWHISPER_MODEL or CDEFAULT_MLX_WHISPER
    kwargs: dict = {
        "path_or_hf_repo": model_ref,
        "word_timestamps": False,
    }
    if language:
        kwargs["language"] = language

    result = mlx_whisper.transcribe(str(wav_path), **kwargs)

    segments = result.get("segments") or []
    if not segments:
        text = str(result.get("text") or "").strip()
        if not text:
            return []
        return [{"start": 0.0, "end": 0.0, "text": text}]

    return [
        {
            "start": float(seg.get("start") or 0.0),
            "end": float(seg.get("end") or 0.0),
            "text": str(seg.get("text") or "").strip(),
        }
        for seg in segments
        if str(seg.get("text") or "").strip()
    ]


# ── Torch backend (transformers) ─────────────────────────────

_asr_pipeline = None


def _torch_device_str() -> str:
    if DEVICE == "cuda":
        return "cuda:0"
    return "cpu"


def _get_torch_pipeline():
    global _asr_pipeline
    if _asr_pipeline is not None:
        return _asr_pipeline

    import torch
    from scipy.io import wavfile as _wf  # noqa: F401 — verify scipy
    from transformers import AutoModelForSpeechSeq2Seq, AutoProcessor, pipeline

    model_id = "openai/whisper-small"
    use_fp16 = DEVICE == "cuda"
    torch_dtype = torch.float16 if use_fp16 else torch.float32
    device_str = _torch_device_str()

    model = AutoModelForSpeechSeq2Seq.from_pretrained(
        model_id, torch_dtype=torch_dtype,
        low_cpu_mem_usage=True, use_safetensors=True,
    ).to(device_str)

    processor = AutoProcessor.from_pretrained(model_id)

    _asr_pipeline = pipeline(
        "automatic-speech-recognition",
        model=model,
        tokenizer=processor.tokenizer,
        feature_extractor=processor.feature_extractor,
        torch_dtype=torch_dtype,
        device=0 if DEVICE == "cuda" else device_str,
    )
    return _asr_pipeline


def _transcribe_torch(wav_path: Path, language: str | None) -> list[dict]:
    from scipy.io import wavfile

    asr = _get_torch_pipeline()
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
        chunk_length_s=30, batch_size=8,
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
            "end": float(
                (chunk.get("timestamp") or (0.0, 0.0))[1]
                or (chunk.get("timestamp") or (0.0, 0.0))[0]
                or 0.0
            ),
            "text": str(chunk.get("text") or "").strip(),
        }
        for chunk in chunks
        if str(chunk.get("text") or "").strip()
    ]


# ── Public API ───────────────────────────────────────────────

def transcribe(audio_path: str, language: str | None = None) -> list[dict]:
    wav_path = _extract_audio_wav(audio_path)
    try:
        if BACKEND == "mlx":
            return _transcribe_mlx(wav_path, language)
        return _transcribe_torch(wav_path, language)
    finally:
        wav_path.unlink(missing_ok=True)
