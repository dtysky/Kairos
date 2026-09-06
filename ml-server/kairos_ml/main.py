from concurrent.futures import Future
from dataclasses import dataclass
import os
import queue
import threading
import time
import json
from urllib import request as urllib_request
from urllib.error import HTTPError, URLError

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


CASR_BATCH_MAX_ITEMS = _read_positive_int_env("KAIROS_ASR_BATCH_MAX_ITEMS", 1)
CASR_BATCH_MAX_WAIT_MS = _read_positive_int_env("KAIROS_ASR_BATCH_MAX_WAIT_MS", 40)
CASR_PREPROCESS_MAX_CONCURRENCY = _read_positive_int_env("KAIROS_ASR_PREPROCESS_MAX_CONCURRENCY", 3)
CASR_WORKER_URL = os.getenv("KAIROS_ASR_WORKER_URL", "").strip().rstrip("/")

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

class TextGenerateRequest(BaseModel):
    prompt: str
    keep_other_models_loaded: bool = False
    max_tokens: int | None = None
    temperature: float | None = None

# ─── State ────────────────────────────────────────────────────

_loaded: set[str] = set()
_asr_worker_state_lock = threading.Lock()
_asr_worker_released = False
_last_asr_worker_status: dict = {}


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

    def submit(self, audio_path: str, language: str | None) -> tuple[str, list[dict], list[dict], dict]:
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
            from .asr_router import transcribe_many

            results = transcribe_many(
                [(item.audio_path, item.language) for item in batch],
                preprocess_max_concurrency=self._preprocess_max_concurrency,
            )
            for item, (raw_text, segments, words, timing) in zip(batch, results):
                payload_timing = dict(timing or {})
                elapsed_ms = (time.perf_counter() - item.submitted_at) * 1000.0
                queue_wait_ms = max(0.0, elapsed_ms - float(payload_timing.get("totalMs") or 0.0))
                payload_timing["queueWaitMs"] = queue_wait_ms
                payload_timing["batched"] = len(batch) > 1
                payload_timing["batchSize"] = len(batch)
                item.future.set_result((raw_text, segments, words, payload_timing))
        except Exception as exc:
            for item in batch:
                item.future.set_exception(exc)


_asr_batcher = _AsrBatcher(
    max_items=CASR_BATCH_MAX_ITEMS,
    max_wait_ms=CASR_BATCH_MAX_WAIT_MS,
    preprocess_max_concurrency=CASR_PREPROCESS_MAX_CONCURRENCY,
)


def _unload_asr():
    if CASR_WORKER_URL:
        try:
            _worker_json("/asr/unload", {})
        except Exception:
            pass
        return
    try:
        from .asr_router import unload

        if unload():
            for name in list(_loaded):
                if name.startswith("asr:"):
                    _loaded.discard(name)
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

def _worker_json(path: str, body: dict | None = None) -> dict:
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib_request.Request(
        f"{CASR_WORKER_URL}{path}",
        data=data,
        headers={"Content-Type": "application/json"},
        method="GET" if body is None else "POST",
    )
    try:
        with urllib_request.urlopen(req, timeout=30 if path == "/health" else 24 * 60 * 60) as response:
            return json.loads(response.read().decode("utf-8"))
    except HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"ASR worker {path} returned HTTP {error.code}: {detail}") from error


