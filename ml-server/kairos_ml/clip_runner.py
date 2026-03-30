"""
CLIP image embedding with two backends:
  - MLX:   mlx_clip  (Apple Silicon, no PyTorch)
  - Torch: open-clip-torch  (CUDA / CPU)
"""
from __future__ import annotations

from pathlib import Path

from .device import DEVICE, BACKEND

_backend_loaded: str | None = None
_model = None
_preprocess = None
_tokenizer = None

CCLIP_HF_REPO = "openai/clip-vit-base-patch32"
CLOCAL_CLIP = "clip-vit-base-patch32"
COPEN_CLIP_ARCH = "ViT-B-32"
COPEN_CLIP_PRETRAINED = "laion2b_s34b_b79k"


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


# ── MLX backend ─────────────────────────────────────────────

def _load_mlx():
    global _backend_loaded, _model
    if _backend_loaded == "mlx":
        return

    from mlx_clip import mlx_clip  # type: ignore

    local = _repo_root() / "models" / CLOCAL_CLIP
    _model = mlx_clip(str(local), hf_repo=CCLIP_HF_REPO)
    _backend_loaded = "mlx"


def _embed_mlx(image_paths: list[str]) -> list[list[float]]:
    results: list[list[float]] = []
    for path in image_paths:
        embedding = _model.image_encoder(path)
        if hasattr(embedding, "tolist"):
            vec = embedding.tolist()
        else:
            vec = list(embedding)
        if isinstance(vec[0], list):
            vec = vec[0]
        results.append(vec)
    return results


# ── Torch backend ────────────────────────────────────────────

def _load_torch():
    global _backend_loaded, _model, _preprocess, _tokenizer
    if _backend_loaded == "torch":
        return

    import open_clip
    import torch  # noqa: F401

    _model, _, _preprocess = open_clip.create_model_and_transforms(
        COPEN_CLIP_ARCH, pretrained=COPEN_CLIP_PRETRAINED,
    )
    _model = _model.to(DEVICE).eval()
    _tokenizer = open_clip.get_tokenizer(COPEN_CLIP_ARCH)
    _backend_loaded = "torch"


def _embed_torch(image_paths: list[str]) -> list[list[float]]:
    import torch
    from PIL import Image

    images = []
    for p in image_paths:
        img = _preprocess(Image.open(p).convert("RGB")).unsqueeze(0)
        images.append(img)

    batch = torch.cat(images).to(DEVICE)
    with torch.no_grad():
        features = _model.encode_image(batch)
        features = features / features.norm(dim=-1, keepdim=True)

    return features.cpu().tolist()


# ── Public API ───────────────────────────────────────────────

def embed_images(image_paths: list[str]) -> list[list[float]]:
    if BACKEND == "mlx":
        _load_mlx()
        return _embed_mlx(image_paths)
    _load_torch()
    return _embed_torch(image_paths)
