#!/usr/bin/env python3
import argparse
import hashlib
import json
import re
import shutil
import sys
import time
from pathlib import Path


CCREATIVE_SIGNAL_KEYS = (
    "slog3",
    "dlog-m",
    "hlg",
    "rec709",
    "lowlight",
)


def main() -> int:
    parser = argparse.ArgumentParser(description="Kairos Resolve color host")
    parser.add_argument("--request", required=True, help="Path to JSON request")
    args = parser.parse_args()

    try:
        payload = json.loads(Path(args.request).read_text(encoding="utf-8"))
        operation = payload.get("operation")
        request_input = payload.get("input") or {}
        resolve = load_resolve()

        if operation == "preflight":
            result = preflight(resolve, request_input)
        elif operation == "prepare_root":
            result = prepare_root(resolve, request_input)
        elif operation == "sync_groups":
            result = sync_groups(resolve, request_input)
        elif operation == "execute_root":
            result = execute_root(resolve, request_input)
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


def load_resolve():
    append_script_api_paths()
    try:
        import DaVinciResolveScript as dvr_script  # type: ignore
    except Exception as error:
        raise HostError(
            "resolve_script_api_missing",
            "Unable to import DaVinciResolveScript from the default Resolve scripting API locations.",
            {"error": str(error)},
        )
    resolve = dvr_script.scriptapp("Resolve")
    if resolve is None:
        raise HostError(
            "resolve_app_unavailable",
            "Unable to connect to DaVinci Resolve. Make sure Resolve Studio is running and external scripting is enabled.",
        )
    return resolve


def append_script_api_paths():
    candidates = []

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
    apply_timeline_spec(project, payload.get("timelineSpec"))
    media_pool = require_method(project, "GetMediaPool")()
    media_storage = require_method(resolve, "GetMediaStorage")()
    namespace_folder = ensure_namespace_folder(media_pool, payload["rootNamespace"])
    timeline = ensure_timeline(project, media_pool, payload["gradingTimelineName"])
    apply_timeline_spec(project, payload.get("timelineSpec"), timeline)
    clip_requests = normalize_clip_requests(payload.get("clips"))
    previous_group_names_by_clip = capture_timeline_group_assignments(timeline, payload["rawLocalPath"])
    repair_template = get_repair_template_asset(payload)
    donor_timeline = None
    repair_template_timeline = None
    if has_timeline_video_items(timeline):
        donor_timeline = duplicate_timeline(
            project,
            timeline,
            build_temp_render_timeline_name(f"{payload['gradingTimelineName']} [Kairos Repair Donor]"),
        )
        safe_call(project, "SetCurrentTimeline", timeline)

    try:
        safe_call(resolve, "OpenPage", "edit")
        safe_call(project, "SetCurrentTimeline", timeline)
        if repair_template["kind"] == "default-drt":
            repair_template_timeline = import_repair_template_timeline(
                media_pool,
                repair_template["path"],
            )
        namespace_state = collect_namespace_state(namespace_folder)
        prepared_entries, sync_summary = sync_namespace_clips(
            media_pool,
            media_storage,
            namespace_folder,
            namespace_state,
            clip_requests,
        )
        ordered_entries = sort_clip_entries(prepared_entries)

        try:
            clear_timeline_items(timeline)
        except HostError as error:
            if error.code != "resolve_timeline_clear_failed":
                raise
            timeline = recreate_timeline(media_pool, project, timeline, payload["gradingTimelineName"])
            apply_timeline_spec(project, payload.get("timelineSpec"), timeline)
        append_clips_to_timeline(project, media_pool, timeline, ordered_entries)
        timeline_item_by_clip_key = build_timeline_item_map(timeline, payload["rawLocalPath"])
        group_states = assign_generated_groups(project, ordered_entries, timeline_item_by_clip_key, previous_group_names_by_clip)
        group_transform_summaries = apply_group_preclip_transforms(project, group_states)
        transform_blockers = dedupe_strings([
            summary.get("detail")
            for summary in group_transform_summaries.values()
            if isinstance(summary, dict) and str(summary.get("transformStatus") or "").startswith("blocked")
        ])
        if transform_blockers:
            raise HostError(
                "resolve_group_transform_failed",
                "Copied LUT is not visible to the current Resolve session. Refresh LUT List in Resolve and retry.",
                {
                    "blockingReasons": transform_blockers,
                    "groupTransforms": group_transform_summaries,
                },
            )

        repair_seed_by_clip = seed_clip_repairs(
            timeline,
            payload["rawLocalPath"],
            clip_requests,
            donor_timeline,
            repair_template,
            repair_template_timeline,
        )

        groups_snapshot = build_groups_snapshot(
            payload["rootId"],
            timeline,
            payload["gradingTimelineName"],
            payload["rawLocalPath"],
            clip_requests,
            origin="prepare_root",
            group_transform_summaries=group_transform_summaries,
            repair_seed_by_clip=repair_seed_by_clip,
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
                "lutSyncStatus": (payload.get("lutSyncSummary") or {}).get("status"),
                "lutSyncTargetRoot": (payload.get("lutSyncSummary") or {}).get("targetRoot"),
                "lutSyncCopiedCount": (payload.get("lutSyncSummary") or {}).get("copiedCount") or 0,
                "lutSyncReusedCount": (payload.get("lutSyncSummary") or {}).get("reusedCount") or 0,
                "resolvedTransformPresetKey": summarize_root_transform_value(group_transform_summaries, "resolvedTransformPresetKey"),
                "detectedProfile": summarize_root_transform_value(group_transform_summaries, "detectedProfile"),
                "effectiveProfile": summarize_root_transform_value(group_transform_summaries, "effectiveProfile"),
                "transformStatus": summarize_root_transform_status(group_transform_summaries),
            },
        }
    finally:
        delete_timeline(media_pool, donor_timeline)
        delete_timeline(media_pool, repair_template_timeline)


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


