"""
Platform / accelerator detection.

On macOS Apple Silicon the ML server runs a pure-MLX stack (mlx-vlm,
mlx-whisper, mlx_clip) — no PyTorch required.

On CUDA machines the server uses the PyTorch / transformers stack.

DEVICE is one of: "cuda", "mps", "cpu"
BACKEND is one of: "mlx", "torch"
"""
from __future__ import annotations

import os
import sys


def _is_apple_silicon() -> bool:
    if sys.platform != "darwin":
        return False
    import platform
    return platform.machine() == "arm64"


def detect_device() -> str:
    try:
        import torch
        if torch.cuda.is_available():
            return "cuda"
        if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            return "mps"
    except ImportError:
        if _is_apple_silicon():
            return "mps"
    return "cpu"


def detect_backend() -> str:
    forced = os.getenv("KAIROS_ML_BACKEND", "").strip().lower()
    if forced in ("mlx", "torch"):
        return forced
    if _is_apple_silicon():
        return "mlx"
    return "torch"


DEVICE = detect_device()
BACKEND = detect_backend()
