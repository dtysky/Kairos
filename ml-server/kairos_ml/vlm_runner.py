from transformers import AutoProcessor, AutoModelForCausalLM
from PIL import Image
import torch
from .device import DEVICE

_model = None
_processor = None

CMODEL_ID = "microsoft/Florence-2-large"


def _load():
    global _model, _processor
    if _model is not None:
        return
    dtype = torch.float16 if DEVICE == "cuda" else torch.float32
    _processor = AutoProcessor.from_pretrained(CMODEL_ID, trust_remote_code=True)
    _model = AutoModelForCausalLM.from_pretrained(
        CMODEL_ID, torch_dtype=dtype, trust_remote_code=True,
    ).to(DEVICE).eval()


def analyze(image_paths: list[str], prompt: str) -> str:
    _load()
    images = [Image.open(p).convert("RGB") for p in image_paths]
    # Use first image for single-image VLM; multi-image concat for context
    image = images[0] if len(images) == 1 else _tile_images(images)

    inputs = _processor(text=prompt, images=image, return_tensors="pt").to(DEVICE)
    with torch.no_grad():
        ids = _model.generate(
            **inputs,
            max_new_tokens=512,
            num_beams=3,
            early_stopping=True,
        )
    result = _processor.batch_decode(ids, skip_special_tokens=True)[0]
    return result


def _tile_images(images: list[Image.Image], cols: int = 3) -> Image.Image:
    """Tile multiple images into a grid for multi-image context."""
    if not images:
        raise ValueError("No images to tile")

    w = max(img.width for img in images)
    h = max(img.height for img in images)
    rows = (len(images) + cols - 1) // cols
    grid = Image.new("RGB", (w * cols, h * rows))

    for i, img in enumerate(images):
        r, c = divmod(i, cols)
        resized = img.resize((w, h))
        grid.paste(resized, (c * w, r * h))

    return grid
