#!/usr/bin/env python3
"""Insert one SFX clip at the start of every photo item in a Resolve timeline.

This is a small sidecar utility, intentionally not a Resolve host operation.
It reuses the vendored host's Resolve connection helpers, then performs one
focused maintenance action against an open Resolve project.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
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
    parser = argparse.ArgumentParser(description="Insert a photo-start SFX on a Resolve timeline.")
    parser.add_argument("--project", required=True, help="Resolve project name.")
    parser.add_argument("--timeline", required=True, help="Resolve timeline name.")
    parser.add_argument("--sfx", required=True, help="Readable local SFX media path.")
    parser.add_argument("--media-namespace", default="Kairos Audio", help="Resolve Media Pool root bin for audio.")
    parser.add_argument("--media-folder", default="sfx", help="Folder under the audio namespace for this SFX.")
    parser.add_argument("--target-track", default="Kairos SFX", help="Timeline audio track name to use.")
    parser.add_argument("--photo-group", default="Kairos Photos", help="Resolve Color Group name that marks photo clips.")
    parser.add_argument("--photo-color", default="Blue", help="Resolve clip color that marks photo clips.")
    parser.add_argument("--tolerance-frames", type=int, default=1, help="Frame tolerance for idempotency checks.")
    parser.add_argument(
        "--no-reuse-empty-track",
        action="store_true",
        help="Create a new track instead of reusing the first empty audio track when the named target track is missing.",
    )
    parser.add_argument("--dry-run", action="store_true", help="Inspect only; do not import media or append audio.")
    parser.add_argument("--no-save", action="store_true", help="Do not SaveProject after inserting clips.")
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
                {"code": "resolve_photo_start_sfx_unhandled", "message": str(error)},
                ensure_ascii=False,
                indent=2,
            ),
            file=sys.stderr,
        )
        return 1


def run(args):
    sfx_path = host.normalize_filesystem_path(args.sfx)
    if not sfx_path or not Path(sfx_path).exists():
        raise ToolError("sfx_path_missing", "SFX path is not readable.", {"sfx": args.sfx})

    resolve = host.load_resolve()
    project, current_project_before = host.load_existing_project(resolve, args.project)
    media_pool = host.require_method(project, "GetMediaPool")()
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
    photo_items = collect_photo_items(timeline, args.photo_group, args.photo_color)
    target_track_index, track_created, reused_empty_track = find_or_create_audio_track(
        timeline,
        args.target_track,
        args.dry_run,
        reuse_empty_track=not args.no_reuse_empty_track,
    )
    existing_starts = collect_existing_sfx_starts(timeline, target_track_index, sfx_path)

    would_insert = []
    skipped_existing = []
    for entry in photo_items:
        start_frame = entry["startFrame"]
        if has_existing_start(start_frame, existing_starts, args.tolerance_frames):
            skipped_existing.append(result_entry(entry, fps))
        else:
            would_insert.append(entry)

    imported_sfx = False
    inserted = []
    failures = []
    save_result = None
    if not args.dry_run and would_insert:
        sfx_item, imported_sfx = find_or_import_media_pool_item(
            resolve,
            media_pool,
            sfx_path,
            args.media_namespace,
            args.media_folder,
        )
        timeline_start_frame = host.parse_float(host.safe_call(timeline, "GetStartFrame")) or 0
        for entry in would_insert:
            appended_item = append_sfx_at_photo_start(
                media_pool,
                sfx_item,
                target_track_index,
                entry["startFrame"],
                timeline_start_frame,
            )
            inserted_start = host.parse_float(host.safe_call(appended_item, "GetStart")) if appended_item else None
            if appended_item is None or inserted_start is None or abs(inserted_start - entry["startFrame"]) > args.tolerance_frames:
                failures.append({
                    **result_entry(entry, fps),
                    "insertedStartFrame": inserted_start,
                })
                continue
            host.safe_call(appended_item, "SetName", build_timeline_item_name(entry, sfx_item))
            existing_starts.append(inserted_start)
            inserted.append({
                **result_entry(entry, fps),
                "audioStartFrame": inserted_start,
                "audioTimelineInMs": host.frames_to_ms(inserted_start, fps),
            })
        if failures:
            raise ToolError(
                "append_failed",
                "Resolve did not append every SFX clip at the requested photo start.",
                {"failedCount": len(failures), "failed": failures[:20]},
            )
        if not args.no_save:
            save_result = host.save_project_with_result(project, resolve)

    return {
        "schemaVersion": "kairos-resolve-photo-start-sfx-tool-v1",
        "project": args.project,
        "timeline": args.timeline,
        "currentProjectBefore": current_project_before,
        "dryRun": bool(args.dry_run),
        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "sfxPath": sfx_path,
        "mediaNamespace": args.media_namespace,
        "mediaFolder": args.media_folder,
        "targetTrack": args.target_track,
        "targetTrackIndex": target_track_index,
        "trackCreated": track_created,
        "reusedEmptyTrack": reused_empty_track,
        "photoCount": len(photo_items),
        "wouldInsertCount": len(would_insert),
        "insertedCount": len(inserted),
        "skippedExistingCount": len(skipped_existing),
        "importedSfx": imported_sfx,
        "saveProjectResult": save_result,
        "samples": {
            "wouldInsert": [result_entry(entry, fps) for entry in would_insert[:10]],
            "inserted": inserted[:10],
            "skippedExisting": skipped_existing[:10],
        },
    }


def collect_photo_items(timeline, photo_group_name, photo_color):
    entries = []
    track_count = host.safe_call(timeline, "GetTrackCount", "video") or 0
    for track_index in range(1, int(track_count) + 1):
        items = host.safe_call(timeline, "GetItemListInTrack", "video", track_index)
        if items is None:
            items = host.safe_call(timeline, "GetItemsInTrack", "video", track_index)
        for item in host.iter_values(items or []):
            source_path = host.normalize_filesystem_path(host.extract_timeline_item_file_path(item))
            start_frame = host.parse_float(host.safe_call(item, "GetStart"))
            if start_frame is None:
                continue
            if not is_photo_item(item, source_path, photo_group_name, photo_color):
                continue
            entries.append({
                "item": item,
                "trackIndex": track_index,
                "name": host.stringify_signal_value(host.safe_call(item, "GetName")) or "",
                "sourcePath": source_path,
                "sourceStem": Path(source_path).stem if source_path else "",
                "startFrame": start_frame,
            })
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


def find_or_create_audio_track(timeline, track_name, dry_run, reuse_empty_track=True):
    existing = find_audio_track_by_name(timeline, track_name)
    if existing is not None:
        return existing, False, False
    if reuse_empty_track:
        empty_track = find_first_empty_audio_track(timeline)
        if empty_track is not None:
            if not dry_run:
                host.safe_call(timeline, "SetTrackName", "audio", empty_track, track_name)
            return empty_track, False, True
    if dry_run:
        count = host.safe_call(timeline, "GetTrackCount", "audio") or 0
        return int(count) + 1, True, False
    before = int(host.safe_call(timeline, "GetTrackCount", "audio") or 0)
    created = host.safe_call(timeline, "AddTrack", "audio", "stereo")
    after = int(host.safe_call(timeline, "GetTrackCount", "audio") or 0)
    if created is False or after <= before:
        raise ToolError("audio_track_create_failed", f"Unable to create audio track: {track_name}")
    track_index = after
    host.safe_call(timeline, "SetTrackName", "audio", track_index, track_name)
    return track_index, True, False


def find_audio_track_by_name(timeline, track_name):
    count = int(host.safe_call(timeline, "GetTrackCount", "audio") or 0)
    for index in range(1, count + 1):
        name = host.stringify_signal_value(host.safe_call(timeline, "GetTrackName", "audio", index)) or ""
        if name == track_name:
            return index
    return None


def find_first_empty_audio_track(timeline):
    count = int(host.safe_call(timeline, "GetTrackCount", "audio") or 0)
    for index in range(1, count + 1):
        items = host.safe_call(timeline, "GetItemListInTrack", "audio", index)
        if items is None:
            items = host.safe_call(timeline, "GetItemsInTrack", "audio", index)
        if not list(host.iter_values(items or [])):
            return index
    return None


def collect_existing_sfx_starts(timeline, track_index, sfx_path):
    starts = []
    items = host.safe_call(timeline, "GetItemListInTrack", "audio", track_index)
    if items is None:
        items = host.safe_call(timeline, "GetItemsInTrack", "audio", track_index)
    for item in host.iter_values(items or []):
        source_path = host.normalize_filesystem_path(host.extract_timeline_item_file_path(item))
        if source_path != sfx_path:
            continue
        start_frame = host.parse_float(host.safe_call(item, "GetStart"))
        if start_frame is not None:
            starts.append(start_frame)
    return starts


def has_existing_start(start_frame, existing_starts, tolerance_frames):
    return any(abs(start_frame - existing) <= tolerance_frames for existing in existing_starts)


def find_or_import_media_pool_item(resolve, media_pool, sfx_path, namespace, folder):
    namespace_folder = host.ensure_namespace_folder(media_pool, namespace)
    namespace_state = host.collect_namespace_state(namespace_folder)
    existing = namespace_state["clipBySourcePath"].get(sfx_path)
    if existing is not None:
        return existing, False
    target_folder = host.ensure_folder_chain(
        media_pool,
        namespace_folder,
        namespace_state["folderByRelativeDir"],
        folder,
    )
    item = host.import_media_pool_item(host.require_method(resolve, "GetMediaStorage")(), media_pool, target_folder, sfx_path)
    return item, True


def append_sfx_at_photo_start(media_pool, sfx_item, track_index, target_start_frame, timeline_start_frame):
    record_frame = int(round(target_start_frame - timeline_start_frame))
    appended = host.safe_call(media_pool, "AppendToTimeline", [{
        "mediaPoolItem": sfx_item,
        "mediaType": 2,
        "trackIndex": track_index,
        "recordFrame": record_frame,
    }])
    for item in host.iter_values(appended or []):
        track_info = host.safe_call(item, "GetTrackTypeAndIndex")
        if isinstance(track_info, (list, tuple)) and len(track_info) >= 2:
            if str(track_info[0]).lower() == "audio" and int(track_info[1]) == int(track_index):
                return item
    return next(iter(host.iter_values(appended or [])), None)


def build_timeline_item_name(photo_entry, sfx_item):
    sfx_name = host.stringify_signal_value(host.safe_call(sfx_item, "GetName")) or "photo-sfx"
    source = photo_entry.get("sourceStem") or photo_entry.get("name") or "photo"
    return f"Kairos Photo SFX {source} {sfx_name}"[:180]


def result_entry(entry, fps):
    return {
        "photoName": entry.get("name"),
        "sourceStem": entry.get("sourceStem"),
        "sourcePath": entry.get("sourcePath"),
        "videoTrackIndex": entry.get("trackIndex"),
        "startFrame": entry.get("startFrame"),
        "timelineInMs": host.frames_to_ms(entry.get("startFrame"), fps),
    }


if __name__ == "__main__":
    raise SystemExit(main())
