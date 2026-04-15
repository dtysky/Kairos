"""
ASR runner with two backends:
  - MLX:     mlx-whisper  (Apple Silicon, no PyTorch)
  - Non-MLX: faster-whisper / CTranslate2  (CUDA / CPU)
"""
from __future__ import annotations

import audioop
from concurrent.futures import ThreadPoolExecutor, as_completed
import gc
import json
import os
import subprocess
import time
import warnings
import wave
from pathlib import Path
from tempfile import NamedTemporaryFile

from .device import DEVICE, BACKEND

CDEFAULT_MLX_WHISPER = "mlx-community/whisper-large-v3-turbo"
CLOCAL_MLX_WHISPER = "whisper-large-v3-turbo"
CDEFAULT_NON_MLX_WHISPER = "large-v3"
CDEFAULT_NON_MLX_WHISPER_REPO = "Systran/faster-whisper-large-v3"
CFALLBACK_NON_MLX_WHISPER = "small"
CFALLBACK_NON_MLX_WHISPER_REPO = "Systran/faster-whisper-small"
CLOCAL_NON_MLX_WHISPER = "whisper-large-v3-ct2"
CLOCAL_NON_MLX_WHISPER_ALT = "whisper-large-v3"
CLOCAL_NON_MLX_WHISPER_FALLBACK = "whisper-small-ct2"
CLOCAL_NON_MLX_WHISPER_FALLBACK_ALT = "whisper-small"
CWHISPER_MODEL = os.getenv("KAIROS_WHISPER_MODEL", "")
CSILENCE_GATE_WINDOW_SECONDS = 1.0
CSILENCE_GATE_RMS_THRESHOLD = 48
CSILENCE_GATE_PEAK_THRESHOLD = 192
CTRANSCRIPT_SHORT_PAUSE_SECONDS = 0.22
CTRANSCRIPT_LONG_PAUSE_SECONDS = 0.48
CTRANSCRIPT_TARGET_UNITS = 18
CFASTER_WHISPER_BATCH_SIZE = max(1, int(os.getenv("KAIROS_FASTER_WHISPER_BATCH_SIZE", "8")))
CFASTER_WHISPER_BEAM_SIZE = max(1, int(os.getenv("KAIROS_FASTER_WHISPER_BEAM_SIZE", "5")))


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


def _huggingface_hub_root() -> Path:
    raw = os.getenv("HF_HOME", "").strip()
    if raw:
        root = Path(raw)
        return root / "hub" if (root / "hub").exists() else root
    return Path.home() / ".cache" / "huggingface" / "hub"


def _resolve_path_target(path: Path) -> Path | None:
    try:
        resolved = path.resolve(strict=True)
    except Exception:
        return None
    if resolved.name.endswith(".incomplete"):
        return None
    return resolved


def _has_complete_model_file(path: Path) -> bool:
    resolved = _resolve_path_target(path)
    return resolved is not None and resolved.is_file() and resolved.stat().st_size > 0


def _is_complete_ctranslate2_model_dir(model_dir: Path) -> bool:
    required_files = [
        model_dir / "config.json",
        model_dir / "model.bin",
    ]
    if not all(_has_complete_model_file(path) for path in required_files):
        return False

    tokenizer_candidates = [
        model_dir / "tokenizer.json",
        model_dir / "vocabulary.json",
        model_dir / "tokenizer_config.json",
    ]
    return any(_has_complete_model_file(path) for path in tokenizer_candidates)


def _find_complete_hf_snapshot(repo_id: str, validator) -> Path | None:
    cache_dir = _huggingface_hub_root() / f"models--{repo_id.replace('/', '--')}"
    snapshots_dir = cache_dir / "snapshots"
    if not snapshots_dir.exists():
        return None

    snapshot_dirs = sorted(
        (path for path in snapshots_dir.iterdir() if path.is_dir()),
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )
    for snapshot_dir in snapshot_dirs:
        if validator(snapshot_dir):
            return snapshot_dir
    return None


def _first_complete_local_model_dir(candidates: list[Path]) -> Path | None:
    for candidate in candidates:
        if _is_complete_ctranslate2_model_dir(candidate):
            return candidate
    return None


def _resolve_non_mlx_model_ref() -> str:
    if CWHISPER_MODEL:
        return CWHISPER_MODEL

    preferred_local = _first_complete_local_model_dir([
        _repo_root() / "models" / CLOCAL_NON_MLX_WHISPER,
        _repo_root() / "models" / CLOCAL_NON_MLX_WHISPER_ALT,
    ])
    if preferred_local is not None:
        return str(preferred_local)

    preferred_cache = _find_complete_hf_snapshot(
        CDEFAULT_NON_MLX_WHISPER_REPO,
        _is_complete_ctranslate2_model_dir,
    )
    if preferred_cache is not None:
        return str(preferred_cache)

    fallback_local = _first_complete_local_model_dir([
        _repo_root() / "models" / CLOCAL_NON_MLX_WHISPER_FALLBACK,
        _repo_root() / "models" / CLOCAL_NON_MLX_WHISPER_FALLBACK_ALT,
    ])
    if fallback_local is not None:
        return str(fallback_local)

    fallback_cache = _find_complete_hf_snapshot(
        CFALLBACK_NON_MLX_WHISPER_REPO,
        _is_complete_ctranslate2_model_dir,
    )
    if fallback_cache is not None:
        return str(fallback_cache)

    return CDEFAULT_NON_MLX_WHISPER


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


