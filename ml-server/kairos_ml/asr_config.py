from __future__ import annotations

import json
from pathlib import Path
from typing import Any


DEFAULT_CONFIG: dict[str, Any] = {
    "backend": "whisper",
}

QWEN3_RUNTIME = {
    "mlxModelPath": "models/Qwen3-ASR-1.7B-MLX-8bit",
    "mlxAlignerModelPath": "models/Qwen3-ForcedAligner-0.6B-8bit",
    "transformersModelPath": "models/Qwen3-ASR-1_7B",
    "transformersAlignerModelPath": "models/Qwen3-ForcedAligner-0_6B",
}


def repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def config_path() -> Path:
    return repo_root() / "config" / "runtime.json"


def load_config() -> dict[str, Any]:
    path = config_path()
    runtime = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    if not isinstance(runtime, dict):
        raise ValueError("config/runtime.json must contain a JSON object")
    raw = runtime.get("asr", DEFAULT_CONFIG)
    if not isinstance(raw, dict):
        raise ValueError("config/runtime.json asr must be an object")
    backend = str(raw.get("backend") or "").strip()
    if backend not in {"qwen3", "whisper"}:
        raise ValueError("config/runtime.json asr.backend must be qwen3 or whisper")
    if set(raw) != {"backend"}:
        raise ValueError("config/runtime.json asr only supports the backend field")
    return {"backend": backend}


def qwen3_runtime_config() -> dict[str, str]:
    return dict(QWEN3_RUNTIME)


def resolve_local_path(value: str) -> Path:
    path = Path(value).expanduser()
    return path if path.is_absolute() else repo_root() / path
