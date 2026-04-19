#!/usr/bin/env python3
import argparse
import json
import os
import sys
import time
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(description="Kairos Resolve color host")
    parser.add_argument("--request", required=True, help="Path to JSON request")
    args = parser.parse_args()

    try:
        payload = json.loads(Path(args.request).read_text(encoding="utf-8"))
        operation = payload.get("operation")
        script_api_root = payload.get("scriptApiRoot")
        request_input = payload.get("input") or {}
        resolve = load_resolve(script_api_root)

        if operation == "prepare_root":
            result = prepare_root(resolve, request_input)
        elif operation == "sync_groups":
            result = sync_groups(resolve, request_input)
        elif operation == "execute_group":
            result = execute_group(resolve, request_input)
        else:
            raise HostError("invalid_operation", f"Unsupported operation: {operation}")

        print(json.dumps(result, ensure_ascii=False))
        return 0
    except HostError as error:
        print(json.dumps(error.to_payload(), ensure_ascii=False), file=sys.stderr)
        return 2
    except Exception as error:  # pragma: no cover - defensive bridge
        print(
            json.dumps(
                {
                    "code": "resolve_color_host_unhandled",
                    "message": str(error),
                },
                ensure_ascii=False,
            ),
            file=sys.stderr,
        )
        return 1


class HostError(RuntimeError):
    def __init__(self, code: str, message: str, details=None):
        super().__init__(message)
        self.code = code
        self.details = details

    def to_payload(self):
        payload = {
            "code": self.code,
            "message": str(self),
        }
        if self.details is not None:
            payload["details"] = self.details
        return payload


def load_resolve(script_api_root):
    append_script_api_paths(script_api_root)
    try:
        import DaVinciResolveScript as dvr_script  # type: ignore
    except Exception as error:
        raise HostError(
            "resolve_script_api_missing",
            "Unable to import DaVinciResolveScript. Configure resolveColorScriptApiRoot or install the official scripting API.",
            {"error": str(error)},
        )
    resolve = dvr_script.scriptapp("Resolve")
    if resolve is None:
        raise HostError(
            "resolve_app_unavailable",
            "Unable to connect to DaVinci Resolve. Make sure Resolve Studio is running and external scripting is enabled.",
        )
    return resolve


def append_script_api_paths(explicit_root):
    candidates = []
    if explicit_root:
        root = Path(explicit_root).expanduser()
        candidates.extend([root, root / "Modules"])

    env_root = os.environ.get("RESOLVE_SCRIPT_API")
    if env_root:
        env_path = Path(env_root).expanduser()
        candidates.extend([env_path, env_path / "Modules"])

    if sys.platform == "darwin":
        base = Path("/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting")
    elif sys.platform == "win32":
        base = Path("C:/ProgramData/Blackmagic Design/DaVinci Resolve/Support/Developer/Scripting")
    else:
        base = Path("/opt/resolve/Developer/Scripting")
    candidates.extend([base, base / "Modules"])

    for candidate in candidates:
        text = str(candidate)
        if candidate.exists() and text not in sys.path:
            sys.path.insert(0, text)


def prepare_root(resolve, payload):
    project = ensure_project(resolve, payload["resolveProjectName"])
    media_pool = require_method(project, "GetMediaPool")()
    ensure_namespace_folder(media_pool, payload["rootNamespace"])
    ensure_timeline(project, media_pool, payload["gradingTimelineName"])
    return {
        "resolveProjectName": payload["resolveProjectName"],
        "gradingTimelineName": payload["gradingTimelineName"],
        "mirrorStatus": "synced",
        "timelineStatus": "ready",
        "hostSummary": {
            "rootNamespace": payload["rootNamespace"],
        },
    }


def sync_groups(resolve, payload):
    project = ensure_project(resolve, payload["resolveProjectName"])
    timeline = ensure_named_timeline(project, payload["gradingTimelineName"])
    group_map = {}
    for item in iter_timeline_video_items(timeline):
        file_path = extract_timeline_item_file_path(item)
        if not file_path:
            continue
        try:
            clip_key = to_portable_relative(payload["rawLocalPath"], file_path)
        except ValueError:
            continue
        group_key = normalize_group_key(extract_group_name(item) or "ungrouped")
        display_name = extract_group_name(item) or "ungrouped"
        entry = group_map.setdefault(group_key, {
            "groupKey": group_key,
            "displayName": display_name,
            "clipKeys": [],
            "hostSummary": {
                "timelineName": payload["gradingTimelineName"],
                "groupName": display_name,
            },
        })
        if clip_key not in entry["clipKeys"]:
            entry["clipKeys"].append(clip_key)

    groups = sorted(group_map.values(), key=lambda item: item["groupKey"])
    return {
        "rootId": payload["rootId"],
        "syncedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "timelineName": payload["gradingTimelineName"],
        "groups": groups,
    }


