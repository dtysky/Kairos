"""
VLM (Vision Language Model) runner with two backends:
  - MLX:   mlx-vlm + Qwen3-VL quantized  (Apple Silicon, no PyTorch)
  - Torch: transformers + Qwen3.5 / Qwen3-VL  (CUDA / CPU)
"""
from __future__ import annotations

import gc
import os
import re
import time
from pathlib import Path

from .device import DEVICE, BACKEND

_backend_loaded: str | None = None
_model = None
_processor = None
_model_type: str | None = None

CMODEL_SOURCE = os.getenv("KAIROS_VLM_MODEL_SOURCE", "auto")
CMODEL_ID = os.getenv("KAIROS_VLM_MODEL_ID", "")
CMODEL_PATH = os.getenv("KAIROS_VLM_MODEL_PATH")

CDEFAULT_MLX_MODEL = "mlx-community/Qwen3-VL-4B-Instruct-8bit"
CLOCAL_MLX_VLM = "Qwen3-VL-4B-Instruct-8bit"
CDEFAULT_CUDA_MODEL = "Qwen/Qwen3.5-9B"
CLOCAL_TORCH_VLM = "Qwen3_5-9B"
CLEGACY_LOCAL_TORCH_VLM = "Qwen3-VL-4B-Instruct"
CTHINK_BLOCK_RE = re.compile(r"<think>.*?</think>\s*", re.DOTALL)
CWINDOWS_SAFE_GLOBAL_WORKERS = max(1, int(os.getenv("KAIROS_VLM_WINDOWS_GLOBAL_WORKERS", "1")))


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


# ── MLX backend ──────────────────────────────────────────────

def _resolve_mlx_ref() -> str:
    if CMODEL_PATH or CMODEL_ID:
        return CMODEL_PATH or CMODEL_ID
    local = _repo_root() / "models" / CLOCAL_MLX_VLM
    return str(local) if local.exists() else CDEFAULT_MLX_MODEL


def _load_mlx() -> tuple[float, str]:
    global _backend_loaded, _model, _processor
    model_ref = _resolve_mlx_ref()
    if _backend_loaded == "mlx":
        return 0.0, model_ref

    from mlx_vlm import load  # type: ignore

    started_at = time.perf_counter()
    _model, _processor = load(model_ref)
    _backend_loaded = "mlx"
    return (time.perf_counter() - started_at) * 1000.0, model_ref


def _analyze_mlx(image_paths: list[str], prompt: str) -> tuple[str, dict]:
    from mlx_vlm import generate, apply_chat_template  # type: ignore

    total_started_at = time.perf_counter()
    abs_paths = [str(Path(p).resolve()) for p in image_paths]
    prompt_text = (
        f"{prompt}\n"
        "Return only one JSON object and do not wrap it in markdown."
    )
    prep_started_at = time.perf_counter()
    formatted = apply_chat_template(
        _processor, _model.config, prompt_text,
        num_images=len(abs_paths),
    )
    processor_ms = (time.perf_counter() - prep_started_at) * 1000.0
    generate_started_at = time.perf_counter()
    result = generate(
        _model, _processor, formatted, image=abs_paths,
        max_tokens=512, temperature=0.1, verbose=False,
    )
    generate_ms = (time.perf_counter() - generate_started_at) * 1000.0
    text = result.text if hasattr(result, "text") else str(result)
    return text, {
        "backend": BACKEND,
        "totalMs": (time.perf_counter() - total_started_at) * 1000.0,
        "loadMs": 0.0,
        "imageOpenMs": 0.0,
        "processorMs": processor_ms,
        "h2dMs": 0.0,
        "generateMs": generate_ms,
        "decodeMs": 0.0,
        "modelRef": _resolve_mlx_ref(),
    }


# ── Torch backend (CUDA / CPU) ──────────────────────────────

def _default_local_model_path() -> Path | None:
    candidates = [
        _repo_root() / "models" / CLOCAL_TORCH_VLM,
        _repo_root() / "models" / CLEGACY_LOCAL_TORCH_VLM,
    ]
    for candidate in candidates:
        if candidate.exists():
            return candidate
    return None


def _resolve_transformers_ref() -> str:
    if CMODEL_PATH:
        return CMODEL_PATH
    default_local = _default_local_model_path()
    if default_local is not None:
        return str(default_local)

    model_id = CMODEL_ID or CDEFAULT_CUDA_MODEL
    source = CMODEL_SOURCE.strip().lower()
    if source == "modelscope" or (source == "auto" and DEVICE == "cuda"):
        from modelscope import snapshot_download
        return snapshot_download(model_id)
    return model_id


def _resolve_transformers_model_class(model_ref: str):
    from transformers import AutoConfig, Qwen3VLForConditionalGeneration, Qwen3_5ForConditionalGeneration

    config = AutoConfig.from_pretrained(model_ref)
    model_type = str(getattr(config, "model_type", "") or "").strip().lower()
    if model_type == "qwen3_5":
        return Qwen3_5ForConditionalGeneration, model_type
    return Qwen3VLForConditionalGeneration, model_type


def _should_disable_thinking() -> bool:
    return _model_type == "qwen3_5"


