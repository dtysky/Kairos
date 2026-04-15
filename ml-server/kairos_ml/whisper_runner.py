"""
ASR runner with two backends:
  - MLX:   mlx-whisper  (Apple Silicon, no PyTorch)
  - Torch: transformers pipeline  (CUDA / CPU)
"""
from __future__ import annotations

import audioop
from concurrent.futures import ThreadPoolExecutor, as_completed
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
CTRANSCRIPT_SHORT_PAUSE_SECONDS = 0.22
CTRANSCRIPT_LONG_PAUSE_SECONDS = 0.48
CTRANSCRIPT_TARGET_UNITS = 18


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
    return "openai/whisper-large-v3-turbo"


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


def _normalize_text(text: str) -> str:
    return " ".join(str(text or "").strip().split())


def _normalize_timestamp_pair(start: float | None, end: float | None) -> tuple[float, float]:
    normalized_start = max(0.0, float(start or 0.0))
    normalized_end = max(normalized_start, float(end or normalized_start))
    return normalized_start, normalized_end


def _join_words(words: list[dict]) -> str:
    result = ""
    for word in words:
        text = _normalize_text(word.get("text") or word.get("word") or "")
        if not text:
            continue
        if not result:
            result = text
            continue

        previous_char = result[-1]
        next_char = text[0]
        should_add_space = (
            previous_char.isascii()
            and next_char.isascii()
            and previous_char.isalnum()
            and next_char.isalnum()
        )
        result += f" {text}" if should_add_space else text

    return (
        result
        .replace(" ,", ",")
        .replace(" .", ".")
        .replace(" !", "!")
        .replace(" ?", "?")
        .replace(" :", ":")
        .replace(" ;", ";")
        .replace(" ，", "，")
        .replace(" 。", "。")
        .replace(" ！", "！")
        .replace(" ？", "？")
        .replace(" ：", "：")
        .replace(" ；", "；")
        .strip()
    )


def _estimate_text_units(text: str) -> int:
    normalized = _normalize_text(text)
    if not normalized:
        return 0

    units = 0
    token = ""
    token_mode = None
    for char in normalized:
        if "\u4e00" <= char <= "\u9fff":
            units += 1
            token = ""
            token_mode = None
            continue
        if char.isspace():
            if token:
                units += 1
            token = ""
            token_mode = None
            continue
        if char.isascii() and char.isalnum():
            mode = "digit" if char.isdigit() else "latin"
            if token and token_mode != mode:
                units += 1
                token = char
            else:
                token += char
            token_mode = mode
            continue
        if token:
            units += 1
        token = ""
        token_mode = None

    if token:
        units += 1
    return units


def _group_words_to_segments(words: list[dict]) -> list[dict]:
    if not words:
        return []

    segments: list[dict] = []
    current: list[dict] = []

    def flush() -> None:
        nonlocal current
        if not current:
            return
        text = _join_words(current)
        start = float(current[0].get("start") or 0.0)
        end = float(current[-1].get("end") or start)
        current = []
        if not text or end <= start:
            return
        segments.append({
            "start": start,
            "end": end,
            "text": text,
        })

    for index, word in enumerate(words):
        current.append(word)
        text = _join_words(current)
        next_word = words[index + 1] if index + 1 < len(words) else None
        pause_after = (
            max(0.0, float(next_word.get("start") or 0.0) - float(word.get("end") or 0.0))
            if next_word
            else float("inf")
        )
        should_break = (
            next_word is None
            or pause_after >= CTRANSCRIPT_LONG_PAUSE_SECONDS
            or text.endswith(("。", "！", "？", ".", "!", "?", ";", "；", "…"))
            or (
                _estimate_text_units(text) >= CTRANSCRIPT_TARGET_UNITS
                and (
                    pause_after >= CTRANSCRIPT_SHORT_PAUSE_SECONDS
                    or text.endswith(("，", ",", "：", ":", "、"))
                )
            )
        )
        if should_break:
            flush()

    flush()
    return segments


def _extract_mlx_words(segment: dict) -> list[dict]:
    words = []
    for word in segment.get("words") or []:
        text = _normalize_text(word.get("word") or word.get("text") or "")
        if not text:
            continue
        start, end = _normalize_timestamp_pair(word.get("start"), word.get("end"))
        if end <= start:
            continue
        words.append({
            "start": start,
            "end": end,
            "text": text,
        })
    return words


