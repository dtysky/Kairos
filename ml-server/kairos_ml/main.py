from concurrent.futures import Future
from dataclasses import dataclass
import os
import queue
import threading
import time

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
import uvicorn

from .device import DEVICE, BACKEND

app = FastAPI(title="Kairos ML Server")

def _read_positive_int_env(name: str, default: int) -> int:
    raw = os.getenv(name, "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        return default
    return max(1, value)


CASR_BATCH_MAX_ITEMS = _read_positive_int_env("KAIROS_ASR_BATCH_MAX_ITEMS", 4)
CASR_BATCH_MAX_WAIT_MS = _read_positive_int_env("KAIROS_ASR_BATCH_MAX_WAIT_MS", 40)
CASR_PREPROCESS_MAX_CONCURRENCY = _read_positive_int_env("KAIROS_ASR_PREPROCESS_MAX_CONCURRENCY", 3)

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
    max_tokens: int | None = None

# ─── State ────────────────────────────────────────────────────

_loaded: set[str] = set()


@dataclass
class _AsrBatchItem:
    audio_path: str
    language: str | None
    submitted_at: float
    future: Future


class _AsrBatcher:
    def __init__(self, max_items: int, max_wait_ms: int, preprocess_max_concurrency: int):
        self._max_items = max_items
        self._max_wait_ms = max_wait_ms
        self._preprocess_max_concurrency = preprocess_max_concurrency
        self._queue: queue.Queue[_AsrBatchItem] = queue.Queue()
        self._thread = threading.Thread(target=self._run, name="kairos-asr-batcher", daemon=True)
        self._thread.start()

    def submit(self, audio_path: str, language: str | None) -> tuple[list[dict], dict]:
        future: Future = Future()
        self._queue.put(_AsrBatchItem(
            audio_path=audio_path,
            language=language,
            submitted_at=time.perf_counter(),
            future=future,
        ))
        return future.result()

    def queued_requests(self) -> int:
        return self._queue.qsize()

    def _run(self):
        while True:
            batch = self._drain_batch()
            self._process_batch(batch)

    def _drain_batch(self) -> list[_AsrBatchItem]:
        first = self._queue.get()
        batch = [first]
        deadline = time.perf_counter() + (self._max_wait_ms / 1000.0)
        while len(batch) < self._max_items:
            timeout = deadline - time.perf_counter()
            if timeout <= 0:
                break
            try:
                batch.append(self._queue.get(timeout=timeout))
            except queue.Empty:
                break
        return batch

    def _process_batch(self, batch: list[_AsrBatchItem]):
        try:
            from .whisper_runner import transcribe_many

            results = transcribe_many(
                [(item.audio_path, item.language) for item in batch],
                preprocess_max_concurrency=self._preprocess_max_concurrency,
            )
            for item, (segments, timing) in zip(batch, results):
                payload_timing = dict(timing or {})
                elapsed_ms = (time.perf_counter() - item.submitted_at) * 1000.0
                queue_wait_ms = max(0.0, elapsed_ms - float(payload_timing.get("totalMs") or 0.0))
                payload_timing["queueWaitMs"] = queue_wait_ms
                payload_timing["batched"] = BACKEND == "torch" and len(batch) > 1
                payload_timing["batchSize"] = len(batch) if BACKEND == "torch" else 1
                item.future.set_result((segments, payload_timing))
        except Exception as exc:
            for item in batch:
                item.future.set_exception(exc)


_asr_batcher = _AsrBatcher(
    max_items=CASR_BATCH_MAX_ITEMS,
    max_wait_ms=CASR_BATCH_MAX_WAIT_MS,
    preprocess_max_concurrency=CASR_PREPROCESS_MAX_CONCURRENCY,
)


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
        "limits": {
            "asrBatchMaxItems": CASR_BATCH_MAX_ITEMS,
            "asrBatchMaxWaitMs": CASR_BATCH_MAX_WAIT_MS,
            "asrPreprocessMaxConcurrency": CASR_PREPROCESS_MAX_CONCURRENCY,
            "asrMode": "torch-batched" if BACKEND == "torch" else "mlx-single-inference",
            "asrQueuedRequests": _asr_batcher.queued_requests(),
        },
    }


@app.post("/asr")
def asr(req: AsrRequest):
    try:
        # Kairos normally switches model residency when moving between ASR and VLM.
        # keep_other_models_loaded is only an explicit override for non-default flows.
        if not req.keep_other_models_loaded:
            _unload_vlm()
        _loaded.add("whisper")
        segments, timing = _asr_batcher.submit(req.audio_path, req.language)
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
        # The default Kairos hot path unloads Whisper before entering VLM so the
        # ASR and finalize stages do not keep both models resident together.
        if not req.keep_other_models_loaded:
            _unload_whisper()
        from .vlm_runner import analyze
        _loaded.add("vlm")
        description, timing = analyze(req.image_paths, req.prompt, max_tokens=req.max_tokens)
        return {"description": description, "timing": timing}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


def run():
    uvicorn.run(app, host="127.0.0.1", port=8910)


if __name__ == "__main__":
    run()
