from faster_whisper import WhisperModel
from .device import DEVICE

_model: WhisperModel | None = None


def _get_model() -> WhisperModel:
    global _model
    if _model is None:
        compute = "float16" if DEVICE == "cuda" else "int8"
        _model = WhisperModel("large-v3", device=DEVICE, compute_type=compute)
    return _model


def transcribe(audio_path: str, language: str | None = None) -> list[dict]:
    model = _get_model()
    kwargs: dict = {}
    if language:
        kwargs["language"] = language
    segments, _ = model.transcribe(audio_path, **kwargs)
    return [
        {"start": s.start, "end": s.end, "text": s.text}
        for s in segments
    ]
