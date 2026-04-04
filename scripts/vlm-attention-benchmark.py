#!/usr/bin/env python3
"""
Benchmark Kairos VLM attention backends without touching the running ML server.

Examples:
  python scripts/vlm-attention-benchmark.py test/assets/frame-001.jpg
  python scripts/vlm-attention-benchmark.py a.jpg b.jpg --repeat 5 --warmup 1
  python scripts/vlm-attention-benchmark.py a.jpg --modes sdpa flash_attention_2 --output .tmp/vlm-bench.json
"""
from __future__ import annotations

import argparse
import gc
import json
import os
import statistics
import sys
import time
from pathlib import Path
from typing import Any


CDEFAULT_MODEL_ID = "Qwen/Qwen3-VL-4B-Instruct"
CDEFAULT_PROMPT = (
    "Summarize the provided image(s) as one JSON object with keys "
    '"scene", "notable_objects", and "camera_notes".'
)


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def _default_local_model_path() -> Path:
    return _repo_root() / "models" / "Qwen3-VL-4B-Instruct"


def _resolve_model_ref(explicit_ref: str | None) -> str:
    if explicit_ref:
        return explicit_ref

    env_path = os.getenv("KAIROS_VLM_MODEL_PATH")
    if env_path:
        return env_path

    local_model = _default_local_model_path()
    if local_model.exists():
        return str(local_model)

    env_id = os.getenv("KAIROS_VLM_MODEL_ID", "").strip()
    if env_id:
        return env_id

    return CDEFAULT_MODEL_ID


def _detect_device() -> str:
    import torch

    if torch.cuda.is_available():
        return "cuda"
    if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def _resolve_dtype(dtype_name: str, device: str) -> Any:
    import torch

    normalized = dtype_name.strip().lower()
    if normalized == "runner":
        return torch.float16 if device == "cuda" else torch.float32
    if normalized == "auto":
        return "auto"

    mapping = {
        "float16": torch.float16,
        "fp16": torch.float16,
        "bfloat16": torch.bfloat16,
        "bf16": torch.bfloat16,
        "float32": torch.float32,
        "fp32": torch.float32,
    }
    if normalized not in mapping:
        raise ValueError(f"Unsupported dtype: {dtype_name}")
    return mapping[normalized]


def _validate_images(image_paths: list[str]) -> list[str]:
    resolved: list[str] = []
    for raw_path in image_paths:
        path = Path(raw_path).expanduser().resolve()
        if not path.exists():
            raise FileNotFoundError(f"Image not found: {path}")
        resolved.append(str(path))
    return resolved


def _synchronize(device: str) -> None:
    if device == "cuda":
        import torch

        torch.cuda.synchronize()


def _cleanup_case(model: Any, processor: Any, device: str) -> None:
    del model
    del processor
    gc.collect()
    if device == "cuda":
        import torch

        torch.cuda.empty_cache()
        torch.cuda.ipc_collect()


def _load_case(model_ref: str, attn_mode: str, device: str, dtype_name: str) -> tuple[Any, Any, float]:
    from transformers import AutoProcessor, Qwen3VLForConditionalGeneration

    dtype = _resolve_dtype(dtype_name, device)
    started_at = time.perf_counter()
    processor = AutoProcessor.from_pretrained(model_ref)

    kwargs: dict[str, Any] = {
        "dtype": dtype,
        "attn_implementation": attn_mode,
    }
    if device == "cuda":
        kwargs["device_map"] = "auto"

    model = Qwen3VLForConditionalGeneration.from_pretrained(model_ref, **kwargs).eval()
    if device == "cpu":
        model = model.to("cpu")
    elif device == "mps":
        model = model.to("mps")

    _synchronize(device)
    load_ms = (time.perf_counter() - started_at) * 1000.0
    return model, processor, load_ms


