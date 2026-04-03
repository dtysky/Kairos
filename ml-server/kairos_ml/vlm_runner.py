"""
VLM (Vision Language Model) runner with two backends:
  - MLX:   mlx-vlm + Qwen3-VL quantized  (Apple Silicon, no PyTorch)
  - Torch: transformers + Qwen3-VL        (CUDA / CPU)
"""
from __future__ import annotations

import os
import time
from pathlib import Path

from .device import DEVICE, BACKEND

_backend_loaded: str | None = None
_model = None
_processor = None

CMODEL_SOURCE = os.getenv("KAIROS_VLM_MODEL_SOURCE", "auto")
CMODEL_ID = os.getenv("KAIROS_VLM_MODEL_ID", "")
CMODEL_PATH = os.getenv("KAIROS_VLM_MODEL_PATH")

CDEFAULT_MLX_MODEL = "mlx-community/Qwen3-VL-4B-Instruct-8bit"
CLOCAL_MLX_VLM = "Qwen3-VL-4B-Instruct-8bit"
CDEFAULT_CUDA_MODEL = "Qwen/Qwen3-VL-4B-Instruct"


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

def _default_local_model_path() -> Path:
    return _repo_root() / "models" / "Qwen3-VL-4B-Instruct"


def _resolve_transformers_ref() -> str:
    if CMODEL_PATH:
        return CMODEL_PATH
    default_local = _default_local_model_path()
    if default_local.exists():
        return str(default_local)

    model_id = CMODEL_ID or CDEFAULT_CUDA_MODEL
    source = CMODEL_SOURCE.strip().lower()
    if source == "modelscope" or (source == "auto" and DEVICE == "cuda"):
        from modelscope import snapshot_download
        return snapshot_download(model_id)
    return model_id


def _load_transformers() -> tuple[float, str]:
    global _backend_loaded, _model, _processor
    model_ref = _resolve_transformers_ref()
    if _backend_loaded == "torch":
        return 0.0, model_ref

    import torch
    from transformers import AutoProcessor, Qwen3VLForConditionalGeneration

    started_at = time.perf_counter()
    _processor = AutoProcessor.from_pretrained(model_ref)

    if DEVICE == "cuda":
        _model = Qwen3VLForConditionalGeneration.from_pretrained(
            model_ref, dtype=torch.float16,
            device_map="auto", attn_implementation="sdpa",
        ).eval()
    else:
        _model = Qwen3VLForConditionalGeneration.from_pretrained(
            model_ref, dtype=torch.float32,
        ).eval().to("cpu")

    _backend_loaded = "torch"
    return (time.perf_counter() - started_at) * 1000.0, model_ref


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
    text = _processor.apply_chat_template(
        messages, tokenize=False, add_generation_prompt=True,
    )

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
    return (outputs[0] if outputs else ""), {
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
