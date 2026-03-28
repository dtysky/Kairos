import open_clip
import torch
from PIL import Image
from .device import DEVICE

_model = None
_preprocess = None
_tokenizer = None


def _load():
    global _model, _preprocess, _tokenizer
    if _model is not None:
        return
    _model, _, _preprocess = open_clip.create_model_and_transforms(
        "ViT-B-32", pretrained="laion2b_s34b_b79k",
    )
    _model = _model.to(DEVICE).eval()
    _tokenizer = open_clip.get_tokenizer("ViT-B-32")


def embed_images(image_paths: list[str]) -> list[list[float]]:
    _load()
    images = []
    for p in image_paths:
        img = _preprocess(Image.open(p).convert("RGB")).unsqueeze(0)
        images.append(img)

    batch = torch.cat(images).to(DEVICE)
    with torch.no_grad():
        features = _model.encode_image(batch)
        features = features / features.norm(dim=-1, keepdim=True)

    return features.cpu().tolist()
