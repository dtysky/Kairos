import os

from modelscope import snapshot_download
from transformers import AutoModelForCausalLM, AutoTokenizer
from transformers.generation import GenerationConfig

from .device import DEVICE

_model = None
_tokenizer = None

CMODEL_ID = os.getenv("KAIROS_VLM_MODEL_ID", "qwen/Qwen-VL-Chat")
CMODEL_SOURCE = os.getenv("KAIROS_VLM_MODEL_SOURCE", "modelscope")
CMODEL_PATH = os.getenv("KAIROS_VLM_MODEL_PATH")


def _resolve_model_ref() -> str:
    if CMODEL_PATH:
        return CMODEL_PATH
    if CMODEL_SOURCE == "modelscope":
        return snapshot_download(CMODEL_ID)
    if CMODEL_SOURCE == "huggingface":
        if "/" not in CMODEL_ID or CMODEL_ID.startswith("qwen/"):
            return "Qwen/Qwen-VL-Chat"
        return CMODEL_ID
    raise ValueError(f"Unsupported VLM model source: {CMODEL_SOURCE}")


def _load():
    global _model, _tokenizer
    if _model is not None:
        return

    model_ref = _resolve_model_ref()
    _tokenizer = AutoTokenizer.from_pretrained(model_ref, trust_remote_code=True)

    if DEVICE == "cuda":
        _model = AutoModelForCausalLM.from_pretrained(
            model_ref,
            device_map="cuda",
            trust_remote_code=True,
            fp16=True,
        ).eval()
    else:
        _model = AutoModelForCausalLM.from_pretrained(
            model_ref,
            device_map="cpu",
            trust_remote_code=True,
        ).eval()

    _model.generation_config = GenerationConfig.from_pretrained(
        model_ref,
        trust_remote_code=True,
    )


def analyze(image_paths: list[str], prompt: str) -> str:
    if not image_paths:
        raise ValueError("No images provided for VLM analysis")

    _load()
    query_items = [{"image": os.path.abspath(path)} for path in image_paths]
    query_items.append(
        {
            "text": (
                f"{prompt}\n"
                "Return only one JSON object and do not wrap it in markdown."
            ),
        },
    )
    query = _tokenizer.from_list_format(query_items)
    response, _history = _model.chat(_tokenizer, query=query, history=None)
    return response
