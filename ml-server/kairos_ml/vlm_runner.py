from __future__ import annotations

import os
from pathlib import Path

import torch
from modelscope import snapshot_download
from PIL import Image
from transformers import AutoProcessor, Qwen3VLForConditionalGeneration

from .device import DEVICE

_model = None
_processor = None

CMODEL_ID = os.getenv("KAIROS_VLM_MODEL_ID", "Qwen/Qwen3-VL-4B-Instruct")
CMODEL_SOURCE = os.getenv("KAIROS_VLM_MODEL_SOURCE", "modelscope")
CMODEL_PATH = os.getenv("KAIROS_VLM_MODEL_PATH")


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _default_local_model_path() -> Path:
    return _repo_root() / "models" / "Qwen3-VL-4B-Instruct"


def _resolve_model_ref() -> str:
    if CMODEL_PATH:
        return CMODEL_PATH
    default_local_path = _default_local_model_path()
    if default_local_path.exists():
        return str(default_local_path)
    if CMODEL_SOURCE == "modelscope":
        return snapshot_download(CMODEL_ID)
    if CMODEL_SOURCE == "huggingface":
        return CMODEL_ID
    raise ValueError(f"Unsupported VLM model source: {CMODEL_SOURCE}")


def _model_device() -> str:
    return "cuda" if DEVICE == "cuda" else "cpu"


def _load():
    global _model, _processor
    if _model is not None and _processor is not None:
        return

    model_ref = _resolve_model_ref()
    _processor = AutoProcessor.from_pretrained(model_ref)

    if DEVICE == "cuda":
        _model = Qwen3VLForConditionalGeneration.from_pretrained(
            model_ref,
            dtype=torch.float16,
            device_map="auto",
            attn_implementation="sdpa",
        ).eval()
    else:
        _model = Qwen3VLForConditionalGeneration.from_pretrained(
            model_ref,
            dtype=torch.float32,
        ).eval()
        _model = _model.to("cpu")


def _load_images(image_paths: list[str]) -> list[Image.Image]:
    images: list[Image.Image] = []
    for path in image_paths:
        with Image.open(path) as source:
            images.append(source.convert("RGB"))
    return images


def analyze(image_paths: list[str], prompt: str) -> str:
    if not image_paths:
        raise ValueError("No images provided for VLM analysis")

    _load()

    prompt_text = (
        f"{prompt}\n"
        "Return only one JSON object and do not wrap it in markdown."
    )
    messages = [
        {
            "role": "user",
            "content": [
                *[
                    {
                        "type": "image",
                        "image": str(Path(path).resolve()),
                    }
                    for path in image_paths
                ],
                {
                    "type": "text",
                    "text": prompt_text,
                },
            ],
        },
    ]
    text = _processor.apply_chat_template(
        messages,
        tokenize=False,
        add_generation_prompt=True,
    )
    images = _load_images(image_paths)
    inputs = _processor(
        text=[text],
        images=images,
        padding=True,
        return_tensors="pt",
    )
    inputs.pop("token_type_ids", None)
    if DEVICE == "cuda":
        inputs = {
            key: value.to(_model_device()) if hasattr(value, "to") else value
            for key, value in inputs.items()
        }

    generated_ids = _model.generate(**inputs, max_new_tokens=256)
    input_ids = inputs["input_ids"]
    generated_ids_trimmed = [
        output_ids[len(input_id):]
        for input_id, output_ids in zip(input_ids, generated_ids)
    ]
    outputs = _processor.batch_decode(
        generated_ids_trimmed,
        skip_special_tokens=True,
        clean_up_tokenization_spaces=False,
    )
    return outputs[0] if outputs else ""