def _extract_torch_words(result: dict) -> list[dict]:
    words = []
    for chunk in result.get("chunks") or []:
        timestamp = chunk.get("timestamp") or (0.0, 0.0)
        start, end = _normalize_timestamp_pair(
            timestamp[0] if isinstance(timestamp, (list, tuple)) and len(timestamp) > 0 else 0.0,
            timestamp[1] if isinstance(timestamp, (list, tuple)) and len(timestamp) > 1 else (
                timestamp[0] if isinstance(timestamp, (list, tuple)) and len(timestamp) > 0 else 0.0
            ),
        )
        text = _normalize_text(chunk.get("text") or "")
        if not text or end <= start:
            continue
        words.append({
            "start": start,
            "end": end,
            "text": text,
        })
    return words


# ── MLX backend (mlx-whisper) ────────────────────────────────

def _transcribe_mlx(wav_path: Path, language: str | None) -> tuple[list[dict], list[dict]]:
    import mlx_whisper  # type: ignore

    model_ref = _resolve_mlx_model_ref()
    kwargs: dict = {
        "path_or_hf_repo": model_ref,
        "word_timestamps": True,
    }
    if language:
        kwargs["language"] = language

    result = mlx_whisper.transcribe(str(wav_path), **kwargs)

    raw_segments = result.get("segments") or []
    if not raw_segments:
        text = str(result.get("text") or "").strip()
        if not text:
            return [], []
        return [{"start": 0.0, "end": 0.0, "text": text}], []

    segments = []
    words = []
    for seg in raw_segments:
        text = _normalize_text(seg.get("text") or "")
        if text:
            start, end = _normalize_timestamp_pair(seg.get("start"), seg.get("end"))
            if end > start:
                segments.append({
                    "start": start,
                    "end": end,
                    "text": text,
                })
        words.extend(_extract_mlx_words(seg))

    return segments, words


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


def _load_torch_audio_input(wav_path: Path) -> dict:
    from scipy.io import wavfile

    sample_rate, samples = wavfile.read(str(wav_path))
    if len(samples.shape) > 1:
        samples = samples.mean(axis=1)
    return {
        "array": samples.astype("float32") / 32768.0,
        "sampling_rate": int(sample_rate),
    }


def _prepare_transcription_input(media_path: str) -> dict:
    total_started_at = time.perf_counter()
    wav_started_at = time.perf_counter()
    wav_path = _extract_audio_wav(media_path)
    wav_extract_ms = (time.perf_counter() - wav_started_at) * 1000.0
    silence_gate_started_at = time.perf_counter()
    has_effective_audio, silence_gate = _has_effective_audio(wav_path)
    silence_gate_ms = (time.perf_counter() - silence_gate_started_at) * 1000.0
    return {
        "wav_path": wav_path,
        "wav_extract_ms": wav_extract_ms,
        "silence_gate_ms": silence_gate_ms,
        "silence_gate": silence_gate,
        "has_effective_audio": has_effective_audio,
        "total_started_at": total_started_at,
    }


def _build_silent_timing(prepared: dict) -> dict:
    return {
        "backend": BACKEND,
        "modelRef": _resolve_mlx_model_ref() if BACKEND == "mlx" else _resolve_torch_model_ref(),
        "totalMs": (time.perf_counter() - prepared["total_started_at"]) * 1000.0,
        "loadMs": 0.0,
        "wavExtractMs": prepared["wav_extract_ms"],
        "inferenceMs": 0.0,
        "silenceGateMs": prepared["silence_gate_ms"],
        "skippedSilent": True,
        "effectiveAudioDetected": False,
        "silenceGateStats": prepared["silence_gate"],
    }


