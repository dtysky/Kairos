from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
import gc
import time
import wave
from pathlib import Path
from tempfile import NamedTemporaryFile
from typing import Any

from .device import DEVICE
from .whisper_runner import (
    _build_silent_timing as _build_whisper_silent_timing,
    _group_words_to_segments,
    _normalize_text,
    _normalize_timestamp_pair,
    _prepare_transcription_input,
)


_asr_model = None
_loaded_refs: tuple[str, str] | None = None
_loaded_dtype: str | None = None
_CHUNK_DURATION_SECONDS = 240


def _language_name(requested: str | None) -> str:
    raw = str(requested or "Chinese").strip()
    aliases = {
        "zh": "Chinese",
        "zh-cn": "Chinese",
        "zh-hans": "Chinese",
        "cn": "Chinese",
    }
    return aliases.get(raw.lower(), raw)


def _get_model(model_path: str, aligner_model_path: str):
    global _asr_model, _loaded_refs, _loaded_dtype
    if DEVICE != "cuda":
        raise RuntimeError(f"Qwen3 Transformers backend requires NVIDIA CUDA; actual device={DEVICE}")

    refs = (model_path, aligner_model_path)
    if _loaded_refs != refs:
        unload()
    if _asr_model is not None:
        return _asr_model, _loaded_dtype or "unknown", 0.0

    import torch
    from qwen_asr import Qwen3ASRModel  # type: ignore

    dtype = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16
    dtype_name = "bfloat16" if dtype == torch.bfloat16 else "float16"
    started_at = time.perf_counter()
    print(
        "[kairos-ml] loading Qwen3-ASR Transformers model from: "
        f"{model_path} (device=cuda:0, dtype={dtype_name})"
    )
    _asr_model = Qwen3ASRModel.from_pretrained(
        model_path,
        dtype=dtype,
        device_map="cuda:0",
        max_inference_batch_size=1,
        max_new_tokens=2048,
        forced_aligner=aligner_model_path,
        forced_aligner_kwargs={
            "dtype": dtype,
            "device_map": "cuda:0",
        },
    )
    _loaded_refs = refs
    _loaded_dtype = dtype_name
    return _asr_model, dtype_name, (time.perf_counter() - started_at) * 1000.0


def unload() -> bool:
    global _asr_model, _loaded_refs, _loaded_dtype
    if _asr_model is None:
        return False
    model_ref = _asr_model
    _asr_model = None
    _loaded_refs = None
    _loaded_dtype = None
    del model_ref
    gc.collect()
    try:
        import torch

        torch.cuda.empty_cache()
        if hasattr(torch.cuda, "ipc_collect"):
            torch.cuda.ipc_collect()
    except Exception:
        pass
    return True


def _split_wav(wav_path: Path, chunk_duration_seconds: int) -> list[tuple[Path, float, bool]]:
    chunks: list[tuple[Path, float, bool]] = []
    with wave.open(str(wav_path), "rb") as source:
        frame_rate = source.getframerate()
        total_frames = source.getnframes()
        chunk_frames = max(1, int(frame_rate * chunk_duration_seconds))
        if total_frames <= chunk_frames:
            return [(wav_path, 0.0, False)]

        channels = source.getnchannels()
        sample_width = source.getsampwidth()
        compression_type = source.getcomptype()
        compression_name = source.getcompname()
        offset_frames = 0
        while offset_frames < total_frames:
            frames = source.readframes(min(chunk_frames, total_frames - offset_frames))
            if not frames:
                break
            with NamedTemporaryFile(delete=False, suffix=".wav", dir=wav_path.parent) as handle:
                chunk_path = Path(handle.name)
            with wave.open(str(chunk_path), "wb") as target:
                target.setnchannels(channels)
                target.setsampwidth(sample_width)
                target.setframerate(frame_rate)
                target.setcomptype(compression_type, compression_name)
                target.writeframes(frames)
            chunks.append((chunk_path, offset_frames / frame_rate, True))
            offset_frames += len(frames) // max(1, sample_width * channels)
    return chunks