def execute_group(resolve, payload):
    project = ensure_project(resolve, payload["resolveProjectName"])
    timeline = ensure_named_timeline(project, payload["gradingTimelineName"])
    require_method(project, "SetCurrentTimeline")(timeline)
    render_format = normalize_render_format(payload.get("renderPreset", {}))
    set_render_format(project, render_format)

    entries = []
    target_dir = Path(payload["stagingRoot"]).expanduser().resolve()
    target_dir.mkdir(parents=True, exist_ok=True)

    clip_key_to_item = {}
    for item in iter_timeline_video_items(timeline):
        file_path = extract_timeline_item_file_path(item)
        if not file_path:
            continue
        try:
            clip_key = to_portable_relative_from_candidates(
                [clip["sourceAbsolutePath"] for clip in payload.get("clips", []) if clip.get("sourceAbsolutePath")],
                file_path,
            )
        except ValueError:
            continue
        clip_key_to_item[clip_key] = item

    for clip in payload.get("clips", []):
        clip_key = clip["rawRelativePath"]
        timeline_item = clip_key_to_item.get(clip_key)
        if timeline_item is None:
          raise HostError("resolve_group_clip_missing", f"Clip not found on timeline for group render: {clip_key}")
        output_name = normalize_output_filename(clip_key)
        output_path = str(target_dir / output_name)
        queue_render_job(project, timeline_item, target_dir, output_name)
        entries.append({
            "rawRelativePath": clip_key,
            "outputPath": output_path,
            "normalizedOutputFilename": output_name,
        })

    start_rendering(project)
    wait_for_render(project)

    return {
        "renderedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "entries": entries,
        "hostSummary": {
            "timelineName": payload["gradingTimelineName"],
            "groupKey": payload["groupKey"],
        },
    }


def ensure_project(resolve, project_name):
    project_manager = require_method(resolve, "GetProjectManager")()
    current = safe_call(project_manager, "GetCurrentProject")
    if current and safe_call(current, "GetName") == project_name:
        return current
    loaded = safe_call(project_manager, "LoadProject", project_name)
    if loaded:
        return loaded
    created = safe_call(project_manager, "CreateProject", project_name)
    if created:
        return created
    current = safe_call(project_manager, "GetCurrentProject")
    if current and safe_call(current, "GetName") == project_name:
        return current
    raise HostError("resolve_project_unavailable", f"Unable to load or create Resolve project: {project_name}")


def ensure_namespace_folder(media_pool, namespace):
    root_folder = require_method(media_pool, "GetRootFolder")()
    subfolders = safe_call(root_folder, "GetSubFolders") or safe_call(root_folder, "GetSubFolderList") or []
    for folder in iter_values(subfolders):
        if safe_call(folder, "GetName") == namespace:
            return folder
    created = safe_call(media_pool, "AddSubFolder", root_folder, namespace)
    return created or root_folder


def ensure_timeline(project, media_pool, timeline_name):
    current = safe_call(project, "GetCurrentTimeline")
    if current and safe_call(current, "GetName") == timeline_name:
        return current
    existing = find_named_timeline(project, timeline_name)
    if existing:
        safe_call(project, "SetCurrentTimeline", existing)
        return existing
    created = safe_call(media_pool, "CreateEmptyTimeline", timeline_name)
    if created:
        safe_call(project, "SetCurrentTimeline", created)
        return created
    existing = find_named_timeline(project, timeline_name)
    if existing:
        safe_call(project, "SetCurrentTimeline", existing)
        return existing
    raise HostError("resolve_timeline_unavailable", f"Unable to ensure grading timeline: {timeline_name}")


def ensure_named_timeline(project, timeline_name):
    current = safe_call(project, "GetCurrentTimeline")
    if current and safe_call(current, "GetName") == timeline_name:
        return current
    existing = find_named_timeline(project, timeline_name)
    if existing:
        safe_call(project, "SetCurrentTimeline", existing)
        return existing
    raise HostError("resolve_timeline_missing", f"Missing grading timeline: {timeline_name}")


def find_named_timeline(project, timeline_name):
    count = safe_call(project, "GetTimelineCount") or 0
    for index in range(1, int(count) + 1):
        candidate = safe_call(project, "GetTimelineByIndex", index)
        if candidate and safe_call(candidate, "GetName") == timeline_name:
            return candidate
    return None


def iter_timeline_video_items(timeline):
    track_count = safe_call(timeline, "GetTrackCount", "video") or safe_call(timeline, "GetTrackCount", "Video") or 0
    for track_index in range(1, int(track_count) + 1):
        items = safe_call(timeline, "GetItemListInTrack", "video", track_index)
        if items is None:
            items = safe_call(timeline, "GetItemsInTrack", "video", track_index)
        for item in iter_values(items or []):
            yield item


