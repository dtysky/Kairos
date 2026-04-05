from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
import uvicorn

from .device import DEVICE, BACKEND

app = FastAPI(title="Kairos ML Server")

# ─── Models ───────────────────────────────────────────────────

class AsrRequest(BaseModel):
    audio_path: str
    language: str | None = None
    keep_other_models_loaded: bool = False

class OcrRequest(BaseModel):
    image_path: str

class ClipEmbedRequest(BaseModel):
    image_paths: list[str]

class VlmRequest(BaseModel):
    image_paths: list[str]
    prompt: str
    keep_other_models_loaded: bool = False

# ─── State ────────────────────────────────────────────────────

_loaded: set[str] = set()


def _unload_whisper():
    try:
        from .whisper_runner import unload

        if unload():
            _loaded.discard("whisper")
    except Exception:
        return


def _unload_vlm():
    try:
        from .vlm_runner import unload

        if unload():
            _loaded.discard("vlm")
    except Exception:
        return

# ─── Routes ───────────────────────────────────────────────────

@app.get("/health")
def health():
    return {
        "status": "ok",
        "device": DEVICE,
        "backend": BACKEND,
        "models_loaded": sorted(_loaded),
    }


@app.post("/asr")
def asr(req: AsrRequest):
    try:
        # Analyze finalize may chain ASR -> decision VLM for the same asset.
        # Allow callers to keep both models resident for that hot path.
        if not req.keep_other_models_loaded:
            _unload_vlm()
        from .whisper_runner import transcribe
        _loaded.add("whisper")
        segments, timing = transcribe(req.audio_path, req.language)
        return {"segments": segments, "timing": timing}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/ocr")
def ocr(req: OcrRequest):
    try:
        from .ocr_runner import run_ocr
        _loaded.add("ocr")
        texts = run_ocr(req.image_path)
        return {"texts": texts}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/clip/embed")
def clip_embed(req: ClipEmbedRequest):
    try:
        from .clip_runner import embed_images
        _loaded.add("clip")
        embeddings = embed_images(req.image_paths)
        return {"embeddings": embeddings}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/vlm/analyze")
def vlm_analyze(req: VlmRequest):
    try:
        if not req.keep_other_models_loaded:
            _unload_whisper()
        from .vlm_runner import analyze
        _loaded.add("vlm")
        description, timing = analyze(req.image_paths, req.prompt)
        return {"description": description, "timing": timing}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


def run():
    uvicorn.run(app, host="127.0.0.1", port=8910)


if __name__ == "__main__":
    run()
