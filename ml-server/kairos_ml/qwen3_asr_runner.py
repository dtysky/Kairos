from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
import gc
import time
from pathlib import Path
from typing import Any

from .device import BACKEND, DEVICE
from .whisper_runner import (
    _build_silent_timing as _build_whisper_silent_timing,
    _group_words_to_segments,
    _normalize_text,
    _normalize_timestamp_pair,
    _prepare_transcription_input,
)


_asr_model = None
_aligner_model = None
_loaded_refs: tuple[str, str] | None = None
_CHUNK_DURATION_SECONDS = 240


def _install_mlx_audio_stream_compat() -> None:
    import mlx.core as mx

    # mlx-audio 0.5.1 still references the pre-0.31 helper name while MLX 0.31
    # exposes the same operation as new_stream. Keep this scoped to the local
    # Qwen backend until upstream removes the compatibility gap.
    if not hasattr(mx, "new_thread_local_stream") and hasattr(mx, "new_stream"):
        mx.new_thread_local_stream = mx.new_stream


def _get_models(model_path: str, aligner_model_path: str):
    global _asr_model, _aligner_model, _loaded_refs
    refs = (model_path, aligner_model_path)
    if _loaded_refs != refs:
        unload()
    if _asr_model is not None and _aligner_model is not None:
        return _asr_model, _aligner_model, 0.0

    started_at = time.perf_counter()
    _install_mlx_audio_stream_compat()
    from mlx_audio.stt import load  # type: ignore

    print(f"[kairos-ml] loading Qwen3-ASR model from: {model_path}")
    _asr_model = load(model_path)
    print(f"[kairos-ml] loading Qwen3 ForcedAligner from: {aligner_model_path}")
    _aligner_model = load(aligner_model_path)
    _loaded_refs = refs
    return _asr_model, _aligner_model, (time.perf_counter() - started_at) * 1000.0


def unload() -> bool:
    global _asr_model, _aligner_model, _loaded_refs
    if _asr_model is None and _aligner_model is None:
        return False
    asr_ref = _asr_model
    aligner_ref = _aligner_model
    _asr_model = None
    _aligner_model = None
    _loaded_refs = None
    del asr_ref, aligner_ref
    gc.collect()
    try:
        import mlx.core as mx

        mx.clear_cache()
    except Exception:
        pass
    return True


def _language_name(requested: str | None) -> str:
    raw = str(requested or "Chinese").strip()
    aliases = {
        "zh": "Chinese",
        "zh-cn": "Chinese",
        "zh-hans": "Chinese",
        "cn": "Chinese",
    }
    return aliases.get(raw.lower(), raw)


def _extract_segments(result: Any) -> list[dict]:
    segments = []
    for raw in getattr(result, "segments", None) or []:
        text = _normalize_text(raw.get("text") if isinstance(raw, dict) else getattr(raw, "text", ""))
        start = raw.get("start") if isinstance(raw, dict) else getattr(raw, "start", 0.0)
        end = raw.get("end") if isinstance(raw, dict) else getattr(raw, "end", start)
        normalized_start, normalized_end = _normalize_timestamp_pair(start, end)
        if text and normalized_end > normalized_start:
            segments.append({"start": normalized_start, "end": normalized_end, "text": text})
    if segments:
        return segments
    text = _normalize_text(getattr(result, "text", ""))
    return [{"start": 0.0, "end": 0.0, "text": text}] if text else []