def _run_round(
    model: Any,
    processor: Any,
    image_paths: list[str],
    prompt: str,
    max_new_tokens: int,
    device: str,
    resize_longest_edge: int | None,
) -> tuple[dict[str, float | int | None], str]:
    import torch
    from PIL import Image

    total_started_at = time.perf_counter()
    prompt_text = (
        f"{prompt}\n"
        "Return only one JSON object and do not wrap it in markdown."
    )
    messages = [{
        "role": "user",
        "content": [
            *[{"type": "image", "image": image_path} for image_path in image_paths],
            {"type": "text", "text": prompt_text},
        ],
    }]
    text = processor.apply_chat_template(
        messages,
        tokenize=False,
        add_generation_prompt=True,
    )

    image_open_started_at = time.perf_counter()
    images = []
    resize_ms = 0.0
    resized_count = 0
    max_input_pixels = 0
    for path in image_paths:
        image = Image.open(path).convert("RGB")
        width, height = image.size
        max_input_pixels = max(max_input_pixels, width * height)
        if resize_longest_edge and max(width, height) > resize_longest_edge:
            resize_started_at = time.perf_counter()
            scale = resize_longest_edge / float(max(width, height))
            resized_size = (
                max(1, int(round(width * scale))),
                max(1, int(round(height * scale))),
            )
            image = image.resize(resized_size, Image.Resampling.LANCZOS)
            resize_ms += (time.perf_counter() - resize_started_at) * 1000.0
            resized_count += 1
        images.append(image)
    image_open_ms = (time.perf_counter() - image_open_started_at) * 1000.0

    processor_started_at = time.perf_counter()
    inputs = processor(text=[text], images=images, padding=True, return_tensors="pt")
    processor_ms = (time.perf_counter() - processor_started_at) * 1000.0
    inputs.pop("token_type_ids", None)

    peak_memory_mb: float | None = None
    h2d_ms = 0.0
    target_device: str | None = None
    if device == "cuda":
        target_device = "cuda"
        torch.cuda.reset_peak_memory_stats()
    elif device == "mps":
        target_device = "mps"

    if target_device is not None:
        h2d_started_at = time.perf_counter()
        inputs = {
            key: value.to(target_device) if hasattr(value, "to") else value
            for key, value in inputs.items()
        }
        _synchronize(device)
        h2d_ms = (time.perf_counter() - h2d_started_at) * 1000.0

    _synchronize(device)
    generate_started_at = time.perf_counter()
    with torch.no_grad():
        generated_ids = model.generate(**inputs, max_new_tokens=max_new_tokens)
    _synchronize(device)
    generate_ms = (time.perf_counter() - generate_started_at) * 1000.0

    trimmed = [out_ids[len(in_ids):] for in_ids, out_ids in zip(inputs["input_ids"], generated_ids)]
    decode_started_at = time.perf_counter()
    outputs = processor.batch_decode(
        trimmed,
        skip_special_tokens=True,
        clean_up_tokenization_spaces=False,
    )
    decode_ms = (time.perf_counter() - decode_started_at) * 1000.0

    if device == "cuda":
        peak_memory_mb = torch.cuda.max_memory_allocated() / (1024.0 * 1024.0)

    output_text = outputs[0] if outputs else ""
    return {
        "totalMs": (time.perf_counter() - total_started_at) * 1000.0,
        "imageOpenMs": image_open_ms,
        "resizeMs": resize_ms,
        "processorMs": processor_ms,
        "h2dMs": h2d_ms,
        "generateMs": generate_ms,
        "decodeMs": decode_ms,
        "peakMemoryMB": peak_memory_mb,
        "outputChars": len(output_text),
        "resizedImageCount": resized_count,
        "maxInputPixels": max_input_pixels,
    }, output_text


