#!/usr/bin/env python3
"""Generate Kairos photo blur-fill Fusion comps for photo timeline items.

This is a focused Resolve maintenance tool, intentionally separate from the
timeline generator. It uses the open Resolve project/timeline and only touches
photo clips identified by source extension, clip color, or color group. Each
photo gets its own comp so the foreground fit and blurred-background fill can
be calculated from the source image resolution and the timeline resolution.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import re
import sys
import time
from pathlib import Path


CIMAGE_EXTENSIONS = {
    ".jpg",
    ".jpeg",
    ".png",
    ".tif",
    ".tiff",
    ".dng",
    ".heic",
    ".heif",
    ".webp",
}

CDEFAULT_COMP_NAME = "Kairos Photo Blur Fill"
CDEFAULT_FOREGROUND_TRACK_NAME = "Kairos Photo Foreground"
CDEFAULT_BACKGROUND_BLUR = 900.0
CDEFAULT_BACKGROUND_BLUR_PASSES = 5
CDEFAULT_BACKGROUND_BLUR_FILTER = "Fast Gaussian"
CDEFAULT_BACKGROUND_GAIN = 0.78
CDEFAULT_BACKGROUND_SATURATION = 0.82
CDEFAULT_BACKGROUND_OVERSCAN = 1.12
CDEFAULT_PANORAMA_ASPECT = 2.2
CDEFAULT_PANORAMA_FOREGROUND_INSET = 1.0
CSCALE_STRETCH = 4


def load_host_module():
    repo_root = Path(__file__).resolve().parents[1]
    host_path = repo_root / "vendor" / "resolve-color-host" / "resolve-color-host.py"
    spec = importlib.util.spec_from_file_location("kairos_resolve_color_host", host_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load Resolve host helpers: {host_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


host = load_host_module()


class ToolError(RuntimeError):
    def __init__(self, code: str, message: str, details=None):
        super().__init__(message)
        self.code = code
        self.details = details

    def to_payload(self):
        payload = {"code": self.code, "message": str(self)}
        if self.details is not None:
            payload["details"] = self.details
        return payload


def main() -> int:
    parser = argparse.ArgumentParser(description="Apply Kairos Photo Blur Fill to photo clips in a Resolve timeline.")
    parser.add_argument("--project", required=True, help="Resolve project name.")
    parser.add_argument("--timeline", required=True, help="Resolve timeline name.")
    parser.add_argument(
        "--comp",
        default=str(Path(__file__).resolve().parents[1] / "config" / "fusion-comps" / "Kairos Photo Blur Fill.comp"),
        help="Legacy static Fusion comp path kept for diagnostics; default operation generates a per-photo comp.",
    )
    parser.add_argument("--photo-group", default="Kairos Photos", help="Resolve Color Group name that marks photo clips.")
    parser.add_argument("--photo-color", default="Blue", help="Resolve clip color that marks photo clips.")
    parser.add_argument("--comp-name", default=CDEFAULT_COMP_NAME, help="Fusion comp name used for idempotency.")
    parser.add_argument(
        "--foreground-track",
        default=CDEFAULT_FOREGROUND_TRACK_NAME,
        help="Legacy foreground video track to clear/exclude from old layered runs.",
    )
    parser.add_argument("--replace-existing", action="store_true", help="Delete existing comp with --comp-name before import.")
    parser.add_argument("--limit", type=int, default=0, help="Apply to at most this many matching photo clips; 0 means all.")
    parser.add_argument("--name-contains", default="", help="Only apply to photo clips whose timeline item name contains this text.")
    parser.add_argument("--dry-run", action="store_true", help="Inspect only; do not import Fusion comps.")
    parser.add_argument("--no-save", action="store_true", help="Do not SaveProject after importing comps.")
    args = parser.parse_args()

    try:
        result = run(args)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except ToolError as error:
        print(json.dumps(error.to_payload(), ensure_ascii=False, indent=2), file=sys.stderr)
        return 2
    except Exception as error:
        print(
            json.dumps(
                {"code": "resolve_photo_blur_fill_unhandled", "message": str(error)},
                ensure_ascii=False,
                indent=2,
            ),
            file=sys.stderr,
        )
        return 1


def run(args):
    repo_root = Path(__file__).resolve().parents[1]
    legacy_comp_path = host.normalize_filesystem_path(args.comp)

    resolve = host.load_resolve()
    project, current_project_before = host.load_existing_project(resolve, args.project)
    timeline = host.find_named_timeline(project, args.timeline)
    if timeline is None:
        raise ToolError(
            "timeline_missing",
            f"Resolve timeline not found: {args.timeline}",
            {"project": args.project, "timelines": host.list_timeline_names(project)},
        )

    host.safe_call(project, "SetCurrentTimeline", timeline)
    host.safe_call(resolve, "OpenPage", "edit")

    fps = host.resolve_timeline_fps(project, timeline)
    timeline_width, timeline_height = resolve_timeline_resolution(project, timeline)
    foreground_track_index = find_video_track_by_name(timeline, args.foreground_track)
    cleared_foreground_count = clear_track_items(timeline, "video", foreground_track_index, args.dry_run) if foreground_track_index else 0
    photo_items = collect_photo_items(
        timeline,
        args.photo_group,
        args.photo_color,
        exclude_video_track_names={args.foreground_track},
    )
    if args.name_contains:
        photo_items = [
            entry for entry in photo_items
            if args.name_contains in (entry.get("name") or "")
            or args.name_contains in (entry.get("sourceStem") or "")
            or args.name_contains in (entry.get("sourcePath") or "")
        ]
    return run_single_comp(
        args,
        repo_root,
        resolve,
        project,
        timeline,
        fps,
        timeline_width,
        timeline_height,
        photo_items,
        current_project_before,
        legacy_comp_path,
        foreground_track_index,
        cleared_foreground_count,
    )


def run_single_comp(
    args,
    repo_root,
    resolve,
    project,
    timeline,
    fps,
    timeline_width,
    timeline_height,
    photo_items,
    current_project_before,
    legacy_comp_path,
    foreground_track_index,
    cleared_foreground_count,
):
    already_applied = []
    would_apply = []
    for entry in photo_items:
        names = fusion_comp_names(entry["item"])
        if has_named_comp(entry["item"], names, args.comp_name):
            if args.replace_existing:
                would_apply.append({**entry, "existingCompNames": names, "replace": True})
            else:
                already_applied.append({**entry, "existingCompNames": names})
        else:
            would_apply.append({**entry, "existingCompNames": names, "replace": False})
    if args.limit and args.limit > 0:
        would_apply = would_apply[: args.limit]

    applied = []
    failures = []
    save_result = None
    if not args.dry_run:
        comp_dir = repo_root / ".tmp" / "fusion-comps" / "photo-blur-fill"
        comp_dir.mkdir(parents=True, exist_ok=True)
        for entry in would_apply:
            item = entry["item"]
            if entry["replace"]:
                host.safe_call(item, "DeleteFusionCompByName", args.comp_name)
            before = set(fusion_comp_names(item))
            comp_path = write_photo_blur_fill_comp(
                comp_dir,
                entry,
                timeline_width,
                timeline_height,
                fps,
            )
            comp = host.safe_call(item, "ImportFusionComp", str(comp_path))
            after = fusion_comp_names(item)
            created = [name for name in after if name not in before]
            if not after:
                failures.append(
                    result_entry(
                        entry,
                        fps,
                        {
                            "before": sorted(before),
                            "after": after,
                            "compPath": str(comp_path),
                        },
                    )
                )
                continue
            if args.comp_name not in after and created:
                host.safe_call(item, "RenameFusionCompByName", created[-1], args.comp_name)
                after = fusion_comp_names(item)
            if not has_named_comp(item, after, args.comp_name):
                failures.append(
                    result_entry(
                        entry,
                        fps,
                        {
                            "before": sorted(before),
                            "after": after,
                            "compPath": str(comp_path),
                        },
                    )
                )
                continue
            canvas_mapping_result = apply_timeline_item_canvas_mapping(item, entry, timeline_width, timeline_height)
            applied.append(
                result_entry(
                    entry,
                    fps,
                    {
                        "fusionCompNames": after,
                        "compPath": str(comp_path),
                        "layoutKind": entry.get("layoutKind"),
                        "sourceAspect": entry.get("sourceAspect"),
                        "foregroundInset": entry.get("foregroundInset"),
                        "foregroundScale": entry.get("foregroundScale"),
                        "backgroundScale": entry.get("backgroundScale"),
                        "canvasMappingResult": canvas_mapping_result,
                    },
                )
            )
        if failures:
            raise ToolError(
                "fusion_comp_import_failed",
                "Resolve did not import the Fusion comp onto every requested photo clip.",
                {"failedCount": len(failures), "failed": failures[:20]},
            )
        if applied and not args.no_save:
            save_result = host.save_project_with_result(project, resolve)

    return {
        "schemaVersion": "kairos-resolve-photo-blur-fill-tool-v3",
        "mode": "single-fusion-built-in",
        "project": args.project,
        "timeline": args.timeline,
        "currentProjectBefore": current_project_before,
        "dryRun": bool(args.dry_run),
        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "compMode": "per-photo-fit-fill-single-comp",
        "legacyCompPath": legacy_comp_path,
        "compName": args.comp_name,
        "replaceExisting": bool(args.replace_existing),
        "photoGroup": args.photo_group,
        "photoColor": args.photo_color,
        "timelineResolution": {"width": timeline_width, "height": timeline_height},
        "foregroundTrack": args.foreground_track,
        "foregroundTrackIndex": foreground_track_index,
        "clearedForegroundCount": cleared_foreground_count,
        "backgroundBlur": CDEFAULT_BACKGROUND_BLUR,
        "backgroundBlurPasses": CDEFAULT_BACKGROUND_BLUR_PASSES,
        "backgroundBlurFilter": CDEFAULT_BACKGROUND_BLUR_FILTER,
        "backgroundGain": CDEFAULT_BACKGROUND_GAIN,
        "backgroundSaturation": CDEFAULT_BACKGROUND_SATURATION,
        "backgroundOverscan": CDEFAULT_BACKGROUND_OVERSCAN,
        "panoramaAspectThreshold": CDEFAULT_PANORAMA_ASPECT,
        "panoramaForegroundInset": CDEFAULT_PANORAMA_FOREGROUND_INSET,
        "photoCount": len(photo_items),
        "wouldApplyCount": len(would_apply),
        "appliedCount": len(applied),
        "alreadyAppliedCount": len(already_applied),
        "saveProjectResult": save_result,
        "samples": {
            "wouldApply": [result_entry(entry, fps) for entry in would_apply[:10]],
            "applied": applied[:10],
            "alreadyApplied": [result_entry(entry, fps, {"fusionCompNames": entry.get("existingCompNames", [])}) for entry in already_applied[:10]],
        },
    }


def collect_photo_items(timeline, photo_group_name, photo_color, exclude_video_track_names=None):
    excluded_names = set(exclude_video_track_names or [])
    entries = []
    track_count = host.safe_call(timeline, "GetTrackCount", "video") or 0
    for track_index in range(1, int(track_count) + 1):
        track_name = host.stringify_signal_value(host.safe_call(timeline, "GetTrackName", "video", track_index)) or ""
        if track_name in excluded_names:
            continue
        items = host.safe_call(timeline, "GetItemListInTrack", "video", track_index)
        if items is None:
            items = host.safe_call(timeline, "GetItemsInTrack", "video", track_index)
        for item in host.iter_values(items or []):
            source_path = host.normalize_filesystem_path(host.extract_timeline_item_file_path(item))
            start_frame = host.parse_float(host.safe_call(item, "GetStart"))
            end_frame = host.parse_float(host.safe_call(item, "GetEnd"))
            if start_frame is None:
                continue
            if not is_photo_item(item, source_path, photo_group_name, photo_color):
                continue
            source_width, source_height = resolve_source_resolution(item, source_path)
            entries.append(
                {
                    "item": item,
                    "trackIndex": track_index,
                    "trackName": track_name,
                    "name": host.stringify_signal_value(host.safe_call(item, "GetName")) or "",
                    "sourcePath": source_path,
                    "sourceStem": Path(source_path).stem if source_path else "",
                    "sourceWidth": source_width,
                    "sourceHeight": source_height,
                    "startFrame": start_frame,
                    "endFrame": end_frame,
                }
            )
    return sorted(entries, key=lambda entry: (entry["startFrame"], entry["trackIndex"], entry["name"]))


def is_photo_item(item, source_path, photo_group_name, photo_color):
    group = host.safe_call(item, "GetColorGroup")
    group_name = host.stringify_signal_value(host.safe_call(group, "GetName")) if group else ""
    if group_name == photo_group_name:
        return True
    color = host.stringify_signal_value(host.safe_call(item, "GetClipColor")) or ""
    if color.lower() == str(photo_color).lower():
        return True
    if source_path and Path(source_path).suffix.lower() in CIMAGE_EXTENSIONS:
        return True
    return False


def fusion_comp_names(item):
    names = host.safe_call(item, "GetFusionCompNameList")
    if names is None:
        names = host.safe_call(item, "GetFusionCompNames")
    return [host.stringify_signal_value(name) for name in host.iter_values(names or []) if host.stringify_signal_value(name)]


def has_named_comp(item, names, comp_name):
    target = str(comp_name).strip().lower()
    matched_name = next((name for name in names if str(name).strip().lower() == target), None)
    if matched_name is None:
        return False
    comp = host.safe_call(item, "GetFusionCompByName", matched_name)
    tools = host.safe_call(comp, "GetToolList") if comp else None
    return len(tools or {}) >= 4


def find_video_track_by_name(timeline, track_name):
    count = int(host.safe_call(timeline, "GetTrackCount", "video") or 0)
    for index in range(1, count + 1):
        name = host.stringify_signal_value(host.safe_call(timeline, "GetTrackName", "video", index)) or ""
        if name == track_name:
            return index
    return None


def clear_track_items(timeline, track_type, track_index, dry_run):
    if not track_index:
        return 0
    items = host.safe_call(timeline, "GetItemListInTrack", track_type, track_index)
    if items is None:
        items = host.safe_call(timeline, "GetItemsInTrack", track_type, track_index)
    item_list = list(host.iter_values(items or []))
    if not item_list:
        return 0
    if dry_run:
        return len(item_list)
    ok = host.safe_call(timeline, "DeleteClips", item_list, False)
    if ok is False:
        raise ToolError(
            "track_clear_failed",
            f"Unable to clear {track_type} track {track_index}.",
            {"trackType": track_type, "trackIndex": track_index, "itemCount": len(item_list)},
        )
    return len(item_list)


def apply_timeline_item_canvas_mapping(item, entry, timeline_width, timeline_height):
    source_width = host.parse_float(entry.get("sourceWidth")) or 0
    source_height = host.parse_float(entry.get("sourceHeight")) or 0
    source_aspect = source_width / source_height if source_width and source_height else None
    timeline_aspect = timeline_width / timeline_height if timeline_width and timeline_height else None
    values = {
        "Scaling": CSCALE_STRETCH,
        "ZoomGang": True,
        "ZoomX": 1,
        "ZoomY": 1,
        "Pan": 0,
        "Tilt": 0,
    }
    result = {}
    for key, value in values.items():
        result[key] = host.safe_call(item, "SetProperty", key, value)

    readback = host.safe_call(item, "GetProperty") or {}
    scaling_readback = host.parse_int(readback.get("Scaling"))
    fallback_values = None
    if scaling_readback != CSCALE_STRETCH and source_aspect and timeline_aspect:
        zoom_x = 1
        zoom_y = 1
        if source_aspect > timeline_aspect:
            zoom_y = source_aspect / timeline_aspect
        elif source_aspect < timeline_aspect:
            zoom_x = timeline_aspect / source_aspect
        fallback_values = {
            "ZoomGang": False,
            "ZoomX": zoom_x,
            "ZoomY": zoom_y,
            "Pan": 0,
            "Tilt": 0,
        }
        for key, value in fallback_values.items():
            result[f"fallback:{key}"] = host.safe_call(item, "SetProperty", key, value)
        readback = host.safe_call(item, "GetProperty") or readback

    result["readback"] = {
        key: readback.get(key)
        for key in ("Scaling", "ZoomGang", "ZoomX", "ZoomY", "Pan", "Tilt")
        if key in readback
    }
    result["sourceAspect"] = source_aspect
    result["timelineAspect"] = timeline_aspect
    result["fallbackValues"] = fallback_values
    return result


def resolve_timeline_resolution(project, timeline):
    candidates = []
    timeline_settings = host.safe_call(timeline, "GetSetting") if timeline is not None else None
    if isinstance(timeline_settings, dict):
        candidates.append(timeline_settings)
    project_settings = host.safe_call(project, "GetSetting") if project is not None else None
    if isinstance(project_settings, dict):
        candidates.append(project_settings)

    for settings in candidates:
        width = first_int(settings, ("timelineOutputResolutionWidth", "timelineResolutionWidth"))
        height = first_int(settings, ("timelineOutputResolutionHeight", "timelineResolutionHeight"))
        if width and height:
            return width, height

    width = (
        host.parse_int(host.safe_call(timeline, "GetSetting", "timelineOutputResolutionWidth"))
        or host.parse_int(host.safe_call(timeline, "GetSetting", "timelineResolutionWidth"))
        or host.parse_int(host.safe_call(project, "GetSetting", "timelineOutputResolutionWidth"))
        or host.parse_int(host.safe_call(project, "GetSetting", "timelineResolutionWidth"))
    )
    height = (
        host.parse_int(host.safe_call(timeline, "GetSetting", "timelineOutputResolutionHeight"))
        or host.parse_int(host.safe_call(timeline, "GetSetting", "timelineResolutionHeight"))
        or host.parse_int(host.safe_call(project, "GetSetting", "timelineOutputResolutionHeight"))
        or host.parse_int(host.safe_call(project, "GetSetting", "timelineResolutionHeight"))
    )
    return width or 3840, height or 2160


def first_int(settings, keys):
    for key in keys:
        parsed = host.parse_int(settings.get(key))
        if parsed and parsed > 0:
            return parsed
    return None


def resolve_source_resolution(item, source_path):
    media_pool_item = host.safe_call(item, "GetMediaPoolItem")
    property_maps = [
        host.safe_call(item, "GetClipProperty"),
        host.safe_call(item, "GetProperty"),
        host.safe_call(media_pool_item, "GetClipProperty") if media_pool_item else None,
    ]
    keys = (
        "Resolution",
        "Frame Size",
        "Video Resolution",
        "Source Resolution",
        "Original Resolution",
        "Dimensions",
    )
    for property_map in property_maps:
        if not isinstance(property_map, dict):
            continue
        for key in keys:
            parsed = parse_resolution(property_map.get(key))
            if parsed:
                return parsed
        for value in property_map.values():
            parsed = parse_resolution(value)
            if parsed:
                return parsed
    for target in (item, media_pool_item):
        if target is None:
            continue
        for key in keys:
            parsed = parse_resolution(host.safe_call(target, "GetClipProperty", key))
            if parsed:
                return parsed
    return probe_image_resolution(source_path)


def parse_resolution(value):
    if not isinstance(value, str):
        return None
    match = re.search(r"(\d{2,6})\s*[xX×]\s*(\d{2,6})", value)
    if not match:
        return None
    width = int(match.group(1))
    height = int(match.group(2))
    if width <= 0 or height <= 0:
        return None
    return width, height


def probe_image_resolution(source_path):
    path = Path(source_path) if source_path else None
    if not path or not path.exists():
        return None, None
    try:
        from PIL import Image  # type: ignore

        with Image.open(path) as image:
            width, height = image.size
            return int(width), int(height)
    except Exception:
        pass
    try:
        with path.open("rb") as handle:
            header = handle.read(32)
            if header.startswith(b"\x89PNG\r\n\x1a\n") and len(header) >= 24:
                return int.from_bytes(header[16:20], "big"), int.from_bytes(header[20:24], "big")
            if header[:2] == b"\xff\xd8":
                return probe_jpeg_resolution(path)
    except Exception:
        return None, None
    return None, None


def probe_jpeg_resolution(path):
    with path.open("rb") as handle:
        handle.read(2)
        while True:
            marker_prefix = handle.read(1)
            if not marker_prefix:
                return None, None
            if marker_prefix != b"\xff":
                continue
            marker = handle.read(1)
            while marker == b"\xff":
                marker = handle.read(1)
            if not marker:
                return None, None
            marker_value = marker[0]
            if marker_value in (0xD8, 0xD9):
                continue
            length_bytes = handle.read(2)
            if len(length_bytes) != 2:
                return None, None
            segment_length = int.from_bytes(length_bytes, "big")
            if segment_length < 2:
                return None, None
            if marker_value in {
                0xC0,
                0xC1,
                0xC2,
                0xC3,
                0xC5,
                0xC6,
                0xC7,
                0xC9,
                0xCA,
                0xCB,
                0xCD,
                0xCE,
                0xCF,
            }:
                frame = handle.read(5)
                if len(frame) != 5:
                    return None, None
                height = int.from_bytes(frame[1:3], "big")
                width = int.from_bytes(frame[3:5], "big")
                return width, height
            handle.seek(segment_length - 2, 1)


def write_photo_blur_fill_comp(output_dir, entry, timeline_width, timeline_height, fps):
    source_width = host.parse_int(entry.get("sourceWidth"))
    source_height = host.parse_int(entry.get("sourceHeight"))
    if not source_width or not source_height:
        raise ToolError(
            "photo_resolution_missing",
            "Cannot generate photo blur-fill comp because the source image resolution is unknown.",
            result_entry(entry, fps),
        )
    source_path = entry.get("sourcePath")
    if not source_path:
        raise ToolError("photo_source_path_missing", "Cannot generate photo blur-fill comp without a source path.", result_entry(entry, fps))

    duration_frames = max(1, int(round((entry.get("endFrame") or 0) - (entry.get("startFrame") or 0))))
    source_aspect = source_width / source_height
    timeline_aspect = timeline_width / timeline_height
    foreground_inset = 1.0
    layout_kind = "standard"
    if source_aspect >= max(CDEFAULT_PANORAMA_ASPECT, timeline_aspect * 1.2):
        foreground_inset = CDEFAULT_PANORAMA_FOREGROUND_INSET
        layout_kind = "panorama"
    elif source_aspect <= timeline_aspect / 1.8:
        layout_kind = "portrait"

    foreground_scale = min(timeline_width / source_width, timeline_height / source_height) * foreground_inset
    background_scale = max(timeline_width / source_width, timeline_height / source_height) * CDEFAULT_BACKGROUND_OVERSCAN
    entry["layoutKind"] = layout_kind
    entry["sourceAspect"] = source_aspect
    entry["foregroundInset"] = foreground_inset
    entry["foregroundScale"] = foreground_scale
    entry["backgroundScale"] = background_scale

    digest = hashlib.sha1(f"{source_path}|{entry.get('startFrame')}|{entry.get('endFrame')}".encode("utf-8")).hexdigest()[:16]
    safe_stem = re.sub(r"[^A-Za-z0-9_.-]+", "_", entry.get("sourceStem") or "photo").strip("._") or "photo"
    path = output_dir / f"{safe_stem}_{digest}.comp"
    path.write_text(
        build_photo_blur_fill_comp(
            source_path=source_path,
            source_name=entry.get("name") or entry.get("sourceStem") or "Photo",
            source_width=source_width,
            source_height=source_height,
            timeline_width=timeline_width,
            timeline_height=timeline_height,
            duration_frames=duration_frames,
            fps=fps,
            foreground_scale=foreground_scale,
            background_scale=background_scale,
        ),
        encoding="utf-8",
    )
    return path


def build_photo_blur_fill_comp(
    *,
    source_path,
    source_name,
    source_width,
    source_height,
    timeline_width,
    timeline_height,
    duration_frames,
    fps,
    foreground_scale,
    background_scale,
):
    last_frame = max(0, duration_frames - 1)
    return f"""Composition {{
\tCurrentTime = 0,
\tRenderRange = {{ 0, {last_frame} }},
\tGlobalRange = {{ 0, {last_frame} }},
\tCurrentID = 9,
\tPlaybackUpdateMode = 0,
\tStereoMode = false,
\tVersion = "DaVinci Resolve Studio",
\tSavedOutputs = 0,
\tHeldTools = 0,
\tDisabledTools = 0,
\tLockedTools = 0,
\tAudioOffset = 0,
\tResumable = true,
\tOutputClips = {{
\t}},
\tTools = ordered() {{
\t\tMediaIn1 = Loader {{
\t\t\tExtentSet = true,
\t\t\tCtrlWShown = false,
\t\t\tCustomData = {{
\t\t\t\tMediaProps = {{
\t\t\t\t\tMEDIA_FORMAT_TYPE = "Photo",
\t\t\t\t\tMEDIA_HAS_AUDIO = false,
\t\t\t\t\tMEDIA_HEIGHT = {source_height},
\t\t\t\t\tMEDIA_IS_SOURCE_RES = true,
\t\t\t\t\tMEDIA_MARK_IN = 0,
\t\t\t\t\tMEDIA_MARK_OUT = {last_frame},
\t\t\t\t\tMEDIA_NAME = "{fusion_string(source_name)}",
\t\t\t\t\tMEDIA_NUM_FRAMES = {duration_frames},
\t\t\t\t\tMEDIA_PAR = 1,
\t\t\t\t\tMEDIA_PATH = "{fusion_string(source_path)}",
\t\t\t\t\tMEDIA_SRC_FRAME_RATE = {fusion_number(fps)},
\t\t\t\t\tMEDIA_START_FRAME = 0,
\t\t\t\t\tMEDIA_WIDTH = {source_width}
\t\t\t\t}},
\t\t\t}},
\t\t\tInputs = {{
\t\t\t\tGlobalOut = Input {{ Value = {last_frame}, }},
\t\t\t\tClipTimeEnd = Input {{ Value = {last_frame}, }},
\t\t\t\tDeepOutputMode = Input {{
\t\t\t\t\tValue = 0,
\t\t\t\t\tDisabled = true,
\t\t\t\t}},
\t\t\t}},
\t\t\tViewInfo = OperatorInfo {{ Pos = {{ 0, 0 }} }},
\t\t\tVersion = 1,
\t\t\tClips = {{
\t\t\t\tClip {{
\t\t\t\t\tID = "Clip1",
\t\t\t\t\tMultiframe = true,
\t\t\t\t\tFilename = "{fusion_string(source_path)}",
\t\t\t\t\tLength = {duration_frames},
\t\t\t\t\tLengthSetManually = true,
\t\t\t\t\tGlobalEnd = {last_frame},
\t\t\t\t\tTrimOut = {last_frame},
\t\t\t\t}}
\t\t\t}}
\t\t}},
\t\tCanvasBackground = Background {{
\t\t\tCtrlWShown = false,
\t\t\tInputs = {{
\t\t\t\tGlobalOut = Input {{ Value = {last_frame}, }},
\t\t\t\tWidth = Input {{ Value = {timeline_width}, }},
\t\t\t\tHeight = Input {{ Value = {timeline_height}, }},
\t\t\t\tUseFrameFormatSettings = Input {{ Value = 0, }},
\t\t\t\tTopLeftRed = Input {{ Value = 0, }},
\t\t\t\tTopLeftGreen = Input {{ Value = 0, }},
\t\t\t\tTopLeftBlue = Input {{ Value = 0, }},
\t\t\t\tTopLeftAlpha = Input {{ Value = 1, }}
\t\t\t}},
\t\t\tViewInfo = OperatorInfo {{ Pos = {{ 220, -180 }} }},
\t\t}},
\t\tBackgroundTransform = Transform {{
\t\t\tCtrlWShown = false,
\t\t\tInputs = {{
\t\t\t\tSize = Input {{ Value = {fusion_number(background_scale)}, }},
\t\t\t\tInput = Input {{
\t\t\t\t\tSourceOp = "MediaIn1",
\t\t\t\t\tSource = "Output",
\t\t\t\t}}
\t\t\t}},
\t\t\tViewInfo = OperatorInfo {{ Pos = {{ 220, -70 }} }},
\t\t}},
\t\tBackgroundBlur1 = Blur {{
\t\t\tCtrlWShown = false,
\t\t\tInputs = {{
\t\t\t\tXBlur = Input {{ Value = {fusion_number(CDEFAULT_BACKGROUND_BLUR)}, }},
\t\t\t\tYBlur = Input {{ Value = {fusion_number(CDEFAULT_BACKGROUND_BLUR)}, }},
\t\t\t\tFilter = Input {{ Value = FuID {{ "{fusion_string(CDEFAULT_BACKGROUND_BLUR_FILTER)}" }}, }},
\t\t\t\tInput = Input {{
\t\t\t\t\tSourceOp = "BackgroundTransform",
\t\t\t\t\tSource = "Output",
\t\t\t\t}}
\t\t\t}},
\t\t\tViewInfo = OperatorInfo {{ Pos = {{ 440, -70 }} }},
\t\t}},
\t\tBackgroundBlur2 = Blur {{
\t\t\tCtrlWShown = false,
\t\t\tInputs = {{
\t\t\t\tXBlur = Input {{ Value = {fusion_number(CDEFAULT_BACKGROUND_BLUR)}, }},
\t\t\t\tYBlur = Input {{ Value = {fusion_number(CDEFAULT_BACKGROUND_BLUR)}, }},
\t\t\t\tFilter = Input {{ Value = FuID {{ "{fusion_string(CDEFAULT_BACKGROUND_BLUR_FILTER)}" }}, }},
\t\t\t\tInput = Input {{
\t\t\t\t\tSourceOp = "BackgroundBlur1",
\t\t\t\t\tSource = "Output",
\t\t\t\t}}
\t\t\t}},
\t\t\tViewInfo = OperatorInfo {{ Pos = {{ 660, -70 }} }},
\t\t}},
\t\tBackgroundBlur3 = Blur {{
\t\t\tCtrlWShown = false,
\t\t\tInputs = {{
\t\t\t\tXBlur = Input {{ Value = {fusion_number(CDEFAULT_BACKGROUND_BLUR)}, }},
\t\t\t\tYBlur = Input {{ Value = {fusion_number(CDEFAULT_BACKGROUND_BLUR)}, }},
\t\t\t\tFilter = Input {{ Value = FuID {{ "{fusion_string(CDEFAULT_BACKGROUND_BLUR_FILTER)}" }}, }},
\t\t\t\tInput = Input {{
\t\t\t\t\tSourceOp = "BackgroundBlur2",
\t\t\t\t\tSource = "Output",
\t\t\t\t}}
\t\t\t}},
\t\t\tViewInfo = OperatorInfo {{ Pos = {{ 880, -70 }} }},
\t\t}},
\t\tBackgroundBlur4 = Blur {{
\t\t\tCtrlWShown = false,
\t\t\tInputs = {{
\t\t\t\tXBlur = Input {{ Value = {fusion_number(CDEFAULT_BACKGROUND_BLUR)}, }},
\t\t\t\tYBlur = Input {{ Value = {fusion_number(CDEFAULT_BACKGROUND_BLUR)}, }},
\t\t\t\tFilter = Input {{ Value = FuID {{ "{fusion_string(CDEFAULT_BACKGROUND_BLUR_FILTER)}" }}, }},
\t\t\t\tInput = Input {{
\t\t\t\t\tSourceOp = "BackgroundBlur3",
\t\t\t\t\tSource = "Output",
\t\t\t\t}}
\t\t\t}},
\t\t\tViewInfo = OperatorInfo {{ Pos = {{ 1100, -70 }} }},
\t\t}},
\t\tBackgroundBlur5 = Blur {{
\t\t\tCtrlWShown = false,
\t\t\tInputs = {{
\t\t\t\tXBlur = Input {{ Value = {fusion_number(CDEFAULT_BACKGROUND_BLUR)}, }},
\t\t\t\tYBlur = Input {{ Value = {fusion_number(CDEFAULT_BACKGROUND_BLUR)}, }},
\t\t\t\tFilter = Input {{ Value = FuID {{ "{fusion_string(CDEFAULT_BACKGROUND_BLUR_FILTER)}" }}, }},
\t\t\t\tInput = Input {{
\t\t\t\t\tSourceOp = "BackgroundBlur4",
\t\t\t\t\tSource = "Output",
\t\t\t\t}}
\t\t\t}},
\t\t\tViewInfo = OperatorInfo {{ Pos = {{ 1320, -70 }} }},
\t\t}},
\t\tBackgroundGrade = BrightnessContrast {{
\t\t\tCtrlWShown = false,
\t\t\tInputs = {{
\t\t\t\tGain = Input {{ Value = {fusion_number(CDEFAULT_BACKGROUND_GAIN)}, }},
\t\t\t\tSaturation = Input {{ Value = {fusion_number(CDEFAULT_BACKGROUND_SATURATION)}, }},
\t\t\t\tInput = Input {{
\t\t\t\t\tSourceOp = "BackgroundBlur5",
\t\t\t\t\tSource = "Output",
\t\t\t\t}}
\t\t\t}},
\t\t\tViewInfo = OperatorInfo {{ Pos = {{ 1540, -70 }} }},
\t\t}},
\t\tMergeBackground = Merge {{
\t\t\tCtrlWShown = false,
\t\t\tInputs = {{
\t\t\t\tBackground = Input {{
\t\t\t\t\tSourceOp = "CanvasBackground",
\t\t\t\t\tSource = "Output",
\t\t\t\t}},
\t\t\t\tForeground = Input {{
\t\t\t\t\tSourceOp = "BackgroundGrade",
\t\t\t\t\tSource = "Output",
\t\t\t\t}},
\t\t\t\tPerformDepthMerge = Input {{ Value = 0, }}
\t\t\t}},
\t\t\tViewInfo = OperatorInfo {{ Pos = {{ 1760, -70 }} }},
\t\t}},
\t\tForegroundTransform = Transform {{
\t\t\tCtrlWShown = false,
\t\t\tInputs = {{
\t\t\t\tSize = Input {{ Value = {fusion_number(foreground_scale)}, }},
\t\t\t\tInput = Input {{
\t\t\t\t\tSourceOp = "MediaIn1",
\t\t\t\t\tSource = "Output",
\t\t\t\t}}
\t\t\t}},
\t\t\tViewInfo = OperatorInfo {{ Pos = {{ 1540, 110 }} }},
\t\t}},
\t\tMergeForeground = Merge {{
\t\t\tCtrlWShown = false,
\t\t\tInputs = {{
\t\t\t\tBackground = Input {{
\t\t\t\t\tSourceOp = "MergeBackground",
\t\t\t\t\tSource = "Output",
\t\t\t\t}},
\t\t\t\tForeground = Input {{
\t\t\t\t\tSourceOp = "ForegroundTransform",
\t\t\t\t\tSource = "Output",
\t\t\t\t}},
\t\t\t\tPerformDepthMerge = Input {{ Value = 0, }}
\t\t\t}},
\t\t\tViewInfo = OperatorInfo {{ Pos = {{ 1980, 0 }} }},
\t\t}},
\t\tOutputCrop = Crop {{
\t\t\tCtrlWShown = false,
\t\t\tInputs = {{
\t\t\t\tXOffset = Input {{ Value = 0, }},
\t\t\t\tYOffset = Input {{ Value = 0, }},
\t\t\t\tXSize = Input {{ Value = {timeline_width}, }},
\t\t\t\tYSize = Input {{ Value = {timeline_height}, }},
\t\t\t\tKeepCentered = Input {{ Value = 1, }},
\t\t\t\tInput = Input {{
\t\t\t\t\tSourceOp = "MergeForeground",
\t\t\t\t\tSource = "Output",
\t\t\t\t}}
\t\t\t}},
\t\t\tViewInfo = OperatorInfo {{ Pos = {{ 2200, 0 }} }},
\t\t}},
\t\tMediaOut1 = Saver {{
\t\t\tCtrlWShown = false,
\t\t\tInputs = {{
\t\t\t\tIndex = Input {{ Value = "0", }},
\t\t\t\tInput = Input {{
\t\t\t\t\tSourceOp = "OutputCrop",
\t\t\t\t\tSource = "Output",
\t\t\t\t}}
\t\t\t}},
\t\t\tViewInfo = OperatorInfo {{ Pos = {{ 2420, 0 }} }},
\t\t}}
\t}},
\tFrames = {{
\t}},
\tPrefs = {{
\t\tComp = {{
\t\t\tFrameFormat = {{
\t\t\t\tWidth = {timeline_width},
\t\t\t\tHeight = {timeline_height},
\t\t\t\tDepthFull = 3,
\t\t\t\tDepthPreview = 3,
\t\t\t\tDepthInteractive = 3,
\t\t\t}},
\t\t\tUnsorted = {{
\t\t\t\tGlobalEnd = {last_frame}
\t\t\t}},
\t\t}}
\t}},
}}
"""


def fusion_string(value):
    text = str(value or "")
    return text.replace("\\", "\\\\").replace('"', '\\"')


def fusion_number(value):
    parsed = host.parse_float(value)
    if parsed is None:
        parsed = 0
    if abs(parsed - round(parsed)) < 0.000001:
        return str(int(round(parsed)))
    return f"{parsed:.6f}".rstrip("0").rstrip(".")


def result_entry(entry, fps, extra=None):
    payload = {
        "trackIndex": entry.get("trackIndex"),
        "name": entry.get("name"),
        "sourceStem": entry.get("sourceStem"),
        "sourcePath": entry.get("sourcePath"),
        "sourceResolution": {
            "width": entry.get("sourceWidth"),
            "height": entry.get("sourceHeight"),
        },
        "startFrame": entry.get("startFrame"),
        "endFrame": entry.get("endFrame"),
        "timelineInMs": host.frames_to_ms(entry.get("startFrame"), fps) if entry.get("startFrame") is not None else None,
    }
    if extra:
        payload.update(extra)
    return payload


if __name__ == "__main__":
    raise SystemExit(main())