def execute_root(resolve, payload):
    project = ensure_project(resolve, payload["resolveProjectName"])
    timeline = ensure_named_timeline(project, payload["gradingTimelineName"])
    require_method(project, "SetCurrentTimeline")(timeline)

    target_dir = Path(payload["stagingRoot"]).expanduser().resolve()
    target_dir.mkdir(parents=True, exist_ok=True)
    render_dir = target_dir / "__resolve_render__"
    prepare_clip_staging_dir(render_dir)

    render_format = normalize_render_format(payload.get("renderPreset", {}))
    selected_clips = normalize_render_batch_clips(payload.get("clips"), sanitize_extension(render_format.get("container") or "mp4"))
    if not selected_clips:
        raise HostError("resolve_root_batch_empty", "Root batch does not contain any render clips.")

    media_pool = require_method(project, "GetMediaPool")()
    safe_call(resolve, "OpenPage", "edit")
    save_project(project)
    temp_timeline = duplicate_timeline(project, timeline, build_temp_render_timeline_name(payload["gradingTimelineName"]))
    try:
        require_method(project, "SetCurrentTimeline")(temp_timeline)
        prune_timeline_to_selected_clips(temp_timeline, payload["rawLocalPath"], {
            clip["rawRelativePath"] for clip in selected_clips
        })
        safe_call(resolve, "OpenPage", "deliver")
        resolved_render_format = set_render_format(project, render_format)
        selected_clips = normalize_render_batch_clips(payload.get("clips"), resolved_render_format["extension"])
        safe_call(project, "DeleteAllRenderJobs")
        queued_job_id = queue_root_render_job(project, render_dir, resolved_render_format, selected_clips)
        start_rendering(project, [queued_job_id])
        wait_for_render(project)
        normalized_entries = adopt_root_render_outputs(render_dir, target_dir, selected_clips, resolved_render_format["extension"])
    finally:
        safe_call(project, "SetCurrentTimeline", timeline)
        safe_call(resolve, "OpenPage", "edit")
        delete_timeline(media_pool, temp_timeline)

    return {
        "renderedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "entries": normalized_entries,
        "hostSummary": {
            "timelineName": payload["gradingTimelineName"],
            "selectionMode": payload.get("selectionMode") or "all",
            "clipCount": len(selected_clips),
            "resolvedFormat": resolved_render_format["format"],
            "resolvedCodec": resolved_render_format["videoCodec"],
            "audioCodec": resolved_render_format["audioCodec"],
            "bitrateKbps": resolved_render_format["bitrateKbps"],
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


def recreate_timeline(media_pool, project, timeline, timeline_name):
    temp_name = build_temp_render_timeline_name(f"{timeline_name} [Kairos Prepare]")
    replacement = safe_call(media_pool, "CreateEmptyTimeline", temp_name)
    if not replacement:
        raise HostError("resolve_timeline_recreate_failed", f"Unable to create replacement grading timeline: {timeline_name}")
    safe_call(project, "SetCurrentTimeline", replacement)
    deleted = safe_call(media_pool, "DeleteTimelines", [timeline])
    if deleted is False:
        raise HostError("resolve_timeline_recreate_failed", f"Unable to replace locked grading timeline: {timeline_name}")
    renamed = safe_call(replacement, "SetName", timeline_name)
    if renamed is False:
        existing = find_named_timeline(project, timeline_name)
        if existing is None:
            raise HostError("resolve_timeline_recreate_failed", f"Unable to restore grading timeline name: {timeline_name}")
        replacement = existing
    safe_call(project, "SetCurrentTimeline", replacement)
    return replacement


def apply_timeline_spec(project, spec, timeline=None):
    width = parse_int((spec or {}).get("width"))
    height = parse_int((spec or {}).get("height"))
    fps = parse_float((spec or {}).get("fps"))
    if not width or not height or not fps:
        return
    settings = {
        "timelineResolutionWidth": width,
        "timelineResolutionHeight": height,
        "timelineOutputResolutionWidth": width,
        "timelineOutputResolutionHeight": height,
        "timelineFrameRate": fps,
        "timelinePlaybackFrameRate": fps,
    }
    for owner in (project, timeline):
        if owner is None:
            continue
        for key, value in settings.items():
            safe_call(owner, "SetSetting", key, stringify_setting_value(value))


def find_named_timeline(project, timeline_name):
    count = safe_call(project, "GetTimelineCount") or 0
    for index in range(1, int(count) + 1):
        candidate = safe_call(project, "GetTimelineByIndex", index)
        if candidate and safe_call(candidate, "GetName") == timeline_name:
            return candidate
    return None


def list_timeline_names(project):
    names = []
    count = safe_call(project, "GetTimelineCount") or 0
    for index in range(1, int(count) + 1):
        candidate = safe_call(project, "GetTimelineByIndex", index)
        name = safe_call(candidate, "GetName") if candidate else None
        if isinstance(name, str) and name:
            names.append(name)
    return names


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
        creative = build_clip_creative_summary(clip_request)
        prepared_entries.append({
            **clip_request,
            "mediaPoolItem": media_pool_item,
            "creativeTags": creative["creativeTags"],
            "groupNameSeed": creative["displayName"],
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
                result = safe_call(timeline, "DeleteClips", items)
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


def has_timeline_video_items(timeline):
    return next(iter_timeline_video_items(timeline), None) is not None


def get_repair_template_asset(payload):
    explicit_drt = stringify_signal_value(payload.get("repairDrtPath"))
    drt_candidate = Path(explicit_drt).expanduser() if explicit_drt else Path(__file__).resolve().parents[2] / "config" / "default.drt"
    if drt_candidate.is_file():
        return {"kind": "default-drt", "path": drt_candidate}

    explicit_drx = stringify_signal_value(payload.get("repairDrxPath"))
    drx_candidate = Path(explicit_drx).expanduser() if explicit_drx else Path(__file__).resolve().parents[2] / "config" / "default.drx"
    if not drx_candidate.is_file():
        raise HostError(
            "resolve_repair_template_missing",
            f"Missing clip repair template asset: {drx_candidate.name}",
            {
                "drtPath": str(drt_candidate),
                "drxPath": str(drx_candidate),
            },
        )
    return {"kind": "default-drx", "path": drx_candidate}


def import_repair_template_timeline(media_pool, template_path):
    timeline = safe_call(media_pool, "ImportTimelineFromFile", str(template_path))
    if not timeline:
        raise HostError(
            "resolve_repair_template_import_failed",
            f"Unable to import clip repair template timeline: {template_path.name}",
            {"drtPath": str(template_path)},
        )
    safe_call(timeline, "SetName", build_temp_render_timeline_name("__Kairos Repair Template"))
    donor_item = find_first_timeline_video_item(timeline)
    if donor_item is None or not clip_like_has_canonical_repair_layout(donor_item):
        raise HostError(
            "resolve_repair_template_invalid",
            "Imported clip repair DRT does not match the expected Gyro -> Dehaze -> User1 -> User2 -> NR contract.",
            {"drtPath": str(template_path)},
        )
    return timeline


def find_first_timeline_video_item(timeline):
    return next(iter_timeline_video_items(timeline), None)


def clip_like_has_grade_content(item):
    if item is None:
        return False
    graph = safe_call(item, "GetNodeGraph")
    node_count = parse_int(safe_call(graph, "GetNumNodes")) or 0
    tools_by_node = collect_graph_tools_by_node(graph)
    graph_luts = collect_graph_luts(graph)
    return graph_has_nonblank_content(node_count, tools_by_node, graph_luts)


def list_requested_repair_kinds(clip_request):
    return ["gyro", "user1", "user2", "dehaze", "nr"]


def seed_clip_repairs(
    timeline,
    raw_local_path,
    clip_requests,
    donor_timeline=None,
    repair_template=None,
    repair_template_timeline=None,
):
    target_items_by_clip = build_timeline_item_map(timeline, raw_local_path)
    donor_items_by_clip = build_timeline_item_map(donor_timeline, raw_local_path) if donor_timeline else {}
    repair_template_kind = stringify_signal_value((repair_template or {}).get("kind"))
    repair_template_path = (repair_template or {}).get("path")
    repair_template_source_item = find_first_timeline_video_item(repair_template_timeline) if repair_template_timeline else None
    repair_seed_by_clip = {}
    invalid_repair_layouts = []
    for clip_request in clip_requests:
        clip_key = clip_request["rawRelativePath"]
        target_item = target_items_by_clip.get(clip_key)
        if target_item is None:
            raise HostError(
                "resolve_repair_target_missing",
                f"Prepared clip is missing from grading timeline after append: {clip_key}",
            )
        copied_existing_grade = False
        rebuilt_legacy_grade = False
        seeded_repair_donor_kind = None
        forced_enabled_node_indices = []
        forced_disabled_node_indices = []
        donor_item = donor_items_by_clip.get(clip_key)
        if (
            donor_item is not None
            and donor_item is not target_item
            and clip_like_has_grade_content(donor_item)
            and clip_like_has_canonical_repair_layout(donor_item)
        ):
            result = safe_call(donor_item, "CopyGrades", [target_item])
            if result is False:
                raise HostError(
                    "resolve_clip_repair_copy_failed",
                    f"Unable to preserve existing clip repair grade for: {clip_key}",
            )
            copied_existing_grade = True
            node_default_state = apply_reserved_node_defaults(target_item, clip_request, reset_tail_reserved_nodes=False)
            forced_enabled_node_indices = node_default_state["enabled"]
            forced_disabled_node_indices = node_default_state["disabled"]
        elif repair_template_source_item is not None:
            rebuilt_legacy_grade = donor_item is not None and clip_like_has_grade_content(donor_item)
            result = safe_call(repair_template_source_item, "CopyGrades", [target_item])
            if result is False:
                raise HostError(
                    "resolve_clip_repair_seed_failed",
                    f"Unable to seed clip repair template grade for: {clip_key}",
                    {"repairTemplateKind": repair_template_kind},
                )
            seeded_repair_donor_kind = repair_template_kind or "default-drt"
            node_default_state = apply_reserved_node_defaults(target_item, clip_request, reset_tail_reserved_nodes=True)
            forced_enabled_node_indices = node_default_state["enabled"]
            forced_disabled_node_indices = node_default_state["disabled"]
            if not clip_like_has_canonical_repair_layout(target_item):
                invalid_repair_layouts.append({
                    "clipKey": clip_key,
                    "snapshot": build_clip_repair_snapshot(target_item, clip_request, {
                        "copiedExistingGrade": False,
                        "rebuiltLegacyGrade": rebuilt_legacy_grade,
                        "requestedRepairKinds": list_requested_repair_kinds(clip_request),
                        "seededRepairDonorKind": seeded_repair_donor_kind,
                        "availableRepairDonorKinds": [repair_template_kind] if repair_template_kind else [],
                        "forcedEnabledNodeIndices": forced_enabled_node_indices,
                        "forcedDisabledNodeIndices": forced_disabled_node_indices,
                    }),
                })
        elif repair_template_path is not None:
            rebuilt_legacy_grade = donor_item is not None and clip_like_has_grade_content(donor_item)
            apply_repair_drx(target_item, repair_template_path, clip_key)
            seeded_repair_donor_kind = repair_template_kind or "default-drx"
            node_default_state = apply_reserved_node_defaults(target_item, clip_request, reset_tail_reserved_nodes=True)
            forced_enabled_node_indices = node_default_state["enabled"]
            forced_disabled_node_indices = node_default_state["disabled"]
            if not clip_like_has_canonical_repair_layout(target_item):
                invalid_repair_layouts.append({
                    "clipKey": clip_key,
                    "snapshot": build_clip_repair_snapshot(target_item, clip_request, {
                        "copiedExistingGrade": False,
                        "rebuiltLegacyGrade": rebuilt_legacy_grade,
                        "requestedRepairKinds": list_requested_repair_kinds(clip_request),
                        "seededRepairDonorKind": seeded_repair_donor_kind,
                        "availableRepairDonorKinds": [repair_template_kind] if repair_template_kind else [],
                        "forcedEnabledNodeIndices": forced_enabled_node_indices,
                        "forcedDisabledNodeIndices": forced_disabled_node_indices,
                    }),
                })

        repair_seed_by_clip[clip_key] = {
            "copiedExistingGrade": copied_existing_grade,
            "rebuiltLegacyGrade": rebuilt_legacy_grade,
            "requestedRepairKinds": list_requested_repair_kinds(clip_request),
            "seededRepairDonorKind": seeded_repair_donor_kind,
            "availableRepairDonorKinds": [repair_template_kind] if repair_template_kind else [],
            "forcedEnabledNodeIndices": forced_enabled_node_indices,
            "forcedDisabledNodeIndices": forced_disabled_node_indices,
        }
    if invalid_repair_layouts:
        raise HostError(
            "resolve_repair_drx_invalid",
            "Applied clip repair DRX does not match the expected Gyro -> Dehaze -> User1 -> User2 -> NR contract.",
            {
                "templateKind": repair_template_kind,
                "templatePath": str(repair_template_path) if repair_template_path is not None else None,
                "invalidClipCount": len(invalid_repair_layouts),
                "invalidClips": invalid_repair_layouts[:20],
            },
        )
    return repair_seed_by_clip


def apply_repair_drx(item, repair_drx_path, clip_key):
    graph = safe_call(item, "GetNodeGraph")
    if graph is None:
        raise HostError(
            "resolve_repair_graph_missing",
            f"Unable to access clip repair node graph for: {clip_key}",
        )
    method = getattr(graph, "ApplyGradeFromDRX", None)
    if method is None:
        raise HostError(
            "resolve_repair_drx_unsupported",
            "Resolve NodeGraph is missing ApplyGradeFromDRX; cannot apply config/default.drx.",
            {"clipKey": clip_key, "drxPath": str(repair_drx_path)},
        )
    try:
        result = method(str(repair_drx_path), 0)
    except Exception as error:
        raise HostError(
            "resolve_repair_drx_apply_failed",
            f"Unable to apply clip repair DRX for: {clip_key}",
            {"clipKey": clip_key, "drxPath": str(repair_drx_path), "error": str(error)},
        )
    if result is False:
        raise HostError(
            "resolve_repair_drx_apply_failed",
            f"Unable to apply clip repair DRX for: {clip_key}",
            {"clipKey": clip_key, "drxPath": str(repair_drx_path)},
        )


def clip_like_has_canonical_repair_layout(item):
    graph = safe_call(item, "GetNodeGraph")
    node_count = parse_int(safe_call(graph, "GetNumNodes")) or 0
    tools_by_node = collect_graph_tools_by_node(graph)
    lut_by_node = collect_graph_lut_by_node(graph)
    layout_state = inspect_clip_repair_layout(
        node_count,
        tools_by_node,
        lut_by_node,
        collect_graph_node_enabled(graph, node_count),
        True,
    )
    return layout_state.get("layoutStatus") == "canonical"


def build_clip_repair_snapshot(item, clip_request, repair_seed_state=None):
    graph = safe_call(item, "GetNodeGraph")
    node_count = parse_int(safe_call(graph, "GetNumNodes")) or 0
    tools_by_node = collect_graph_tools_by_node(graph)
    lut_by_node = collect_graph_lut_by_node(graph)
    graph_luts = collect_graph_luts(graph)
    node_enabled_by_node = collect_graph_node_enabled(graph, node_count)
    gyro_eligible = clip_request.get("gyroEligible") is True
    lowlight_requested = clip_request.get("lowlight") is True
    layout_state = inspect_clip_repair_layout(
        node_count,
        tools_by_node,
        lut_by_node,
        node_enabled_by_node,
        gyro_eligible,
        repair_seed_state,
    )
    gyroflow_status = layout_state["gyroflowStatus"]
    dehaze_status = layout_state["dehazeStatus"]
    nr_status = layout_state["nrStatus"]
    layout_status = layout_state["layoutStatus"]
    reserved_node_indices = layout_state["reservedNodeIndices"]
    clip_repair_status = determine_clip_repair_status(
        node_count,
        gyro_eligible,
        layout_status,
        gyroflow_status,
        dehaze_status,
        nr_status,
        tools_by_node,
        graph_luts,
    )
    return {
        "clipKey": clip_request["rawRelativePath"],
        "displayName": clip_request.get("sourceStem") or Path(clip_request["rawRelativePath"]).stem,
        "logProfile": normalize_log_profile(clip_request.get("logProfile")) or "unknown",
        "lowlight": lowlight_requested,
        "gyroEligible": gyro_eligible,
        "gyroflowStatus": gyroflow_status,
        "dehazeStatus": dehaze_status,
        "nrStatus": nr_status,
        "clipRepairStatus": clip_repair_status,
        "layoutStatus": layout_status,
        "reservedNodeIndices": reserved_node_indices,
        "hostSummary": {
            "nodeCount": node_count,
            "toolsByNode": {str(node_index): tools for node_index, tools in sorted(tools_by_node.items())},
            "luts": list(graph_luts),
            "nodeEnabledByNode": {str(node_index): value for node_index, value in sorted(node_enabled_by_node.items())},
            "layoutStatus": layout_status,
            "reservedNodeIndices": reserved_node_indices,
            "copiedExistingGrade": bool(repair_seed_state and repair_seed_state.get("copiedExistingGrade")),
            "rebuiltLegacyGrade": bool(repair_seed_state and repair_seed_state.get("rebuiltLegacyGrade")),
            "requestedRepairKinds": list(repair_seed_state.get("requestedRepairKinds") or []) if isinstance(repair_seed_state, dict) else [],
            "seededRepairDonorKind": stringify_signal_value((repair_seed_state or {}).get("seededRepairDonorKind")) if isinstance(repair_seed_state, dict) else None,
            "availableRepairDonorKinds": list((repair_seed_state or {}).get("availableRepairDonorKinds") or []) if isinstance(repair_seed_state, dict) else [],
            "forcedEnabledNodeIndices": list((repair_seed_state or {}).get("forcedEnabledNodeIndices") or []) if isinstance(repair_seed_state, dict) else [],
            "forcedDisabledNodeIndices": list((repair_seed_state or {}).get("forcedDisabledNodeIndices") or []) if isinstance(repair_seed_state, dict) else [],
        },
    }


def collect_graph_tools_by_node(graph):
    tools_by_node = {}
    if graph is None:
        return tools_by_node
    node_count = parse_int(safe_call(graph, "GetNumNodes")) or 0
    for node_index in range(1, int(node_count) + 1):
        tools = safe_call(graph, "GetToolsInNode", node_index) or []
        normalized_tools = dedupe_strings([
            stringify_signal_value(tool)
            for tool in iter_values(tools)
        ])
        if normalized_tools:
            tools_by_node[node_index] = normalized_tools
    return tools_by_node


def collect_graph_lut_by_node(graph):
    lut_by_node = {}
    if graph is None:
        return lut_by_node
    node_count = parse_int(safe_call(graph, "GetNumNodes")) or 0
    for node_index in range(1, int(node_count) + 1):
        lut_path = stringify_signal_value(safe_call(graph, "GetLUT", node_index))
        if lut_path:
            lut_by_node[node_index] = lut_path
    return lut_by_node


def collect_graph_node_enabled(graph, node_count):
    enabled_by_node = {}
    if graph is None:
        return enabled_by_node
    for node_index in range(1, int(node_count) + 1):
        enabled_value = safe_call(graph, "GetNodeEnabled", node_index)
        parsed = parse_bool(enabled_value)
        if parsed is not None:
            enabled_by_node[node_index] = parsed
    return enabled_by_node


def inspect_tool_presence(tools_by_node, node_enabled_by_node, predicate):
    present = False
    enabled_present = False
    for node_index, tools in tools_by_node.items():
        if not predicate(tools):
            continue
        present = True
        if node_enabled_by_node.get(node_index, True) is not False:
            enabled_present = True
    return present, enabled_present


def graph_has_nonblank_content(node_count, tools_by_node, graph_luts):
    if tools_by_node or graph_luts:
        return True
    return node_count > 1


def contains_gyroflow_tool(tools):
    return any("gyroflow" in str(tool).lower() for tool in tools or [])


def contains_noise_reduction_tool(tools):
    return any(
        "noise reduction" in str(tool).lower() or "denoise" in str(tool).lower()
        for tool in tools or []
    )


def contains_dehaze_tool(tools):
    return any("dehaze" in str(tool).lower() for tool in tools or [])


def apply_reserved_node_defaults(item, clip_request, reset_tail_reserved_nodes):
    graph = safe_call(item, "GetNodeGraph")
    if graph is None:
        return {"enabled": [], "disabled": []}
    enabled_nodes = []
    disabled = []
    node_defaults = {1: clip_request.get("gyroEligible") is True}
    if reset_tail_reserved_nodes:
        node_defaults.update({2: False, 5: False})
    for node_index, enabled in node_defaults.items():
        result = safe_call(graph, "SetNodeEnabled", node_index, bool(enabled))
        if result is False:
            continue
        if enabled:
            enabled_nodes.append(node_index)
        else:
            disabled.append(node_index)
    if reset_tail_reserved_nodes:
        for node_index in (3, 4):
            result = safe_call(graph, "SetNodeEnabled", node_index, True)
            if result is False:
                continue
            enabled_nodes.append(node_index)
    return {"enabled": enabled_nodes, "disabled": disabled}


def disable_seeded_reserved_nodes(item, donor_kind):
    graph = safe_call(item, "GetNodeGraph")
    if graph is None:
        return []
    disabled = []
    if donor_kind == "canonical":
        node_indices = (4, 5)
    elif donor_kind == "nr":
        node_indices = (1, 2)
    else:
        node_indices = ()
    for node_index in node_indices:
        result = safe_call(graph, "SetNodeEnabled", node_index, False)
        if result is False:
            continue
        disabled.append(node_index)
    return disabled


def inspect_clip_repair_layout(
    node_count,
    tools_by_node,
    lut_by_node,
    node_enabled_by_node,
    gyro_eligible,
    repair_seed_state=None,
):
    gyro_index = find_first_matching_node_index(node_count, tools_by_node, contains_gyroflow_tool)
    nr_index = find_last_matching_node_index(node_count, tools_by_node, contains_noise_reduction_tool)
    dehaze_index = find_first_matching_node_index(node_count, tools_by_node, contains_dehaze_tool)

    layout_status = "legacy-layout"
    user_start = 3 if gyro_index == 1 and dehaze_index == 2 else None
    user_end = (nr_index - 1) if nr_index is not None else None
    user_node_count = (user_end - user_start + 1) if user_start is not None and user_end is not None else 0
    if (
        gyro_index == 1
        and dehaze_index == 2
        and nr_index == node_count
        and user_node_count >= 2
    ):
        layout_status = "canonical"

    reserved_node_indices = {}
    if gyro_index is not None:
        reserved_node_indices["gyro"] = gyro_index
    if user_start is not None:
        reserved_node_indices["userStart"] = user_start
    if user_start is not None and user_end is not None and user_end >= user_start:
        reserved_node_indices["userEnd"] = user_end
    if dehaze_index is not None:
        reserved_node_indices["dehaze"] = dehaze_index
    if nr_index is not None:
        reserved_node_indices["nr"] = nr_index

    forced_disabled = set((repair_seed_state or {}).get("forcedDisabledNodeIndices") or [])
    if gyro_index == 1:
        if node_enabled_by_node.get(gyro_index) is False or gyro_index in forced_disabled or not gyro_eligible:
            gyroflow_status = "seeded-disabled"
        else:
            gyroflow_status = "ready-to-load"
    else:
        gyroflow_status = "not-seeded"

    dehaze_status = infer_reserved_effect_status(
        dehaze_index,
        node_enabled_by_node,
        forced_disabled,
        default_when_unknown=(
            "seeded-disabled"
            if dehaze_index is not None and (
                contains_dehaze_tool(tools_by_node.get(dehaze_index))
                or is_blank_reserve_node(dehaze_index, tools_by_node, lut_by_node)
            )
            else "seeded-enabled"
        ),
    )
    nr_status = infer_reserved_effect_status(
        nr_index,
        node_enabled_by_node,
        forced_disabled,
        default_when_unknown="seeded-disabled" if layout_status == "canonical" else "seeded-enabled",
    )
    return {
        "gyroflowStatus": gyroflow_status,
        "dehazeStatus": dehaze_status,
        "nrStatus": nr_status,
        "layoutStatus": layout_status,
        "reservedNodeIndices": reserved_node_indices,
    }


def find_first_matching_node_index(node_count, tools_by_node, predicate):
    for node_index in range(1, int(node_count) + 1):
        if predicate(tools_by_node.get(node_index)):
            return node_index
    return None


def find_last_matching_node_index(node_count, tools_by_node, predicate):
    for node_index in range(int(node_count), 0, -1):
        if predicate(tools_by_node.get(node_index)):
            return node_index
    return None


def is_blank_reserve_node(node_index, tools_by_node, lut_by_node):
    if node_index is None or int(node_index) <= 0:
        return False
    return not tools_by_node.get(node_index) and not stringify_signal_value(lut_by_node.get(node_index))


def infer_reserved_effect_status(node_index, node_enabled_by_node, forced_disabled, default_when_unknown):
    if node_index is None:
        return "not-seeded"
    if node_index in forced_disabled:
        return "seeded-disabled"
    if node_enabled_by_node.get(node_index) is True:
        return "seeded-enabled"
    if node_enabled_by_node.get(node_index) is False:
        return "seeded-disabled"
    return default_when_unknown


def determine_clip_repair_status(node_count, gyro_eligible, layout_status, gyroflow_status, dehaze_status, nr_status, tools_by_node, graph_luts):
    requested_repairs = ["gyro", "dehaze", "nr"]
    has_repair_content = graph_has_nonblank_content(node_count, tools_by_node, graph_luts)
    seeded_repairs = 0
    if gyroflow_status != "not-seeded":
        seeded_repairs += 1
    if dehaze_status != "not-seeded":
        seeded_repairs += 1
    if nr_status != "not-seeded":
        seeded_repairs += 1
    if seeded_repairs == 0:
        return "skeleton-only" if has_repair_content else "missing"
    if layout_status == "canonical" and seeded_repairs == len(requested_repairs):
        return "ready"
    return "partial"


def summarize_group_log_profile(clip_requests):
    log_profiles = dedupe_strings([
        normalize_log_profile(clip_request.get("logProfile"))
        for clip_request in clip_requests or []
    ])
    if len(log_profiles) == 1:
        return log_profiles[0]
    if len(log_profiles) > 1:
        return "mixed"
    return "unknown"


def summarize_group_lowlight(clip_snapshots):
    lowlight_values = {
        "lowlight" if clip.get("lowlight") is True else "base"
        for clip in clip_snapshots or []
        if clip.get("lowlight") is not None
    }
    if len(lowlight_values) == 1:
        return next(iter(lowlight_values))
    if len(lowlight_values) > 1:
        return "mixed"
    return None


def inspect_group_post_clip_creative_status(color_group):
    if color_group is None:
        return "missing"
    graph = safe_call(color_group, "GetPostClipNodeGraph")
    if graph is None:
        return "missing"
    node_count = parse_int(safe_call(graph, "GetNumNodes")) or 0
    if node_count <= 0 and not collect_graph_luts(graph):
        return "empty"
    return "ready"


def assign_generated_groups(project, clip_entries, timeline_item_by_clip_key, previous_group_names_by_clip):
    existing_groups_by_name = {}
    for group in iter_values(safe_call(project, "GetColorGroupsList") or []):
        group_name = safe_call(group, "GetName")
        if isinstance(group_name, str) and group_name.strip():
            existing_groups_by_name[group_name.strip()] = group

    entries_by_group_name = {}
    for entry in clip_entries:
        entries_by_group_name.setdefault(entry["groupNameSeed"], []).append(entry)

    claimed_group_names = set()
    group_states = {}
    for group_name_seed, entries in entries_by_group_name.items():
        previous_names = sorted({
            previous_group_names_by_clip.get(entry["rawRelativePath"])
            for entry in entries
            if previous_group_names_by_clip.get(entry["rawRelativePath"])
        })
        if (
            len(previous_names) == 1
            and previous_names[0] not in claimed_group_names
            and normalize_group_key(previous_names[0]) == normalize_group_key(group_name_seed)
        ):
            desired_group_name = previous_names[0]
        else:
            desired_group_name = ensure_unique_group_name(
                entries[0]["groupNameSeed"],
                group_name_seed,
                claimed_group_names,
                existing_groups_by_name,
            )
        claimed_group_names.add(desired_group_name)
        color_group, is_new_group = ensure_color_group(project, existing_groups_by_name, desired_group_name)
        group_states[desired_group_name] = {
            "colorGroup": color_group,
            "isNewGroup": is_new_group,
            "entries": entries,
        }
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
    return group_states


def ensure_unique_group_name(base_name, uniqueness_seed, claimed_group_names, existing_groups_by_name):
    candidate = base_name or "Ungrouped"
    if candidate not in claimed_group_names:
        return candidate
    short_fingerprint = hashlib.sha1(uniqueness_seed.encode("utf-8")).hexdigest()[:8]
    candidate = f"{candidate} [{short_fingerprint}]"
    index = 2
    while candidate in claimed_group_names:
        candidate = f"{base_name or 'Ungrouped'} [{short_fingerprint}-{index}]"
        index += 1
    return candidate


def ensure_color_group(project, existing_groups_by_name, group_name):
    existing = existing_groups_by_name.get(group_name)
    if existing:
        return existing, False
    created = safe_call(project, "AddColorGroup", group_name)
    if created:
        existing_groups_by_name[group_name] = created
        return created, True
    for group in iter_values(safe_call(project, "GetColorGroupsList") or []):
        current_name = safe_call(group, "GetName")
        if current_name == group_name:
            existing_groups_by_name[group_name] = group
            return group, False
    raise HostError("resolve_color_group_missing", f"Unable to create or reuse Resolve group: {group_name}")


def build_groups_snapshot(
    root_id,
    timeline,
    timeline_name,
    raw_local_path,
    clip_requests,
    origin,
    group_transform_summaries=None,
    repair_seed_by_clip=None,
):
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
        group = safe_call(item, "GetColorGroup")
        group_name = extract_group_name(item) or "Ungrouped"
        clip_request = clip_requests_by_key.get(clip_key, {"rawRelativePath": clip_key})
        entry = group_map.setdefault(group_name, {
            "displayName": group_name,
            "clipKeys": [],
            "clipRequests": [],
            "clipSnapshots": [],
            "colorGroup": None,
        })
        if entry["colorGroup"] is None and group:
            entry["colorGroup"] = group
        if clip_key not in entry["clipKeys"]:
            entry["clipKeys"].append(clip_key)
        if clip_requests_by_key.get(clip_key):
            entry["clipRequests"].append(clip_request)
        entry["clipSnapshots"].append(build_clip_repair_snapshot(
            item,
            clip_request,
            repair_seed_by_clip.get(clip_key) if isinstance(repair_seed_by_clip, dict) else None,
        ))

    groups = []
    for display_name in sorted(group_map):
        entry = group_map[display_name]
        log_profile = summarize_group_log_profile(entry["clipRequests"])
        lowlight = summarize_group_lowlight(entry["clipSnapshots"])
        post_clip_creative_status = inspect_group_post_clip_creative_status(entry.get("colorGroup"))
        summary = build_group_creative_summary(log_profile, lowlight)
        transform_summary = {
            **build_group_transform_summary(entry["clipRequests"]),
            **((group_transform_summaries or {}).get(display_name) or {}),
        }
        groups.append({
            "groupKey": normalize_group_key(display_name),
            "displayName": display_name,
            "clipKeys": entry["clipKeys"],
            "logProfile": log_profile,
            "lowlight": lowlight,
            "postClipCreativeStatus": post_clip_creative_status,
            "clips": entry["clipSnapshots"],
            "hostSummary": {
                "timelineName": timeline_name,
                "groupName": display_name,
                "origin": origin,
                "creativeTags": summary["creativeTags"],
                "logProfile": log_profile,
                "lowlight": lowlight,
                "postClipCreativeStatus": post_clip_creative_status,
                "detectedProfile": transform_summary.get("detectedProfile"),
                "effectiveProfile": transform_summary.get("effectiveProfile"),
                "profileSource": transform_summary.get("profileSource"),
                "rootFallbackUsed": transform_summary.get("rootFallbackUsed"),
                "resolvedTransformPresetKey": transform_summary.get("resolvedTransformPresetKey"),
                "lutSyncStatus": transform_summary.get("lutSyncStatus"),
                "transformStatus": transform_summary.get("transformStatus"),
                "detail": transform_summary.get("detail"),
            },
        })

    return {
        "rootId": root_id,
        "syncedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "timelineName": timeline_name,
        "groups": groups,
    }


def build_clip_creative_summary(clip_request):
    log_profile = normalize_log_profile(clip_request.get("logProfile"))
    creative_tags = []
    if log_profile:
        creative_tags.append(log_profile)
    if clip_request.get("lowlight") is True:
        creative_tags.append("lowlight")
    return {
        "creativeTags": creative_tags,
        "displayName": " + ".join(creative_tags) if creative_tags else "base",
    }


def build_group_creative_summary(log_profile, lowlight):
    creative_tags = []
    if log_profile and log_profile not in ("mixed", "unknown"):
        creative_tags.append(log_profile)
    if lowlight == "lowlight":
        creative_tags.append("lowlight")
    return {
        "creativeTags": creative_tags,
    }


def build_group_transform_summary(clip_requests):
    detected_profiles = dedupe_strings([
        normalize_log_profile(clip_request.get("detectedProfile"))
        for clip_request in clip_requests or []
    ])
    effective_profiles = dedupe_strings([
        stringify_signal_value(clip_request.get("effectiveProfile"))
        for clip_request in clip_requests or []
    ])
    profile_sources = dedupe_strings([
        stringify_signal_value(clip_request.get("profileSource"))
        for clip_request in clip_requests or []
    ])
    preset_keys = dedupe_strings([
        stringify_signal_value(clip_request.get("resolvedTransformPresetKey"))
        for clip_request in clip_requests or []
    ])
    relative_lut_paths = dedupe_strings([
        stringify_signal_value(clip_request.get("resolvedLutRelativePath"))
        for clip_request in clip_requests or []
    ])
    absolute_lut_paths = dedupe_strings([
        normalize_filesystem_path(clip_request.get("resolvedLutAbsolutePath"))
        for clip_request in clip_requests or []
    ])
    if effective_profiles:
        default_status = "skipped-no-preset"
    else:
        default_status = "skipped-unknown-profile"
    if len(preset_keys) > 1 or len(relative_lut_paths) > 1 or len(absolute_lut_paths) > 1:
        default_status = "skipped-mixed-preset"
    return {
        "detectedProfile": detected_profiles[0] if len(detected_profiles) == 1 else ("mixed" if len(detected_profiles) > 1 else None),
        "effectiveProfile": effective_profiles[0] if len(effective_profiles) == 1 else ("mixed" if len(effective_profiles) > 1 else None),
        "profileSource": profile_sources[0] if len(profile_sources) == 1 else ("mixed" if len(profile_sources) > 1 else None),
        "rootFallbackUsed": "root-fallback" in profile_sources,
        "resolvedTransformPresetKey": preset_keys[0] if len(preset_keys) == 1 else None,
        "resolvedLutRelativePath": relative_lut_paths[0] if len(relative_lut_paths) == 1 else None,
        "resolvedLutAbsolutePath": absolute_lut_paths[0] if len(absolute_lut_paths) == 1 else None,
        "lutSyncStatus": "ready" if len(relative_lut_paths) == 1 else ("mixed" if len(relative_lut_paths) > 1 else None),
        "transformStatus": default_status,
    }


def apply_group_preclip_transforms(project, group_states):
    summaries = {}
    any_lut_requested = any(
        stringify_signal_value(clip_request.get("resolvedLutRelativePath"))
        for state in group_states.values()
        for clip_request in state.get("entries", [])
    )
    if any_lut_requested:
        safe_call(project, "RefreshLUTList")

    for group_name, state in group_states.items():
        summary = build_group_transform_summary(state.get("entries", []))
        color_group = state.get("colorGroup")
        if color_group is None:
            summaries[group_name] = {
                **summary,
                "transformStatus": "blocked-group-missing",
                "detail": f"Resolve ColorGroup 不存在：{group_name}",
            }
            continue
        relative_lut_path = summary.get("resolvedLutRelativePath")
        absolute_lut_path = summary.get("resolvedLutAbsolutePath")
        if summary.get("transformStatus") == "skipped-mixed-preset":
            summaries[group_name] = {
                **summary,
                "detail": "同一 Resolve Group 内解析出了多个 preset，已跳过默认技术底板。",
            }
            continue
        if not relative_lut_path:
            summaries[group_name] = summary
            continue
        graph = safe_call(color_group, "GetPreClipNodeGraph")
        if graph is None:
            summaries[group_name] = {
                **summary,
                "transformStatus": "blocked-preclip-graph-unavailable",
                "detail": f"Resolve 未返回 Group Pre-Clip graph：{group_name}",
            }
            continue
        current_node_count = parse_int(safe_call(graph, "GetNumNodes")) or 0
        existing_luts = collect_graph_luts(graph)
        if state.get("isNewGroup") is not True:
            if lut_matches_any(existing_luts, relative_lut_path, absolute_lut_path):
                summaries[group_name] = {
                    **summary,
                    "transformStatus": "already-applied",
                    "detail": f"默认技术 LUT 已存在于 Group Pre-Clip：{group_name}",
                }
                continue
            if current_node_count > 0 or existing_luts:
                summaries[group_name] = {
                    **summary,
                    "transformStatus": "skipped-existing-grade",
                    "detail": f"Group Pre-Clip 已有现存节点或 grade，已跳过默认技术 LUT：{group_name}",
                }
                continue
        ensured_node_count = ensure_preclip_graph_node(graph)
        if ensured_node_count <= 0:
            summaries[group_name] = {
                **summary,
                "transformStatus": "blocked-preclip-graph-empty",
                "detail": f"无法为 Group Pre-Clip 创建技术底板节点：{group_name}",
            }
            continue
        applied = apply_graph_lut(graph, relative_lut_path, absolute_lut_path)
        if not applied:
            summaries[group_name] = {
                **summary,
                "transformStatus": "blocked-lut-not-visible",
                "detail": f"LUT 当前对 Resolve 不可见，请先 Refresh LUT List / Update Lists：{relative_lut_path}",
            }
            continue
        summaries[group_name] = {
            **summary,
            "transformStatus": "applied",
            "detail": f"已把默认技术 LUT 应用到 Group Pre-Clip：{relative_lut_path}",
        }
    return summaries


def ensure_preclip_graph_node(graph):
    node_count = parse_int(safe_call(graph, "GetNumNodes")) or 0
    if node_count > 0:
        return node_count
    for method_name in ("AddSerialNode", "AddCorrectorNode", "AddNode"):
        safe_call(graph, method_name)
        node_count = parse_int(safe_call(graph, "GetNumNodes")) or 0
        if node_count > 0:
            return node_count
    return node_count


def collect_graph_luts(graph):
    return dedupe_strings(collect_graph_lut_by_node(graph).values())


def lut_matches_any(existing_luts, relative_lut_path, absolute_lut_path):
    return any(
        lut_matches(existing_path, relative_lut_path, absolute_lut_path)
        for existing_path in existing_luts or []
    )


def lut_matches(existing_path, relative_lut_path, absolute_lut_path):
    normalized_existing = stringify_signal_value(existing_path)
    if not normalized_existing:
        return False
    normalized_relative = stringify_signal_value(relative_lut_path)
    normalized_absolute = normalize_filesystem_path(absolute_lut_path)
    if normalized_relative and normalized_existing.replace("\\", "/") == normalized_relative.replace("\\", "/"):
        return True
    if normalized_absolute and normalize_filesystem_path(normalized_existing) == normalized_absolute:
        return True
    return False


def apply_graph_lut(graph, relative_lut_path, absolute_lut_path):
    for candidate in (relative_lut_path, absolute_lut_path):
        if not candidate:
            continue
        safe_call(graph, "SetLUT", 1, candidate)
        current_lut = stringify_signal_value(safe_call(graph, "GetLUT", 1))
        if lut_matches(current_lut, relative_lut_path, absolute_lut_path):
            return True
    return False


def summarize_root_transform_value(group_transform_summaries, key):
    values = dedupe_strings([
        stringify_signal_value((summary or {}).get(key))
        for summary in (group_transform_summaries or {}).values()
    ])
    if len(values) == 1:
        return values[0]
    if len(values) > 1:
        return "mixed"
    return None


def summarize_root_transform_status(group_transform_summaries):
    statuses = dedupe_strings([
        stringify_signal_value((summary or {}).get("transformStatus"))
        for summary in (group_transform_summaries or {}).values()
    ])
    if not statuses:
        return None
    if "blocked-lut-not-visible" in statuses or any(status.startswith("blocked") for status in statuses):
        return "blocked"
    if "applied" in statuses:
        return "applied"
    if "already-applied" in statuses:
        return "already-applied"
    if "skipped-existing-grade" in statuses:
        return "skipped-existing-grade"
    if "skipped-mixed-preset" in statuses:
        return "skipped-mixed-preset"
    if "skipped-no-preset" in statuses:
        return "skipped-no-preset"
    if "skipped-unknown-profile" in statuses:
        return "skipped-unknown-profile"
    return statuses[0]


def normalize_log_profile(value):
    normalized = stringify_signal_value(value)
    if not normalized:
        return None
    lowered = normalized.strip().lower()
    if "s-log3" in lowered or "slog3" in lowered:
        return "slog3"
    if "d-log" in lowered or "dlog" in lowered:
        return "dlog-m"
    if lowered == "hlg" or " hlg" in lowered or lowered.startswith("hlg"):
        return "hlg"
    if "rec709" in lowered or "rec 709" in lowered or "rec-709" in lowered:
        return "rec709"
    return None


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
            "sourceStem": stringify_signal_value(clip.get("sourceStem")) or Path(raw_relative_path).stem,
            "capturedAt": stringify_signal_value(clip.get("capturedAt")),
            "width": parse_int(clip.get("width")),
            "height": parse_int(clip.get("height")),
            "fps": parse_float(clip.get("fps")),
            "codec": stringify_signal_value(clip.get("codec")),
            "rawTags": normalize_string_map(clip.get("rawTags")),
            "detectedProfile": normalize_log_profile(clip.get("detectedProfile")),
            "effectiveProfile": stringify_signal_value(clip.get("effectiveProfile")),
            "profileSource": stringify_signal_value(clip.get("profileSource")) or "unknown",
            "logProfile": normalize_log_profile(clip.get("logProfile")),
            "gyroEligible": clip.get("gyroEligible") is True,
            "lowlight": clip.get("lowlight") is True,
            "resolvedTransformPresetKey": stringify_signal_value(clip.get("resolvedTransformPresetKey")),
            "resolvedLutRelativePath": stringify_signal_value(clip.get("resolvedLutRelativePath")),
            "resolvedLutAbsolutePath": normalize_filesystem_path(clip.get("resolvedLutAbsolutePath")),
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


def normalize_output_filename(source_stem, extension):
    return f"{source_stem}.{extension.lstrip('.')}"


def normalize_render_format(render_preset):
    container = str(render_preset.get("container") or "mp4").strip()
    video_codec = str(render_preset.get("videoCodec") or "h265").strip()
    audio_codec = str(render_preset.get("audioCodec") or "aac").strip()
    bitrate = parse_float(render_preset.get("bitrateKbps"))
    return {
        "container": container,
        "videoCodec": video_codec,
        "audioCodec": audio_codec,
        "bitrateKbps": bitrate,
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
        "bitrateKbps": render_format["bitrateKbps"],
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


def normalize_render_batch_clips(clips, extension):
    normalized = []
    for clip in clips or []:
        clip_key = normalize_portable_path(clip.get("rawRelativePath"))
        source_path = normalize_filesystem_path(clip.get("sourceAbsolutePath"))
        source_stem = stringify_signal_value(clip.get("sourceStem")) or Path(clip_key).stem
        if not clip_key or not source_path or not source_stem:
            continue
        normalized.append({
            "rawRelativePath": clip_key,
            "sourceAbsolutePath": source_path,
            "sourceStem": source_stem,
            "normalizedOutputFilename": normalize_output_filename(source_stem, extension),
            "width": parse_int(clip.get("width")),
            "height": parse_int(clip.get("height")),
            "fps": parse_float(clip.get("fps")),
        })
    return normalized


def build_temp_render_timeline_name(base_name):
    fingerprint = hashlib.sha1(f"{base_name}-{time.time()}".encode("utf-8")).hexdigest()[:8]
    return f"{base_name} [Kairos Render {fingerprint}]"


def duplicate_timeline(project, source_timeline, temp_name):
    timeline_count_before = parse_int(safe_call(project, "GetTimelineCount")) or 0
    timeline_names_before = set(list_timeline_names(project))
    require_method(project, "SetCurrentTimeline")(source_timeline)
    duplicated = safe_call(source_timeline, "DuplicateTimeline", temp_name)
    if duplicated:
        return duplicated
    duplicated = safe_call(source_timeline, "DuplicateTimeline")
    if duplicated and safe_call(duplicated, "SetName", temp_name) is not False:
        return duplicated
    count_after = parse_int(safe_call(project, "GetTimelineCount")) or 0
    if count_after > timeline_count_before:
        candidate = safe_call(project, "GetTimelineByIndex", count_after)
        if candidate and safe_call(candidate, "SetName", temp_name) is not False:
            return candidate
    for index in range(1, int(count_after) + 1):
        candidate = safe_call(project, "GetTimelineByIndex", index)
        name = safe_call(candidate, "GetName") if candidate else None
        if isinstance(name, str) and name and name not in timeline_names_before:
            if safe_call(candidate, "SetName", temp_name) is not False:
                return candidate
    existing = find_named_timeline(project, temp_name)
    if existing:
        return existing
    raise HostError("resolve_timeline_duplicate_failed", f"Unable to duplicate render timeline: {temp_name}")


def delete_timeline(media_pool, timeline):
    if timeline is None:
        return
    safe_call(media_pool, "DeleteTimelines", [timeline])


def prune_timeline_to_selected_clips(timeline, raw_local_path, selected_clip_keys):
    to_delete = []
    for track_type in ("video", "audio", "subtitle"):
        track_count = safe_call(timeline, "GetTrackCount", track_type) or safe_call(timeline, "GetTrackCount", track_type.title()) or 0
        for track_index in range(1, int(track_count) + 1):
            items = safe_call(timeline, "GetItemListInTrack", track_type, track_index)
            if items is None:
                items = safe_call(timeline, "GetItemsInTrack", track_type, track_index)
            for item in iter_values(items or []):
                file_path = extract_clip_like_file_path(item)
                if not file_path:
                    continue
                try:
                    clip_key = to_portable_relative(raw_local_path, file_path)
                except ValueError:
                    continue
                if clip_key not in selected_clip_keys:
                    to_delete.append(item)
    if not to_delete:
        return
    result = safe_call(timeline, "DeleteClips", to_delete, False)
    if result is False:
        result = safe_call(timeline, "DeleteClips", to_delete)
    if result is False:
        raise HostError("resolve_timeline_subset_prune_failed", "Unable to prune temporary render timeline to the selected clips.")


def queue_root_render_job(project, target_dir, render_format, clips):
    settings = {
        "TargetDir": str(target_dir),
        "SelectAllFrames": True,
        "UniqueFilenameStyle": 0,
        "ExportVideo": True,
        "ExportAudio": True,
    }
    unique_widths = {clip["width"] for clip in clips if clip.get("width")}
    unique_heights = {clip["height"] for clip in clips if clip.get("height")}
    unique_fps_values = {normalize_fps_string(clip.get("fps")) for clip in clips if clip.get("fps")}
    if len(unique_widths) == 1:
        settings["FormatWidth"] = int(next(iter(unique_widths)))
    if len(unique_heights) == 1:
        settings["FormatHeight"] = int(next(iter(unique_heights)))
    if len(unique_fps_values) == 1:
        settings["FrameRate"] = float(next(iter(unique_fps_values)))
    if render_format.get("audioCodec"):
        settings["AudioCodec"] = render_format["audioCodec"]
    if render_format.get("bitrateKbps"):
        settings["VideoQuality"] = max(1, int(round(float(render_format["bitrateKbps"]))))
    result = safe_call(project, "SetRenderSettings", settings)
    if result is False:
        raise HostError(
            "resolve_render_settings_failed",
            "Unable to set render settings for root render batch",
            {"renderSettings": settings},
        )
    job_id = safe_call(project, "AddRenderJob")
    if job_id is False or job_id is None:
        raise HostError("resolve_add_render_job_failed", "Unable to queue render job for root render batch")
    return job_id


def prepare_clip_staging_dir(path):
    if path.exists():
        shutil.rmtree(path)
    path.mkdir(parents=True, exist_ok=True)


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


def adopt_root_render_outputs(render_dir, staging_root, clips, extension):
    if has_duplicate_source_stems(clips):
        raise HostError(
            "resolve_render_output_duplicate_source_stem",
            "Root render batch contains duplicate source stems; Resolve output binding would be ambiguous.",
            {
                "rawRelativePaths": [clip["rawRelativePath"] for clip in clips],
            },
        )
    candidates = [
        path
        for path in render_dir.rglob("*")
        if path.is_file() and path.suffix.lower() == f".{extension.lstrip('.').lower()}"
    ]
    if not candidates:
        raise HostError(
            "resolve_render_output_missing",
            "Unable to locate rendered outputs for root render batch.",
            {"renderDir": str(render_dir)},
        )

    normalized_entries = []
    claimed = []
    for clip in clips:
        matching_candidates = [
            path
            for path in candidates
            if path not in claimed and rendered_output_matches_source_stem(path, clip["sourceStem"])
        ]
        if not matching_candidates:
            raise HostError(
                "resolve_render_output_missing",
                f"Unable to locate rendered output for {clip['normalizedOutputFilename']}",
                {
                    "rawRelativePath": clip["rawRelativePath"],
                    "candidatePaths": [str(path) for path in sorted(candidates, key=lambda value: value.name)],
                },
            )
        if len(matching_candidates) > 1:
            raise HostError(
                "resolve_render_output_ambiguous",
                f"Multiple rendered outputs matched {clip['normalizedOutputFilename']}",
                {
                    "rawRelativePath": clip["rawRelativePath"],
                    "candidatePaths": [str(path) for path in sorted(matching_candidates, key=lambda value: value.name)],
                },
            )
        actual_path = matching_candidates[0]
        claimed.append(actual_path)
        relative_dir = portable_parent_dir(clip["rawRelativePath"])
        output_dir = staging_root / relative_dir if relative_dir else staging_root
        output_dir.mkdir(parents=True, exist_ok=True)
        target_path = (output_dir / clip["normalizedOutputFilename"]).resolve()
        if target_path.exists():
            target_path.unlink()
        actual_path.replace(target_path)
        normalized_entries.append({
            "rawRelativePath": clip["rawRelativePath"],
            "outputPath": str(target_path),
            "normalizedOutputFilename": clip["normalizedOutputFilename"],
        })

    unclaimed = [str(path) for path in candidates if path not in claimed]
    if unclaimed:
        raise HostError(
            "resolve_render_output_unclaimed",
            "Resolve rendered extra outputs that do not map to the selected root batch clips.",
            {"candidatePaths": unclaimed},
        )
    return normalized_entries


def rendered_output_matches_source_stem(path, source_stem):
    candidate_stem = path.stem
    if not isinstance(candidate_stem, str) or not candidate_stem:
        return False
    pattern = re.compile(rf"^{re.escape(source_stem)}(?:[_-]\d+)?$", re.IGNORECASE)
    return bool(pattern.match(candidate_stem))


def has_duplicate_source_stems(clips):
    seen = set()
    for clip in clips:
        stem = str(clip.get("sourceStem") or "").strip().lower()
        if not stem:
            continue
        if stem in seen:
            return True
        seen.add(stem)
    return False


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
        warnings.append("无法从 Resolve 读取 render formats；execute_root 的格式守卫会按保守模式处理。")
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


def stringify_setting_value(value):
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if abs(value - round(value)) < 0.001:
            return str(int(round(value)))
        return f"{value:.3f}".rstrip("0").rstrip(".")
    if isinstance(value, str):
        return value
    return ""


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


def parse_bool(value):
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str) and value.strip():
        lowered = value.strip().lower()
        if lowered in ("1", "true", "yes", "on"):
            return True
        if lowered in ("0", "false", "no", "off"):
            return False
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