def _strip_reasoning_output(text: str) -> str:
    if not text:
        return text

    normalized = text.strip()
    if "</think>" in normalized:
        normalized = normalized.split("</think>")[-1].strip()
    normalized = CTHINK_BLOCK_RE.sub("", normalized).strip()
    return normalized


def _windows_safe_transformers_global_workers() -> int | None:
    if os.name != "nt" or DEVICE != "cuda":
        return None
    return CWINDOWS_SAFE_GLOBAL_WORKERS


def _configure_transformers_loading() -> None:
    target_workers = _windows_safe_transformers_global_workers()
    if target_workers is None:
        return

    # Windows/CUDA can crash when transformers materializes many shards
    # in parallel immediately after Whisper has been unloaded.
    import transformers.core_model_loading as core_model_loading

    if getattr(core_model_loading, "GLOBAL_WORKERS", None) == target_workers:
        return
    core_model_loading.GLOBAL_WORKERS = target_workers


def _load_transformers() -> tuple[float, str]:
    global _backend_loaded, _model, _processor, _model_type
    model_ref = _resolve_transformers_ref()
    if _backend_loaded == "torch":
        return 0.0, model_ref

    import torch
    from transformers import AutoProcessor

    started_at = time.perf_counter()
    _configure_transformers_loading()
    _processor = AutoProcessor.from_pretrained(model_ref)
    model_cls, _model_type = _resolve_transformers_model_class(model_ref)

    if DEVICE == "cuda":
        _model = model_cls.from_pretrained(
            model_ref, torch_dtype=torch.float16,
            device_map="auto", attn_implementation="sdpa",
        ).eval()
    else:
        _model = model_cls.from_pretrained(
            model_ref, torch_dtype=torch.float32,
        ).eval().to("cpu")

    _backend_loaded = "torch"
    return (time.perf_counter() - started_at) * 1000.0, model_ref


def unload() -> bool:
    global _backend_loaded, _model, _processor, _model_type
    if _backend_loaded is None and _model is None and _processor is None and _model_type is None:
        return False

    model_ref = _model
    processor_ref = _processor
    model_type_ref = _model_type
    _backend_loaded = None
    _model = None
    _processor = None
    _model_type = None
    del model_ref
    del processor_ref
    del model_type_ref
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


def _analyze_transformers(image_paths: list[str], prompt: str) -> tuple[str, dict]:
    import torch
    from PIL import Image

    total_started_at = time.perf_counter()
    prompt_text = (
        f"{prompt}\n"
        "Return only one JSON object and do not wrap it in markdown."
    )
    messages = [{
        "role": "user",
        "content": [
            *[{"type": "image", "image": str(Path(p).resolve())} for p in image_paths],
            {"type": "text", "text": prompt_text},
        ],
    }]
    chat_template_kwargs = {
        "tokenize": False,
        "add_generation_prompt": True,
    }
    if _should_disable_thinking():
        chat_template_kwargs["enable_thinking"] = False
    text = _processor.apply_chat_template(messages, **chat_template_kwargs)

    image_open_started_at = time.perf_counter()
    images = [Image.open(p).convert("RGB") for p in image_paths]
    image_open_ms = (time.perf_counter() - image_open_started_at) * 1000.0
    processor_started_at = time.perf_counter()
    inputs = _processor(text=[text], images=images, padding=True, return_tensors="pt")
    processor_ms = (time.perf_counter() - processor_started_at) * 1000.0
    inputs.pop("token_type_ids", None)
    h2d_ms = 0.0
    if DEVICE == "cuda":
        h2d_started_at = time.perf_counter()
        inputs = {k: v.to("cuda") if hasattr(v, "to") else v for k, v in inputs.items()}
        h2d_ms = (time.perf_counter() - h2d_started_at) * 1000.0

    generate_started_at = time.perf_counter()
    with torch.no_grad():
        generated_ids = _model.generate(**inputs, max_new_tokens=512)
    generate_ms = (time.perf_counter() - generate_started_at) * 1000.0

    trimmed = [out[len(inp):] for inp, out in zip(inputs["input_ids"], generated_ids)]
    decode_started_at = time.perf_counter()
    outputs = _processor.batch_decode(
        trimmed, skip_special_tokens=True, clean_up_tokenization_spaces=False,
    )
    decode_ms = (time.perf_counter() - decode_started_at) * 1000.0
    return _strip_reasoning_output(outputs[0] if outputs else ""), {
        "backend": BACKEND,
        "totalMs": (time.perf_counter() - total_started_at) * 1000.0,
        "loadMs": 0.0,
        "imageOpenMs": image_open_ms,
        "processorMs": processor_ms,
        "h2dMs": h2d_ms,
        "generateMs": generate_ms,
        "decodeMs": decode_ms,
        "modelRef": "",
    }


# ── Public API ───────────────────────────────────────────────

def analyze(image_paths: list[str], prompt: str) -> tuple[str, dict]:
    if not image_paths:
        raise ValueError("No images provided for VLM analysis")

    if BACKEND == "mlx":
        load_ms, model_ref = _load_mlx()
        description, timing = _analyze_mlx(image_paths, prompt)
        timing["loadMs"] = load_ms
        timing["modelRef"] = model_ref
        return description, timing
    load_ms, model_ref = _load_transformers()
    description, timing = _analyze_transformers(image_paths, prompt)
    timing["loadMs"] = load_ms
    timing["modelRef"] = model_ref
    return description, timing