def _asr_status_and_limits() -> tuple[dict, dict]:
    global _asr_worker_released, _last_asr_worker_status
    if not CASR_WORKER_URL:
        from .asr_router import get_status
        status = get_status()
        status["lifecycleState"] = "ready" if status.get("available") is True else "unavailable"
        return status, {
            "asrBatchMaxItems": CASR_BATCH_MAX_ITEMS,
            "asrBatchMaxWaitMs": CASR_BATCH_MAX_WAIT_MS,
            "asrPreprocessMaxConcurrency": CASR_PREPROCESS_MAX_CONCURRENCY,
            "asrMode": status.get("provider") or "unavailable",
            "asrQueuedRequests": _asr_batcher.queued_requests(),
        }
    try:
        worker = _worker_json("/health")
        status = dict(worker.get("asr") or {})
        status["workerRuntimeVariant"] = status.get("runtimeVariant")
        status["runtimeVariant"] = "transformers-cuda-worker"
        status["lifecycleState"] = "ready" if status.get("available") is True else "unavailable"
        with _asr_worker_state_lock:
            _asr_worker_released = False
            _last_asr_worker_status = dict(status)
        return status, dict(worker.get("limits") or {})
    except Exception as exc:
        with _asr_worker_state_lock:
            released = _asr_worker_released
            last_status = dict(_last_asr_worker_status)
        if released:
            last_status.update({
                "configuredBackend": "qwen3",
                "actualBackend": "qwen3",
                "available": False,
                "runtimeVariant": "transformers-cuda-worker",
                "lifecycleState": "released",
            })
            last_status.pop("blocker", None)
            return last_status, {"asrMode": "released", "asrQueuedRequests": 0}
        return {
            "configuredBackend": "qwen3",
            "actualBackend": "qwen3",
            "available": False,
            "runtimeVariant": "transformers-cuda-worker",
            "lifecycleState": "unavailable",
            "blocker": f"Qwen ASR worker unavailable: {exc}",
        }, {"asrMode": "unavailable", "asrQueuedRequests": 0}

@app.get("/health")
def health():
    asr_status, limits = _asr_status_and_limits()
    return {
        "status": "ok",
        "device": DEVICE,
        "backend": BACKEND,
        "models_loaded": sorted(_loaded),
        "asr": asr_status,
        "limits": limits,
    }


@app.post("/asr")
def asr(req: AsrRequest):
    global _asr_worker_released
    try:
        # Kairos normally switches model residency when moving between ASR and VLM.
        # keep_other_models_loaded is only an explicit override for non-default flows.
        if not req.keep_other_models_loaded:
            _unload_vlm()
        if CASR_WORKER_URL:
            response = _worker_json("/asr", req.model_dump() if hasattr(req, "model_dump") else req.dict())
            with _asr_worker_state_lock:
                _asr_worker_released = False
            return response
        raw_text, segments, words, timing = _asr_batcher.submit(req.audio_path, req.language)
        actual_backend = str(timing.get("provider") or timing.get("backend") or "unknown")
        _loaded.add(f"asr:{actual_backend}")
        return {"rawText": raw_text, "segments": segments, "words": words, "timing": timing}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/asr/unload")
def asr_unload():
    global _asr_worker_released
    try:
        if CASR_WORKER_URL:
            try:
                _worker_json("/asr/shutdown", {})
            except (URLError, ConnectionError, TimeoutError):
                # The gateway intentionally keeps running after the dedicated
                # ASR process exits. Repeated unload calls must therefore be
                # safe when the worker is already gone.
                pass
            with _asr_worker_state_lock:
                _asr_worker_released = True
            return {"unloaded": True, "workerStopped": True}
        _unload_asr()
        return {"unloaded": True, "workerStopped": False}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/asr/shutdown")
def asr_shutdown():
    """Stop a dedicated ASR worker after its model has been unloaded."""
    if CASR_WORKER_URL:
        raise HTTPException(status_code=400, detail="ASR gateway cannot be shut down through the worker endpoint")
    try:
        _unload_asr()
        threading.Timer(0.2, lambda: os._exit(0)).start()
        return {"unloaded": True, "workerStopped": True}
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
        # The default Kairos hot path unloads the configured ASR backend before entering VLM so the
        # ASR and finalize stages do not keep both models resident together.
        if not req.keep_other_models_loaded:
            _unload_asr()
        from .vlm_runner import analyze
        _loaded.add("vlm")
        description, timing = analyze(req.image_paths, req.prompt, max_tokens=req.max_tokens)
        return {"description": description, "timing": timing}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/text/generate")
def text_generate(req: TextGenerateRequest):
    try:
        # Text generation reuses the qwen VLM/text residency path but does not
        # open image inputs. It still unloads the configured ASR backend by default to keep the
        # same one-heavy-model-at-a-time policy as VLM analysis.
        if not req.keep_other_models_loaded:
            _unload_asr()
        from .vlm_runner import generate_text
        _loaded.add("vlm")
        text, timing = generate_text(
            req.prompt,
            max_tokens=req.max_tokens,
            temperature=req.temperature,
        )
        return {"text": text, "timing": timing}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


def run():
    uvicorn.run(app, host="127.0.0.1", port=8910)


if __name__ == "__main__":
    run()
