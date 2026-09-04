from __future__ import annotations

import importlib.util
import json
from pathlib import Path
from typing import Any

from .asr_config import load_config, qwen3_runtime_config, resolve_local_path
from .device import BACKEND, DEVICE


_active_signature: str | None = None


def _complete_model_dir(path: Path) -> tuple[bool, str | None]:
    if not path.is_dir():
        return False, f"模型目录不存在：{path}"
    required = ["config.json", "tokenizer_config.json", "preprocessor_config.json"]
    missing = [name for name in required if not (path / name).is_file()]
    weight_files = [item for item in path.glob("*.safetensors") if item.stat().st_size > 0]
    index_path = path / "model.safetensors.index.json"
    if index_path.is_file():
        try:
            index = json.loads(index_path.read_text(encoding="utf-8"))
            shard_names = set((index.get("weight_map") or {}).values())
            missing_shards = [
                name
                for name in shard_names
                if not (path / name).is_file() or (path / name).stat().st_size <= 0
            ]
            if not shard_names or missing_shards:
                missing.append(
                    "model.safetensors.index.json referenced shards"
                    + (f" ({', '.join(sorted(missing_shards))})" if missing_shards else "")
                )
        except Exception:
            missing.append("valid model.safetensors.index.json")
    elif not weight_files:
        missing.append("*.safetensors")
    if missing:
        return False, f"模型目录不完整：{path}（缺少 {', '.join(missing)}）"
    return True, None


def _qwen3_status() -> dict[str, Any]:
    qwen = qwen3_runtime_config()
    is_mlx = BACKEND == "mlx"
    is_transformers_cuda = BACKEND == "torch" and DEVICE == "cuda"
    runtime_variant = "mlx" if is_mlx else "transformers-cuda" if is_transformers_cuda else "unsupported"
    model_path = resolve_local_path(
        qwen["mlxModelPath"] if is_mlx else qwen["transformersModelPath"]
    )
    aligner_path = resolve_local_path(
        qwen["mlxAlignerModelPath"] if is_mlx else qwen["transformersAlignerModelPath"]
    )
    blockers: list[str] = []
    if is_mlx:
        if importlib.util.find_spec("mlx_audio") is None:
            blockers.append("缺少 mlx-audio 依赖，请重建或更新 .venv-ml")
        if importlib.util.find_spec("transformers") is None:
            blockers.append("缺少 transformers 依赖，请重建或更新 .venv-ml")
    elif is_transformers_cuda:
        if importlib.util.find_spec("torch") is None:
            blockers.append("缺少 torch 依赖，请在 Windows 原生 Python 中安装 .[cuda]")
        if importlib.util.find_spec("qwen_asr") is None:
            blockers.append("缺少 qwen-asr 依赖，请在 Windows 原生 Python 中安装 .[cuda]")
    else:
        blockers.append(
            f"Qwen3-ASR 当前只支持 Apple Silicon/MLX 或 NVIDIA CUDA；实际 backend={BACKEND}, device={DEVICE}"
        )
    model_ok, model_blocker = _complete_model_dir(model_path)
    aligner_ok, aligner_blocker = _complete_model_dir(aligner_path)
    if model_blocker:
        blockers.append(model_blocker)
    if aligner_blocker:
        blockers.append(aligner_blocker)
    return {
        "configuredBackend": "qwen3",
        "actualBackend": "qwen3",
        "provider": "qwen3-mlx" if is_mlx else "qwen3-transformers" if is_transformers_cuda else None,
        "runtimeBackend": BACKEND,
        "runtimeVariant": runtime_variant,
        "device": DEVICE,
        "available": not blockers,
        "modelRef": str(model_path),
        "modelAvailable": model_ok,
        "alignerModelRef": str(aligner_path),
        "alignerAvailable": aligner_ok,
        "timestampMode": "qwen3-forced-aligner",
        "blocker": "；".join(blockers) if blockers else None,
    }


def _whisper_status() -> dict[str, Any]:
    from . import whisper_runner

    whisper_runner.configure(None)
    status = whisper_runner.get_status()
    return {
        "configuredBackend": "whisper",
        "actualBackend": "whisper",
        "provider": status["provider"],
        "runtimeBackend": BACKEND,
        "runtimeVariant": "mlx" if BACKEND == "mlx" else "faster-whisper",
        "device": DEVICE,
        "available": status["available"],
        "modelRef": status["modelRef"],
        "modelAvailable": status["modelAvailable"],
        "alignerModelRef": None,
        "alignerAvailable": None,
        "timestampMode": "whisper-word-timestamps",
        "blocker": status.get("blocker"),
    }


def get_status() -> dict[str, Any]:
    try:
        config = load_config()
        return _qwen3_status() if config["backend"] == "qwen3" else _whisper_status()
    except Exception as exc:
        return {
            "configuredBackend": None,
            "actualBackend": None,
            "provider": None,
            "runtimeBackend": BACKEND,
            "runtimeVariant": "unknown",
            "device": DEVICE,
            "available": False,
            "modelRef": None,
            "modelAvailable": False,
            "alignerModelRef": None,
            "alignerAvailable": False,
            "timestampMode": None,
            "blocker": f"ASR 全局配置无效：{exc}",
        }


def _activate_config(config: dict[str, Any]) -> None:
    global _active_signature
    signature = json.dumps(config, ensure_ascii=False, sort_keys=True)
    if _active_signature is not None and _active_signature != signature:
        unload()
    _active_signature = signature


def transcribe_many(
    requests: list[tuple[str, str | None]],
    preprocess_max_concurrency: int = 1,
) -> list[tuple[list[dict], list[dict], dict]]:
    config = load_config()
    _activate_config(config)
    status = get_status()
    if not status["available"]:
        raise RuntimeError(status["blocker"] or "配置的 ASR backend 不可用")
    if status["actualBackend"] != config["backend"]:
        raise RuntimeError(
            f"ASR backend 不一致：配置 {config['backend']}，实际 {status['actualBackend']}"
        )

    if config["backend"] == "qwen3":
        qwen = qwen3_runtime_config()
        if BACKEND == "mlx":
            from .qwen3_asr_runner import transcribe_many as qwen3_transcribe_many

            return qwen3_transcribe_many(
                requests,
                model_path=str(resolve_local_path(qwen["mlxModelPath"])),
                aligner_model_path=str(resolve_local_path(qwen["mlxAlignerModelPath"])),
                preprocess_max_concurrency=preprocess_max_concurrency,
            )

        from .qwen3_asr_transformers_runner import transcribe_many as qwen3_transcribe_many

        return qwen3_transcribe_many(
            requests,
            model_path=str(resolve_local_path(qwen["transformersModelPath"])),
            aligner_model_path=str(resolve_local_path(qwen["transformersAlignerModelPath"])),
            preprocess_max_concurrency=preprocess_max_concurrency,
        )

    from . import whisper_runner

    whisper_runner.configure(None)
    return whisper_runner.transcribe_many(
        requests,
        preprocess_max_concurrency=preprocess_max_concurrency,
    )


def unload() -> bool:
    unloaded = False
    try:
        from .qwen3_asr_runner import unload as unload_qwen3

        unloaded = unload_qwen3() or unloaded
    except Exception:
        pass
    try:
        from .qwen3_asr_transformers_runner import unload as unload_qwen3_transformers

        unloaded = unload_qwen3_transformers() or unloaded
    except Exception:
        pass
    try:
        from .whisper_runner import unload as unload_whisper

        unloaded = unload_whisper() or unloaded
    except Exception:
        pass
    return unloaded
