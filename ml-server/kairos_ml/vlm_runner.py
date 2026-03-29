"""
VLM (Vision Language Model) runner with two backends:
  - MLX:   mlx-vlm + Qwen3-VL quantized  (Apple Silicon, no PyTorch)
  - Torch: transformers + Qwen3-VL        (CUDA / CPU)
"""
from __future__ import annotations

import os
from pathlib import Path

from .device import DEVICE, BACKEND

_backend_loaded: str | None = None
_model = None
_processor = None

CMODEL_SOURCE = os.getenv("KAIROS_VLM_MODEL_SOURCE", "auto")
CMODEL_ID = os.getenv("KAIROS_VLM_MODEL_ID", "")
CMODEL_PATH = os.getenv("KAIROS_VLM_MODEL_PATH")

CDEFAULT_MLX_MODEL = "mlx-community/Qwen3-VL-4B-Instruct-8bit"
CDEFAULT_CUDA_MODEL = "Qwen/Qwen3-VL-4B-Instruct"


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


# ── MLX backend ──────────────────────────────────────────────

def _load_mlx():
    global _backend_loaded, _model, _processor
    if _backend_loaded == "mlx":
        return

    from mlx_vlm import load  # type: ignore

    model_ref = CMODEL_PATH or CMODEL_ID or CDEFAULT_MLX_MODEL
    _model, _processor = load(model_ref)
    _backend_loaded = "mlx"


def _analyze_mlx(image_paths: list[str], prompt: str) -> str:
    from mlx_vlm import generate, apply_chat_template  # type: ignore

    abs_paths = [str(Path(p).resolve()) for p in image_paths]
    prompt_text = (
        f"{prompt}\n"
        "Return only one JSON object and do not wrap it in markdown."
    )
    formatted = apply_chat_template(_processor, _model.config, prompt_text, abs_paths)
    return generate(
        _model, _processor, formatted, abs_paths,
        max_tokens=512, temperature=0.1, verbose=False,
    )


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


def _load_transformers():
    global _backend_loaded, _model, _processor
    if _backend_loaded == "torch":
        return

    import torch
    from transformers import AutoProcessor, Qwen3VLForConditionalGeneration

    model_ref = _resolve_transformers_ref()
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


def _analyze_transformers(image_paths: list[str], prompt: str) -> str:
    import torch
    from PIL import Image

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

    images = [Image.open(p).convert("RGB") for p in image_paths]
    inputs = _processor(text=[text], images=images, padding=True, return_tensors="pt")
    inputs.pop("token_type_ids", None)
    if DEVICE == "cuda":
        inputs = {k: v.to("cuda") if hasattr(v, "to") else v for k, v in inputs.items()}

    with torch.no_grad():
        generated_ids = _model.generate(**inputs, max_new_tokens=512)

    trimmed = [out[len(inp):] for inp, out in zip(inputs["input_ids"], generated_ids)]
    outputs = _processor.batch_decode(
        trimmed, skip_special_tokens=True, clean_up_tokenization_spaces=False,
    )
    return outputs[0] if outputs else ""


# ── Public API ───────────────────────────────────────────────

def analyze(image_paths: list[str], prompt: str) -> str:
    if not image_paths:
        raise ValueError("No images provided for VLM analysis")

    if BACKEND == "mlx":
        _load_mlx()
        return _analyze_mlx(image_paths, prompt)
    _load_transformers()
    return _analyze_transformers(image_paths, prompt)