def _summarize_rounds(rounds: list[dict[str, float | int | None]]) -> dict[str, float | int | None]:
    def mean_for(key: str) -> float | None:
        values = [float(row[key]) for row in rounds if row.get(key) is not None]
        return statistics.mean(values) if values else None

    def median_for(key: str) -> float | None:
        values = [float(row[key]) for row in rounds if row.get(key) is not None]
        return statistics.median(values) if values else None

    def min_for(key: str) -> float | None:
        values = [float(row[key]) for row in rounds if row.get(key) is not None]
        return min(values) if values else None

    def max_for(key: str) -> float | None:
        values = [float(row[key]) for row in rounds if row.get(key) is not None]
        return max(values) if values else None

    return {
        "roundCount": len(rounds),
        "avgTotalMs": mean_for("totalMs"),
        "medianTotalMs": median_for("totalMs"),
        "minTotalMs": min_for("totalMs"),
        "maxTotalMs": max_for("totalMs"),
        "avgGenerateMs": mean_for("generateMs"),
        "avgProcessorMs": mean_for("processorMs"),
        "avgImageOpenMs": mean_for("imageOpenMs"),
        "avgResizeMs": mean_for("resizeMs"),
        "avgH2DMs": mean_for("h2dMs"),
        "avgDecodeMs": mean_for("decodeMs"),
        "avgPeakMemoryMB": mean_for("peakMemoryMB"),
        "avgOutputChars": mean_for("outputChars"),
    }


def _compute_speedups(cases: list[dict[str, Any]], baseline_mode: str) -> list[dict[str, Any]]:
    baseline_case = next(
        (
            case for case in cases
            if case.get("mode") == baseline_mode and case.get("status") == "ok"
        ),
        None,
    )
    if baseline_case is None:
        return []

    baseline_avg = baseline_case["summary"].get("avgTotalMs")
    if not baseline_avg:
        return []

    speedups: list[dict[str, Any]] = []
    for case in cases:
        if case.get("status") != "ok" or case.get("mode") == baseline_mode:
            continue
        avg_total = case["summary"].get("avgTotalMs")
        if not avg_total:
            continue
        speedups.append({
            "baseline": baseline_mode,
            "mode": case["mode"],
            "avgTotalSpeedup": baseline_avg / avg_total,
            "avgTotalDeltaMs": avg_total - baseline_avg,
        })
    return speedups