def _align_segments(aligner: Any, wav_path: Path, segments: list[dict], language: str) -> list[dict]:
    if not segments:
        return []
    from mlx_audio.stt.utils import load_audio  # type: ignore

    waveform = load_audio(str(wav_path))
    sample_rate = 16000
    words: list[dict] = []
    for segment in segments:
        text = _normalize_text(segment.get("text") or "")
        if not text:
            continue
        start, end = _normalize_timestamp_pair(segment.get("start"), segment.get("end"))
        if end <= start:
            raise RuntimeError("Qwen3-ASR returned text without an alignable source time range")
        audio_slice = waveform[int(start * sample_rate):int(end * sample_rate)]
        if len(audio_slice) == 0:
            raise RuntimeError("Qwen3 ForcedAligner received an empty audio slice")
        aligned = aligner.generate(audio=audio_slice, text=text, language=language)
        for item in getattr(aligned, "items", None) or []:
            item_text = _normalize_text(getattr(item, "text", ""))
            item_start, item_end = _normalize_timestamp_pair(
                getattr(item, "start_time", 0.0),
                getattr(item, "end_time", 0.0),
            )
            if item_text and item_end > item_start:
                words.append({
                    "start": start + item_start,
                    "end": start + item_end,
                    "text": item_text,
                })
    if any(_normalize_text(segment.get("text") or "") for segment in segments) and not words:
        raise RuntimeError("Qwen3 ForcedAligner returned no word timestamps")
    return words


def transcribe_many(
    requests: list[tuple[str, str | None]],
    *,
    model_path: str,
    aligner_model_path: str,
    preprocess_max_concurrency: int = 1,
) -> list[tuple[list[dict], list[dict], dict]]:
    prepared_entries: list[dict | None] = [None] * len(requests)
    outputs: list[tuple[list[dict], list[dict], dict] | None] = [None] * len(requests)
    with ThreadPoolExecutor(max_workers=max(1, preprocess_max_concurrency)) as executor:
        future_map = {
            executor.submit(_prepare_transcription_input, media_path): (index, language)
            for index, (media_path, language) in enumerate(requests)
        }
        for future in as_completed(future_map):
            index, language = future_map[future]
            prepared = future.result()
            prepared["language"] = language
            if not prepared["has_effective_audio"]:
                timing = _build_whisper_silent_timing(prepared)
                timing.update({
                    "backend": "qwen3",
                    "runtimeBackend": BACKEND,
                    "runtimeVariant": "mlx",
                    "provider": "qwen3-mlx",
                    "device": DEVICE,
                    "modelRef": model_path,
                    "alignerModelRef": aligner_model_path,
                    "alignmentMs": 0.0,
                })
                outputs[index] = ([], [], timing)
                prepared["wav_path"].unlink(missing_ok=True)
                continue
            prepared_entries[index] = prepared

    active_entries = [entry for entry in prepared_entries if entry is not None]
    try:
        if active_entries:
            asr, aligner, load_ms = _get_models(model_path, aligner_model_path)
            for index, prepared in enumerate(prepared_entries):
                if prepared is None:
                    continue
                language = _language_name(prepared["language"])
                inference_started_at = time.perf_counter()
                result = asr.generate(
                    str(prepared["wav_path"]),
                    language=language,
                    chunk_duration=float(_CHUNK_DURATION_SECONDS),
                    max_tokens=8192,
                    verbose=False,
                )
                raw_segments = _extract_segments(result)
                inference_ms = (time.perf_counter() - inference_started_at) * 1000.0
                alignment_started_at = time.perf_counter()
                words = _align_segments(aligner, prepared["wav_path"], raw_segments, language)
                alignment_ms = (time.perf_counter() - alignment_started_at) * 1000.0
                segments = _group_words_to_segments(words) if words else []
                outputs[index] = (
                    segments,
                    words,
                    {
                        "backend": "qwen3",
                        "runtimeBackend": BACKEND,
                        "runtimeVariant": "mlx",
                        "provider": "qwen3-mlx",
                        "device": DEVICE,
                        "modelRef": model_path,
                        "alignerModelRef": aligner_model_path,
                        "totalMs": (time.perf_counter() - prepared["total_started_at"]) * 1000.0,
                        "loadMs": load_ms,
                        "wavExtractMs": prepared["wav_extract_ms"],
                        "inferenceMs": inference_ms,
                        "alignmentMs": alignment_ms,
                        "silenceGateMs": prepared["silence_gate_ms"],
                        "skippedSilent": False,
                        "effectiveAudioDetected": True,
                        "silenceGateStats": prepared["silence_gate"],
                    },
                )
    finally:
        for prepared in active_entries:
            prepared["wav_path"].unlink(missing_ok=True)

    return [item for item in outputs if item is not None]