def _extract_faster_whisper_words(raw_segment) -> list[dict]:
    words = []
    for raw_word in getattr(raw_segment, "words", None) or []:
        start, end = _normalize_timestamp_pair(
            getattr(raw_word, "start", 0.0),
            getattr(raw_word, "end", getattr(raw_word, "start", 0.0)),
        )
        text = _normalize_text(getattr(raw_word, "word", "") or getattr(raw_word, "text", ""))
        if not text or end <= start:
            continue
        words.append({
            "start": start,
            "end": end,
            "text": text,
        })
    return words


def _extract_faster_whisper_result(raw_segments: list[object]) -> tuple[list[dict], list[dict]]:
    segments = []
    words = []
    for raw_segment in raw_segments:
        start, end = _normalize_timestamp_pair(
            getattr(raw_segment, "start", 0.0),
            getattr(raw_segment, "end", getattr(raw_segment, "start", 0.0)),
        )
        text = _normalize_text(getattr(raw_segment, "text", ""))
        if not text or end <= start:
            words.extend(_extract_faster_whisper_words(raw_segment))
            continue
        segments.append({
            "start": start,
            "end": end,
            "text": text,
        })
        words.extend(_extract_faster_whisper_words(raw_segment))

    if not segments and words:
        segments = _group_words_to_segments(words)
    return segments, words


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


# ── Non-MLX backend (faster-whisper / CTranslate2) ───────────

_asr_pipeline = None


def _non_mlx_device_str() -> str:
    if DEVICE == "cuda":
        return "cuda"
    return "cpu"


def _non_mlx_compute_type() -> str:
    if DEVICE == "cuda":
        return "float16"
    return "int8"


def _get_non_mlx_asr():
    global _asr_pipeline
    if _asr_pipeline is not None:
        return _asr_pipeline

    with warnings.catch_warnings():
        warnings.filterwarnings(
            "ignore",
            message="pkg_resources is deprecated as an API.*",
            category=UserWarning,
        )
        from faster_whisper import BatchedInferencePipeline, WhisperModel

    model_id = _resolve_non_mlx_model_ref()
    device_str = _non_mlx_device_str()
    compute_type = _non_mlx_compute_type()
    model_path = Path(model_id)
    print(
        "[kairos-ml] loading faster-whisper model from: "
        f"{model_id} (device={device_str}, compute_type={compute_type})"
    )

    model = WhisperModel(
        model_id,
        device=device_str,
        compute_type=compute_type,
        local_files_only=not model_path.exists(),
    )
    _asr_pipeline = BatchedInferencePipeline(model=model)
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
        "modelRef": _resolve_mlx_model_ref() if BACKEND == "mlx" else _resolve_non_mlx_model_ref(),
        "totalMs": (time.perf_counter() - prepared["total_started_at"]) * 1000.0,
        "loadMs": 0.0,
        "wavExtractMs": prepared["wav_extract_ms"],
        "inferenceMs": 0.0,
        "silenceGateMs": prepared["silence_gate_ms"],
        "skippedSilent": True,
        "effectiveAudioDetected": False,
        "silenceGateStats": prepared["silence_gate"],
    }


def _transcribe_non_mlx_batch(prepared_entries: list[dict], languages: list[str | None]) -> list[tuple[list[dict], list[dict], dict]]:
    outputs: list[tuple[list[dict], list[dict], dict] | None] = [None] * len(prepared_entries)
    load_started_at = time.perf_counter()
    asr = _get_non_mlx_asr()
    load_ms = (time.perf_counter() - load_started_at) * 1000.0

    for index, language in enumerate(languages):
        prepared = prepared_entries[index]
        transcribe_kwargs: dict = {
            "task": "transcribe",
            "beam_size": CFASTER_WHISPER_BEAM_SIZE,
            "batch_size": CFASTER_WHISPER_BATCH_SIZE,
            "without_timestamps": False,
            "word_timestamps": True,
            "vad_filter": False,
        }
        if language:
            transcribe_kwargs["language"] = language

        inference_started_at = time.perf_counter()
        raw_segments, _info = asr.transcribe(str(prepared["wav_path"]), **transcribe_kwargs)
        segments, words = _extract_faster_whisper_result(list(raw_segments))
        inference_ms = (time.perf_counter() - inference_started_at) * 1000.0

        outputs[index] = (
            segments,
            words,
            {
                "backend": BACKEND,
                "modelRef": _resolve_non_mlx_model_ref(),
                "totalMs": (time.perf_counter() - prepared["total_started_at"]) * 1000.0,
                "loadMs": load_ms,
                "wavExtractMs": prepared["wav_extract_ms"],
                "inferenceMs": inference_ms,
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
                active_results = _transcribe_non_mlx_batch(active_entries, active_languages)
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
