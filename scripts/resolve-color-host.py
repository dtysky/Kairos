#!/usr/bin/env python3
import argparse
import hashlib
import json
import os
import sys
import time
from pathlib import Path


CSIGNAL_KEYS = (
    "colorspace",
    "gamma",
    "logProfile",
    "cameraModel",
    "codecFamily",
    "resolution",
    "fps",
)


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

        if operation == "preflight":
            result = preflight(resolve, request_input)
        elif operation == "prepare_root":
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
    media_storage = require_method(resolve, "GetMediaStorage")()
    namespace_folder = ensure_namespace_folder(media_pool, payload["rootNamespace"])
    timeline = ensure_timeline(project, media_pool, payload["gradingTimelineName"])
    clip_requests = normalize_clip_requests(payload.get("clips"))
    previous_group_names_by_clip = capture_timeline_group_assignments(timeline, payload["rawLocalPath"])

    namespace_state = collect_namespace_state(namespace_folder)
    prepared_entries, sync_summary = sync_namespace_clips(
        media_pool,
        media_storage,
        namespace_folder,
        namespace_state,
        clip_requests,
    )
    ordered_entries = sort_clip_entries(prepared_entries)

    clear_timeline_items(timeline)
    append_clips_to_timeline(project, media_pool, timeline, ordered_entries)
    timeline_item_by_clip_key = build_timeline_item_map(timeline, payload["rawLocalPath"])
    assign_generated_groups(project, ordered_entries, timeline_item_by_clip_key, previous_group_names_by_clip)

    groups_snapshot = build_groups_snapshot(
        payload["rootId"],
        timeline,
        payload["gradingTimelineName"],
        payload["rawLocalPath"],
        clip_requests,
        origin="prepare_root",
    )
    save_project(project)
    return {
        "resolveProjectName": payload["resolveProjectName"],
        "gradingTimelineName": payload["gradingTimelineName"],
        "mirrorStatus": "synced",
        "timelineStatus": "ready",
        "groupsSnapshot": groups_snapshot,
        "hostSummary": {
            "rootNamespace": payload["rootNamespace"],
            "clipCount": len(ordered_entries),
            "importedClipCount": sync_summary["imported"],
            "movedClipCount": sync_summary["moved"],
            "reusedClipCount": sync_summary["reused"],
            "groupCount": len(groups_snapshot["groups"]),
        },
    }


def preflight(resolve, payload):
    warnings = []
    degraded_reasons = []
    product_name = get_resolve_product_name(resolve)
    version_string, version_tuple, version_warnings = get_resolve_version_info(resolve)
    warnings.extend(version_warnings)
    if version_warnings:
        degraded_reasons.extend(version_warnings)

    is_studio = infer_is_studio(product_name)
    blocking_reasons = []
    if not is_studio:
        blocking_reasons.append("当前仅支持 DaVinci Resolve Studio。")
    if version_tuple is None:
        warnings.append("无法稳定识别 Resolve 版本，已按降级兼容口径处理。")
        degraded_reasons.append("version_probe_fallback")
    elif version_tuple < (18, 5):
        blocking_reasons.append(
            f"当前 Resolve 版本为 {version_string or format_version_tuple(version_tuple)}，正式要求 >= 18.5。",
        )

    render_support = {
        "containers": [],
        "supportsAudioCodec": False,
        "supportsVideoQuality": False,
    }
    if not blocking_reasons:
        project, project_warnings = ensure_preflight_project(resolve, payload.get("resolveProjectName"))
        warnings.extend(project_warnings)
        degraded_reasons.extend(project_warnings)
        render_support, render_warnings, render_degraded = collect_render_support(project)
        warnings.extend(render_warnings)
        if render_degraded:
            degraded_reasons.append("render_support_probe")

    status = "blocked" if blocking_reasons else ("degraded" if degraded_reasons else "ready")
    return {
        "status": status,
        "checkedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "productName": product_name,
        "versionString": version_string,
        "isStudio": is_studio,
        "warnings": dedupe_strings(warnings),
        "blockingReasons": dedupe_strings(blocking_reasons),
        "renderSupport": render_support,
    }


def sync_groups(resolve, payload):
    project = ensure_project(resolve, payload["resolveProjectName"])
    timeline = ensure_named_timeline(project, payload["gradingTimelineName"])
    return build_groups_snapshot(
        payload["rootId"],
        timeline,
        payload["gradingTimelineName"],
        payload["rawLocalPath"],
        normalize_clip_requests(payload.get("clips")),
        origin="resolve",
    )