def _print_summary(report: dict[str, Any]) -> None:
    print("# Kairos VLM Attention Benchmark")
    print(f"device      : {report['device']}")
    print(f"modelRef    : {report['modelRef']}")
    print(f"images      : {len(report['images'])}")
    print(f"maxSide     : {report['resizeLongestEdge'] or 'original'}")
    print(f"warmup/reps : {report['warmup']} / {report['repeat']}")
    print("")

    for case in report["cases"]:
        print(f"[{case['mode']}] {case['status']}")
        if case["status"] != "ok":
            print(f"  error     : {case['error']}")
            print("")
            continue

        summary = case["summary"]
        print(f"  loadMs    : {case['loadMs']:.1f}")
        print(f"  avgTotal  : {summary['avgTotalMs']:.1f}")
        print(f"  median    : {summary['medianTotalMs']:.1f}")
        print(f"  avgGen    : {summary['avgGenerateMs']:.1f}")
        if summary["avgResizeMs"] is not None:
            print(f"  avgResize : {summary['avgResizeMs']:.1f}")
        if summary["avgPeakMemoryMB"] is not None:
            print(f"  avgPeakMB : {summary['avgPeakMemoryMB']:.1f}")
        print(f"  preview   : {case['outputPreview']}")
        print("")

    if report["speedups"]:
        print("Speedups:")
        for speedup in report["speedups"]:
            print(
                f"  {speedup['mode']} vs {speedup['baseline']}: "
                f"{speedup['avgTotalSpeedup']:.3f}x "
                f"({speedup['avgTotalDeltaMs']:+.1f} ms)"
            )


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Benchmark sdpa vs flash_attention_2 for Kairos Qwen3-VL.",
    )
    parser.add_argument(
        "images",
        nargs="+",
        help="Input image paths. Use more than one image to benchmark multi-image scenarios.",
    )
    parser.add_argument(
        "--modes",
        nargs="+",
        default=["sdpa", "flash_attention_2"],
        choices=["sdpa", "flash_attention_2", "eager"],
        help="Attention implementations to compare.",
    )
    parser.add_argument(
        "--prompt",
        default=CDEFAULT_PROMPT,
        help="Prompt used for every benchmark round.",
    )
    parser.add_argument(
        "--repeat",
        type=int,
        default=3,
        help="Measured rounds per mode.",
    )
    parser.add_argument(
        "--warmup",
        type=int,
        default=1,
        help="Warmup rounds per mode before measurement.",
    )
    parser.add_argument(
        "--max-new-tokens",
        type=int,
        default=128,
        help="Generation length cap for each round.",
    )
    parser.add_argument(
        "--dtype",
        default="runner",
        choices=["runner", "auto", "float16", "fp16", "bfloat16", "bf16", "float32", "fp32"],
        help="Model dtype. 'runner' mirrors Kairos current defaults.",
    )
    parser.add_argument(
        "--model-ref",
        help="Optional explicit model path or model ID. Defaults to local models/Qwen3-VL-4B-Instruct when present.",
    )
    parser.add_argument(
        "--output",
        help="Optional JSON output path.",
    )
    parser.add_argument(
        "--max-side",
        type=int,
        help="Optionally downsample each image so its longest edge is at most this many pixels before benchmarking.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    if args.repeat < 1:
        raise ValueError("--repeat must be >= 1")
    if args.warmup < 0:
        raise ValueError("--warmup must be >= 0")
    if args.max_side is not None and args.max_side < 1:
        raise ValueError("--max-side must be >= 1")

    image_paths = _validate_images(args.images)
    device = _detect_device()
    model_ref = _resolve_model_ref(args.model_ref)

    report: dict[str, Any] = {
        "device": device,
        "modelRef": model_ref,
        "images": image_paths,
        "prompt": args.prompt,
        "repeat": args.repeat,
        "warmup": args.warmup,
        "maxNewTokens": args.max_new_tokens,
        "dtype": args.dtype,
        "resizeLongestEdge": args.max_side,
        "cases": [],
        "speedups": [],
    }

    for mode in args.modes:
        case: dict[str, Any] = {
            "mode": mode,
            "status": "pending",
            "loadMs": None,
            "warmupRounds": [],
            "rounds": [],
            "summary": {},
            "outputPreview": "",
        }
        model = None
        processor = None
        try:
            model, processor, load_ms = _load_case(model_ref, mode, device, args.dtype)
            case["loadMs"] = load_ms

            for _ in range(args.warmup):
                warmup_round, _ = _run_round(
                    model,
                    processor,
                    image_paths,
                    args.prompt,
                    args.max_new_tokens,
                    device,
                    args.max_side,
                )
                case["warmupRounds"].append(warmup_round)

            previews: list[str] = []
            for _ in range(args.repeat):
                round_result, output_text = _run_round(
                    model,
                    processor,
                    image_paths,
                    args.prompt,
                    args.max_new_tokens,
                    device,
                    args.max_side,
                )
                case["rounds"].append(round_result)
                if output_text:
                    previews.append(output_text.strip().replace("\n", " ")[:160])

            case["summary"] = _summarize_rounds(case["rounds"])
            case["outputPreview"] = previews[0] if previews else ""
            case["status"] = "ok"
        except Exception as exc:  # noqa: BLE001
            case["status"] = "error"
            case["error"] = f"{type(exc).__name__}: {exc}"
        finally:
            if model is not None and processor is not None:
                _cleanup_case(model, processor, device)

        report["cases"].append(case)

    report["speedups"] = _compute_speedups(report["cases"], baseline_mode="sdpa")
    _print_summary(report)

    if args.output:
        output_path = Path(args.output).expanduser().resolve()
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print("")
        print(f"JSON report written to: {output_path}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