def extract_timeline_item_file_path(item):
    media_pool_item = safe_call(item, "GetMediaPoolItem")
    candidates = []
    if media_pool_item:
        clip_property = safe_call(media_pool_item, "GetClipProperty")
        if isinstance(clip_property, dict):
            candidates.extend([
                clip_property.get("File Path"),
                clip_property.get("FilePath"),
                clip_property.get("Path"),
                clip_property.get("Clip Path"),
            ])
        for key in ("File Path", "FilePath", "Path", "Clip Path"):
            value = safe_call(media_pool_item, "GetClipProperty", key)
            if value:
                candidates.append(value)
    clip_property = safe_call(item, "GetProperty")
    if isinstance(clip_property, dict):
        candidates.extend([
            clip_property.get("File Path"),
            clip_property.get("Source File"),
            clip_property.get("Path"),
        ])
    for candidate in candidates:
        if isinstance(candidate, str) and candidate.strip():
            return str(Path(candidate).expanduser())
    return None


def extract_group_name(item):
    for method_name in ("GetGroup", "GetColorGroup"):
        group = safe_call(item, method_name)
        if group:
            group_name = safe_call(group, "GetName")
            if isinstance(group_name, str) and group_name.strip():
                return group_name.strip()
    for method_name in ("GetProperty", "GetClipProperty", "GetMetadata"):
        getter = getattr(item, method_name, None)
        if getter is None:
            continue
        for key in ("Group", "Group Name", "Color Group"):
            try:
                value = getter(key)
            except Exception:
                continue
            if isinstance(value, str) and value.strip():
                return value.strip()
    media_pool_item = safe_call(item, "GetMediaPoolItem")
    if media_pool_item:
        for key in ("Group", "Group Name", "Color Group"):
            value = safe_call(media_pool_item, "GetClipProperty", key) or safe_call(media_pool_item, "GetMetadata", key)
            if isinstance(value, str) and value.strip():
                return value.strip()
    return None


def normalize_group_key(value):
    lowered = value.strip().lower()
    sanitized = []
    for char in lowered:
        if char.isalnum():
            sanitized.append(char)
        else:
            sanitized.append("-")
    normalized = "".join(sanitized).strip("-")
    return normalized or "ungrouped"


def normalize_output_filename(raw_relative_path):
    stem = Path(raw_relative_path).stem
    safe_stem = stem.replace("/", "_").replace("\\", "_")
    return f"{safe_stem}.mp4"


def normalize_render_format(render_preset):
    container = str(render_preset.get("container") or "mp4").lower()
    video_codec = str(render_preset.get("videoCodec") or "h265").lower()
    audio_codec = str(render_preset.get("audioCodec") or "aac").lower()
    return {
        "container": container,
        "videoCodec": video_codec,
        "audioCodec": audio_codec,
    }


def set_render_format(project, render_format):
    format_name = render_format["container"].upper()
    codec_name = render_format["videoCodec"].upper()
    safe_call(project, "SetCurrentRenderFormatAndCodec", format_name, codec_name)


def queue_render_job(project, timeline_item, target_dir, output_name):
    mark_in = safe_call(timeline_item, "GetStart") or safe_call(timeline_item, "GetTimelineIn") or 0
    mark_out = safe_call(timeline_item, "GetEnd") or safe_call(timeline_item, "GetTimelineOut") or mark_in
    settings = {
        "TargetDir": str(target_dir),
        "CustomName": output_name,
        "MarkIn": int(mark_in),
        "MarkOut": int(mark_out),
        "ExportVideo": True,
        "ExportAudio": True,
    }
    if safe_call(project, "SetRenderSettings", settings) is False:
        raise HostError("resolve_render_settings_failed", f"Unable to set render settings for {output_name}")
    if safe_call(project, "AddRenderJob") is False:
        raise HostError("resolve_add_render_job_failed", f"Unable to queue render job for {output_name}")


def start_rendering(project):
    result = safe_call(project, "StartRendering")
    if result is False:
        raise HostError("resolve_start_render_failed", "Unable to start Resolve rendering")


def wait_for_render(project, timeout_seconds=3600):
    started = time.time()
    while True:
        in_progress = safe_call(project, "IsRenderingInProgress")
        if not in_progress:
            return
        if time.time() - started > timeout_seconds:
            raise HostError("resolve_render_timeout", "Timed out waiting for Resolve rendering")
        time.sleep(1)


def to_portable_relative(root_path, file_path):
    root = Path(root_path).resolve()
    path = Path(file_path).resolve()
    try:
        relative = path.relative_to(root)
    except ValueError as error:
        raise ValueError(str(error))
    return str(relative).replace("\\", "/")


def to_portable_relative_from_candidates(source_paths, file_path):
    candidate_path = Path(file_path).resolve()
    for source_path in source_paths:
        source = Path(source_path).resolve()
        if source == candidate_path:
            return str(source.name)
    raise ValueError(f"Unable to map rendered clip back to request source: {file_path}")


def iter_values(value):
    if isinstance(value, dict):
        return value.values()
    if isinstance(value, list):
        return value
    if isinstance(value, tuple):
        return value
    return []


def require_method(target, method_name):
    method = getattr(target, method_name, None)
    if method is None:
        raise HostError("resolve_api_missing_method", f"Resolve object is missing method: {method_name}")
    return method


def safe_call(target, method_name, *args):
    method = getattr(target, method_name, None)
    if method is None:
        return None
    try:
        return method(*args)
    except Exception:
        return None


if __name__ == "__main__":
    raise SystemExit(main())