def execute_group(resolve, payload):
    project = ensure_project(resolve, payload["resolveProjectName"])
    timeline = ensure_named_timeline(project, payload["gradingTimelineName"])
    require_method(project, "SetCurrentTimeline")(timeline)
    render_format = normalize_render_format(payload.get("renderPreset", {}))
    resolved_render_format = set_render_format(project, render_format)
    safe_call(project, "DeleteAllRenderJobs")

    entries = []
    target_dir = Path(payload["stagingRoot"]).expanduser().resolve()
    target_dir.mkdir(parents=True, exist_ok=True)

    clip_key_to_item = build_timeline_item_map(timeline, payload["rawLocalPath"])
    queued_job_ids = []
    for clip in payload.get("clips", []):
        clip_key = normalize_portable_path(clip.get("rawRelativePath"))
        timeline_item = clip_key_to_item.get(clip_key)
        if timeline_item is None:
            raise HostError("resolve_group_clip_missing", f"Clip not found on timeline for group render: {clip_key}")
        relative_dir = portable_parent_dir(clip_key)
        output_name = normalize_output_filename(clip_key, resolved_render_format["extension"])
        output_dir = target_dir / relative_dir if relative_dir else target_dir
        output_dir.mkdir(parents=True, exist_ok=True)
        output_path = str((output_dir / output_name).resolve())
        queued_job_ids.append(queue_render_job(project, timeline_item, output_dir, output_name, resolved_render_format))
        entries.append({
            "rawRelativePath": clip_key,
            "outputPath": output_path,
            "normalizedOutputFilename": output_name,
        })

    start_rendering(project, queued_job_ids)
    wait_for_render(project)

    return {
        "renderedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "entries": entries,
        "hostSummary": {
            "timelineName": payload["gradingTimelineName"],
            "groupKey": payload["groupKey"],
            "resolvedFormat": resolved_render_format["format"],
            "resolvedCodec": resolved_render_format["videoCodec"],
            "audioCodec": resolved_render_format["audioCodec"],
            "bitrateMbps": resolved_render_format["bitrateMbps"],
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


def ensure_preflight_project(resolve, project_name):
    warnings = []
    project_manager = require_method(resolve, "GetProjectManager")()
    current = safe_call(project_manager, "GetCurrentProject")
    if current and safe_call(current, "GetName"):
        current_name = safe_call(current, "GetName")
        if not project_name or current_name == project_name:
            return current, warnings

    if project_name:
        loaded = safe_call(project_manager, "LoadProject", project_name)
        if loaded:
            return loaded, warnings
        current = safe_call(project_manager, "GetCurrentProject")
        if current and safe_call(current, "GetName") == project_name:
            return current, warnings
        created = safe_call(project_manager, "CreateProject", project_name)
        if created:
            warnings.append("preflight 为探测 render 支持创建了目标 Resolve 项目的空壳。")
            return created, warnings

    current = safe_call(project_manager, "GetCurrentProject")
    if current:
        warnings.append("preflight 复用了当前 Resolve 项目来探测 render 支持。")
        return current, warnings
    raise HostError("resolve_project_unavailable", "Unable to acquire a Resolve project for preflight render support probe.")


def ensure_namespace_folder(media_pool, namespace):
    root_folder = require_method(media_pool, "GetRootFolder")()
    subfolders = safe_call(root_folder, "GetSubFolders") or safe_call(root_folder, "GetSubFolderList") or []
    for folder in iter_values(subfolders):
        if safe_call(folder, "GetName") == namespace:
            return folder
    created = safe_call(media_pool, "AddSubFolder", root_folder, namespace)
    if created:
        return created
    raise HostError("resolve_media_pool_namespace_failed", f"Unable to ensure root namespace folder: {namespace}")


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


def capture_timeline_group_assignments(timeline, raw_local_path):
    assignments = {}
    for item in iter_timeline_video_items(timeline):
        file_path = extract_timeline_item_file_path(item)
        if not file_path:
            continue
        try:
            clip_key = to_portable_relative(raw_local_path, file_path)
        except ValueError:
            continue
        group_name = extract_group_name(item)
        if group_name:
            assignments[clip_key] = group_name
    return assignments


def collect_namespace_state(namespace_folder):
    folder_by_relative_dir = {"": namespace_folder}
    clip_by_source_path = {}
    clip_folder_by_source_path = {}

    def walk(folder, relative_dir):
        for clip in iter_values(safe_call(folder, "GetClipList") or []):
            file_path = normalize_filesystem_path(extract_media_pool_item_file_path(clip))
            if not file_path:
                continue
            clip_by_source_path[file_path] = clip
            clip_folder_by_source_path[file_path] = folder
        subfolders = safe_call(folder, "GetSubFolders") or safe_call(folder, "GetSubFolderList") or []
        for child in iter_values(subfolders):
            child_name = safe_call(child, "GetName")
            if not isinstance(child_name, str) or not child_name.strip():
                continue
            child_relative_dir = normalize_portable_path(join_portable(relative_dir, child_name.strip()))
            folder_by_relative_dir[child_relative_dir] = child
            walk(child, child_relative_dir)

    walk(namespace_folder, "")
    return {
        "folderByRelativeDir": folder_by_relative_dir,
        "clipBySourcePath": clip_by_source_path,
        "clipFolderBySourcePath": clip_folder_by_source_path,
    }


def sync_namespace_clips(media_pool, media_storage, namespace_folder, namespace_state, clip_requests):
    imported = 0
    moved = 0
    reused = 0
    prepared_entries = []
    folder_by_relative_dir = namespace_state["folderByRelativeDir"]
    clip_by_source_path = namespace_state["clipBySourcePath"]
    clip_folder_by_source_path = namespace_state["clipFolderBySourcePath"]

    for clip_request in clip_requests:
        relative_dir = portable_parent_dir(clip_request["rawRelativePath"])
        target_folder = ensure_folder_chain(media_pool, namespace_folder, folder_by_relative_dir, relative_dir)
        source_path = clip_request["sourceAbsolutePath"]
        media_pool_item = clip_by_source_path.get(source_path)
        if media_pool_item is None:
            media_pool_item = import_media_pool_item(media_storage, media_pool, target_folder, source_path)
            imported += 1
        else:
            current_folder = clip_folder_by_source_path.get(source_path)
            if current_folder is not target_folder:
                result = safe_call(media_pool, "MoveClips", [media_pool_item], target_folder)
                if result is False:
                    raise HostError(
                        "resolve_media_pool_move_failed",
                        f"Unable to move clip into root namespace mirror: {clip_request['rawRelativePath']}",
                    )
                moved += 1
            else:
                reused += 1
        clip_by_source_path[source_path] = media_pool_item
        clip_folder_by_source_path[source_path] = target_folder
        technical = build_clip_technical_summary(media_pool_item, clip_request)
        prepared_entries.append({
            **clip_request,
            "mediaPoolItem": media_pool_item,
            "signals": technical["signals"],
            "fingerprint": technical["fingerprint"],
            "displayName": technical["displayName"],
        })

    return prepared_entries, {
        "imported": imported,
        "moved": moved,
        "reused": reused,
    }


def ensure_folder_chain(media_pool, namespace_folder, folder_by_relative_dir, relative_dir):
    normalized_dir = normalize_portable_path(relative_dir)
    if not normalized_dir:
        return namespace_folder
    current = namespace_folder
    segments = [segment for segment in normalized_dir.split("/") if segment]
    built = []
    for segment in segments:
        built.append(segment)
        key = "/".join(built)
        folder = folder_by_relative_dir.get(key)
        if folder is None:
            folder = safe_call(media_pool, "AddSubFolder", current, segment)
            if not folder:
                raise HostError("resolve_media_pool_folder_failed", f"Unable to create mirror folder: {key}")
            folder_by_relative_dir[key] = folder
        current = folder
    return current


def import_media_pool_item(media_storage, media_pool, target_folder, source_path):
    safe_call(media_pool, "SetCurrentFolder", target_folder)
    imported = safe_call(media_storage, "AddItemListToMediaPool", [source_path])
    if not imported:
        imported = safe_call(media_pool, "ImportMedia", [source_path])
    for candidate in iter_values(imported or []):
        file_path = normalize_filesystem_path(extract_media_pool_item_file_path(candidate))
        if file_path == source_path:
            return candidate
    first = next(iter(iter_values(imported or [])), None)
    if first:
        return first
    raise HostError("resolve_media_pool_import_failed", f"Unable to import clip into Resolve: {source_path}")


def clear_timeline_items(timeline):
    for track_type in ("video", "audio", "subtitle"):
        items = []
        track_count = safe_call(timeline, "GetTrackCount", track_type) or 0
        for track_index in range(1, int(track_count) + 1):
            track_items = safe_call(timeline, "GetItemListInTrack", track_type, track_index)
            if track_items is None:
                track_items = safe_call(timeline, "GetItemsInTrack", track_type, track_index)
            items.extend(iter_values(track_items or []))
        if items:
            result = safe_call(timeline, "DeleteClips", items, False)
            if result is False:
                raise HostError("resolve_timeline_clear_failed", f"Unable to clear {track_type} timeline items")


def append_clips_to_timeline(project, media_pool, timeline, clip_entries):
    safe_call(project, "SetCurrentTimeline", timeline)
    for entry in clip_entries:
        appended = safe_call(media_pool, "AppendToTimeline", [entry["mediaPoolItem"]])
        if not appended:
            raise HostError(
                "resolve_timeline_append_failed",
                f"Unable to append clip to grading timeline: {entry['rawRelativePath']}",
            )


def build_timeline_item_map(timeline, raw_local_path):
    clip_key_to_item = {}
    for item in iter_timeline_video_items(timeline):
        file_path = extract_timeline_item_file_path(item)
        if not file_path:
            continue
        try:
            clip_key = to_portable_relative(raw_local_path, file_path)
        except ValueError:
            continue
        clip_key_to_item[clip_key] = item
    return clip_key_to_item


def assign_generated_groups(project, clip_entries, timeline_item_by_clip_key, previous_group_names_by_clip):
    existing_groups_by_name = {}
    for group in iter_values(safe_call(project, "GetColorGroupsList") or []):
        group_name = safe_call(group, "GetName")
        if isinstance(group_name, str) and group_name.strip():
            existing_groups_by_name[group_name.strip()] = group

    entries_by_fingerprint = {}
    for entry in clip_entries:
        entries_by_fingerprint.setdefault(entry["fingerprint"], []).append(entry)

    claimed_group_names = set()
    for fingerprint, entries in entries_by_fingerprint.items():
        previous_names = sorted({
            previous_group_names_by_clip.get(entry["rawRelativePath"])
            for entry in entries
            if previous_group_names_by_clip.get(entry["rawRelativePath"])
        })
        if len(previous_names) == 1 and previous_names[0] not in claimed_group_names:
            desired_group_name = previous_names[0]
        else:
            desired_group_name = ensure_unique_group_name(
                entries[0]["displayName"],
                fingerprint,
                claimed_group_names,
                existing_groups_by_name,
            )
        claimed_group_names.add(desired_group_name)
        color_group = ensure_color_group(project, existing_groups_by_name, desired_group_name)
        for entry in entries:
            timeline_item = timeline_item_by_clip_key.get(entry["rawRelativePath"])
            if timeline_item is None:
                raise HostError(
                    "resolve_timeline_clip_missing_after_prepare",
                    f"Prepared timeline item missing after append: {entry['rawRelativePath']}",
                )
            current_group = safe_call(timeline_item, "GetColorGroup")
            current_group_name = safe_call(current_group, "GetName") if current_group else None
            if current_group_name == desired_group_name:
                continue
            if current_group:
                safe_call(timeline_item, "RemoveFromColorGroup")
            result = safe_call(timeline_item, "AssignToColorGroup", color_group)
            if result is False:
                raise HostError(
                    "resolve_color_group_assign_failed",
                    f"Unable to assign clip to Resolve group: {entry['rawRelativePath']}",
                )


def ensure_unique_group_name(base_name, fingerprint, claimed_group_names, existing_groups_by_name):
    candidate = base_name or "Ungrouped"
    if candidate not in claimed_group_names:
        return candidate
    short_fingerprint = hashlib.sha1(fingerprint.encode("utf-8")).hexdigest()[:8]
    candidate = f"{candidate} [{short_fingerprint}]"
    index = 2
    while candidate in claimed_group_names:
        candidate = f"{base_name or 'Ungrouped'} [{short_fingerprint}-{index}]"
        index += 1
    return candidate


def ensure_color_group(project, existing_groups_by_name, group_name):
    existing = existing_groups_by_name.get(group_name)
    if existing:
        return existing
    created = safe_call(project, "AddColorGroup", group_name)
    if created:
        existing_groups_by_name[group_name] = created
        return created
    for group in iter_values(safe_call(project, "GetColorGroupsList") or []):
        current_name = safe_call(group, "GetName")
        if current_name == group_name:
            existing_groups_by_name[group_name] = group
            return group
    raise HostError("resolve_color_group_missing", f"Unable to create or reuse Resolve group: {group_name}")


def build_groups_snapshot(root_id, timeline, timeline_name, raw_local_path, clip_requests, origin):
    clip_requests_by_key = {
        clip["rawRelativePath"]: clip
        for clip in clip_requests
    }
    group_map = {}
    for item in iter_timeline_video_items(timeline):
        file_path = extract_timeline_item_file_path(item)
        if not file_path:
            continue
        try:
            clip_key = to_portable_relative(raw_local_path, file_path)
        except ValueError:
            continue
        group_name = extract_group_name(item) or "Ungrouped"
        technical = build_clip_technical_summary(
            safe_call(item, "GetMediaPoolItem"),
            clip_requests_by_key.get(clip_key, {"rawRelativePath": clip_key, "rawTags": {}}),
        )
        entry = group_map.setdefault(group_name, {
            "displayName": group_name,
            "clipKeys": [],
            "signals": [],
            "fingerprints": [],
        })
        if clip_key not in entry["clipKeys"]:
            entry["clipKeys"].append(clip_key)
        entry["signals"].append(technical["signals"])
        entry["fingerprints"].append(technical["fingerprint"])

    groups = []
    for display_name in sorted(group_map):
        entry = group_map[display_name]
        summary = build_group_technical_summary(entry["signals"], entry["fingerprints"])
        groups.append({
            "groupKey": normalize_group_key(summary["fingerprint"] or display_name),
            "displayName": display_name,
            "clipKeys": entry["clipKeys"],
            "hostSummary": {
                "timelineName": timeline_name,
                "groupName": display_name,
                "origin": origin,
                "fingerprint": summary["fingerprint"],
                "signals": summary["signals"],
                **({"memberFingerprints": summary["memberFingerprints"]} if summary["memberFingerprints"] else {}),
            },
        })

    return {
        "rootId": root_id,
        "syncedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "timelineName": timeline_name,
        "groups": groups,
    }


def build_clip_technical_summary(media_pool_item, clip_request):
    properties = {}
    clip_property = safe_call(media_pool_item, "GetClipProperty") if media_pool_item else None
    if isinstance(clip_property, dict):
        properties = {
            normalize_lookup_key(key): stringify_signal_value(value)
            for key, value in clip_property.items()
            if stringify_signal_value(value)
        }
    raw_tags = normalize_string_map(clip_request.get("rawTags"))
    normalized_tags = {normalize_lookup_key(key): value for key, value in raw_tags.items()}

    colorspace = first_signal_value(
        properties,
        normalized_tags,
        property_keys=("inputcolorspace", "colorspace", "colorspacetag"),
        tag_keys=("colorspace", "colorprimaries", "color_primaries", "comappleproappscolorspace"),
    )
    gamma = first_signal_value(
        properties,
        normalized_tags,
        property_keys=("inputgamma", "gamma", "gammatag"),
        tag_keys=("gamma", "transfercharacteristics", "transfer_characteristics"),
    )
    log_profile = first_signal_value(
        properties,
        normalized_tags,
        property_keys=("logprofile", "inputgamma", "gamma"),
        tag_keys=("comappleproappslogprofile", "logprofile", "profile"),
    )
    if not log_profile and gamma and "log" in gamma.lower():
        log_profile = gamma
    camera_make = first_signal_value(
        properties,
        normalized_tags,
        property_keys=("camera", "camera1", "cameramodel", "make"),
        tag_keys=("make", "camera", "camera1", "comapplequicktimemake"),
    )
    camera_model = first_signal_value(
        properties,
        normalized_tags,
        property_keys=("cameramodel", "model", "camera"),
        tag_keys=("model", "cameramodel", "comapplequicktimemodel"),
    )
    camera_value = join_distinct_parts([camera_make, camera_model])
    codec = first_signal_value(
        properties,
        normalized_tags,
        property_keys=("codec", "videocodec"),
        tag_keys=("codec",),
    ) or clip_request.get("codec")
    codec_family = normalize_codec_family(codec)
    resolution_value = first_signal_value(
        properties,
        normalized_tags,
        property_keys=("resolution",),
        tag_keys=(),
    )
    if resolution_value:
        resolution = normalize_resolution_string(resolution_value)
    else:
        resolution = build_resolution_string(clip_request.get("width"), clip_request.get("height"))
    fps_value = first_signal_value(
        properties,
        normalized_tags,
        property_keys=("fps", "framerate", "clipframerate"),
        tag_keys=("framerate", "fps"),
    )
    fps = normalize_fps_string(fps_value or clip_request.get("fps"))

    signals = {
        "colorspace": colorspace,
        "gamma": gamma,
        "logProfile": log_profile,
        "cameraModel": camera_value,
        "codecFamily": codec_family,
        "resolution": resolution,
        "fps": fps,
    }
    fingerprint = build_signal_fingerprint(signals)
    return {
        "signals": {key: value for key, value in signals.items() if value},
        "fingerprint": fingerprint,
        "displayName": build_group_display_name(signals, fingerprint),
    }


def build_group_technical_summary(signal_list, fingerprints):
    aggregated_signals = {}
    for key in CSIGNAL_KEYS:
        values = []
        seen = set()
        for signals in signal_list:
            value = signals.get(key) if isinstance(signals, dict) else None
            if not isinstance(value, str) or not value.strip() or value in seen:
                continue
            seen.add(value)
            values.append(value)
        if len(values) == 1:
            aggregated_signals[key] = values[0]
        elif len(values) > 1:
            aggregated_signals[key] = values
    unique_fingerprints = []
    seen_fingerprints = set()
    for fingerprint in fingerprints:
        if not isinstance(fingerprint, str) or not fingerprint.strip() or fingerprint in seen_fingerprints:
            continue
        seen_fingerprints.add(fingerprint)
        unique_fingerprints.append(fingerprint)
    if len(unique_fingerprints) == 1:
        fingerprint = unique_fingerprints[0]
    elif len(unique_fingerprints) > 1:
        joined = "|".join(sorted(unique_fingerprints))
        fingerprint = f"mixed::{hashlib.sha1(joined.encode('utf-8')).hexdigest()[:12]}"
    else:
        fingerprint = "ungrouped"
    return {
        "fingerprint": fingerprint,
        "signals": aggregated_signals,
        "memberFingerprints": unique_fingerprints if len(unique_fingerprints) > 1 else [],
    }


def build_signal_fingerprint(signals):
    parts = []
    for key in CSIGNAL_KEYS:
        value = signals.get(key)
        if isinstance(value, str) and value.strip():
            parts.append(f"{key}={normalize_lookup_key(value)}")
    return "::".join(parts) or "ungrouped"


def build_group_display_name(signals, fingerprint):
    parts = [
        signals.get("cameraModel"),
        signals.get("logProfile") or signals.get("gamma"),
        signals.get("colorspace"),
        signals.get("codecFamily"),
        signals.get("resolution"),
        f"{signals['fps']}fps" if signals.get("fps") else None,
    ]
    display_name = join_distinct_parts(parts, separator=" | ")
    if display_name:
        return display_name
    if fingerprint == "ungrouped":
        return "Ungrouped"
    short_fingerprint = hashlib.sha1(fingerprint.encode("utf-8")).hexdigest()[:8]
    return f"Technical Group {short_fingerprint}"


def normalize_clip_requests(clips):
    normalized = []
    for clip in clips or []:
        raw_relative_path = normalize_portable_path(clip.get("rawRelativePath"))
        source_absolute_path = normalize_filesystem_path(clip.get("sourceAbsolutePath"))
        if not raw_relative_path or not source_absolute_path:
            continue
        normalized.append({
            "rawRelativePath": raw_relative_path,
            "sourceAbsolutePath": source_absolute_path,
            "capturedAt": stringify_signal_value(clip.get("capturedAt")),
            "width": parse_int(clip.get("width")),
            "height": parse_int(clip.get("height")),
            "fps": parse_float(clip.get("fps")),
            "codec": stringify_signal_value(clip.get("codec")),
            "rawTags": normalize_string_map(clip.get("rawTags")),
        })
    return normalized


def sort_clip_entries(entries):
    return sorted(
        entries,
        key=lambda entry: (
            entry.get("capturedAt") is None,
            entry.get("capturedAt") or "",
            entry["rawRelativePath"],
        ),
    )


def iter_timeline_video_items(timeline):
    track_count = safe_call(timeline, "GetTrackCount", "video") or safe_call(timeline, "GetTrackCount", "Video") or 0
    for track_index in range(1, int(track_count) + 1):
        items = safe_call(timeline, "GetItemListInTrack", "video", track_index)
        if items is None:
            items = safe_call(timeline, "GetItemsInTrack", "video", track_index)
        for item in iter_values(items or []):
            yield item


def extract_timeline_item_file_path(item):
    return extract_clip_like_file_path(item)


def extract_media_pool_item_file_path(item):
    return extract_clip_like_file_path(item)


def extract_clip_like_file_path(item):
    candidates = []
    clip_property = safe_call(item, "GetClipProperty")
    if isinstance(clip_property, dict):
        candidates.extend([
            clip_property.get("File Path"),
            clip_property.get("FilePath"),
            clip_property.get("Path"),
            clip_property.get("Clip Path"),
            clip_property.get("File Name"),
        ])
    for key in ("File Path", "FilePath", "Path", "Clip Path"):
        value = safe_call(item, "GetClipProperty", key)
        if value:
            candidates.append(value)
    property_map = safe_call(item, "GetProperty")
    if isinstance(property_map, dict):
        candidates.extend([
            property_map.get("File Path"),
            property_map.get("Source File"),
            property_map.get("Path"),
        ])
    media_pool_item = safe_call(item, "GetMediaPoolItem")
    if media_pool_item:
        media_property = safe_call(media_pool_item, "GetClipProperty")
        if isinstance(media_property, dict):
            candidates.extend([
                media_property.get("File Path"),
                media_property.get("FilePath"),
                media_property.get("Path"),
                media_property.get("Clip Path"),
            ])
        for key in ("File Path", "FilePath", "Path", "Clip Path"):
            value = safe_call(media_pool_item, "GetClipProperty", key)
            if value:
                candidates.append(value)
    for candidate in candidates:
        normalized = normalize_filesystem_path(candidate)
        if normalized:
            return normalized
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


def normalize_output_filename(raw_relative_path, extension):
    stem = Path(raw_relative_path).stem
    return f"{stem}.{extension.lstrip('.')}"


def normalize_render_format(render_preset):
    container = str(render_preset.get("container") or "mp4").strip()
    video_codec = str(render_preset.get("videoCodec") or "h265").strip()
    audio_codec = str(render_preset.get("audioCodec") or "aac").strip()
    bitrate = parse_float(render_preset.get("bitrateMbps"))
    return {
        "container": container,
        "videoCodec": video_codec,
        "audioCodec": audio_codec,
        "bitrateMbps": bitrate,
    }


def set_render_format(project, render_format):
    format_name, extension = resolve_render_format(project, render_format["container"])
    codec_name = resolve_render_codec(project, format_name, render_format["videoCodec"])
    safe_call(project, "SetCurrentRenderMode", 0)
    result = safe_call(project, "SetCurrentRenderFormatAndCodec", format_name, codec_name)
    if result is False:
        raise HostError(
            "resolve_render_format_failed",
            f"Unable to set render format {render_format['container']} / {render_format['videoCodec']}",
        )
    return {
        "format": format_name,
        "extension": extension,
        "videoCodec": codec_name,
        "audioCodec": render_format["audioCodec"],
        "bitrateMbps": render_format["bitrateMbps"],
    }


def resolve_render_format(project, requested_container):
    formats = safe_call(project, "GetRenderFormats") or {}
    requested = normalize_lookup_key(requested_container)
    for format_name, extension in items_of(formats):
        candidates = {
            normalize_lookup_key(format_name),
            normalize_lookup_key(extension),
            normalize_lookup_key(str(extension).lstrip(".")),
        }
        if requested in candidates:
            return format_name, sanitize_extension(extension or requested_container)
    raise HostError(
        "resolve_render_format_unsupported",
        f"Resolve does not support render container: {requested_container}",
    )


def resolve_render_codec(project, format_name, requested_codec):
    codecs = safe_call(project, "GetRenderCodecs", format_name) or {}
    requested = normalize_lookup_key(requested_codec)
    for description, codec_name in items_of(codecs):
        candidates = {
            normalize_lookup_key(description),
            normalize_lookup_key(codec_name),
        }
        if requested in candidates:
            return codec_name
    raise HostError(
        "resolve_render_codec_unsupported",
        f"Resolve does not support {requested_codec} for render format {format_name}",
    )


def queue_render_job(project, timeline_item, target_dir, output_name, render_format):
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
    if render_format.get("audioCodec"):
        settings["AudioCodec"] = render_format["audioCodec"]
    if render_format.get("bitrateMbps"):
        settings["VideoQuality"] = max(1, int(round(float(render_format["bitrateMbps"]) * 1000)))
    result = safe_call(project, "SetRenderSettings", settings)
    if result is False:
        raise HostError(
            "resolve_render_settings_failed",
            f"Unable to set render settings for {output_name}",
            {"renderSettings": settings},
        )
    job_id = safe_call(project, "AddRenderJob")
    if job_id is False or job_id is None:
        raise HostError("resolve_add_render_job_failed", f"Unable to queue render job for {output_name}")
    return job_id


def start_rendering(project, job_ids):
    if job_ids:
        result = safe_call(project, "StartRendering", job_ids, False)
        if result is False:
            result = safe_call(project, "StartRendering", job_ids)
    else:
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


def get_resolve_product_name(resolve):
    value = safe_call(resolve, "GetProductName")
    if isinstance(value, str) and value.strip():
        return value.strip()
    fallback = safe_call(resolve, "GetVersionString")
    if isinstance(fallback, str) and fallback.strip():
        return fallback.strip()
    return "DaVinci Resolve"


def infer_is_studio(product_name):
    if not isinstance(product_name, str):
        return False
    lowered = product_name.lower()
    return "studio" in lowered


def get_resolve_version_info(resolve):
    warnings = []
    version_string = safe_call(resolve, "GetVersionString")
    if isinstance(version_string, str) and version_string.strip():
        parsed = parse_version_tuple(version_string)
        if parsed is not None:
            return version_string.strip(), parsed, warnings

    version_parts = safe_call(resolve, "GetVersion")
    if isinstance(version_parts, (list, tuple)) and version_parts:
        parsed = tuple(
            int(part)
            for part in version_parts[:3]
            if isinstance(part, (int, float)) and int(part) >= 0
        )
        if parsed:
            warnings.append("Resolve 版本通过 legacy GetVersion 探测，宿主已进入 degraded profile。")
            return format_version_tuple(parsed), parsed, warnings

    warnings.append("无法通过 Resolve API 可靠读取版本号。")
    return None, None, warnings


def parse_version_tuple(value):
    if not isinstance(value, str):
        return None
    parts = []
    for segment in value.replace("-", ".").split("."):
        digits = "".join(char for char in segment if char.isdigit())
        if not digits:
            if parts:
                break
            continue
        parts.append(int(digits))
        if len(parts) >= 3:
            break
    if len(parts) >= 2:
        return tuple(parts)
    return None


def format_version_tuple(parts):
    if not parts:
        return ""
    return ".".join(str(int(part)) for part in parts)


def collect_render_support(project):
    warnings = []
    degraded = False
    formats = safe_call(project, "GetRenderFormats") or {}
    containers = []
    seen_containers = set()
    if not isinstance(formats, dict) or not formats:
        warnings.append("无法从 Resolve 读取 render formats；execute_group 的格式守卫会按保守模式处理。")
        degraded = True
        formats = {}

    for format_name, extension in items_of(formats):
        container = sanitize_extension(extension or format_name)
        if not container or container in seen_containers:
            continue
        seen_containers.add(container)
        codecs = safe_call(project, "GetRenderCodecs", format_name) or {}
        codec_names = []
        if isinstance(codecs, dict):
            seen_codecs = set()
            for description, codec_name in items_of(codecs):
                for candidate in (codec_name, description):
                    normalized = normalize_codec_label(candidate)
                    if normalized and normalized not in seen_codecs:
                        seen_codecs.add(normalized)
                        codec_names.append(normalized)
        else:
            warnings.append(f"无法读取 container {container} 的 render codecs；已按降级兼容处理。")
            degraded = True
        containers.append({
            "container": container,
            "extension": sanitize_extension(extension or container),
            "videoCodecs": codec_names,
        })

    supports_audio_codec = bool(getattr(project, "SetRenderSettings", None))
    supports_video_quality = bool(getattr(project, "SetRenderSettings", None))
    if not supports_audio_codec or not supports_video_quality:
        warnings.append("当前 Resolve API 无法稳定探测 AudioCodec / VideoQuality 设置支持。")
        degraded = True
    return {
        "containers": sorted(containers, key=lambda item: item["container"]),
        "supportsAudioCodec": supports_audio_codec,
        "supportsVideoQuality": supports_video_quality,
    }, warnings, degraded


def save_project(project):
    safe_call(project, "SaveProject")


def to_portable_relative(root_path, file_path):
    root = Path(root_path).expanduser().resolve()
    path = Path(file_path).expanduser().resolve()
    try:
        relative = path.relative_to(root)
    except ValueError as error:
        raise ValueError(str(error))
    return normalize_portable_path(str(relative))


def normalize_portable_path(value):
    if not isinstance(value, str):
        return ""
    normalized = value.replace("\\", "/").strip("/")
    return normalized


def portable_parent_dir(value):
    normalized = normalize_portable_path(value)
    if not normalized or "/" not in normalized:
        return ""
    return normalized.rsplit("/", 1)[0]


def join_portable(left, right):
    left_normalized = normalize_portable_path(left)
    right_normalized = normalize_portable_path(right)
    if not left_normalized:
        return right_normalized
    if not right_normalized:
        return left_normalized
    return f"{left_normalized}/{right_normalized}"


def normalize_filesystem_path(value):
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        return str(Path(value).expanduser().resolve())
    except Exception:
        return None


def sanitize_extension(value):
    text = str(value or "").strip().lstrip(".")
    return text or "mp4"


def normalize_codec_label(value):
    if not isinstance(value, str) or not value.strip():
        return None
    compact = normalize_lookup_key(value)
    family = normalize_codec_family(compact)
    if family:
        return family
    return value.strip().lower()


def normalize_lookup_key(value):
    if not isinstance(value, str):
        return ""
    normalized = []
    for char in value.strip().lower():
        if char.isalnum():
            normalized.append(char)
    return "".join(normalized)


def stringify_signal_value(value):
    if isinstance(value, str) and value.strip():
        return value.strip()
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return str(value)
    return None


def normalize_string_map(value):
    if not isinstance(value, dict):
        return {}
    normalized = {}
    for key, item in value.items():
        key_text = stringify_signal_value(key)
        value_text = stringify_signal_value(item)
        if not key_text or not value_text:
            continue
        normalized[key_text] = value_text
    return normalized


def first_signal_value(properties, normalized_tags, property_keys, tag_keys):
    for key in property_keys:
        value = properties.get(normalize_lookup_key(key))
        if value:
            return value
    for key in tag_keys:
        value = normalized_tags.get(normalize_lookup_key(key))
        if value:
            return value
    return None


def normalize_codec_family(value):
    if not value:
        return None
    normalized = normalize_lookup_key(str(value))
    if normalized in ("h265", "hevc"):
        return "h265"
    if normalized in ("h264", "avc", "avc1"):
        return "h264"
    if "prores" in normalized:
        return "prores"
    if "braw" in normalized:
        return "braw"
    if "dnxhr" in normalized or "dnxhd" in normalized:
        return "dnx"
    if normalized:
        return normalized
    return None


def build_resolution_string(width, height):
    width_value = parse_int(width)
    height_value = parse_int(height)
    if width_value and height_value:
        return f"{width_value}x{height_value}"
    return None


def normalize_resolution_string(value):
    if not isinstance(value, str) or not value.strip():
        return None
    compact = value.lower().replace(" ", "")
    if "x" in compact:
        return compact
    return value.strip()


def normalize_fps_string(value):
    fps_value = parse_float(value)
    if fps_value is None:
        if isinstance(value, str) and value.strip():
            return value.strip()
        return None
    if abs(fps_value - round(fps_value)) < 0.001:
        return str(int(round(fps_value)))
    return f"{fps_value:.3f}".rstrip("0").rstrip(".")


def join_distinct_parts(parts, separator=" "):
    normalized = []
    seen = set()
    for part in parts:
        if not isinstance(part, str) or not part.strip():
            continue
        if part in seen:
            continue
        seen.add(part)
        normalized.append(part)
    return separator.join(normalized) if normalized else None


def dedupe_strings(values):
    normalized = []
    seen = set()
    for value in values or []:
        if not isinstance(value, str) or not value.strip():
            continue
        text = value.strip()
        if text in seen:
            continue
        seen.add(text)
        normalized.append(text)
    return normalized


def parse_int(value):
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, str) and value.strip():
        try:
            parsed = int(float(value))
            return parsed
        except Exception:
            return None
    return None


def parse_float(value):
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str) and value.strip():
        try:
            return float(value)
        except Exception:
            return None
    return None


def items_of(value):
    if isinstance(value, dict):
        return value.items()
    return []


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
