"""
ASR runner with two backends:
  - MLX:   mlx-whisper  (Apple Silicon, no PyTorch)
  - Torch: transformers pipeline  (CUDA / CPU)
"""
from __future__ import annotations

import audioop
import gc
import json
import os
import subprocess
import time
import wave
from pathlib import Path
from tempfile import NamedTemporaryFile

from .device import DEVICE, BACKEND

CDEFAULT_MLX_WHISPER = "mlx-community/whisper-large-v3-turbo"
CLOCAL_MLX_WHISPER = "whisper-large-v3-turbo"
CWHISPER_MODEL = os.getenv("KAIROS_WHISPER_MODEL", "")
CSILENCE_GATE_WINDOW_SECONDS = 1.0
CSILENCE_GATE_RMS_THRESHOLD = 48
CSILENCE_GATE_PEAK_THRESHOLD = 192


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


def _resolve_mlx_model_ref() -> str:
    if CWHISPER_MODEL:
        return CWHISPER_MODEL
    local = _repo_root() / "models" / CLOCAL_MLX_WHISPER
    return str(local) if local.exists() else CDEFAULT_MLX_WHISPER


def _resolve_torch_model_ref() -> str:
    return "openai/whisper-small"


def _extract_audio_wav(media_path: str) -> Path:
    with NamedTemporaryFile(delete=False, suffix=".wav", dir=_audio_temp_dir()) as h:
        out_path = Path(h.name)
    subprocess.run(
        [_ffmpeg_path(), "-i", media_path,
         "-vn", "-ac", "1", "-ar", "16000", "-f", "wav", "-y", str(out_path)],
        check=True, capture_output=True, text=True,
    )
    return out_path


def _build_silence_gate_window_starts(total_frames: int, window_frames: int) -> list[int]:
    if total_frames <= 0 or window_frames <= 0:
        return []
    if total_frames <= window_frames:
        return [0]

    max_start = max(0, total_frames - window_frames)
    midpoint_start = max(0, (total_frames - window_frames) // 2)
    return sorted({0, midpoint_start, max_start})


def _has_effective_audio(wav_path: Path) -> tuple[bool, dict]:
    try:
        with wave.open(str(wav_path), "rb") as wav:
            total_frames = wav.getnframes()
            sample_width = wav.getsampwidth()
            sample_rate = wav.getframerate()
            window_frames = max(1, min(total_frames, int(sample_rate * CSILENCE_GATE_WINDOW_SECONDS)))
            starts = _build_silence_gate_window_starts(total_frames, window_frames)

            sampled_windows = 0
            max_rms = 0
            max_peak = 0

            for start in starts:
                wav.setpos(start)
                frame_bytes = wav.readframes(window_frames)
                if not frame_bytes:
                    continue

                sampled_windows += 1
                max_rms = max(max_rms, int(audioop.rms(frame_bytes, sample_width)))
                max_peak = max(max_peak, int(audioop.max(frame_bytes, sample_width)))
                if max_rms > CSILENCE_GATE_RMS_THRESHOLD or max_peak > CSILENCE_GATE_PEAK_THRESHOLD:
                    return True, {
                        "sampledWindows": sampled_windows,
                        "maxRms": max_rms,
                        "maxPeak": max_peak,
                    }

            return False, {
                "sampledWindows": sampled_windows,
                "maxRms": max_rms,
                "maxPeak": max_peak,
            }
    except Exception:
        # Prefer a false negative over suppressing real speech when probing fails.
        return True, {
            "sampledWindows": 0,
            "maxRms": None,
            "maxPeak": None,
            "probeFailed": True,
        }


# ── MLX backend (mlx-whisper) ────────────────────────────────

def _transcribe_mlx(wav_path: Path, language: str | None) -> list[dict]:
    import mlx_whisper  # type: ignore

    model_ref = _resolve_mlx_model_ref()
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

    model_id = _resolve_torch_model_ref()
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


def unload() -> bool:
    global _asr_pipeline
    if _asr_pipeline is None:
        return False

    pipeline_ref = _asr_pipeline
    _asr_pipeline = None
    del pipeline_ref
    gc.collect()

    if DEVICE == "cuda":
        try:
            import torch

            torch.cuda.empty_cache()
            if hasattr(torch.cuda, "ipc_collect"):
                torch.cuda.ipc_collect()
        except Exception:
            pass

    return True


def _transcribe_torch(wav_path: Path, language: str | None, asr) -> list[dict]:
    from scipy.io import wavfile

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

def transcribe(audio_path: str, language: str | None = None) -> tuple[list[dict], dict]:
    total_started_at = time.perf_counter()
    wav_started_at = time.perf_counter()
    wav_path = _extract_audio_wav(audio_path)
    wav_extract_ms = (time.perf_counter() - wav_started_at) * 1000.0
    try:
        silence_gate_started_at = time.perf_counter()
        has_effective_audio, silence_gate = _has_effective_audio(wav_path)
        silence_gate_ms = (time.perf_counter() - silence_gate_started_at) * 1000.0
        if not has_effective_audio:
            return [], {
                "backend": BACKEND,
                "modelRef": _resolve_mlx_model_ref() if BACKEND == "mlx" else _resolve_torch_model_ref(),
                "totalMs": (time.perf_counter() - total_started_at) * 1000.0,
                "loadMs": 0.0,
                "wavExtractMs": wav_extract_ms,
                "inferenceMs": 0.0,
                "silenceGateMs": silence_gate_ms,
                "skippedSilent": True,
                "effectiveAudioDetected": False,
                "silenceGateStats": silence_gate,
            }
        if BACKEND == "mlx":
            inference_started_at = time.perf_counter()
            segments = _transcribe_mlx(wav_path, language)
            inference_ms = (time.perf_counter() - inference_started_at) * 1000.0
            return segments, {
                "backend": BACKEND,
                "modelRef": _resolve_mlx_model_ref(),
                "totalMs": (time.perf_counter() - total_started_at) * 1000.0,
                "loadMs": 0.0,
                "wavExtractMs": wav_extract_ms,
                "inferenceMs": inference_ms,
                "silenceGateMs": silence_gate_ms,
                "skippedSilent": False,
                "effectiveAudioDetected": True,
                "silenceGateStats": silence_gate,
            }
        load_started_at = time.perf_counter()
        asr = _get_torch_pipeline()
        load_ms = (time.perf_counter() - load_started_at) * 1000.0
        inference_started_at = time.perf_counter()
        segments = _transcribe_torch(wav_path, language, asr)
        inference_ms = (time.perf_counter() - inference_started_at) * 1000.0
        return segments, {
            "backend": BACKEND,
            "modelRef": _resolve_torch_model_ref(),
            "totalMs": (time.perf_counter() - total_started_at) * 1000.0,
            "loadMs": load_ms,
            "wavExtractMs": wav_extract_ms,
            "inferenceMs": inference_ms,
            "silenceGateMs": silence_gate_ms,
            "skippedSilent": False,
            "effectiveAudioDetected": True,
            "silenceGateStats": silence_gate,
        }
    finally:
        wav_path.unlink(missing_ok=True)
