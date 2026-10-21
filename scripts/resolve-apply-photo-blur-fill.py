#!/usr/bin/env python3
"""Apply photo blur fill using existing MediaPool sources and native Fusion nodes.

This is a focused Resolve maintenance tool, intentionally separate from the
timeline generator. It uses the open Resolve project/timeline and only touches
photo clips identified by source extension, clip color, or color group. Each
photo gets its own comp so the foreground fit and blurred-background fill can
be calculated from the source image resolution and the timeline resolution.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import re
import sys
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
CDEFAULT_BACKGROUND_BLUR_FILTER = "Fast Gaussian"
CDEFAULT_BACKGROUND_MIP_WIDTH = 96
CDEFAULT_BACKGROUND_MIP_HEIGHT = 54
# The former serialized XBlur/YBlur fields were not native Blur controls.
# Preserve the actual live-verified appearance: native sizes were both 1,
# with the strong background softness supplied by the 96x54 mip stage.
CDEFAULT_BACKGROUND_MIP_BLUR = 1.0
CDEFAULT_BACKGROUND_FINAL_BLUR = 1.0
CDEFAULT_BACKGROUND_GAIN = 1.0
CDEFAULT_BACKGROUND_SATURATION = 1.0
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
        help="Legacy static Fusion comp path kept for diagnostics; ignored; effects are built with native Fusion nodes, never imported.",
    )
    parser.add_argument("--photo-group", default="Kairos Photos", help="Resolve Color Group name that marks photo clips.")
    parser.add_argument("--photo-color", default="Blue", help="Resolve clip color that marks photo clips.")
    parser.add_argument("--comp-name", default=CDEFAULT_COMP_NAME, help="Fusion comp name used for idempotency.")
    parser.add_argument(
        "--foreground-track",
        default=CDEFAULT_FOREGROUND_TRACK_NAME,
        help="Legacy foreground track to detect and block; this tool never clears tracks.",
    )
    parser.add_argument("--replace-existing", action="store_true", help="Build and validate a replacement before removing the existing named effect.")
    parser.add_argument("--limit", type=int, default=0, help="Apply to at most this many matching photo clips; 0 means all.")
    parser.add_argument("--name-contains", default="", help="Only apply to photo clips whose timeline item name contains this text.")
    parser.add_argument("--dry-run", action="store_true", help="Inspect and validate only; do not modify Fusion comps or media.")
    parser.add_argument("--no-save", action="store_true", help="Do not SaveProject after applying effects.")
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
    resolve = host.load_resolve()
    project, current_project_before = host.load_existing_project(resolve, args.project)
    timeline = host.find_existing_edit_timeline(project, args.timeline)
    if timeline is None:
        raise ToolError("timeline_missing", "The existing target timeline was not found.")
    fps = host.resolve_timeline_fps(project, timeline)
    width, height = resolve_timeline_resolution(project, timeline)
    legacy_track = find_video_track_by_name(timeline, args.foreground_track)
    if legacy_track and timeline.GetItemListInTrack("video", legacy_track):
        raise ToolError("legacy_photo_foreground_track", "Legacy photo foreground track needs separate review; no clips were cleared.")
    entries = collect_photo_items(timeline, args.photo_group, args.photo_color)
    if args.name_contains:
        entries = [e for e in entries if any(args.name_contains in (e.get(k) or "") for k in ("name", "sourceStem", "sourcePath"))]
    if args.limit > 0:
        entries = entries[:args.limit]
    pool = project.GetMediaPool()
    pool_before = snapshot_media_pool(pool)
    timeline_before = snapshot_timeline(timeline)
    planned, skipped = [], []
    # Validate every selected source before the first write.
    for entry in entries:
        capture_existing_source(entry, pool_before)
        entry.update(photo_layout(entry, width, height))
        names = fusion_comp_names(entry["item"])
        if names and names != [args.comp_name]:
            raise ToolError("photo_existing_composition", "Photo has another Fusion composition; review it separately.", {"name": entry["name"], "comps": names})
        if names and not args.replace_existing:
            validate_comp(entry["item"].GetFusionCompByName(args.comp_name), entry)
            skipped.append(entry)
        else:
            planned.append(entry)
    applied = []
    if not args.dry_run:
        for entry in planned:
            apply_native_photo_comp(entry, args.comp_name, width, height,
                                    pool, pool_before, timeline, timeline_before)
            applied.append(result_entry(entry, fps, {"sourceMediaId": entry["sourceMediaId"]}))
    assert_media_pool_unchanged(pool_before, snapshot_media_pool(pool))
    assert_timeline_unchanged(timeline_before, snapshot_timeline(timeline))
    saved = None
    if applied and not args.no_save:
        saved = host.save_project_with_result(project, resolve)
        if saved is not True:
            raise ToolError("photo_project_save_failed", "Resolve did not confirm SaveProject.")
    return {
        "schemaVersion": "kairos-resolve-photo-blur-fill-tool-v4",
        "mode": "native-fusion-existing-media",
        "project": project.GetName(), "timeline": timeline.GetName(),
        "currentProjectBefore": current_project_before, "dryRun": bool(args.dry_run),
        "photoCount": len(entries), "wouldApplyCount": len(planned),
        "appliedCount": len(applied), "alreadyAppliedCount": len(skipped),
        "mediaPoolUnchanged": True, "mediaPoolItemCount": len(pool_before["items"]),
        "timelineUnchanged": True, "saveProjectResult": saved,
        "samples": {"applied": applied[:10]},
    }


def snapshot_media_pool(pool):
    result = {"folders": {}, "items": {}}
    def visit(folder, parent):
        fid = folder.GetUniqueId()
        if not fid or fid in result["folders"]:
            raise ToolError("photo_pool_identity_invalid", "Cannot uniquely inventory MediaPool folders.")
        result["folders"][fid] = {"name": folder.GetName(), "parent": parent}
        for item in host.iter_values(folder.GetClipList() or []):
            uid = item.GetUniqueId()
            if not uid or uid in result["items"]:
                raise ToolError("photo_pool_identity_invalid", "Cannot uniquely inventory MediaPool items.")
            result["items"][uid] = {"folder": fid, "mediaId": item.GetMediaId(),
                                    "name": item.GetName(), "path": item.GetClipProperty("File Path")}
        for child in host.iter_values(folder.GetSubFolderList() or []):
            visit(child, fid)
    visit(pool.GetRootFolder(), None)
    return result


def assert_media_pool_unchanged(before, after):
    if before != after:
        raise ToolError("photo_media_pool_changed", "Photo blur fill changed the MediaPool; stopped without deleting unknown items.", {
            "added": sorted(set(after["items"]) - set(before["items"])),
            "removed": sorted(set(before["items"]) - set(after["items"])),
            "changed": sorted(k for k in before["items"].keys() & after["items"].keys() if before["items"][k] != after["items"][k]),
            "foldersChanged": before["folders"] != after["folders"],
        })


def snapshot_timeline(timeline):
    tracks = []
    for kind in ("video", "audio", "subtitle"):
        for index in range(1, int(timeline.GetTrackCount(kind)) + 1):
            items = []
            for item in host.iter_values(timeline.GetItemListInTrack(kind, index) or []):
                media = item.GetMediaPoolItem()
                items.append((item.GetUniqueId(), item.GetName(), item.GetStart(), item.GetEnd(),
                              item.GetSourceStartFrame(), item.GetSourceEndFrame(), item.GetClipEnabled(),
                              media.GetUniqueId() if media else None))
            tracks.append((kind, index, timeline.GetTrackName(kind, index), items))
    return (timeline.GetUniqueId(), timeline.GetStartFrame(), timeline.GetEndFrame(), tracks)


def assert_timeline_unchanged(before, after):
    if before != after:
        raise ToolError("photo_timeline_changed", "Timeline placement/source/audio/subtitle state changed during photo finishing.")


def capture_existing_source(entry, pool_snapshot):
    media = entry["item"].GetMediaPoolItem()
    uid = media.GetUniqueId() if media else None
    row = pool_snapshot["items"].get(uid)
    if not row or not row["mediaId"] or host.normalize_filesystem_path(row["path"]) != entry["sourcePath"]:
        raise ToolError("photo_existing_source_missing", "Photo must reference an existing, identifiable MediaPool source.")
    # Fusion MediaID is GetMediaId(), not MediaPoolItem.GetUniqueId().
    entry["sourceMediaId"] = row["mediaId"]
    entry["sourceMediaUniqueId"] = uid


def node_specs(entry, width, height):
    end = max(0, int(round(entry["endFrame"] - entry["startFrame"])) - 1)
    return [
        ("CanvasBackground", "Background", {"GlobalOut": end, "UseFrameFormatSettings": 0, "Width": width, "Height": height, "TopLeftAlpha": 1}, {}),
        ("BackgroundResize", "BetterResize", {"Width": entry["backgroundWidth"], "Height": entry["backgroundHeight"]}, {"Input": "MediaIn1"}),
        ("BackgroundTransform", "Transform", {"Size": 1}, {"Input": "BackgroundResize"}),
        ("BackgroundCanvasMerge", "Merge", {"PerformDepthMerge": 0}, {"Background": "CanvasBackground", "Foreground": "BackgroundTransform"}),
        ("BackgroundCanvasCrop", "Crop", {"XSize": width, "YSize": height, "KeepCentered": 1}, {"Input": "BackgroundCanvasMerge"}),
        ("BackgroundMipDown", "BetterResize", {"Width": CDEFAULT_BACKGROUND_MIP_WIDTH, "Height": CDEFAULT_BACKGROUND_MIP_HEIGHT}, {"Input": "BackgroundCanvasCrop"}),
        ("BackgroundMipBlur", "Blur", {"XBlurSize": CDEFAULT_BACKGROUND_MIP_BLUR, "YBlurSize": CDEFAULT_BACKGROUND_MIP_BLUR, "Filter": CDEFAULT_BACKGROUND_BLUR_FILTER}, {"Input": "BackgroundMipDown"}),
        ("BackgroundMipUp", "BetterResize", {"Width": width, "Height": height}, {"Input": "BackgroundMipBlur"}),
        ("BackgroundFinalBlur", "Blur", {"XBlurSize": CDEFAULT_BACKGROUND_FINAL_BLUR, "YBlurSize": CDEFAULT_BACKGROUND_FINAL_BLUR, "Filter": CDEFAULT_BACKGROUND_BLUR_FILTER}, {"Input": "BackgroundMipUp"}),
        ("BackgroundGrade", "BrightnessContrast", {"Gain": CDEFAULT_BACKGROUND_GAIN, "Saturation": CDEFAULT_BACKGROUND_SATURATION}, {"Input": "BackgroundFinalBlur"}),
        ("MergeBackground", "Merge", {"PerformDepthMerge": 0}, {"Background": "CanvasBackground", "Foreground": "BackgroundGrade"}),
        ("ForegroundTransform", "Transform", {"Size": entry["foregroundScale"]}, {"Input": "MediaIn1"}),
        ("MergeForeground", "Merge", {"PerformDepthMerge": 0}, {"Background": "MergeBackground", "Foreground": "ForegroundTransform"}),
        ("OutputCrop", "Crop", {"XSize": width, "YSize": height, "KeepCentered": 1}, {"Input": "MergeForeground"}),
    ]


def tool_map(comp):
    return {t.GetAttrs()["TOOLS_Name"]: t for t in host.iter_values(comp.GetToolList(False) or {})}


def connect(tool, key, source):
    tool.ConnectInput(key, source, "Output")
    assert_connection(tool, key, source.GetAttrs()["TOOLS_Name"])


def assert_connection(tool, key, expected):
    inputs = [i for i in host.iter_values(tool.GetInputList() or {}) if i.GetAttrs().get("INPS_ID") == key]
    output = inputs[0].GetConnectedOutput() if len(inputs) == 1 else None
    source = output.GetTool() if output else None
    if source is None or source.GetAttrs().get("TOOLS_Name") != expected:
        raise ToolError("photo_fusion_connection_invalid", "Fusion graph connection was not confirmed.", {"input": key, "expected": expected})


def validate_comp(comp, entry):
    if comp is None:
        raise ToolError("photo_fusion_missing", "Photo blur composition is missing.")
    nodes = tool_map(comp)
    source, output = nodes.get("MediaIn1"), nodes.get("MediaOut1")
    if source is None or output is None or source.GetAttrs().get("TOOLS_RegID") != "MediaIn" or output.GetAttrs().get("TOOLS_RegID") != "MediaOut":
        raise ToolError("photo_fusion_nodes_invalid", "Photo effect must use native MediaIn and MediaOut nodes.")
    if source.GetAttrs().get("TOOLS_Clip_MediaID") != entry["sourceMediaId"] or source.GetData("MEDIA_ID") != entry["sourceMediaId"]:
        raise ToolError("photo_fusion_source_mismatch", "Existing effect does not reference the original MediaPool item; use an explicit repair/replacement.")
    specs = node_specs(entry, 1, 1)  # Graph shape is independent of canvas dimensions.
    if set(nodes) != {"MediaIn1", "MediaOut1"} | {s[0] for s in specs}:
        raise ToolError("photo_fusion_nodes_invalid", "Photo effect node set is incomplete or has unexpected nodes.")
    for name, kind, _, links in specs:
        if nodes[name].GetAttrs().get("TOOLS_RegID") != kind:
            raise ToolError("photo_fusion_nodes_invalid", "Photo effect node type differs.", {"node": name})
        for key, src in links.items():
            assert_connection(nodes[name], key, src)
    assert_connection(output, "Input", "OutputCrop")


def build_native_graph(comp, entry, width, height):
    nodes = tool_map(comp)
    if set(nodes) - {"MediaIn1", "MediaOut1"}:
        raise ToolError("photo_new_comp_not_empty", "New Fusion composition contains unexpected nodes.")
    for name, kind in (("MediaIn1", "MediaIn"), ("MediaOut1", "MediaOut")):
        if name not in nodes:
            node = comp.AddTool(kind, -1, -1)
            if node is None:
                raise ToolError("photo_fusion_node_create_failed", "Could not create native Fusion node.", {"node": name})
            node.SetAttrs({"TOOLS_Name": name})
            nodes[name] = node
    source = nodes["MediaIn1"]
    source.SetInput("MediaSource", "MediaPool")
    source.SetInput("MediaID", entry["sourceMediaId"])
    source.SetData("MEDIA_ID", entry["sourceMediaId"])
    end = max(0, int(round(entry["endFrame"] - entry["startFrame"])) - 1)
    source.SetInput("GlobalIn", 0)
    source.SetInput("GlobalOut", end)
    source.SetInput("ClipTimeStart", 0)
    source.SetInput("ClipTimeEnd", 0)
    source.SetInput("Loop", 1)
    for pos, (name, kind, values, links) in enumerate(node_specs(entry, width, height)):
        node = comp.AddTool(kind, (pos % 7) * 2, pos // 7)
        if node is None:
            raise ToolError("photo_fusion_node_create_failed", "Could not create Fusion node.", {"node": name})
        node.SetAttrs({"TOOLS_Name": name})
        for key, value in values.items():
            node.SetInput(key, value)
            actual = node.GetInput(key, 0)  # Scalar only. Never request image-valued Input.
            equal = abs(actual - value) < 1e-5 if isinstance(actual, (int, float)) and isinstance(value, (int, float)) else actual == value
            if not equal:
                raise ToolError("photo_fusion_parameter_invalid", "Fusion did not retain a scalar setting.", {"node": name, "input": key, "expected": value, "actual": actual})
        nodes[name] = node
        for key, src in links.items():
            connect(node, key, nodes[src])
    connect(nodes["MediaOut1"], "Input", nodes["OutputCrop"])
    validate_comp(comp, entry)


def apply_native_photo_comp(entry, comp_name, width, height, pool, pool_before, timeline, timeline_before):
    item = entry["item"]
    old_names = fusion_comp_names(item)
    original_props = item.GetProperty()
    new_name = None
    old_backup = None
    try:
        comp = item.AddFusionComp()
        created = [n for n in fusion_comp_names(item) if n not in old_names]
        if len(created) == 1:
            new_name = created[0]
        if comp is None or len(created) != 1:
            raise ToolError("photo_fusion_create_failed", "Resolve did not create exactly one new composition.")
        # Detect an unexpected import before continuing with graph construction.
        assert_media_pool_unchanged(pool_before, snapshot_media_pool(pool))
        build_native_graph(comp, entry, width, height)
        mapping = apply_timeline_item_canvas_mapping(item, entry, width, height)
        if mapping["readback"].get("Scaling") != CSCALE_STRETCH:
            raise ToolError("photo_canvas_mapping_failed", "Resolve did not retain the required canvas mapping.")
        assert_media_pool_unchanged(pool_before, snapshot_media_pool(pool))
        assert_timeline_unchanged(timeline_before, snapshot_timeline(timeline))
        if old_names:
            old_backup = comp_name + " (replacement rollback)"
            if old_backup in fusion_comp_names(item) or item.RenameFusionCompByName(comp_name, old_backup) is not True:
                old_backup = None
                raise ToolError("photo_fusion_replace_failed", "Could not preserve the previous effect for replacement rollback.")
        if item.RenameFusionCompByName(new_name, comp_name) is not True:
            raise ToolError("photo_fusion_rename_failed", "Could not name the validated photo effect.")
        new_name = comp_name
        if not item.LoadFusionCompByName(comp_name):
            raise ToolError("photo_fusion_load_failed", "Could not activate the validated photo effect.")
        validate_comp(item.GetFusionCompByName(comp_name), entry)
        if old_backup and item.DeleteFusionCompByName(old_backup) is not True:
            raise ToolError("photo_fusion_replace_failed", "Could not remove the previous effect after candidate validation.")
    except Exception as error:
        # Only our new composition is removed; never delete MediaPool sources.
        # Resolve will not remove the active candidate while another comp exists.
        restore_name = old_backup or (comp_name if old_names else None)
        rollback_failures = []
        if restore_name and not item.LoadFusionCompByName(restore_name):
            rollback_failures.append("activate previous composition")
        if new_name:
            if item.DeleteFusionCompByName(new_name) is not True:
                rollback_failures.append("remove candidate " + new_name)
        if old_backup:
            if item.RenameFusionCompByName(old_backup, comp_name) is not True:
                rollback_failures.append("restore previous composition name")
        for key in ("Scaling", "ZoomGang", "ZoomX", "ZoomY", "Pan", "Tilt"):
            if key in original_props:
                item.SetProperty(key, original_props[key])
        if old_names and comp_name in fusion_comp_names(item):
            item.LoadFusionCompByName(comp_name)
        if rollback_failures:
            raise ToolError("photo_fusion_rollback_failed", "Photo operation failed and rollback needs review.",
                            {"originalError": str(error), "failures": rollback_failures,
                             "remainingComps": fusion_comp_names(item)}) from error
        raise


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


def find_video_track_by_name(timeline, track_name):
    count = int(host.safe_call(timeline, "GetTrackCount", "video") or 0)
    for index in range(1, count + 1):
        name = host.stringify_signal_value(host.safe_call(timeline, "GetTrackName", "video", index)) or ""
        if name == track_name:
            return index
    return None


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


def photo_layout(entry, timeline_width, timeline_height):
    source_width = host.parse_int(entry.get("sourceWidth"))
    source_height = host.parse_int(entry.get("sourceHeight"))
    if not source_width or not source_height:
        raise ToolError("photo_resolution_missing", "Source image resolution is required.")
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
    background_width = max(timeline_width, int(round(source_width * background_scale)))
    background_height = max(timeline_height, int(round(source_height * background_scale)))
    entry["layoutKind"] = layout_kind
    entry["sourceAspect"] = source_aspect
    entry["foregroundInset"] = foreground_inset
    entry["foregroundScale"] = foreground_scale
    entry["backgroundScale"] = background_scale
    entry["backgroundWidth"] = background_width
    entry["backgroundHeight"] = background_height

    return {key: entry[key] for key in ("layoutKind", "sourceAspect", "foregroundInset", "foregroundScale", "backgroundScale", "backgroundWidth", "backgroundHeight")}


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