def _aligned_items(value: Any) -> list[Any]:
    items = getattr(value, "items", None)
    if items is not None and not callable(items):
        return list(items)
    if isinstance(value, (list, tuple)):
        return list(value)
    try:
        return list(value)
    except TypeError:
        return []


def _extract_words(result: Any, offset_seconds: float) -> list[dict]:
    text = _normalize_text(getattr(result, "text", ""))
    timestamps = getattr(result, "time_stamps", None)
    words: list[dict] = []
    for item in _aligned_items(timestamps):
        item_text = _normalize_text(
            item.get("text", "") if isinstance(item, dict) else getattr(item, "text", "")
        )
        raw_start = item.get("start_time", 0.0) if isinstance(item, dict) else getattr(item, "start_time", 0.0)
        raw_end = item.get("end_time", raw_start) if isinstance(item, dict) else getattr(item, "end_time", raw_start)
        start, end = _normalize_timestamp_pair(raw_start, raw_end)
        if item_text and end > start:
            words.append({
                "start": offset_seconds + start,
                "end": offset_seconds + end,
                "text": item_text,
            })
    if text and not words:
        raise RuntimeError("Qwen3 ForcedAligner returned no word timestamps")
    return words


def _transcribe_prepared(
    asr: Any,
    prepared: dict,
    language: str,
    chunk_duration_seconds: int,
) -> tuple[list[dict], list[dict], float, float, int]:
    chunks = _split_wav(prepared["wav_path"], chunk_duration_seconds)
    words: list[dict] = []
    inference_ms = 0.0
    alignment_ms = 0.0
    try:
        for chunk_path, offset_seconds, _cleanup in chunks:
            started_at = time.perf_counter()
            results = asr.transcribe(
                audio=str(chunk_path),
                language=language,
                return_time_stamps=True,
            )
            elapsed_ms = (time.perf_counter() - started_at) * 1000.0
            # The official wrapper performs decoding and forced alignment in one
            # call, so expose the combined duration without inventing a split.
            inference_ms += elapsed_ms
            alignment_ms += 0.0
            if len(results) != 1:
                raise RuntimeError(
                    f"Qwen3-ASR returned {len(results)} results for one source chunk"
                )
            words.extend(_extract_words(results[0], offset_seconds))
    finally:
        for chunk_path, _offset_seconds, cleanup in chunks:
            if cleanup:
                chunk_path.unlink(missing_ok=True)
    return _group_words_to_segments(words), words, inference_ms, alignment_ms, len(chunks)


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
                    "runtimeBackend": "torch",
                    "runtimeVariant": "transformers-cuda",
                    "provider": "qwen3-transformers",
                    "modelRef": model_path,
                    "alignerModelRef": aligner_model_path,
                    "alignmentMs": 0.0,
                    "device": "cuda",
                })
                outputs[index] = ([], [], timing)
                prepared["wav_path"].unlink(missing_ok=True)
                continue
            prepared_entries[index] = prepared

    active_entries = [entry for entry in prepared_entries if entry is not None]
    try:
        if active_entries:
            asr, dtype_name, load_ms = _get_model(model_path, aligner_model_path)
            for index, prepared in enumerate(prepared_entries):
                if prepared is None:
                    continue
                language = _language_name(prepared["language"])
                segments, words, inference_ms, alignment_ms, chunk_count = _transcribe_prepared(
                    asr,
                    prepared,
                    language,
                    _CHUNK_DURATION_SECONDS,
                )
                outputs[index] = (
                    segments,
                    words,
                    {
                        "backend": "qwen3",
                        "runtimeBackend": "torch",
                        "runtimeVariant": "transformers-cuda",
                        "provider": "qwen3-transformers",
                        "modelRef": model_path,
                        "alignerModelRef": aligner_model_path,
                        "device": "cuda",
                        "dtype": dtype_name,
                        "chunkCount": chunk_count,
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