def _transcribe_torch_batch(prepared_entries: list[dict], languages: list[str | None]) -> list[tuple[list[dict], list[dict], dict]]:
    outputs: list[tuple[list[dict], list[dict], dict] | None] = [None] * len(prepared_entries)
    load_started_at = time.perf_counter()
    asr = _get_torch_pipeline()
    load_ms = (time.perf_counter() - load_started_at) * 1000.0

    grouped_indices: dict[str | None, list[int]] = {}
    for index, language in enumerate(languages):
        grouped_indices.setdefault(language, []).append(index)

    for language, indices in grouped_indices.items():
        audio_inputs = [_load_torch_audio_input(prepared_entries[index]["wav_path"]) for index in indices]
        generate_kwargs: dict = {"task": "transcribe"}
        if language:
            generate_kwargs["language"] = language

        inference_started_at = time.perf_counter()
        batch_result = asr(
            audio_inputs[0] if len(audio_inputs) == 1 else audio_inputs,
            chunk_length_s=30,
            batch_size=max(1, min(2, len(audio_inputs))),
            return_timestamps="word",
            generate_kwargs=generate_kwargs,
        )
        inference_total_ms = (time.perf_counter() - inference_started_at) * 1000.0
        normalized_results = batch_result if isinstance(batch_result, list) else [batch_result]
        per_item_inference_ms = inference_total_ms / max(1, len(indices))

        for result_index, entry_index in enumerate(indices):
            prepared = prepared_entries[entry_index]
            result = normalized_results[result_index]
            words = _extract_torch_words(result)
            if words:
                segments = _group_words_to_segments(words)
            else:
                text = str(result.get("text") or "").strip()
                segments = [] if not text else [{"start": 0.0, "end": 0.0, "text": text}]
            outputs[entry_index] = (
                segments,
                words,
                {
                    "backend": BACKEND,
                    "modelRef": _resolve_torch_model_ref(),
                    "totalMs": (time.perf_counter() - prepared["total_started_at"]) * 1000.0,
                    "loadMs": load_ms,
                    "wavExtractMs": prepared["wav_extract_ms"],
                    "inferenceMs": per_item_inference_ms,
                    "silenceGateMs": prepared["silence_gate_ms"],
                    "skippedSilent": False,
                    "effectiveAudioDetected": True,
                    "silenceGateStats": prepared["silence_gate"],
                },
            )

    return [item for item in outputs if item is not None]


def transcribe_many(
    requests: list[tuple[str, str | None]],
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
                outputs[index] = ([], [], _build_silent_timing(prepared))
                prepared["wav_path"].unlink(missing_ok=True)
                continue
            prepared_entries[index] = prepared

    indexed_active_entries = [
        (index, prepared)
        for index, prepared in enumerate(prepared_entries)
        if prepared is not None
    ]
    active_entries = [prepared for _, prepared in indexed_active_entries]
    active_languages = [prepared["language"] for prepared in active_entries]
    try:
        if active_entries:
            if BACKEND == "mlx":
                for index, prepared in indexed_active_entries:
                    inference_started_at = time.perf_counter()
                    segments, words = _transcribe_mlx(prepared["wav_path"], prepared["language"])
                    inference_ms = (time.perf_counter() - inference_started_at) * 1000.0
                    outputs[index] = (
                        segments,
                        words,
                        {
                            "backend": BACKEND,
                            "modelRef": _resolve_mlx_model_ref(),
                            "totalMs": (time.perf_counter() - prepared["total_started_at"]) * 1000.0,
                            "loadMs": 0.0,
                            "wavExtractMs": prepared["wav_extract_ms"],
                            "inferenceMs": inference_ms,
                            "silenceGateMs": prepared["silence_gate_ms"],
                            "skippedSilent": False,
                            "effectiveAudioDetected": True,
                            "silenceGateStats": prepared["silence_gate"],
                        },
                    )
            else:
                active_results = _transcribe_torch_batch(active_entries, active_languages)
                active_result_index = 0
                for index, prepared in enumerate(prepared_entries):
                    if prepared is None:
                        continue
                    outputs[index] = active_results[active_result_index]
                    active_result_index += 1
    finally:
        for prepared in active_entries:
            prepared["wav_path"].unlink(missing_ok=True)

    return [item for item in outputs if item is not None]


# ── Public API ───────────────────────────────────────────────

def transcribe(audio_path: str, language: str | None = None) -> tuple[list[dict], list[dict], dict]:
    return transcribe_many([(audio_path, language)], preprocess_max_concurrency=1)[0]
