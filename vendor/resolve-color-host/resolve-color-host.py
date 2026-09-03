#!/usr/bin/env python3
import argparse
import hashlib
import json
import math
import os
import re
import shutil
import sys
import tempfile
import time
import uuid
from pathlib import Path


CCREATIVE_SIGNAL_KEYS = (
    "slog3",
    "dlog-m",
    "hlg",
    "rec709",
    "portrait-review",
    "lowlight",
    "windshield-haze",
    "cool-cyan",
    "green-cyan",
    "green",
    "warm",
    "mixed",
    "high-contrast",
    "overexposed",
    "underexposed",
    "white-reference-underexposed",
)

CCOLOR_CAST_GROUP_CLASSES = ("cool-cyan", "green-cyan", "green", "warm", "mixed")
CEXPOSURE_SCENE_GROUP_CLASSES = ("high-contrast", "overexposed", "underexposed")
CEXPOSURE_SCENE_REASON_GROUP_TAGS = ("white-reference-underexposed",)
CROUGH_CUT_AUDIBLE_CLIP_COLOR = "Orange"
CROUGH_CUT_PHOTO_CLIP_COLOR = "Blue"
CROUGH_CUT_TIMELAPSE_CLIP_COLOR = "Purple"
CROUGH_CUT_DRIVE_CLIP_COLOR = "Brown"
CROUGH_CUT_AERIAL_CLIP_COLOR = "Teal"
CROUGH_CUT_PHOTO_COLOR_GROUP = "Kairos Photos"
CROUGH_CUT_TIMELAPSE_COLOR_GROUP = "Kairos Timelapse"


def configure_stdio() -> None:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


def main() -> int:
    configure_stdio()
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
        elif operation == "sync_rough_cut_media":
            result = sync_rough_cut_media(resolve, request_input)
        elif operation == "create_rough_cut_timeline":
            result = create_rough_cut_timeline(resolve, request_input)
        elif operation == "mark_existing_rough_cut_clip_colors":
            result = mark_existing_rough_cut_clip_colors(resolve, request_input)
        elif operation == "relink_edit_media":
            result = relink_edit_media(resolve, request_input)
        elif operation == "relink_color_media":
            result = relink_color_media(resolve, request_input)
        elif operation == "export_edit_timeline_clip_packet":
            result = export_edit_timeline_clip_packet(resolve, request_input)
        elif operation == "save_drp_snapshot":
            result = save_drp_snapshot(resolve, request_input)
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
    resolve_app_candidates = []

    if sys.platform == "darwin":
        base = Path("/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting")
        resolve_app_candidates.append(Path("/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Libraries/Fusion"))
    elif sys.platform == "win32":
        base = Path("C:/ProgramData/Blackmagic Design/DaVinci Resolve/Support/Developer/Scripting")
        resolve_app_candidates.extend([
            Path(os.environ["RESOLVE_SCRIPT_LIB"]).parent if os.environ.get("RESOLVE_SCRIPT_LIB") else None,
            Path("C:/Applications/Davinci"),
            Path("C:/Program Files/Blackmagic Design/DaVinci Resolve"),
        ])
    else:
        base = Path("/opt/resolve/Developer/Scripting")
        resolve_app_candidates.append(Path("/opt/resolve/libs/Fusion"))
    candidates.extend([base, base / "Modules"])

    for candidate in candidates:
        text = str(candidate)
        if candidate.exists() and text not in sys.path:
            sys.path.insert(0, text)

    for candidate in resolve_app_candidates:
        if candidate is None or not candidate.exists():
            continue
        if sys.platform == "win32":
            lib_path = candidate / "fusionscript.dll"
            if lib_path.exists() and not os.environ.get("RESOLVE_SCRIPT_LIB"):
                os.environ["RESOLVE_SCRIPT_LIB"] = str(lib_path)
        text = str(candidate)
        if sys.platform == "win32" and hasattr(os, "add_dll_directory"):
            try:
                os.add_dll_directory(text)
            except Exception:
                pass
        path_value = os.environ.get("PATH", "")
        if text not in path_value.split(os.pathsep):
            os.environ["PATH"] = text + os.pathsep + path_value


def prepare_root(resolve, payload):
    project = ensure_project(resolve, payload["resolveProjectName"])
    apply_timeline_spec(project, payload.get("timelineSpec"))
    media_pool = require_method(project, "GetMediaPool")()
    media_storage = require_method(resolve, "GetMediaStorage")()
    namespace_folder = ensure_namespace_folder(media_pool, payload["rootNamespace"])
    timeline = ensure_timeline(project, media_pool, payload["gradingTimelineName"])
    reset_timeline = payload.get("resetTimeline") is not False
    apply_timeline_spec(project, payload.get("timelineSpec"), timeline)
    save_project(project, resolve)
    clip_requests = normalize_clip_requests(payload.get("clips"))
    previous_group_names_by_clip = capture_timeline_group_assignments(timeline, payload["rawLocalPath"])
    repair_templates = get_repair_template_assets(payload)
    donor_timeline = None
    repair_template_timelines = {}
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
        repair_template_timelines = import_repair_template_timelines(
            media_pool,
            repair_templates,
            clip_requests,
        )
        namespace_state = collect_namespace_state(namespace_folder)
        prepared_entries, sync_summary = sync_namespace_clips(
            media_pool,
            media_storage,
            namespace_folder,
            namespace_state,
            clip_requests,
        )
        save_project(project, resolve)
        ordered_entries = sort_clip_entries(prepared_entries)

        existing_timeline_items_by_clip = {} if reset_timeline else build_timeline_item_map(timeline, payload["rawLocalPath"])
        if reset_timeline:
            try:
                clear_timeline_items(timeline)
            except HostError as error:
                if error.code != "resolve_timeline_clear_failed":
                    raise
                timeline = recreate_timeline(media_pool, project, timeline, payload["gradingTimelineName"])
                apply_timeline_spec(project, payload.get("timelineSpec"), timeline)
            append_entries = ordered_entries
        else:
            append_entries = [
                entry
                for entry in ordered_entries
                if entry["rawRelativePath"] not in existing_timeline_items_by_clip
            ]
        append_clips_to_timeline(project, media_pool, timeline, append_entries)
        save_project(project, resolve)
        timeline_item_by_clip_key = build_timeline_item_map(timeline, payload["rawLocalPath"])
        transform_summary = apply_clip_timeline_transforms(timeline_item_by_clip_key, clip_requests)
        save_project(project, resolve)
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
            repair_templates,
            repair_template_timelines,
        )
        save_project(project, resolve)

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
        save_project(project, resolve)
        return {
            "resolveProjectName": payload["resolveProjectName"],
            "gradingTimelineName": payload["gradingTimelineName"],
            "mirrorStatus": "synced",
            "timelineStatus": "ready",
            "groupsSnapshot": groups_snapshot,
            "hostSummary": {
                "rootNamespace": payload["rootNamespace"],
                "clipCount": len(ordered_entries),
                "timelineName": payload["gradingTimelineName"],
                "chunkId": payload.get("chunkId"),
                "resetTimeline": reset_timeline,
                "appendedClipCount": len(append_entries),
                "skippedExistingTimelineClipCount": len(ordered_entries) - len(append_entries),
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
                **transform_summary,
                **summarize_repair_template_state(repair_templates, repair_seed_by_clip),
            },
        }
    finally:
        delete_timeline(media_pool, donor_timeline)
        for repair_template_timeline in repair_template_timelines.values():
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

    output_root = Path(payload["outputRoot"]).expanduser().resolve()
    output_root.mkdir(parents=True, exist_ok=True)

    render_format = normalize_render_format(payload.get("renderPreset", {}))
    selected_clips = normalize_render_batch_clips(payload.get("clips"), sanitize_extension(render_format.get("container") or "mp4"))
    if not selected_clips:
        raise HostError("resolve_root_batch_empty", "Root batch does not contain any render clips.")

    media_pool = require_method(project, "GetMediaPool")()
    ensure_render_queue_empty(project)
    safe_call(resolve, "OpenPage", "edit")
    save_project(project, resolve)
    normalized_entries = []
    render_jobs = []
    temp_timelines = []
    render_started = False
    transient_render_preset_name = None
    try:
        safe_call(resolve, "OpenPage", "deliver")
        resolved_render_format = set_render_format(project, render_format)
        transient_render_preset_name = ensure_bitrate_render_preset(resolve, project, resolved_render_format)
        selected_clips = normalize_render_batch_clips(payload.get("clips"), resolved_render_format["extension"])
        save_project(project, resolve)

        render_specs = build_day_render_specs(selected_clips, output_root)
        for spec in render_specs:
            temp_timeline = duplicate_timeline(project, timeline, build_temp_render_timeline_name(payload["gradingTimelineName"]))
            temp_timelines.append(temp_timeline)
            require_method(project, "SetCurrentTimeline")(temp_timeline)
            selected_keys = {clip["rawRelativePath"] for clip in spec["clips"]}
            prune_timeline_to_selected_clips(temp_timeline, payload["rawLocalPath"], selected_keys)
            assert_timeline_contains_selected_clips(temp_timeline, payload["rawLocalPath"], selected_keys)
            safe_call(resolve, "OpenPage", "deliver")
            spec["targetDir"].mkdir(parents=True, exist_ok=True)
            queued_job_id = queue_root_render_job(project, spec["targetDir"], resolved_render_format, spec["clips"])
            spec["jobId"] = str(queued_job_id)
            render_jobs.append({
                "jobId": str(queued_job_id),
                "timelineName": safe_call(temp_timeline, "GetName") or payload["gradingTimelineName"],
                "targetDir": str(spec["targetDir"]),
                "clipCount": len(spec["clips"]),
            })

        save_project(project, resolve)
        start_rendering(project, None)
        render_started = True
        wait_for_render(project, [job["jobId"] for job in render_jobs])
        normalized_entries = collect_root_direct_outputs(
            render_specs,
            selected_clips,
            resolved_render_format["extension"],
        )
    finally:
        if not render_started:
            cleanup_created_render_jobs(project, render_jobs)
        if transient_render_preset_name:
            safe_call(project, "DeleteRenderPreset", transient_render_preset_name)
        safe_call(project, "SetCurrentTimeline", timeline)
        safe_call(resolve, "OpenPage", "edit")
        for temp_timeline in temp_timelines:
            delete_timeline(media_pool, temp_timeline)
        save_project(project, resolve)

    entries_by_key = {entry["rawRelativePath"]: entry for entry in normalized_entries}
    normalized_entries = [
        entries_by_key[clip["rawRelativePath"]]
        for clip in selected_clips
        if clip["rawRelativePath"] in entries_by_key
    ]
    return {
        "renderedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "entries": normalized_entries,
        "renderJobs": render_jobs,
        "hostSummary": {
            "timelineName": payload["gradingTimelineName"],
            "selectionMode": payload.get("selectionMode") or "all",
            "clipCount": len(selected_clips),
            "outputRoot": str(output_root),
            "renderJobCount": len(render_jobs),
            "resolvedFormat": resolved_render_format["format"],
            "resolvedCodec": resolved_render_format["videoCodec"],
            "audioCodec": resolved_render_format["audioCodec"],
            "bitrateKbps": resolved_render_format["bitrateKbps"],
            "bitrateControl": "transient-render-preset" if transient_render_preset_name else None,
        },
    }


def sync_rough_cut_media(resolve, payload):
    project = ensure_project(resolve, payload["resolveProjectName"])
    media_pool = require_method(project, "GetMediaPool")()
    media_storage = require_method(resolve, "GetMediaStorage")()
    namespace = stringify_signal_value(payload.get("namespace")) or "Kairos Project Media"
    clip_requests = normalize_rough_cut_media_requests(payload.get("clips"))
    if not clip_requests:
        raise HostError("resolve_media_sync_empty", "sync_rough_cut_media requires at least one media clip.")

    namespace_folder = ensure_namespace_folder_with_legacy(media_pool, namespace, payload.get("legacyNamespaces"))
    namespace_state = collect_namespace_state(namespace_folder)
    media_pool_state = collect_namespace_state(require_method(media_pool, "GetRootFolder")())
    prepared_entries, sync_summary = sync_namespace_clips(
        media_pool,
        media_storage,
        namespace_folder,
        namespace_state,
        clip_requests,
        dedupe_by_source_path=True,
        fallback_state=media_pool_state,
        cleanup_empty_folders=True,
    )
    event_folders = {
        portable_parent_dir(entry["rawRelativePath"])
        for entry in prepared_entries
        if portable_parent_dir(entry["rawRelativePath"])
    }
    save_project(project, resolve)
    return {
        "resolveProjectName": payload["resolveProjectName"],
        "namespace": namespace,
        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "hostSummary": {
            "namespace": namespace,
            "imported": sync_summary["imported"],
            "moved": sync_summary["moved"],
            "reused": sync_summary["reused"],
            "emptyFoldersDeleted": sync_summary.get("emptyFoldersDeleted", 0),
            "eventFolderCount": len(event_folders),
            "mediaItemCount": len(prepared_entries),
        },
    }


def create_rough_cut_timeline(resolve, payload):
    project = ensure_project(resolve, payload["resolveProjectName"])
    media_pool = require_method(project, "GetMediaPool")()
    timeline_name = stringify_signal_value(payload.get("timelineName"))
    if not timeline_name:
        raise HostError("resolve_timeline_name_missing", "create_rough_cut_timeline requires timelineName.")
    clips = normalize_rough_cut_clips(payload.get("clips"))
    if not clips:
        raise HostError("resolve_timeline_empty", "create_rough_cut_timeline requires at least one clip.")

    namespace = stringify_signal_value(payload.get("namespace")) or "Kairos Project Media"
    timeline_folder_name = stringify_signal_value(payload.get("timelineFolderName")) or "Kairos Timelines"
    namespace_folder = ensure_namespace_folder_with_legacy(media_pool, namespace, payload.get("legacyNamespaces"))
    timeline_folder = ensure_namespace_folder(media_pool, timeline_folder_name)
    rename_legacy_timeline_if_needed(project, timeline_name, payload.get("legacyTimelineNames"))
    apply_project_timeline_spec_before_create(project, media_pool, timeline_name, payload.get("timelineSpec"))
    safe_call(media_pool, "SetCurrentFolder", timeline_folder)
    timeline = ensure_timeline(project, media_pool, timeline_name)
    move_timeline_media_pool_item(media_pool, timeline_name, timeline_folder, timeline_folder_name)
    apply_timeline_spec(project, payload.get("timelineSpec"), timeline)
    assert_timeline_matches_spec(project, timeline, payload.get("timelineSpec"))
    safe_call(resolve, "OpenPage", "edit")
    safe_call(project, "SetCurrentTimeline", timeline)
    safe_call(timeline, "SetStartTimecode", "00:00:00:00")
    try:
        clear_timeline_items(timeline)
    except HostError as error:
        if error.code != "resolve_timeline_clear_failed":
            raise
        timeline = recreate_timeline(media_pool, project, timeline, timeline_name)
        move_timeline_media_pool_item(media_pool, timeline_name, timeline_folder, timeline_folder_name)
        apply_timeline_spec(project, payload.get("timelineSpec"), timeline)
        safe_call(project, "SetCurrentTimeline", timeline)
        safe_call(timeline, "SetStartTimecode", "00:00:00:00")
    subtitle_import = import_rough_cut_subtitles(media_pool, timeline, payload)
    namespace_state = collect_namespace_state(namespace_folder)
    media_pool_item_by_source_path = namespace_state["clipBySourcePath"]
    missing = [
        {
            "clipId": clip["clipId"],
            "assetId": clip["assetId"],
            "sourceAbsolutePath": clip["sourceAbsolutePath"],
        }
        for clip in clips
        if clip["sourceAbsolutePath"] not in media_pool_item_by_source_path
    ]
    if missing:
        raise HostError(
            "resolve_media_pool_clip_missing",
            "Resolve Media Pool is missing rough-cut media; run resolve.media_sync before timeline.generate.",
            {"missing": missing[:50], "missingCount": len(missing), "namespace": namespace},
        )
    appended = []
    audio_gain_applied = 0
    audio_mute_applied = 0
    audible_clip_coloring = {
        "color": CROUGH_CUT_AUDIBLE_CLIP_COLOR,
        "itemScope": "ordinary-video-and-linked-audio; linked-audio-only-when-video-has-visual-category-color",
        "checked": 0,
        "colored": 0,
        "failed": 0,
    }
    visual_clip_coloring = {
        "photo": {
            "color": CROUGH_CUT_PHOTO_CLIP_COLOR,
            "itemScope": "video",
            "checked": 0,
            "colored": 0,
            "failed": 0,
        },
        "timelapse": {
            "color": CROUGH_CUT_TIMELAPSE_CLIP_COLOR,
            "itemScope": "video",
            "checked": 0,
            "colored": 0,
            "failed": 0,
        },
        "drive": {
            "color": CROUGH_CUT_DRIVE_CLIP_COLOR,
            "itemScope": "video",
            "checked": 0,
            "colored": 0,
            "failed": 0,
        },
        "aerial": {
            "color": CROUGH_CUT_AERIAL_CLIP_COLOR,
            "itemScope": "video",
            "checked": 0,
            "colored": 0,
            "failed": 0,
        },
    }
    visual_clip_grouping = {
        "photo": {
            "groupName": CROUGH_CUT_PHOTO_COLOR_GROUP,
            "itemScope": "video",
            "checked": 0,
            "assigned": 0,
            "alreadyAssigned": 0,
            "failed": 0,
            "created": False,
        },
        "timelapse": {
            "groupName": CROUGH_CUT_TIMELAPSE_COLOR_GROUP,
            "itemScope": "video",
            "checked": 0,
            "assigned": 0,
            "alreadyAssigned": 0,
            "failed": 0,
            "created": False,
        },
    }
    existing_rough_cut_groups_by_name = collect_color_groups_by_name(project)
    rough_cut_visual_groups_by_category = {}
    speed_ignored = 0
    source_range_validation = {"checked": 0, "passed": 0, "failed": 0, "strategy": "direct-native-append"}
    still_duration_validation = {"checked": 0, "passed": 0, "failed": 0, "expectedMs": parse_float(payload.get("stillDurationMs"))}
    timeline_placement_validation = {"checked": 0, "passed": 0, "failed": 0, "strategy": "sequential-actual-end"}
    fps = parse_float((payload.get("timelineSpec") or {}).get("fps")) or 30.0
    timeline_start_frame = parse_int(safe_call(timeline, "GetStartFrame")) or 0
    next_record_frame = 0
    for clip in clips:
        media_pool_item = media_pool_item_by_source_path.get(clip["sourceAbsolutePath"])
        if media_pool_item is None:
            raise HostError(
                "resolve_media_pool_clip_missing",
                f"Unable to find synced rough-cut clip in Resolve Media Pool: {clip['clipId']}",
                {"clipId": clip["clipId"], "sourceAbsolutePath": clip["sourceAbsolutePath"]},
            )
        clip_info = build_rough_cut_append_clip_info(media_pool_item, clip, fps, next_record_frame)
        appended_items = safe_call(media_pool, "AppendToTimeline", [clip_info])
        if not appended_items:
            raise HostError(
                "resolve_timeline_append_failed",
                f"Unable to append rough-cut clip: {clip['clipId']}",
                {"clipId": clip["clipId"], "sourceAbsolutePath": clip["sourceAbsolutePath"]},
            )
        timeline_items = list(iter_values(appended_items))
        if not timeline_items:
            raise HostError(
                "resolve_timeline_append_failed",
                f"Resolve returned no timeline item for rough-cut clip: {clip['clipId']}",
                {"clipId": clip["clipId"]},
            )
        video_items = resolve_appended_video_items(timeline, timeline_items, clip_info, clip)
        if not video_items:
            raise HostError(
                "resolve_video_item_missing",
                f"Resolve did not return a video TimelineItem for appended rough-cut clip {clip['clipId']}.",
                {
                    "clipId": clip["clipId"],
                    "assetId": clip["assetId"],
                    "sourceAbsolutePath": clip["sourceAbsolutePath"],
                    "recordFrame": clip_info.get("recordFrame"),
                    "returnedItemCount": len(timeline_items),
                },
            )
        display_name = build_resolve_timeline_item_name(clip)
        for item in video_items:
            safe_call(item, "SetName", display_name)
            if clip["assetKind"] == "photo":
                validate_rough_cut_still_duration(item, clip, fps, payload.get("stillDurationMs"), still_duration_validation)
            else:
                validate_rough_cut_source_range(item, media_pool_item, clip, source_range_validation, fps)
        actual_start_frame = min(
            (frame for frame in (parse_int(safe_call(item, "GetStart")) for item in video_items) if frame is not None),
            default=None,
        )
        actual_end_frame = max(
            (frame for frame in (parse_int(safe_call(item, "GetEnd")) for item in video_items) if frame is not None),
            default=None,
        )
        validate_rough_cut_timeline_placement(
            clip,
            clip_info,
            timeline_start_frame,
            actual_start_frame,
            actual_end_frame,
            timeline_placement_validation,
        )
        if actual_end_frame is not None:
            next_record_frame = max(0, actual_end_frame - timeline_start_frame)
        linked_items = collect_linked_timeline_items(video_items)
        audio_items = filter_timeline_items_by_track_type(linked_items, "audio")
        visual_clip_color = apply_rough_cut_visual_clip_color(video_items, clip, visual_clip_coloring)
        visual_clip_group = apply_rough_cut_visual_clip_group(
            video_items,
            clip,
            project,
            existing_rough_cut_groups_by_name,
            rough_cut_visual_groups_by_category,
            visual_clip_grouping,
        )
        audible_color_items = [*audio_items]
        if visual_clip_color is None:
            audible_color_items = [*video_items, *audible_color_items]
        audible_clip_color = apply_rough_cut_audible_clip_color(audible_color_items, clip, audible_clip_coloring)
        if clip["muteAudio"] and clip["assetKind"] != "photo" and audio_items:
            apply_timeline_item_audio_mute(audio_items, clip)
            audio_mute_applied += 1
        if (not clip["muteAudio"]) and clip["audioGainDb"] != 0:
            apply_timeline_item_audio_gain(audio_items, clip)
            audio_gain_applied += 1
        requested_speed = parse_float(clip.get("requestedSpeed")) or clip["speed"]
        if abs(requested_speed - 1.0) > 0.001:
            speed_ignored += 1
        appended.append({
            "clipId": clip["clipId"],
            "assetId": clip["assetId"],
            "spanId": clip.get("spanId"),
            "eventId": clip.get("eventId"),
            "resolveItemName": display_name,
            "timelineInMs": clip["timelineInMs"],
            "timelineOutMs": clip["timelineOutMs"],
            "recordFrame": clip_info.get("recordFrame"),
            **({"actualStartFrame": actual_start_frame} if actual_start_frame is not None else {}),
            **({"actualEndFrame": actual_end_frame} if actual_end_frame is not None else {}),
            "muteAudio": clip["muteAudio"],
            "audioGainDb": clip["audioGainDb"],
            "speed": clip["speed"],
            "spanType": clip.get("spanType"),
            **({"videoClipColor": visual_clip_color} if visual_clip_color else {}),
            **({"videoClipGroup": visual_clip_group} if visual_clip_group else {}),
            **({"audibleClipColor": audible_clip_color} if audible_clip_color else {}),
            **({"requestedSpeed": requested_speed, "speedIgnored": True} if abs(requested_speed - 1.0) > 0.001 else {}),
        })

    save_project(project, resolve)
    return {
        "resolveProjectName": payload["resolveProjectName"],
        "timelineName": timeline_name,
        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "clipCount": len(appended),
        "hostSummary": {
            "namespace": namespace,
            "timelineName": timeline_name,
            "clipCount": len(appended),
            "mutedClipCount": sum(1 for clip in clips if clip["muteAudio"]),
            "audioMuteAppliedCount": audio_mute_applied,
            "audioGainAppliedCount": audio_gain_applied,
            "audibleClipColoring": audible_clip_coloring,
            "visualClipColoring": visual_clip_coloring,
            "visualClipGrouping": visual_clip_grouping,
            "speedAppliedCount": 0,
            "speedIgnoredCount": speed_ignored,
            "timelineCreate": "native-api",
            "speedStrategy": "ignored",
            "syncSummary": {
                "mode": "existing-media-pool",
                "imported": 0,
                "moved": 0,
                "reused": len({clip["sourceAbsolutePath"] for clip in clips}),
            },
            "sourceRangeValidation": source_range_validation,
            "stillDurationValidation": still_duration_validation,
            "timelinePlacementValidation": timeline_placement_validation,
            "timelineGapValidation": validate_rough_cut_timeline_no_gaps(timeline),
            "subtitleImport": subtitle_import,
            "clips": appended,
        },
    }


def mark_existing_rough_cut_clip_colors(resolve, payload):
    project_name = stringify_signal_value(payload.get("resolveProjectName"))
    if not project_name:
        raise HostError(
            "resolve_edit_project_name_missing",
            "mark_existing_rough_cut_clip_colors requires resolveProjectName.",
        )
    timeline_name = stringify_signal_value(payload.get("timelineName"))
    if not timeline_name:
        raise HostError(
            "resolve_edit_timeline_name_missing",
            "mark_existing_rough_cut_clip_colors requires timelineName.",
        )
    clips = normalize_rough_cut_clip_color_marker_clips(payload.get("clips"))
    if not clips:
        raise HostError(
            "resolve_rough_cut_clip_color_empty",
            "mark_existing_rough_cut_clip_colors requires at least one visual-category clip.",
        )

    project, current_project_before = load_existing_project(resolve, project_name)
    timeline = find_named_timeline(project, timeline_name)
    if timeline is None:
        raise HostError(
            "resolve_edit_timeline_missing",
            f"Resolve edit timeline not found: {timeline_name}",
            {
                "resolveProjectName": project_name,
                "timelineName": timeline_name,
                "timelines": list_timeline_names(project),
            },
        )
    safe_call(project, "SetCurrentTimeline", timeline)
    safe_call(resolve, "OpenPage", "edit")

    timeline_entries = collect_timeline_video_color_marker_entries(timeline)
    match_state = build_timeline_color_marker_match_state(clips, timeline_entries)
    visual_clip_coloring = {
        "photo": {
            "color": CROUGH_CUT_PHOTO_CLIP_COLOR,
            "itemScope": "video",
            "checked": 0,
            "colored": 0,
            "failed": 0,
        },
        "timelapse": {
            "color": CROUGH_CUT_TIMELAPSE_CLIP_COLOR,
            "itemScope": "video",
            "checked": 0,
            "colored": 0,
            "failed": 0,
        },
        "drive": {
            "color": CROUGH_CUT_DRIVE_CLIP_COLOR,
            "itemScope": "video",
            "checked": 0,
            "colored": 0,
            "failed": 0,
        },
        "aerial": {
            "color": CROUGH_CUT_AERIAL_CLIP_COLOR,
            "itemScope": "video",
            "checked": 0,
            "colored": 0,
            "failed": 0,
        },
    }
    marked = []
    missing = []
    category_counts = {"photo": 0, "timelapse": 0, "drive": 0, "aerial": 0}
    for clip in clips:
        category = resolve_rough_cut_visual_clip_color_category(clip)
        if not category:
            continue
        category_counts[category] = int(category_counts.get(category) or 0) + 1
        match = match_existing_rough_cut_video_item(clip, match_state)
        if match is None:
            missing.append({
                "clipId": clip["clipId"],
                "clipIndex": clip.get("clipIndex"),
                "resolveNameClipId": clip.get("resolveNameClipId"),
                "sourceStem": clip.get("sourceStem"),
                "sourceAbsolutePath": clip.get("sourceAbsolutePath"),
                "category": category,
            })
            continue
        before_color = stringify_signal_value(safe_call(match["item"], "GetClipColor")) or ""
        color = apply_rough_cut_visual_clip_color([match["item"]], clip, visual_clip_coloring)
        after_color = stringify_signal_value(safe_call(match["item"], "GetClipColor")) or ""
        marked.append({
            "clipId": clip["clipId"],
            "clipIndex": clip.get("clipIndex"),
            "resolveNameClipId": clip.get("resolveNameClipId"),
            "sourceStem": clip.get("sourceStem"),
            "category": category,
            "requestedColor": color,
            "beforeColor": before_color,
            "afterColor": after_color,
            "matchMethod": match["method"],
            "timelineItemName": match["name"],
            "timelineStartFrame": match.get("startFrame"),
        })

    if missing:
        raise HostError(
            "resolve_rough_cut_clip_color_match_missing",
            "Unable to find all requested photo/timelapse clips in the existing Resolve timeline.",
            {
                "resolveProjectName": project_name,
                "timelineName": timeline_name,
                "missing": missing[:50],
                "missingCount": len(missing),
                "markedCount": len(marked),
            },
        )
    save_result = save_project_with_result(project, resolve)
    return {
        "resolveProjectName": project_name,
        "currentProjectBefore": current_project_before,
        "timelineName": safe_call(timeline, "GetName"),
        "markedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "clipCount": len(clips),
        "markedCount": len(marked),
        "saveProjectResult": save_result,
        "hostSummary": {
            "timelineVideoItemCount": len(timeline_entries),
            "categoryCounts": category_counts,
            "visualClipColoring": visual_clip_coloring,
            "matchMethods": count_match_methods(marked),
            "clips": marked,
        },
    }


def relink_edit_media(resolve, payload):
    project_name = stringify_signal_value(payload.get("resolveProjectName"))
    if not project_name:
        raise HostError("resolve_edit_project_name_missing", "relink_edit_media requires resolveProjectName.")
    project, current_project_before = load_existing_project(resolve, project_name)
    media_pool = require_method(project, "GetMediaPool")()
    namespace = stringify_signal_value(payload.get("namespace")) or "Kairos Project Media"
    root_folder = require_method(media_pool, "GetRootFolder")()
    namespace_folder = find_root_media_pool_folder(root_folder, namespace)
    if namespace_folder is None:
        raise HostError(
            "resolve_edit_media_namespace_missing",
            f"Resolve edit media namespace not found: {namespace}",
            {"resolveProjectName": project_name, "namespace": namespace},
        )

    timeline_name = stringify_signal_value(payload.get("timelineName"))
    timeline = find_named_timeline(project, timeline_name) if timeline_name else safe_call(project, "GetCurrentTimeline")
    if timeline_name and timeline is None:
        raise HostError(
            "resolve_edit_timeline_missing",
            f"Resolve edit timeline not found: {timeline_name}",
            {
                "resolveProjectName": project_name,
                "timelineName": timeline_name,
                "timelines": list_timeline_names(project),
            },
        )
    if timeline is not None:
        safe_call(project, "SetCurrentTimeline", timeline)

    mappings = normalize_edit_relink_roots(payload.get("roots"))
    if not mappings:
        raise HostError("resolve_edit_relink_roots_missing", "relink_edit_media requires at least one readable root mapping.")

    timeline_track_types = normalize_relink_timeline_track_types(payload.get("timelineTrackTypes"))
    count_timeline_unmapped = payload.get("timelineCountUnmapped") is not False
    items = collect_media_pool_items(namespace_folder)
    preflight = build_edit_relink_plan(items, mappings)
    relink_results = []
    relinked = 0
    for folder_path in sorted(preflight["byFolder"].keys()):
        clips = preflight["byFolder"][folder_path]
        ok = safe_call(media_pool, "RelinkClips", clips, folder_path)
        relink_results.append({"folder": folder_path, "count": len(clips), "ok": ok is not False and ok is not None})
        relinked += len(clips)

    if relinked > 0:
        time.sleep(1.0)
    verify = summarize_edit_relink_state(
        namespace_folder,
        timeline,
        mappings,
        timeline_track_types,
        count_timeline_unmapped=count_timeline_unmapped,
    )
    relink_failures = [entry for entry in relink_results if not entry["ok"]]
    if relink_failures:
        raise HostError(
            "resolve_edit_relink_verify_failed",
            "Resolve edit media relink did not pass verification.",
            {
                "relinkFailures": relink_failures,
                **verify,
            },
        )

    save_result = save_project_with_result(project, resolve) if relinked > 0 else None
    if relinked > 0 and not save_result:
        raise HostError(
            "resolve_edit_relink_save_failed",
            "Resolve edit media relink succeeded but SaveProject failed.",
            verify,
        )

    return {
        "resolveProjectName": project_name,
        "namespace": namespace,
        "timelineName": timeline_name or (safe_call(timeline, "GetName") if timeline is not None else None),
        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "hostSummary": {
            "currentProjectBefore": current_project_before,
            "loadedProject": safe_call(project, "GetName"),
            "namespace": namespace,
            "timeline": safe_call(timeline, "GetName") if timeline is not None else None,
            "timelineTrackTypes": timeline_track_types,
            "timelineCountUnmapped": count_timeline_unmapped,
            "rootReadable": {mapping["rootId"]: Path(mapping["localPath"]).is_dir() for mapping in mappings},
            "rootCount": len(mappings),
            "alreadyLocalBefore": preflight["alreadyLocal"],
            "preflightMissingTargetCount": len(preflight["missingTargets"]),
            "preflightMissingTargetSamples": preflight["missingTargets"][:20],
            "preflightUnmappedCount": len(preflight["unmapped"]),
            "preflightUnmappedSamples": preflight["unmapped"][:20],
            "preflightSkippedNonFileCount": len(preflight["skippedNonFile"]),
            "preflightSkippedNonFileSamples": preflight["skippedNonFile"][:20],
            "relinked": relinked,
            "relinkFolderCount": len(preflight["byFolder"]),
            "relinkFailures": relink_failures,
            "saveProjectResult": save_result,
            **verify,
        },
    }


def relink_color_media(resolve, payload):
    project_name = stringify_signal_value(payload.get("resolveProjectName"))
    if not project_name:
        raise HostError("resolve_color_project_name_missing", "relink_color_media requires resolveProjectName.")
    root_namespace = stringify_signal_value(payload.get("rootNamespace"))
    if not root_namespace:
        raise HostError("resolve_color_root_namespace_missing", "relink_color_media requires rootNamespace.")
    grading_timeline_name = stringify_signal_value(payload.get("gradingTimelineName"))
    if not grading_timeline_name:
        raise HostError("resolve_color_grading_timeline_missing", "relink_color_media requires gradingTimelineName.")

    project, current_project_before = load_existing_color_project(resolve, project_name)
    media_pool = require_method(project, "GetMediaPool")()
    root_folder = require_method(media_pool, "GetRootFolder")()
    namespace_folder = find_root_media_pool_folder(root_folder, root_namespace)
    if namespace_folder is None:
        raise HostError(
            "resolve_color_media_namespace_missing",
            f"Resolve color root namespace not found: {root_namespace}",
            {
                "resolveProjectName": project_name,
                "rootNamespace": root_namespace,
            },
        )

    timeline = find_named_timeline(project, grading_timeline_name)
    if timeline is None:
        raise HostError(
            "resolve_color_grading_timeline_missing",
            f"Resolve color grading timeline not found: {grading_timeline_name}",
            {
                "resolveProjectName": project_name,
                "gradingTimelineName": grading_timeline_name,
                "timelines": list_timeline_names(project),
            },
        )
    safe_call(project, "SetCurrentTimeline", timeline)

    mappings = normalize_edit_relink_roots(payload.get("roots"))
    if not mappings:
        raise HostError("resolve_color_relink_roots_missing", "relink_color_media requires at least one readable root mapping.")

    items = collect_media_pool_items(namespace_folder)
    preflight = build_edit_relink_plan(items, mappings)
    relink_results = []
    relinked = 0
    for folder_path in sorted(preflight["byFolder"].keys()):
        clips = preflight["byFolder"][folder_path]
        ok = safe_call(media_pool, "RelinkClips", clips, folder_path)
        relink_results.append({"folder": folder_path, "count": len(clips), "ok": ok is not False and ok is not None})
        relinked += len(clips)

    if relinked > 0:
        time.sleep(1.0)
    verify = summarize_edit_relink_state(
        namespace_folder,
        timeline,
        mappings,
        ["video"],
        count_timeline_unmapped=True,
    )
    relink_failures = [entry for entry in relink_results if not entry["ok"]]
    if relink_failures:
        raise HostError(
            "resolve_color_relink_verify_failed",
            "Resolve color media relink did not pass verification.",
            {
                "relinkFailures": relink_failures,
                **verify,
            },
        )

    save_result = save_project_with_result(project, resolve) if relinked > 0 else None
    if relinked > 0 and not save_result:
        raise HostError(
            "resolve_color_relink_save_failed",
            "Resolve color media relink succeeded but SaveProject failed.",
            verify,
        )

    return {
        "resolveProjectName": project_name,
        "rootNamespace": root_namespace,
        "gradingTimelineName": grading_timeline_name,
        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "hostSummary": {
            "currentProjectBefore": current_project_before,
            "loadedProject": safe_call(project, "GetName"),
            "rootNamespace": root_namespace,
            "gradingTimelineName": safe_call(timeline, "GetName"),
            "rootReadable": {mapping["rootId"]: Path(mapping["localPath"]).is_dir() for mapping in mappings},
            "rootCount": len(mappings),
            "alreadyLocalBefore": preflight["alreadyLocal"],
            "preflightMissingTargetCount": len(preflight["missingTargets"]),
            "preflightMissingTargetSamples": preflight["missingTargets"][:20],
            "preflightUnmappedCount": len(preflight["unmapped"]),
            "preflightUnmappedSamples": preflight["unmapped"][:20],
            "preflightSkippedNonFileCount": len(preflight["skippedNonFile"]),
            "preflightSkippedNonFileSamples": preflight["skippedNonFile"][:20],
            "relinked": relinked,
            "relinkFolderCount": len(preflight["byFolder"]),
            "relinkFailures": relink_failures,
            "saveProjectResult": save_result,
            **verify,
        },
    }


def export_edit_timeline_clip_packet(resolve, payload):
    project_name = stringify_signal_value(payload.get("resolveProjectName"))
    if not project_name:
        raise HostError(
            "resolve_edit_project_name_missing",
            "export_edit_timeline_clip_packet requires resolveProjectName.",
        )
    project, current_project_before = load_existing_project(resolve, project_name)
    timeline_name = stringify_signal_value(payload.get("timelineName"))
    timeline = find_named_timeline(project, timeline_name) if timeline_name else safe_call(project, "GetCurrentTimeline")
    if timeline_name and timeline is None:
        raise HostError(
            "resolve_edit_timeline_missing",
            f"Resolve edit timeline not found: {timeline_name}",
            {
                "resolveProjectName": project_name,
                "timelineName": timeline_name,
                "timelines": list_timeline_names(project),
            },
        )
    if timeline is None:
        raise HostError(
            "resolve_edit_timeline_missing",
            "Resolve edit timeline is not available.",
            {"resolveProjectName": project_name, "timelines": list_timeline_names(project)},
        )
    safe_call(project, "SetCurrentTimeline", timeline)
    safe_call(resolve, "OpenPage", "edit")

    fps = resolve_timeline_fps(project, timeline)
    video_items = collect_timeline_track_item_summaries(timeline, "video", fps)
    subtitle_items = collect_timeline_track_item_summaries(timeline, "subtitle", fps)
    audio_items = collect_timeline_track_item_summaries(timeline, "audio", fps, include_details=False)

    return {
        "schemaVersion": "kairos-resolve-edit-timeline-export-v1",
        "resolveProjectName": project_name,
        "currentProjectBefore": current_project_before,
        "timelineName": safe_call(timeline, "GetName"),
        "exportedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "fps": fps,
        "trackCounts": {
            "video": int(safe_call(timeline, "GetTrackCount", "video") or 0),
            "audio": int(safe_call(timeline, "GetTrackCount", "audio") or 0),
            "subtitle": int(safe_call(timeline, "GetTrackCount", "subtitle") or 0),
        },
        "videoItems": video_items,
        "subtitleItems": subtitle_items,
        "audioItemCount": len(audio_items),
        "hostSummary": {
            "videoItemCount": len(video_items),
            "subtitleItemCount": len(subtitle_items),
            "audioItemCount": len(audio_items),
        },
    }


def build_rough_cut_append_clip_info(media_pool_item, clip, timeline_fps, record_frame_override=None):
    clip_info = {
        "mediaPoolItem": media_pool_item,
        "recordFrame": int(record_frame_override)
        if record_frame_override is not None
        else ms_to_frame(clip["timelineInMs"], timeline_fps),
        "trackIndex": 1,
    }
    if clip["assetKind"] == "photo":
        clip_info["mediaType"] = 1
    elif clip.get("sourceInMs") is not None and clip.get("sourceOutMs") is not None:
        start_frame, end_frame = resolve_source_frame_range(media_pool_item, clip, timeline_fps)
        clip_info["startFrame"] = start_frame
        clip_info["endFrame"] = end_frame
    return clip_info


def import_rough_cut_subtitles(media_pool, timeline, payload):
    subtitle_srt_path = stringify_signal_value(payload.get("subtitleSrtPath"))
    if not subtitle_srt_path:
        return {"enabled": False}
    if not os.path.isfile(subtitle_srt_path):
        raise HostError(
            "resolve_subtitle_srt_missing",
            "create_rough_cut_timeline subtitleSrtPath does not point to a readable SRT file.",
            {"subtitleSrtPath": subtitle_srt_path},
        )
    subtitle_import_path = prepare_subtitle_import_path(subtitle_srt_path)
    track_count = parse_int(safe_call(timeline, "GetTrackCount", "subtitle")) or 0
    if track_count < 1 and not safe_call(timeline, "AddTrack", "subtitle"):
        raise HostError(
            "resolve_subtitle_track_create_failed",
            "Unable to create a subtitle track before importing rough-cut subtitles.",
            {"subtitleSrtPath": subtitle_srt_path},
        )
    track_name = stringify_signal_value(payload.get("subtitleTrackName"))
    if track_name:
        safe_call(timeline, "SetTrackName", "subtitle", 1, track_name)
    media_items = list(iter_values(safe_call(media_pool, "ImportMedia", [subtitle_import_path]) or []))
    if not media_items:
        raise HostError(
            "resolve_subtitle_srt_import_failed",
            "Resolve did not import the rough-cut subtitle SRT as a media item.",
            {"subtitleSrtPath": subtitle_srt_path, "subtitleImportPath": subtitle_import_path},
        )
    appended_items = list(iter_values(safe_call(media_pool, "AppendToTimeline", [{
        "mediaPoolItem": media_items[0],
        "trackIndex": 1,
        "recordFrame": 0,
    }]) or []))
    if not appended_items:
        raise HostError(
            "resolve_subtitle_append_failed",
            "Resolve did not append the rough-cut subtitle SRT to the timeline.",
            {"subtitleSrtPath": subtitle_srt_path, "subtitleImportPath": subtitle_import_path},
        )
    subtitle_items = list(iter_values(safe_call(timeline, "GetItemListInTrack", "subtitle", 1) or []))
    if not subtitle_items:
        raise HostError(
            "resolve_subtitle_items_missing",
            "Resolve appended the rough-cut subtitle SRT but no subtitle items were found on track 1.",
            {"subtitleSrtPath": subtitle_srt_path, "subtitleImportPath": subtitle_import_path},
        )
    return {
        "enabled": True,
        "subtitleSrtPath": subtitle_srt_path,
        "subtitleImportPath": subtitle_import_path,
        "trackIndex": 1,
        "trackName": safe_call(timeline, "GetTrackName", "subtitle", 1),
        "importedMediaItemCount": len(media_items),
        "appendReturnedItemCount": len(appended_items),
        "subtitleItemCount": len(subtitle_items),
        "firstStartFrame": parse_int(safe_call(subtitle_items[0], "GetStart")),
        "lastEndFrame": parse_int(safe_call(subtitle_items[-1], "GetEnd")),
    }


def prepare_subtitle_import_path(subtitle_srt_path):
    source = Path(subtitle_srt_path)
    try:
        data = source.read_bytes()
        digest = hashlib.sha1(data).hexdigest()[:12]
        import_dir = Path(tempfile.gettempdir()) / "kairos-resolve-subtitle-imports"
        import_dir.mkdir(parents=True, exist_ok=True)
        suffix = source.suffix or ".srt"
        target = import_dir / f"{source.stem}-{digest}-{uuid.uuid4().hex[:8]}{suffix}"
        target.write_bytes(data)
        return str(target)
    except Exception as exc:
        raise HostError(
            "resolve_subtitle_import_copy_failed",
            "Unable to prepare a unique subtitle import copy for Resolve.",
            {"subtitleSrtPath": subtitle_srt_path, "error": str(exc)},
        )


def validate_rough_cut_timeline_placement(
    clip,
    clip_info,
    timeline_start_frame,
    actual_start_frame,
    actual_end_frame,
    summary,
):
    expected_start_frame = parse_int(clip_info.get("recordFrame"))
    if expected_start_frame is None:
        raise HostError(
            "resolve_timeline_record_frame_missing",
            f"Rough-cut append did not define recordFrame for clip {clip['clipId']}.",
            {"clipId": clip["clipId"]},
        )
    expected_absolute_start = expected_start_frame + int(timeline_start_frame or 0)
    summary["checked"] = int(summary.get("checked") or 0) + 1
    if (
        actual_start_frame is not None
        and actual_end_frame is not None
        and actual_end_frame > actual_start_frame
        and actual_start_frame == expected_absolute_start
    ):
        summary["passed"] = int(summary.get("passed") or 0) + 1
        return
    summary["failed"] = int(summary.get("failed") or 0) + 1
    raise HostError(
        "resolve_timeline_placement_mismatch",
        f"Resolve appended rough-cut clip {clip['clipId']} at an unexpected timeline frame.",
        {
            "clipId": clip["clipId"],
            "assetId": clip["assetId"],
            "recordFrame": expected_start_frame,
            "timelineStartFrame": timeline_start_frame,
            "expectedAbsoluteStartFrame": expected_absolute_start,
            "actualStartFrame": actual_start_frame,
            "actualEndFrame": actual_end_frame,
        },
    )


def validate_rough_cut_timeline_no_gaps(timeline):
    items = list(iter_timeline_video_items(timeline))
    items.sort(key=lambda item: parse_int(safe_call(item, "GetStart")) or 0)
    summary = {
        "checked": len(items),
        "gapCount": 0,
        "overlapCount": 0,
        "maxGapFrames": 0,
        "firstGaps": [],
        "passed": True,
    }
    previous_end = None
    for index, item in enumerate(items, start=1):
        start = parse_int(safe_call(item, "GetStart"))
        end = parse_int(safe_call(item, "GetEnd"))
        if start is None or end is None:
            continue
        if previous_end is not None:
            delta = start - previous_end
            if delta > 0:
                summary["gapCount"] += 1
                summary["maxGapFrames"] = max(summary["maxGapFrames"], delta)
                if len(summary["firstGaps"]) < 20:
                    summary["firstGaps"].append({
                        "index": index,
                        "name": safe_call(item, "GetName"),
                        "gapFrames": delta,
                        "startFrame": start,
                        "previousEndFrame": previous_end,
                    })
            elif delta < 0:
                summary["overlapCount"] += 1
        previous_end = end
    if summary["gapCount"] > 0:
        summary["passed"] = False
        raise HostError(
            "resolve_timeline_gap_detected",
            "Resolve rough-cut timeline contains empty video-frame gaps after append.",
            summary,
        )
    return summary


def resolve_appended_video_items(timeline, appended_items, clip_info, clip):
    linked_items = collect_linked_timeline_items(appended_items)
    video_items = filter_timeline_items_by_track_type(linked_items, "video")
    if video_items:
        return video_items
    record_frame = parse_float(clip_info.get("recordFrame"))
    timeline_start_frame = parse_float(safe_call(timeline, "GetStartFrame")) or 0
    expected_start = record_frame + timeline_start_frame if record_frame is not None else None
    source_path = normalize_filesystem_path(clip.get("sourceAbsolutePath"))
    candidates = []
    for item in iter_timeline_video_items(timeline):
        item_start = parse_float(safe_call(item, "GetStart"))
        if expected_start is not None and item_start is not None and abs(item_start - expected_start) > 1:
            continue
        item_path = normalize_filesystem_path(extract_timeline_item_file_path(item))
        if source_path and item_path and item_path != source_path:
            continue
        candidates.append(item)
    if candidates:
        return candidates
    if not source_path:
        return []
    path_only_candidates = []
    for item in iter_timeline_video_items(timeline):
        item_path = normalize_filesystem_path(extract_timeline_item_file_path(item))
        if item_path == source_path:
            path_only_candidates.append(item)
    path_only_candidates.sort(key=lambda item: parse_float(safe_call(item, "GetStart")) or -1, reverse=True)
    if path_only_candidates:
        return [path_only_candidates[0]]
    return candidates


def resolve_source_frame_range(media_pool_item, clip, timeline_fps):
    expected_start, expected_end, source_fps = resolve_expected_source_frame_range(media_pool_item, clip, timeline_fps)
    start_frame = expected_start
    end_frame = expected_end
    if end_frame <= start_frame:
        raise HostError(
            "resolve_rough_cut_source_range_invalid",
            f"Rough-cut source range resolved to no frames: {clip['clipId']}",
            {
                "clipId": clip["clipId"],
                "sourceInMs": clip.get("sourceInMs"),
                "sourceOutMs": clip.get("sourceOutMs"),
                "sourceFps": source_fps,
                "startFrame": start_frame,
                "endFrame": end_frame,
            },
        )
    return start_frame, end_frame


def resolve_expected_source_frame_range(media_pool_item, clip, timeline_fps):
    source_fps = parse_float(clip.get("fps")) or parse_float(safe_call(media_pool_item, "GetClipProperty", "FPS")) or timeline_fps
    start_frame = ms_to_frame(clip["sourceInMs"], source_fps)
    end_frame = max(start_frame + 1, ms_to_frame(clip["sourceOutMs"], source_fps))
    properties = safe_call(media_pool_item, "GetClipProperty") or {}
    if isinstance(properties, dict):
        media_start = parse_int(properties.get("Start"))
        media_end = parse_int(properties.get("End"))
        if media_start is not None:
            start_frame = max(start_frame, media_start)
        if media_end is not None:
            end_frame = min(end_frame, media_end)
    if end_frame <= start_frame:
        raise HostError(
            "resolve_rough_cut_source_range_invalid",
            f"Rough-cut source range resolved to no frames: {clip['clipId']}",
            {
                "clipId": clip["clipId"],
                "sourceInMs": clip.get("sourceInMs"),
                "sourceOutMs": clip.get("sourceOutMs"),
                "sourceFps": source_fps,
                "expectedStartFrame": start_frame,
                "expectedEndFrame": end_frame,
            },
        )
    return start_frame, end_frame, source_fps

def validate_rough_cut_source_range(item, media_pool_item, clip, summary, timeline_fps=None):
    expected_start, expected_end, source_fps = resolve_expected_source_frame_range(
        media_pool_item,
        clip,
        parse_float(timeline_fps) or parse_float(clip.get("fps")) or 30.0,
    )
    actual_start = parse_int(safe_call(item, "GetSourceStartFrame"))
    actual_end = parse_int(safe_call(item, "GetSourceEndFrame"))
    tolerance = resolve_source_range_validation_tolerance(source_fps, timeline_fps)
    summary["checked"] = int(summary.get("checked") or 0) + 1
    summary["maxToleranceFrames"] = max(int(summary.get("maxToleranceFrames") or 0), tolerance)
    if (
        actual_start is not None
        and actual_end is not None
        and abs(actual_start - expected_start) <= tolerance
        and abs(actual_end - expected_end) <= tolerance
    ):
        summary["passed"] = int(summary.get("passed") or 0) + 1
        return
    summary["failed"] = int(summary.get("failed") or 0) + 1
    raise HostError(
        "resolve_rough_cut_source_range_mismatch",
        f"Resolve appended the wrong source range for rough-cut clip {clip['clipId']}.",
        {
            "clipId": clip["clipId"],
            "assetId": clip["assetId"],
            "sourceAbsolutePath": clip["sourceAbsolutePath"],
            "sourceFps": source_fps,
            "expectedStartFrame": expected_start,
            "expectedEndFrame": expected_end,
            "actualStartFrame": actual_start,
            "actualEndFrame": actual_end,
            "sourceInMs": clip.get("sourceInMs"),
            "sourceOutMs": clip.get("sourceOutMs"),
            "timelineFps": timeline_fps,
            "toleranceFrames": tolerance,
        },
    )


def resolve_source_range_validation_tolerance(source_fps, timeline_fps):
    source = parse_float(source_fps)
    timeline = parse_float(timeline_fps)
    if source is not None and timeline is not None and source > 0 and timeline > 0:
        return max(2, int(math.ceil(source / timeline)))
    return 2


def validate_rough_cut_still_duration(item, clip, timeline_fps, still_duration_ms, summary):
    expected_ms = parse_float(still_duration_ms)
    if expected_ms is None or expected_ms <= 0:
        raise HostError(
            "resolve_still_duration_config_missing",
            "timeline.generate requires an effective photo still duration; default is 1000ms unless timelineStillDurationMs overrides it.",
            {"clipId": clip["clipId"], "assetId": clip["assetId"]},
        )
    expected_frames = ms_to_frame(expected_ms, timeline_fps)
    actual_frames = parse_int(safe_call(item, "GetDuration"))
    summary["checked"] = int(summary.get("checked") or 0) + 1
    summary["expectedMs"] = expected_ms
    if actual_frames is not None and abs(actual_frames - expected_frames) <= 1:
        summary["passed"] = int(summary.get("passed") or 0) + 1
        return
    summary["failed"] = int(summary.get("failed") or 0) + 1
    raise HostError(
        "resolve_still_duration_mismatch",
        f"Resolve still duration does not match the effective Kairos photo duration for rough-cut clip {clip['clipId']}.",
        {
            "clipId": clip["clipId"],
            "assetId": clip["assetId"],
            "expectedMs": expected_ms,
            "expectedFrames": expected_frames,
            "actualFrames": actual_frames,
            "timelineFps": timeline_fps,
        },
    )


def build_resolve_timeline_item_name(clip):
    event_title = stringify_signal_value(clip.get("eventTitle"))
    source = stringify_signal_value(clip.get("sourceStem")) or clip["clipId"]
    parts = [clip["clipId"]]
    if event_title:
        parts.append(event_title)
    parts.append(source)
    name = " ".join(part for part in parts if part)
    if len(name) <= 180:
        return name
    return name[:177].rstrip() + "..."


def save_drp_snapshot(resolve, payload):
    project = ensure_project(resolve, payload["resolveProjectName"])
    save_project(project, resolve)
    snapshot = export_project_snapshot(resolve, project, payload, "manual", "save_drp_snapshot")
    if not snapshot:
        raise HostError(
            "resolve_drp_snapshot_path_missing",
            "save_drp_snapshot requires snapshotRoot.",
        )
    return {
        "snapshot": snapshot,
        "hostSummary": {
            "drpSnapshots": [snapshot],
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


def load_existing_project(resolve, project_name):
    project_manager = require_method(resolve, "GetProjectManager")()
    current = safe_call(project_manager, "GetCurrentProject")
    current_name = safe_call(current, "GetName") if current else None
    if current and current_name == project_name:
        return current, current_name
    loaded = safe_call(project_manager, "LoadProject", project_name)
    if loaded and safe_call(loaded, "GetName") == project_name:
        return loaded, current_name
    current_after = safe_call(project_manager, "GetCurrentProject")
    if current_after and safe_call(current_after, "GetName") == project_name:
        return current_after, current_name
    raise HostError(
        "resolve_edit_project_unavailable",
        f"Unable to load existing Resolve edit project: {project_name}",
        {
            "currentProject": current_name,
            "targetProject": project_name,
        },
    )


def load_existing_color_project(resolve, project_name):
    project_manager = require_method(resolve, "GetProjectManager")()
    current = safe_call(project_manager, "GetCurrentProject")
    current_name = safe_call(current, "GetName") if current else None
    if current and current_name == project_name:
        return current, current_name
    loaded = safe_call(project_manager, "LoadProject", project_name)
    if loaded and safe_call(loaded, "GetName") == project_name:
        return loaded, current_name
    current_after = safe_call(project_manager, "GetCurrentProject")
    if current_after and safe_call(current_after, "GetName") == project_name:
        return current_after, current_name
    raise HostError(
        "resolve_color_project_unavailable",
        f"Unable to load existing Resolve color project: {project_name}",
        {
            "currentProject": current_name,
            "targetProject": project_name,
        },
    )


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


def ensure_namespace_folder_with_legacy(media_pool, namespace, legacy_names):
    root_folder = require_method(media_pool, "GetRootFolder")()
    target = find_root_media_pool_folder(root_folder, namespace)
    if target is None:
        target = ensure_namespace_folder(media_pool, namespace)
    if isinstance(legacy_names, list):
        for legacy_name in legacy_names:
            legacy_text = stringify_signal_value(legacy_name)
            if not legacy_text or legacy_text == namespace:
                continue
            legacy = find_root_media_pool_folder(root_folder, legacy_text)
            if legacy is None:
                continue
            merge_media_pool_folder_into(media_pool, legacy, target, legacy_text, namespace)
    return target


def merge_media_pool_folder_into(media_pool, source_folder, target_folder, source_name, target_name):
    clips = list(iter_values(safe_call(source_folder, "GetClipList") or []))
    if clips:
        moved_clips = safe_call(media_pool, "MoveClips", clips, target_folder)
        if moved_clips is False:
            raise HostError(
                "resolve_media_pool_namespace_move_failed",
                f"Unable to move clips from legacy media namespace: {source_name} -> {target_name}",
                {"legacyNamespace": source_name, "namespace": target_name, "clipCount": len(clips)},
            )
    subfolders = list(iter_values(safe_call(source_folder, "GetSubFolders") or safe_call(source_folder, "GetSubFolderList") or []))
    if subfolders:
        moved_folders = safe_call(media_pool, "MoveFolders", subfolders, target_folder)
        if moved_folders is False:
            raise HostError(
                "resolve_media_pool_namespace_move_failed",
                f"Unable to move folders from legacy media namespace: {source_name} -> {target_name}",
                {"legacyNamespace": source_name, "namespace": target_name, "folderCount": len(subfolders)},
            )
    deleted = safe_call(media_pool, "DeleteFolders", [source_folder])
    if deleted is False:
        raise HostError(
            "resolve_media_pool_namespace_delete_failed",
            f"Unable to delete empty legacy media namespace: {source_name}",
            {"legacyNamespace": source_name, "namespace": target_name},
        )


def find_root_media_pool_folder(root_folder, name):
    subfolders = safe_call(root_folder, "GetSubFolders") or safe_call(root_folder, "GetSubFolderList") or []
    for folder in iter_values(subfolders):
        if safe_call(folder, "GetName") == name:
            return folder
    return None


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


def rename_legacy_timeline_if_needed(project, timeline_name, legacy_timeline_names):
    if find_named_timeline(project, timeline_name) is not None:
        return
    if not isinstance(legacy_timeline_names, list):
        return
    for legacy_name in legacy_timeline_names:
        legacy_text = stringify_signal_value(legacy_name)
        if not legacy_text or legacy_text == timeline_name:
            continue
        legacy = find_named_timeline(project, legacy_text)
        if legacy is None:
            continue
        renamed = safe_call(legacy, "SetName", timeline_name)
        if renamed is False:
            raise HostError(
                "resolve_timeline_rename_failed",
                f"Unable to rename legacy rough-cut timeline: {legacy_text} -> {timeline_name}",
                {"legacyTimelineName": legacy_text, "timelineName": timeline_name},
            )
        safe_call(project, "SetCurrentTimeline", legacy)
        return


def move_timeline_media_pool_item(media_pool, timeline_name, target_folder, target_relative_dir):
    root_folder = require_method(media_pool, "GetRootFolder")()
    found = find_media_pool_item_location_by_name(root_folder, timeline_name, "Timeline", "")
    if found is None:
        return
    item, current_folder, current_relative_dir = found
    if current_relative_dir == target_relative_dir:
        return
    moved = safe_call(media_pool, "MoveClips", [item], target_folder)
    if moved is False:
        raise HostError(
            "resolve_timeline_move_failed",
            f"Unable to move rough-cut timeline into Media Pool folder: {target_relative_dir}",
            {
                "timelineName": timeline_name,
                "currentFolder": current_relative_dir or "<root>",
                "targetFolder": target_relative_dir,
            },
        )


def find_media_pool_item_location_by_name(folder, item_name, item_type=None, relative_dir=""):
    for clip in iter_values(safe_call(folder, "GetClipList") or []):
        name = safe_call(clip, "GetName")
        if name != item_name:
            continue
        if item_type:
            props = safe_call(clip, "GetClipProperty") or {}
            clip_type = props.get("Type") if isinstance(props, dict) else None
            if clip_type != item_type:
                continue
        return clip, folder, relative_dir
    subfolders = safe_call(folder, "GetSubFolders") or safe_call(folder, "GetSubFolderList") or []
    for child in iter_values(subfolders):
        child_name = safe_call(child, "GetName")
        if not isinstance(child_name, str) or not child_name.strip():
            continue
        child_relative_dir = normalize_portable_path(join_portable(relative_dir, child_name.strip()))
        found = find_media_pool_item_location_by_name(child, item_name, item_type, child_relative_dir)
        if found is not None:
            return found
    return None


def apply_project_timeline_spec_before_create(project, media_pool, timeline_name, spec):
    width = parse_int((spec or {}).get("width"))
    height = parse_int((spec or {}).get("height"))
    fps = parse_float((spec or {}).get("fps"))
    if not width or not height or not fps:
        return
    for key, value in (
        ("timelineResolutionWidth", width),
        ("timelineResolutionHeight", height),
        ("timelineOutputResolutionWidth", width),
        ("timelineOutputResolutionHeight", height),
    ):
        safe_call(project, "SetSetting", key, stringify_setting_value(value))
    if project_timeline_fps_matches(project, fps):
        safe_call(project, "SetSetting", "timelinePlaybackFrameRate", stringify_setting_value(fps))
        return
    if set_project_timeline_fps(project, fps):
        return

    existing = find_named_timeline(project, timeline_name)
    timeline_count = parse_int(safe_call(project, "GetTimelineCount")) or 0
    if existing is not None and timeline_count == 1:
        deleted = safe_call(media_pool, "DeleteTimelines", [existing])
        if deleted is False:
            raise HostError(
                "resolve_timeline_fps_locked",
                f"Resolve timeline frame rate is locked and Kairos could not recreate target timeline: {timeline_name}",
                {
                    "timelineName": timeline_name,
                    "currentFps": safe_call(project, "GetSetting", "timelineFrameRate"),
                    "expectedFps": fps,
                },
            )
        if set_project_timeline_fps(project, fps):
            return

    raise HostError(
        "resolve_timeline_fps_locked",
        "Resolve project timeline frame rate does not match Kairos runtime config.",
        {
            "timelineName": timeline_name,
            "currentFps": safe_call(project, "GetSetting", "timelineFrameRate"),
            "expectedFps": fps,
            "timelineCount": safe_call(project, "GetTimelineCount"),
            "timelines": list_timeline_names(project),
            "resolution": {"width": width, "height": height},
        },
    )


def project_timeline_fps_matches(project, fps):
    current = parse_float(safe_call(project, "GetSetting", "timelineFrameRate"))
    return current is not None and abs(current - fps) < 0.001


def set_project_timeline_fps(project, fps):
    value = stringify_setting_value(fps)
    safe_call(project, "SetSetting", "timelineFrameRate", value)
    safe_call(project, "SetSetting", "timelinePlaybackFrameRate", value)
    return project_timeline_fps_matches(project, fps)


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


def assert_timeline_matches_spec(project, timeline, spec):
    fps = parse_float((spec or {}).get("fps"))
    if not fps:
        return
    timeline_settings = safe_call(timeline, "GetSetting") if timeline is not None else None
    timeline_fps = None
    timeline_playback_fps = None
    if isinstance(timeline_settings, dict):
        timeline_fps = parse_float(timeline_settings.get("timelineFrameRate"))
        timeline_playback_fps = parse_float(timeline_settings.get("timelinePlaybackFrameRate"))
    if timeline_fps is None:
        timeline_fps = parse_float(safe_call(project, "GetSetting", "timelineFrameRate"))
    if timeline_playback_fps is None:
        timeline_playback_fps = parse_float(safe_call(project, "GetSetting", "timelinePlaybackFrameRate"))
    frame_rate_matches = timeline_fps is not None and abs(timeline_fps - fps) <= 0.001
    playback_matches = timeline_playback_fps is not None and abs(timeline_playback_fps - fps) <= 0.001
    if frame_rate_matches and playback_matches:
        return
    raise HostError(
        "resolve_timeline_fps_mismatch",
        "Resolve rough-cut timeline frame rate or playback frame rate does not match Kairos runtime config.",
        {
            "expectedFps": fps,
            "actualFps": timeline_fps,
            "actualPlaybackFps": timeline_playback_fps,
            "projectFps": safe_call(project, "GetSetting", "timelineFrameRate"),
            "projectPlaybackFps": safe_call(project, "GetSetting", "timelinePlaybackFrameRate"),
            "timelineName": safe_call(timeline, "GetName") if timeline is not None else None,
        },
    )


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
    clip_relative_dir_by_source_path = {}

    def walk(folder, relative_dir):
        for clip in iter_values(safe_call(folder, "GetClipList") or []):
            file_path = normalize_filesystem_path(extract_media_pool_item_file_path(clip))
            if not file_path:
                continue
            clip_by_source_path[file_path] = clip
            clip_folder_by_source_path[file_path] = folder
            clip_relative_dir_by_source_path[file_path] = normalize_portable_path(relative_dir)
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
        "clipRelativeDirBySourcePath": clip_relative_dir_by_source_path,
    }


def collect_media_pool_items(folder):
    items = []
    for clip in iter_values(safe_call(folder, "GetClipList") or []):
        items.append(clip)
    subfolders = safe_call(folder, "GetSubFolders") or safe_call(folder, "GetSubFolderList") or []
    for child in iter_values(subfolders):
        items.extend(collect_media_pool_items(child))
    return items


def normalize_edit_relink_roots(value):
    roots = []
    for raw in iter_values(value or []):
        if not isinstance(raw, dict):
            continue
        root_id = stringify_signal_value(raw.get("rootId"))
        local_path = normalize_relink_path(raw.get("localPath"))
        if not root_id or not local_path:
            continue
        candidates = []
        for candidate in iter_values(raw.get("candidates") or []):
            normalized = normalize_relink_path(candidate)
            if normalized:
                candidates.append(normalized)
        candidates.insert(0, local_path)
        roots.append({
            "rootId": root_id,
            "label": stringify_signal_value(raw.get("label")),
            "localPath": local_path,
            "candidates": dedupe_strings(candidates),
        })
    return roots


def normalize_relink_timeline_track_types(value):
    allowed = {"video", "audio"}
    result = []
    for raw in iter_values(value or []):
        text = (stringify_signal_value(raw) or "").strip().lower()
        if text in allowed and text not in result:
            result.append(text)
    return result or ["video"]


def build_edit_relink_plan(items, mappings):
    by_folder = {}
    roots = {mapping["rootId"]: 0 for mapping in mappings}
    already_local = 0
    missing_targets = []
    unmapped = []
    skipped_non_file = []
    for item in items:
        source_path = extract_relink_clip_file_path(item)
        item_type = get_relink_item_type(item)
        if not source_path and is_edit_relink_non_file_type(item_type):
            skipped_non_file.append(build_edit_relink_item_sample(item, source_path, {"type": item_type}))
            continue
        root_id, target_path, state = map_edit_relink_target(source_path, mappings)
        if root_id:
            roots[root_id] = roots.get(root_id, 0) + 1
        if state == "local":
            already_local += 1
            if not edit_relink_target_exists(target_path):
                missing_targets.append(build_edit_relink_item_sample(item, source_path, {
                    "type": item_type,
                    "path": target_path,
                }))
        elif state == "old":
            if edit_relink_target_exists(target_path):
                folder_path = str(Path(target_path).parent)
                by_folder.setdefault(folder_path, []).append(item)
            else:
                missing_targets.append(build_edit_relink_item_sample(item, source_path, {
                    "type": item_type,
                    "oldPath": source_path,
                    "target": target_path,
                }))
        else:
            unmapped.append(build_edit_relink_item_sample(item, source_path, {"type": item_type}))
    return {
        "byFolder": by_folder,
        "roots": roots,
        "alreadyLocal": already_local,
        "missingTargets": missing_targets,
        "unmapped": unmapped,
        "skippedNonFile": skipped_non_file,
    }


def summarize_edit_relink_state(namespace_folder, timeline, mappings, timeline_track_types=None, count_timeline_unmapped=True):
    items = collect_media_pool_items(namespace_folder)
    roots = {mapping["rootId"]: 0 for mapping in mappings}
    old_remaining = 0
    local_readable = 0
    local_unreadable = 0
    missing_targets = []
    unmapped = []
    skipped_non_file = []
    for item in items:
        source_path = extract_relink_clip_file_path(item)
        item_type = get_relink_item_type(item)
        if not source_path and is_edit_relink_non_file_type(item_type):
            skipped_non_file.append(build_edit_relink_item_sample(item, source_path, {"type": item_type}))
            continue
        root_id, target_path, state = map_edit_relink_target(source_path, mappings)
        if root_id:
            roots[root_id] = roots.get(root_id, 0) + 1
        if state == "old":
            if edit_relink_target_exists(target_path):
                old_remaining += 1
            else:
                missing_targets.append(build_edit_relink_item_sample(item, source_path, {
                    "type": item_type,
                    "oldPath": source_path,
                    "target": target_path,
                }))
        elif state == "local":
            if edit_relink_target_exists(target_path):
                local_readable += 1
            else:
                local_unreadable += 1
        else:
            unmapped.append(build_edit_relink_item_sample(item, source_path, {"type": item_type}))

    timeline_track_types = timeline_track_types or ["video"]
    timeline_items = list(iter_timeline_relink_items(timeline, timeline_track_types)) if timeline is not None else []
    timeline_old = 0
    timeline_unreadable = 0
    timeline_missing_targets = []
    timeline_unmapped = 0
    timeline_skipped_non_file = 0
    for _track_type, item in timeline_items:
        source_path = extract_relink_clip_file_path(item)
        item_type = get_relink_item_type(item)
        if not source_path and is_edit_relink_non_file_type(item_type):
            timeline_skipped_non_file += 1
            continue
        _root_id, target_path, state = map_edit_relink_target(source_path, mappings)
        if state == "old":
            if edit_relink_target_exists(target_path):
                timeline_old += 1
            else:
                timeline_missing_targets.append(build_edit_relink_item_sample(item, source_path, {
                    "type": item_type,
                    "oldPath": source_path,
                    "target": target_path,
                }))
        elif state == "local":
            if not edit_relink_target_exists(target_path):
                timeline_unreadable += 1
        else:
            if count_timeline_unmapped:
                timeline_unmapped += 1

    return {
        "totalMediaItems": len(items),
        "roots": roots,
        "oldPathRemaining": old_remaining,
        "localReadable": local_readable,
        "localUnreadable": local_unreadable,
        "missingTargetCount": len(missing_targets),
        "missingTargetSamples": missing_targets[:20],
        "unmappedCount": len(unmapped),
        "unmappedSamples": unmapped[:20],
        "skippedNonFileCount": len(skipped_non_file),
        "skippedNonFileSamples": skipped_non_file[:20],
        "timelineTrackTypes": timeline_track_types,
        "timelineCountUnmapped": bool(count_timeline_unmapped),
        "timelineItemCount": len(timeline_items),
        "timelineVideoItemCount": sum(1 for track_type, _item in timeline_items if track_type == "video"),
        "timelineAudioItemCount": sum(1 for track_type, _item in timeline_items if track_type == "audio"),
        "timelineOldPathRemaining": timeline_old,
        "timelineUnreadable": timeline_unreadable,
        "timelineMissingTargetCount": len(timeline_missing_targets),
        "timelineMissingTargetSamples": timeline_missing_targets[:20],
        "timelineUnmappedCount": timeline_unmapped,
        "timelineSkippedNonFileCount": timeline_skipped_non_file,
    }


def map_edit_relink_target(source_path, mappings):
    normalized_path = normalize_relink_path(source_path)
    if not normalized_path:
        return None, None, "unmapped"
    for mapping in mappings:
        local_path = mapping["localPath"]
        if relink_path_has_root(normalized_path, local_path):
            return mapping["rootId"], normalized_path, "local"
        for candidate in mapping["candidates"]:
            if not candidate or candidate == local_path:
                continue
            if relink_path_has_root(normalized_path, candidate):
                relative = normalized_path[len(candidate):].lstrip("/")
                return mapping["rootId"], join_relink_target(local_path, relative), "old"
    return None, None, "unmapped"


def get_relink_item_type(item):
    clip_property = safe_call(item, "GetClipProperty")
    if isinstance(clip_property, dict):
        return stringify_signal_value(clip_property.get("Type"))
    return stringify_signal_value(safe_call(item, "GetClipProperty", "Type"))


def is_edit_relink_non_file_type(item_type):
    normalized = (stringify_signal_value(item_type) or "").strip().lower()
    return normalized in {
        "compound",
        "timeline",
        "multicam",
        "fusion composition",
        "",
    }


def build_edit_relink_item_sample(item, source_path, extra=None):
    sample = {
        "name": safe_call(item, "GetName"),
        "path": source_path,
    }
    if isinstance(extra, dict):
        for key, value in extra.items():
            if value is not None:
                sample[key] = value
    return sample


def extract_relink_clip_file_path(item):
    candidates = []
    append_relink_clip_property_candidates(candidates, item)
    media_pool_item = safe_call(item, "GetMediaPoolItem")
    if media_pool_item:
        append_relink_clip_property_candidates(candidates, media_pool_item)
    for candidate in candidates:
        normalized = normalize_relink_path(candidate)
        if normalized:
            return normalized
    return None


def append_relink_clip_property_candidates(candidates, item):
    clip_property = safe_call(item, "GetClipProperty")
    if isinstance(clip_property, dict):
        candidates.extend([
            clip_property.get("File Path"),
            clip_property.get("FilePath"),
            clip_property.get("Path"),
            clip_property.get("Clip Path"),
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


def normalize_relink_path(value):
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip().replace("\\", "/")
    if re.match(r"^[A-Za-z]:/", text):
        return re.sub(r"/+", "/", text).rstrip("/")
    if text.startswith("/"):
        normalized = re.sub(r"/+", "/", text).rstrip("/")
        return normalized or "/"
    return text.rstrip("/")


def relink_path_has_root(path, root):
    path_key = relink_compare_key(path)
    root_key = relink_compare_key(root)
    return path_key == root_key or path_key.startswith(root_key.rstrip("/") + "/")


def relink_compare_key(value):
    text = normalize_relink_path(value) or ""
    return text.lower() if re.match(r"^[A-Za-z]:/", text) else text


def join_relink_target(local_path, relative_path):
    relative = normalize_portable_path(relative_path)
    if not relative:
        return local_path
    return str(Path(local_path).joinpath(*[segment for segment in relative.split("/") if segment]))


def edit_relink_target_exists(path):
    if not path:
        return False
    target = Path(path)
    if target.exists():
        return True
    match = re.match(r"^(.*)\[(\d+)-(\d+)\](\.[^./\\]+)$", path)
    if not match:
        return False
    prefix, start, end, suffix = match.groups()
    width = len(start)
    for frame in range(int(start), int(end) + 1):
        if not Path(f"{prefix}{frame:0{width}d}{suffix}").exists():
            return False
    return True


def clear_namespace_contents(media_pool, namespace_folder):
    clips = list(iter_values(safe_call(namespace_folder, "GetClipList") or []))
    if clips:
        deleted_clips = safe_call(media_pool, "DeleteClips", clips)
        if deleted_clips is False:
            raise HostError(
                "resolve_media_pool_namespace_clear_failed",
                f"Unable to clear clips from namespace folder: {safe_call(namespace_folder, 'GetName')}",
            )
    subfolders = list(iter_values(safe_call(namespace_folder, "GetSubFolders") or safe_call(namespace_folder, "GetSubFolderList") or []))
    if subfolders:
        deleted_folders = safe_call(media_pool, "DeleteFolders", subfolders)
        if deleted_folders is False:
            raise HostError(
                "resolve_media_pool_namespace_clear_failed",
                f"Unable to clear subfolders from namespace folder: {safe_call(namespace_folder, 'GetName')}",
            )


def sync_namespace_clips(
    media_pool,
    media_storage,
    namespace_folder,
    namespace_state,
    clip_requests,
    dedupe_by_source_path=True,
    fallback_state=None,
    cleanup_empty_folders=False,
):
    imported = 0
    moved = 0
    reused = 0
    prepared_entries = []
    folder_by_relative_dir = namespace_state["folderByRelativeDir"]
    clip_by_source_path = namespace_state["clipBySourcePath"]
    clip_folder_by_source_path = namespace_state["clipFolderBySourcePath"]
    clip_relative_dir_by_source_path = namespace_state.get("clipRelativeDirBySourcePath", {})
    fallback_clip_by_source_path = (fallback_state or {}).get("clipBySourcePath", {}) if fallback_state else {}
    fallback_clip_folder_by_source_path = (fallback_state or {}).get("clipFolderBySourcePath", {}) if fallback_state else {}
    fallback_clip_relative_dir_by_source_path = (fallback_state or {}).get("clipRelativeDirBySourcePath", {}) if fallback_state else {}

    for clip_request in clip_requests:
        relative_dir = portable_parent_dir(clip_request["rawRelativePath"])
        target_folder = ensure_folder_chain(media_pool, namespace_folder, folder_by_relative_dir, relative_dir)
        source_path = clip_request["sourceAbsolutePath"]
        media_pool_item = clip_by_source_path.get(source_path) if dedupe_by_source_path else None
        current_folder = clip_folder_by_source_path.get(source_path)
        current_relative_dir = clip_relative_dir_by_source_path.get(source_path)
        if media_pool_item is None and dedupe_by_source_path:
            media_pool_item = fallback_clip_by_source_path.get(source_path)
            current_folder = fallback_clip_folder_by_source_path.get(source_path)
            current_relative_dir = fallback_clip_relative_dir_by_source_path.get(source_path)
        if media_pool_item is None:
            media_pool_item = import_media_pool_item(media_storage, media_pool, target_folder, source_path)
            imported += 1
        else:
            if normalize_portable_path(current_relative_dir) != normalize_portable_path(relative_dir):
                result = safe_call(media_pool, "MoveClips", [media_pool_item], target_folder)
                if result is False:
                    raise HostError(
                        "resolve_media_pool_move_failed",
                        f"Unable to move clip into root namespace mirror: {clip_request['rawRelativePath']}",
                    )
                moved += 1
            elif current_folder is not None and current_folder is not target_folder:
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
        clip_relative_dir_by_source_path[source_path] = normalize_portable_path(relative_dir)
        creative = build_clip_creative_summary(clip_request)
        prepared_entries.append({
            **clip_request,
            "mediaPoolItem": media_pool_item,
            "creativeTags": creative["creativeTags"],
            "groupNameSeed": creative["displayName"],
        })

    empty_folders_deleted = prune_empty_namespace_folders(media_pool, namespace_folder) if cleanup_empty_folders else 0
    return prepared_entries, {
        "imported": imported,
        "moved": moved,
        "reused": reused,
        "emptyFoldersDeleted": empty_folders_deleted,
    }


def prune_empty_namespace_folders(media_pool, namespace_folder):
    deleted = 0

    def prune_children(parent_folder, parent_relative_dir):
        total = 0
        subfolders = list(iter_values(safe_call(parent_folder, "GetSubFolders") or safe_call(parent_folder, "GetSubFolderList") or []))
        for child in subfolders:
            child_name = safe_call(child, "GetName")
            child_relative_dir = normalize_portable_path(join_portable(parent_relative_dir, child_name or "unnamed"))
            total += prune_folder(child, child_relative_dir)
        return total

    def prune_folder(folder, relative_dir):
        total = prune_children(folder, relative_dir)
        clips = list(iter_values(safe_call(folder, "GetClipList") or []))
        subfolders = list(iter_values(safe_call(folder, "GetSubFolders") or safe_call(folder, "GetSubFolderList") or []))
        if clips or subfolders:
            return total
        deleted_folders = safe_call(media_pool, "DeleteFolders", [folder])
        if deleted_folders is False:
            raise HostError(
                "resolve_media_pool_empty_folder_prune_failed",
                f"Unable to delete empty media pool event folder: {relative_dir}",
                {"relativeDir": relative_dir},
            )
        return total + 1

    deleted += prune_children(namespace_folder, "")
    return deleted


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
    imported = safe_call(media_pool, "ImportMedia", [source_path])
    if not imported:
        imported = safe_call(media_storage, "AddItemListToMediaPool", [source_path])
    for candidate in iter_values(imported or []):
        file_path = normalize_filesystem_path(extract_media_pool_item_file_path(candidate))
        if file_path == source_path:
            return candidate
    returned = []
    for candidate in iter_values(imported or []):
        props = safe_call(candidate, "GetClipProperty") or {}
        returned.append({
            "name": safe_call(candidate, "GetName"),
            "filePath": normalize_filesystem_path(extract_media_pool_item_file_path(candidate)),
            "type": props.get("Type") if isinstance(props, dict) else None,
            "frames": props.get("Frames") if isinstance(props, dict) else None,
        })
    raise HostError(
        "resolve_media_pool_import_failed",
        f"Unable to import clip into Resolve: {source_path}",
        {"returnedItems": returned},
    )


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


def apply_clip_timeline_transforms(timeline_item_by_clip_key, clip_requests):
    applied = 0
    portrait = 0
    skipped = 0
    for clip_request in clip_requests:
        if stringify_signal_value(clip_request.get("orientationStatus")) == "portrait":
            portrait += 1
        transform = clip_request.get("timelineTransform")
        if not isinstance(transform, dict):
            continue
        item = timeline_item_by_clip_key.get(clip_request["rawRelativePath"])
        if item is None:
            skipped += 1
            continue
        apply_timeline_item_transform(item, transform, clip_request["rawRelativePath"])
        applied += 1
    return {
        "portraitClipCount": portrait,
        "timelineTransformClipCount": applied,
        "timelineTransformSkippedClipCount": skipped,
    }


def apply_timeline_item_transform(item, transform, clip_key):
    property_map = {
        "RotationAngle": transform.get("rotationAngle"),
        "ZoomGang": transform.get("zoomGang"),
        "ZoomX": transform.get("zoomX"),
        "ZoomY": transform.get("zoomY"),
        "Pan": transform.get("pan"),
        "Tilt": transform.get("tilt"),
    }
    for property_name, value in property_map.items():
        if value is None:
            continue
        result = safe_call(item, "SetProperty", property_name, value)
        if result is False:
            raise HostError(
                "resolve_timeline_transform_failed",
                f"Unable to set {property_name} for portrait clip: {clip_key}",
                {"clipKey": clip_key, "property": property_name, "value": value},
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


def get_repair_template_assets(payload):
    config_root = Path(__file__).resolve().parents[2] / "config"
    supplied_templates = payload.get("repairTemplates") if isinstance(payload.get("repairTemplates"), dict) else {}
    explicit_default_drt = stringify_signal_value(payload.get("repairDrtPath"))
    candidates = {
        "default": stringify_signal_value(supplied_templates.get("default"))
        or explicit_default_drt
        or str(config_root / "default.drt"),
        "portrait-90": stringify_signal_value(supplied_templates.get("portrait-90"))
        or str(config_root / "gyroflow-portrait-90.drt"),
        "portrait--90": stringify_signal_value(supplied_templates.get("portrait--90"))
        or str(config_root / "gyroflow-portrait--90.drt"),
    }
    return {
        key: build_repair_template_asset(key, path)
        for key, path in candidates.items()
    }


def build_repair_template_asset(template_key, path_value):
    drt_candidate = Path(path_value).expanduser()
    if drt_candidate.is_file():
        return {
            "key": template_key,
            "kind": "default-drt" if template_key == "default" else "orientation-drt",
            "status": "default-drt" if template_key == "default" else f"{template_key}-drt",
            "path": drt_candidate,
            "drtPath": str(drt_candidate),
            "hash": hash_file(drt_candidate),
        }

    if template_key == "default":
        return {
            "key": template_key,
            "kind": "missing-drt",
            "status": "skipped-missing-drt",
            "path": None,
            "drtPath": str(drt_candidate),
            "skippedReason": "Missing config/default.drt; skipped automatic clip repair seed.",
        }
    return {
        "key": template_key,
        "kind": "missing-orientation-drt",
        "status": "skipped-missing-orientation-drt",
        "path": None,
        "drtPath": str(drt_candidate),
        "skippedReason": f"Missing {drt_candidate.name}; skipped automatic portrait Gyro seed.",
        "disableGyro": True,
    }


def hash_file(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


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


def import_repair_template_timelines(media_pool, repair_templates, clip_requests):
    timelines = {}
    for template_key in sorted({resolve_clip_repair_template_key(clip) for clip in clip_requests}):
        template = repair_templates.get(template_key) or repair_templates.get("default")
        if not template or template.get("path") is None:
            continue
        timelines[template_key] = import_repair_template_timeline(media_pool, template["path"])
    return timelines


def resolve_clip_repair_template_key(clip_request):
    key = stringify_signal_value(clip_request.get("repairTemplateKey"))
    return key or "default"


def get_clip_repair_template(repair_templates, clip_request):
    key = resolve_clip_repair_template_key(clip_request)
    return repair_templates.get(key) or repair_templates.get("default") or {}


def apply_template_effective_clip_request(clip_request, repair_template):
    if not repair_template.get("disableGyro"):
        return clip_request
    return {
        **clip_request,
        "gyroEligible": False,
    }


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


def list_available_repair_donor_kinds(repair_template_kind):
    return [repair_template_kind] if repair_template_kind in ("default-drt", "orientation-drt") else []


def summarize_repair_template_state(repair_templates, repair_seed_by_clip):
    seed_states = list((repair_seed_by_clip or {}).values())
    statuses = dedupe_strings([
        stringify_signal_value(state.get("repairTemplateStatus"))
        for state in seed_states
    ])
    skipped_reasons = dedupe_strings([
        stringify_signal_value(state.get("repairSeedSkippedReason"))
        for state in seed_states
    ])
    template_paths = {
        key: stringify_signal_value(template.get("drtPath"))
        for key, template in (repair_templates or {}).items()
        if stringify_signal_value(template.get("drtPath"))
    }
    summary = {
        "repairTemplateStatus": statuses[0] if len(statuses) == 1 else ("mixed" if statuses else "unknown"),
        "repairTemplateStatuses": statuses,
        "repairTemplatePaths": template_paths,
        "repairSeededClipCount": sum(1 for state in seed_states if state.get("seededRepairDonorKind")),
        "repairPreservedClipCount": sum(1 for state in seed_states if state.get("copiedExistingGrade")),
        "repairResetClipCount": sum(1 for state in seed_states if state.get("resetExistingGradeBeforeTemplate")),
        "repairSeedSkippedClipCount": sum(1 for state in seed_states if state.get("repairSeedSkippedReason")),
        "repairOrientationTemplateMissingClipCount": sum(
            1 for state in seed_states
            if state.get("repairTemplateStatus") == "skipped-missing-orientation-drt"
        ),
        "portraitClipCount": sum(1 for state in seed_states if state.get("orientationStatus") == "portrait"),
        "timelineTransformClipCount": sum(1 for state in seed_states if state.get("timelineTransform")),
    }
    if skipped_reasons:
        summary["repairSeedSkippedReason"] = "；".join(skipped_reasons)
    return summary


def seed_clip_repairs(
    timeline,
    raw_local_path,
    clip_requests,
    donor_timeline=None,
    repair_templates=None,
    repair_template_timelines=None,
):
    target_items_by_clip = build_timeline_item_map(timeline, raw_local_path)
    donor_items_by_clip = build_timeline_item_map(donor_timeline, raw_local_path) if donor_timeline else {}
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
        reset_existing_grade_before_template = False
        seeded_repair_donor_kind = None
        forced_enabled_node_indices = []
        forced_disabled_node_indices = []
        repair_template_key = resolve_clip_repair_template_key(clip_request)
        repair_template = get_clip_repair_template(repair_templates or {}, clip_request)
        effective_clip_request = apply_template_effective_clip_request(clip_request, repair_template)
        repair_template_kind = stringify_signal_value(repair_template.get("kind"))
        repair_template_status = stringify_signal_value(repair_template.get("status")) or repair_template_kind
        repair_template_hash = stringify_signal_value(repair_template.get("hash"))
        repair_seed_skipped_reason = stringify_signal_value(repair_template.get("skippedReason"))
        available_repair_donor_kinds = list_available_repair_donor_kinds(repair_template_kind)
        repair_template_path = repair_template.get("path")
        repair_template_timeline = (repair_template_timelines or {}).get(repair_template_key)
        repair_template_source_item = find_first_timeline_video_item(repair_template_timeline) if repair_template_timeline else None
        donor_item = donor_items_by_clip.get(clip_key)
        force_template_reseed = should_force_repair_template_reseed(
            clip_request,
            repair_template,
            repair_template_source_item,
        )
        if (
            donor_item is not None
            and donor_item is not target_item
            and clip_like_has_grade_content(donor_item)
            and clip_like_has_canonical_repair_layout(donor_item)
            and not force_template_reseed
        ):
            result = safe_call(donor_item, "CopyGrades", [target_item])
            if result is False:
                raise HostError(
                    "resolve_clip_repair_copy_failed",
                    f"Unable to preserve existing clip repair grade for: {clip_key}",
            )
            copied_existing_grade = True
            node_default_state = apply_reserved_node_defaults(target_item, effective_clip_request, reset_tail_reserved_nodes=False)
            forced_enabled_node_indices = node_default_state["enabled"]
            forced_disabled_node_indices = node_default_state["disabled"]
        elif repair_template_source_item is not None:
            rebuilt_legacy_grade = donor_item is not None and clip_like_has_grade_content(donor_item)
            if force_template_reseed:
                reset_clip_repair_grade(target_item, clip_key)
                reset_existing_grade_before_template = True
            result = safe_call(repair_template_source_item, "CopyGrades", [target_item])
            if result is False:
                raise HostError(
                    "resolve_clip_repair_seed_failed",
                    f"Unable to seed clip repair template grade for: {clip_key}",
                    {"repairTemplateKind": repair_template_kind, "repairTemplateKey": repair_template_key},
                )
            seeded_repair_donor_kind = repair_template_kind or "default-drt"
            node_default_state = apply_reserved_node_defaults(target_item, effective_clip_request, reset_tail_reserved_nodes=True)
            forced_enabled_node_indices = node_default_state["enabled"]
            forced_disabled_node_indices = node_default_state["disabled"]
            if not clip_like_has_canonical_repair_layout(target_item):
                invalid_repair_layouts.append({
                    "clipKey": clip_key,
                    "snapshot": build_clip_repair_snapshot(target_item, clip_request, {
                        "copiedExistingGrade": False,
                        "resetExistingGradeBeforeTemplate": reset_existing_grade_before_template,
                        "rebuiltLegacyGrade": rebuilt_legacy_grade,
                        "requestedRepairKinds": list_requested_repair_kinds(clip_request),
                        "seededRepairDonorKind": seeded_repair_donor_kind,
                        "availableRepairDonorKinds": available_repair_donor_kinds,
                        "forcedEnabledNodeIndices": forced_enabled_node_indices,
                        "forcedDisabledNodeIndices": forced_disabled_node_indices,
                        "repairTemplateKey": repair_template_key,
                        "repairTemplateStatus": repair_template_status,
                    }),
                })
        elif repair_template_path is not None and repair_template_kind == "default-drx":
            rebuilt_legacy_grade = donor_item is not None and clip_like_has_grade_content(donor_item)
            apply_repair_drx(target_item, repair_template_path, clip_key)
            seeded_repair_donor_kind = repair_template_kind or "default-drx"
            node_default_state = apply_reserved_node_defaults(target_item, effective_clip_request, reset_tail_reserved_nodes=True)
            forced_enabled_node_indices = node_default_state["enabled"]
            forced_disabled_node_indices = node_default_state["disabled"]
            if not clip_like_has_canonical_repair_layout(target_item):
                invalid_repair_layouts.append({
                    "clipKey": clip_key,
                    "snapshot": build_clip_repair_snapshot(target_item, clip_request, {
                        "copiedExistingGrade": False,
                        "resetExistingGradeBeforeTemplate": reset_existing_grade_before_template,
                        "rebuiltLegacyGrade": rebuilt_legacy_grade,
                        "requestedRepairKinds": list_requested_repair_kinds(clip_request),
                        "seededRepairDonorKind": seeded_repair_donor_kind,
                        "availableRepairDonorKinds": available_repair_donor_kinds,
                        "forcedEnabledNodeIndices": forced_enabled_node_indices,
                        "forcedDisabledNodeIndices": forced_disabled_node_indices,
                        "repairTemplateKey": repair_template_key,
                        "repairTemplateStatus": repair_template_status,
                    }),
                })

        repair_seed_state = {
            "copiedExistingGrade": copied_existing_grade,
            "resetExistingGradeBeforeTemplate": reset_existing_grade_before_template,
            "rebuiltLegacyGrade": rebuilt_legacy_grade,
            "requestedRepairKinds": list_requested_repair_kinds(clip_request),
            "seededRepairDonorKind": seeded_repair_donor_kind,
            "availableRepairDonorKinds": available_repair_donor_kinds,
            "forcedEnabledNodeIndices": forced_enabled_node_indices,
            "forcedDisabledNodeIndices": forced_disabled_node_indices,
            "repairTemplateKey": repair_template_key,
            "repairTemplateStatus": repair_template_status,
            "repairTemplateHash": repair_template_hash,
            "previousRepairTemplateHash": stringify_signal_value(clip_request.get("previousRepairTemplateHash")),
            "forcedRepairTemplateReseed": force_template_reseed,
            "orientationStatus": stringify_signal_value(clip_request.get("orientationStatus")),
            "timelineTransform": clip_request.get("timelineTransform") if isinstance(clip_request.get("timelineTransform"), dict) else None,
            "gyroDataAvailable": clip_request.get("gyroDataAvailable") is True or clip_request.get("gyroEligible") is True,
            "effectiveGyroEligible": effective_clip_request.get("gyroEligible") is True,
        }
        if (
            repair_seed_skipped_reason
            and not copied_existing_grade
            and not seeded_repair_donor_kind
        ):
            repair_seed_state["repairSeedSkippedReason"] = repair_seed_skipped_reason
        repair_seed_by_clip[clip_key] = repair_seed_state
    if invalid_repair_layouts:
        raise HostError(
            "resolve_repair_template_invalid_layout",
            "Applied clip repair template does not match the expected Gyro -> Dehaze -> User1 -> User2 -> NR contract.",
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


def should_force_repair_template_reseed(clip_request, repair_template, repair_template_source_item):
    if repair_template_source_item is None:
        return False
    template_key = resolve_clip_repair_template_key(clip_request)
    if template_key not in ("portrait-90", "portrait--90"):
        return False
    current_hash = stringify_signal_value(repair_template.get("hash"))
    if not current_hash:
        return False
    previous_hash = stringify_signal_value(clip_request.get("previousRepairTemplateHash"))
    return previous_hash != current_hash


def reset_clip_repair_grade(item, clip_key):
    graph = safe_call(item, "GetNodeGraph")
    method = getattr(graph, "ResetAllGrades", None)
    if method is None:
        raise HostError(
            "resolve_clip_repair_reset_unsupported",
            f"Resolve NodeGraph is missing ResetAllGrades; cannot reset stale portrait repair for: {clip_key}",
            {"clipKey": clip_key},
        )
    try:
        result = method()
    except Exception as error:
        raise HostError(
            "resolve_clip_repair_reset_failed",
            f"Unable to reset stale portrait repair grade for: {clip_key}",
            {"clipKey": clip_key, "error": str(error)},
        )
    if result is False:
        raise HostError(
            "resolve_clip_repair_reset_failed",
            f"Unable to reset stale portrait repair grade for: {clip_key}",
            {"clipKey": clip_key},
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
    gyro_eligible = (
        repair_seed_state.get("effectiveGyroEligible") is True
        if isinstance(repair_seed_state, dict) and "effectiveGyroEligible" in repair_seed_state
        else clip_request.get("gyroEligible") is True
    )
    gyro_data_available = (
        repair_seed_state.get("gyroDataAvailable") is True
        if isinstance(repair_seed_state, dict)
        else clip_request.get("gyroDataAvailable") is True or clip_request.get("gyroEligible") is True
    )
    lowlight_requested = clip_request.get("lowlight") is True
    windshield_haze_requested = clip_request.get("windshieldHaze") is True
    orientation_status = stringify_signal_value(clip_request.get("orientationStatus"))
    repair_template_key = stringify_signal_value(clip_request.get("repairTemplateKey"))
    repair_template_hash = stringify_signal_value((repair_seed_state or {}).get("repairTemplateHash")) if isinstance(repair_seed_state, dict) else stringify_signal_value(clip_request.get("previousRepairTemplateHash"))
    timeline_transform = clip_request.get("timelineTransform") if isinstance(clip_request.get("timelineTransform"), dict) else None
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
    if (
        isinstance(repair_seed_state, dict)
        and repair_seed_state.get("repairSeedSkippedReason")
        and not repair_seed_state.get("copiedExistingGrade")
        and not repair_seed_state.get("seededRepairDonorKind")
        and layout_status != "canonical"
    ):
        clip_repair_status = (
            "pending-orientation-template"
            if repair_seed_state.get("repairTemplateStatus") == "skipped-missing-orientation-drt"
            else "pending-template"
        )
    snapshot = {
        "clipKey": clip_request["rawRelativePath"],
        "displayName": clip_request.get("sourceStem") or Path(clip_request["rawRelativePath"]).stem,
        "logProfile": normalize_log_profile(clip_request.get("logProfile")) or "unknown",
        "lowlight": lowlight_requested,
        "windshieldHaze": windshield_haze_requested,
        "windshieldHazeConfidence": parse_float(clip_request.get("windshieldHazeConfidence")),
        "windshieldHazeMetrics": clip_request.get("windshieldHazeMetrics") if isinstance(clip_request.get("windshieldHazeMetrics"), dict) else {},
        "colorCastClass": normalize_color_cast_class(clip_request.get("colorCastClass")) or "unknown",
        "colorCastConfidence": parse_float(clip_request.get("colorCastConfidence")),
        "colorCastMetrics": clip_request.get("colorCastMetrics") if isinstance(clip_request.get("colorCastMetrics"), dict) else {},
        "exposureSceneClass": normalize_exposure_scene_class(clip_request.get("exposureSceneClass")) or "unknown",
        "exposureSceneConfidence": parse_float(clip_request.get("exposureSceneConfidence")),
        "exposureSceneMetrics": clip_request.get("exposureSceneMetrics") if isinstance(clip_request.get("exposureSceneMetrics"), dict) else {},
        "encodedWidth": parse_int(clip_request.get("encodedWidth") or clip_request.get("width")),
        "encodedHeight": parse_int(clip_request.get("encodedHeight") or clip_request.get("height")),
        "displayWidth": parse_int(clip_request.get("displayWidth") or clip_request.get("width")),
        "displayHeight": parse_int(clip_request.get("displayHeight") or clip_request.get("height")),
        "rotationDegrees": parse_float(clip_request.get("rotationDegrees")),
        "orientationStatus": orientation_status,
        "repairTemplateKey": repair_template_key,
        "repairTemplateHash": repair_template_hash,
        "timelineTransform": timeline_transform,
        "gyroDataAvailable": gyro_data_available,
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
                "resetExistingGradeBeforeTemplate": bool(repair_seed_state and repair_seed_state.get("resetExistingGradeBeforeTemplate")),
                "rebuiltLegacyGrade": bool(repair_seed_state and repair_seed_state.get("rebuiltLegacyGrade")),
            "requestedRepairKinds": list(repair_seed_state.get("requestedRepairKinds") or []) if isinstance(repair_seed_state, dict) else [],
            "seededRepairDonorKind": stringify_signal_value((repair_seed_state or {}).get("seededRepairDonorKind")) if isinstance(repair_seed_state, dict) else None,
            "availableRepairDonorKinds": list((repair_seed_state or {}).get("availableRepairDonorKinds") or []) if isinstance(repair_seed_state, dict) else [],
            "forcedEnabledNodeIndices": list((repair_seed_state or {}).get("forcedEnabledNodeIndices") or []) if isinstance(repair_seed_state, dict) else [],
            "forcedDisabledNodeIndices": list((repair_seed_state or {}).get("forcedDisabledNodeIndices") or []) if isinstance(repair_seed_state, dict) else [],
            "repairTemplateKey": stringify_signal_value((repair_seed_state or {}).get("repairTemplateKey")) if isinstance(repair_seed_state, dict) else repair_template_key,
            "repairTemplateStatus": stringify_signal_value((repair_seed_state or {}).get("repairTemplateStatus")) if isinstance(repair_seed_state, dict) else None,
            "repairTemplateHash": repair_template_hash,
            "previousRepairTemplateHash": stringify_signal_value((repair_seed_state or {}).get("previousRepairTemplateHash")) if isinstance(repair_seed_state, dict) else None,
            "forcedRepairTemplateReseed": bool(repair_seed_state and repair_seed_state.get("forcedRepairTemplateReseed")),
            "repairSeedSkippedReason": stringify_signal_value((repair_seed_state or {}).get("repairSeedSkippedReason")) if isinstance(repair_seed_state, dict) else None,
            "orientationStatus": orientation_status,
            "timelineTransform": timeline_transform,
        },
    }
    for optional_key in (
        "encodedWidth",
        "encodedHeight",
        "displayWidth",
        "displayHeight",
        "rotationDegrees",
        "orientationStatus",
        "repairTemplateKey",
        "repairTemplateHash",
        "timelineTransform",
        "windshieldHazeConfidence",
        "colorCastConfidence",
        "exposureSceneConfidence",
    ):
        if snapshot.get(optional_key) in (None, "", {}):
            snapshot.pop(optional_key, None)
    return snapshot


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


def summarize_group_windshield_haze(clip_snapshots):
    values = {
        "windshield-haze" if clip.get("windshieldHaze") is True else "base"
        for clip in clip_snapshots or []
        if clip.get("windshieldHaze") is not None
    }
    if len(values) == 1:
        return next(iter(values))
    if len(values) > 1:
        return "mixed"
    return None


def summarize_group_color_cast(clip_snapshots):
    values = set()
    for clip in clip_snapshots or []:
        normalized = normalize_color_cast_class(clip.get("colorCastClass"))
        if normalized in ("neutral", "unknown"):
            values.add(normalized)
        elif should_group_color_cast(normalized, clip.get("colorCastConfidence")):
            values.add(normalized)
    if not values:
        return "unknown"
    non_neutral_values = {
        value
        for value in values
        if value not in ("neutral", "unknown")
    }
    if len(non_neutral_values) == 1:
        dominant = next(iter(non_neutral_values))
        if values.issubset({dominant, "neutral", "unknown"}):
            return dominant
    if len(non_neutral_values) > 1:
        return "mixed"
    if len(values) == 1:
        return next(iter(values))
    return "unknown"


def summarize_group_orientation(clip_snapshots):
    values = {
        stringify_signal_value(clip.get("orientationStatus"))
        for clip in clip_snapshots or []
        if stringify_signal_value(clip.get("orientationStatus")) in ("unknown", "horizontal", "portrait")
    }
    if len(values) == 1:
        return next(iter(values))
    return "unknown"


def summarize_group_exposure_scene(clip_snapshots):
    values = set()
    for clip in clip_snapshots or []:
        normalized = normalize_exposure_scene_class(clip.get("exposureSceneClass"))
        if normalized in ("normal", "unknown"):
            values.add(normalized)
        elif should_group_exposure_scene(normalized, clip.get("exposureSceneConfidence")):
            values.add(normalized)
    if not values:
        return "unknown"
    grouped_values = {
        value
        for value in values
        if value in CEXPOSURE_SCENE_GROUP_CLASSES
    }
    if len(grouped_values) == 1:
        dominant = next(iter(grouped_values))
        if values.issubset({dominant, "normal", "unknown"}):
            return dominant
    if len(values) == 1:
        return next(iter(values))
    return "unknown"


def summarize_group_exposure_scene_addon_tag(clip_snapshots):
    values = set()
    for clip in clip_snapshots or []:
        addon_tag = resolve_exposure_scene_addon_tag(clip)
        if addon_tag:
            values.add(addon_tag)
    if len(values) == 1:
        return next(iter(values))
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


def collect_color_groups_by_name(project):
    groups_by_name = {}
    for group in iter_values(safe_call(project, "GetColorGroupsList") or []):
        group_name = safe_call(group, "GetName")
        if isinstance(group_name, str) and group_name.strip():
            groups_by_name[group_name.strip()] = group
    return groups_by_name


def assign_generated_groups(project, clip_entries, timeline_item_by_clip_key, previous_group_names_by_clip):
    existing_groups_by_name = collect_color_groups_by_name(project)

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
        orientation_status = summarize_group_orientation(entry["clipSnapshots"])
        lowlight = summarize_group_lowlight(entry["clipSnapshots"])
        windshield_haze = summarize_group_windshield_haze(entry["clipSnapshots"])
        color_cast = summarize_group_color_cast(entry["clipSnapshots"])
        exposure_scene = summarize_group_exposure_scene(entry["clipSnapshots"])
        exposure_scene_addon_tag = summarize_group_exposure_scene_addon_tag(entry["clipSnapshots"])
        post_clip_creative_status = inspect_group_post_clip_creative_status(entry.get("colorGroup"))
        summary = build_group_creative_summary(
            log_profile,
            orientation_status,
            lowlight,
            windshield_haze,
            color_cast,
            exposure_scene,
            exposure_scene_addon_tag,
        )
        transform_summary = {
            **build_group_transform_summary(entry["clipRequests"]),
            **((group_transform_summaries or {}).get(display_name) or {}),
        }
        groups.append({
            "groupKey": normalize_group_key(display_name),
            "displayName": display_name,
            "clipKeys": entry["clipKeys"],
            "logProfile": log_profile,
            "orientationStatus": orientation_status,
            "lowlight": lowlight,
            "windshieldHaze": windshield_haze,
            "colorCastClass": color_cast,
            "exposureSceneClass": exposure_scene,
            "postClipCreativeStatus": post_clip_creative_status,
            "clips": entry["clipSnapshots"],
            "hostSummary": {
                "timelineName": timeline_name,
                "groupName": display_name,
                "origin": origin,
                "creativeTags": summary["creativeTags"],
                "logProfile": log_profile,
                "orientationStatus": orientation_status,
                "lowlight": lowlight,
                "windshieldHaze": windshield_haze,
                "colorCastClass": color_cast,
                "exposureSceneClass": exposure_scene,
                "exposureSceneAddonTag": exposure_scene_addon_tag,
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
    log_profile = normalize_log_profile(clip_request.get("logProfile")) or "unknown"
    color_cast = normalize_color_cast_class(clip_request.get("colorCastClass"))
    exposure_scene_addon_tag = resolve_exposure_scene_addon_tag(clip_request)
    addon_tag = None
    if stringify_signal_value(clip_request.get("orientationStatus")) == "portrait":
        addon_tag = "portrait-review"
    elif clip_request.get("lowlight") is True:
        addon_tag = "lowlight"
    elif clip_request.get("windshieldHaze") is True:
        addon_tag = "windshield-haze"
    elif should_group_color_cast(color_cast, clip_request.get("colorCastConfidence")):
        addon_tag = color_cast
    elif exposure_scene_addon_tag:
        addon_tag = exposure_scene_addon_tag
    creative_tags = [log_profile]
    if addon_tag:
        creative_tags.append(addon_tag)
    return {
        "creativeTags": creative_tags,
        "displayName": " + ".join(creative_tags),
    }


def build_group_creative_summary(
    log_profile,
    orientation_status,
    lowlight,
    windshield_haze,
    color_cast=None,
    exposure_scene=None,
    exposure_scene_addon_tag=None,
):
    base_log = log_profile if log_profile and log_profile != "mixed" else "unknown"
    addon_tag = None
    if orientation_status == "portrait":
        addon_tag = "portrait-review"
    elif lowlight == "lowlight":
        addon_tag = "lowlight"
    elif windshield_haze == "windshield-haze":
        addon_tag = "windshield-haze"
    elif color_cast in CCOLOR_CAST_GROUP_CLASSES:
        addon_tag = color_cast
    elif exposure_scene_addon_tag in CEXPOSURE_SCENE_REASON_GROUP_TAGS:
        addon_tag = exposure_scene_addon_tag
    elif exposure_scene in CEXPOSURE_SCENE_GROUP_CLASSES:
        addon_tag = exposure_scene
    creative_tags = [base_log]
    if addon_tag:
        creative_tags.append(addon_tag)
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


def normalize_color_cast_class(value):
    normalized = stringify_signal_value(value)
    if not normalized:
        return None
    lowered = normalized.strip().lower()
    aliases = {
        "neutral": "neutral",
        "none": "neutral",
        "coolcyan": "cool-cyan",
        "cool-cyan": "cool-cyan",
        "cyan": "cool-cyan",
        "bluegreen": "green-cyan",
        "greencyan": "green-cyan",
        "green-cyan": "green-cyan",
        "green cyan": "green-cyan",
        "cyan-green": "green-cyan",
        "cyan green": "green-cyan",
        "green": "green",
        "warm": "warm",
        "mixed": "mixed",
        "unknown": "unknown",
    }
    compact = lowered.replace("_", "").replace(" ", "").replace("-", "")
    if lowered in aliases:
        return aliases[lowered]
    return aliases.get(compact)


def normalize_exposure_scene_class(value):
    normalized = stringify_signal_value(value)
    if not normalized:
        return None
    lowered = normalized.strip().lower()
    aliases = {
        "normal": "normal",
        "base": "normal",
        "highcontrast": "high-contrast",
        "high-contrast": "high-contrast",
        "high contrast": "high-contrast",
        "overexposed": "overexposed",
        "over-exposed": "overexposed",
        "over exposed": "overexposed",
        "underexposed": "underexposed",
        "under-exposed": "underexposed",
        "under exposed": "underexposed",
        "unknown": "unknown",
    }
    compact = lowered.replace("_", "").replace(" ", "").replace("-", "")
    if lowered in aliases:
        return aliases[lowered]
    return aliases.get(compact)


def should_group_color_cast(value, confidence=None):
    normalized = normalize_color_cast_class(value)
    if normalized not in CCOLOR_CAST_GROUP_CLASSES:
        return False
    parsed_confidence = parse_float(confidence)
    return parsed_confidence is not None and parsed_confidence >= 0.65


def should_group_exposure_scene(value, confidence=None):
    normalized = normalize_exposure_scene_class(value)
    if normalized not in CEXPOSURE_SCENE_GROUP_CLASSES:
        return False
    parsed_confidence = parse_float(confidence)
    return parsed_confidence is not None and parsed_confidence >= 0.65


def resolve_exposure_scene_addon_tag(clip_request):
    exposure_scene = normalize_exposure_scene_class(clip_request.get("exposureSceneClass"))
    if not should_group_exposure_scene(exposure_scene, clip_request.get("exposureSceneConfidence")):
        return None
    if exposure_scene == "underexposed":
        metrics = clip_request.get("exposureSceneMetrics")
        reasons = metrics.get("exposureSceneReasons") if isinstance(metrics, dict) else None
        if isinstance(reasons, list):
            for reason in reasons:
                normalized_reason = stringify_signal_value(reason)
                if normalized_reason in CEXPOSURE_SCENE_REASON_GROUP_TAGS:
                    return normalized_reason
        frame_metrics = metrics.get("frames") if isinstance(metrics, dict) else None
        if isinstance(frame_metrics, list):
            for frame in frame_metrics:
                if not isinstance(frame, dict):
                    continue
                normalized_reason = stringify_signal_value(frame.get("exposureSceneReason"))
                if normalized_reason in CEXPOSURE_SCENE_REASON_GROUP_TAGS:
                    return normalized_reason
    return exposure_scene


def normalize_rough_cut_clips(clips):
    normalized = []
    for clip in clips or []:
        clip_id = stringify_signal_value(clip.get("clipId"))
        asset_id = stringify_signal_value(clip.get("assetId"))
        source_absolute_path = normalize_filesystem_path(clip.get("sourceAbsolutePath"))
        asset_kind = stringify_signal_value(clip.get("assetKind")) or "video"
        if not clip_id or not asset_id or not source_absolute_path:
            raise HostError(
                "resolve_rough_cut_clip_invalid",
                "Rough-cut clip requires clipId, assetId, and sourceAbsolutePath.",
                {"clip": clip},
            )
        timeline_in_ms = parse_float(clip.get("timelineInMs"))
        timeline_out_ms = parse_float(clip.get("timelineOutMs"))
        if timeline_in_ms is None or timeline_out_ms is None or timeline_out_ms <= timeline_in_ms:
            raise HostError(
                "resolve_rough_cut_clip_invalid",
                f"Rough-cut clip has invalid timeline range: {clip_id}",
                {"clipId": clip_id, "timelineInMs": clip.get("timelineInMs"), "timelineOutMs": clip.get("timelineOutMs")},
            )
        audio_gain_db = parse_float(clip.get("audioGainDb"))
        speed = parse_float(clip.get("speed"))
        if audio_gain_db is None or speed is None or speed <= 0:
            raise HostError(
                "resolve_rough_cut_clip_invalid",
                f"Rough-cut clip requires numeric audioGainDb and positive speed: {clip_id}",
                {"clipId": clip_id, "audioGainDb": clip.get("audioGainDb"), "speed": clip.get("speed")},
            )
        source_in_ms = parse_float(clip.get("sourceInMs"))
        source_out_ms = parse_float(clip.get("sourceOutMs"))
        if source_in_ms is not None and source_out_ms is not None and source_out_ms <= source_in_ms:
            raise HostError(
                "resolve_rough_cut_clip_invalid",
                f"Rough-cut clip has invalid source range: {clip_id}",
                {"clipId": clip_id, "sourceInMs": clip.get("sourceInMs"), "sourceOutMs": clip.get("sourceOutMs")},
            )
        raw_relative_path = normalize_portable_path(clip.get("rawRelativePath"))
        if not raw_relative_path:
            raw_relative_path = normalize_portable_path(
                f"{asset_id}/{clip_id}-{Path(source_absolute_path).name}",
            )
        normalized.append({
            "clipId": clip_id,
            "assetId": asset_id,
            "spanId": stringify_signal_value(clip.get("spanId")),
            "spanType": stringify_signal_value(clip.get("spanType")),
            "eventId": stringify_signal_value(clip.get("eventId")),
            "eventTitle": stringify_signal_value(clip.get("eventTitle")),
            "eventKind": stringify_signal_value(clip.get("eventKind")),
            "assetKind": asset_kind,
            "rawRelativePath": raw_relative_path,
            "sourceAbsolutePath": source_absolute_path,
            "sourceStem": stringify_signal_value(clip.get("sourceStem")) or Path(source_absolute_path).stem,
            "fps": parse_float(clip.get("fps")),
            "sourceInMs": source_in_ms,
            "sourceOutMs": source_out_ms,
            "timelineInMs": timeline_in_ms,
            "timelineOutMs": timeline_out_ms,
            "audioGainDb": audio_gain_db,
            "muteAudio": clip.get("muteAudio") is True or audio_gain_db <= -100,
            "speed": speed,
            "requestedSpeed": parse_float(clip.get("requestedSpeed")),
        })
    return sorted(normalized, key=lambda clip: (clip["timelineInMs"], clip["clipId"]))


def normalize_rough_cut_media_requests(clips):
    normalized = []
    seen_sources = set()
    for clip in clips or []:
        asset_id = stringify_signal_value(clip.get("assetId"))
        source_absolute_path = normalize_filesystem_path(clip.get("sourceAbsolutePath"))
        asset_kind = stringify_signal_value(clip.get("assetKind")) or "video"
        if not asset_id or not source_absolute_path:
            raise HostError(
                "resolve_media_sync_clip_invalid",
                "Resolve media sync clip requires assetId and sourceAbsolutePath.",
                {"clip": clip},
            )
        if source_absolute_path in seen_sources:
            continue
        seen_sources.add(source_absolute_path)
        raw_relative_path = normalize_portable_path(clip.get("rawRelativePath"))
        if not raw_relative_path:
            raw_relative_path = normalize_portable_path(
                f"{asset_id}/{Path(source_absolute_path).name}",
            )
        normalized.append({
            "assetId": asset_id,
            "eventId": stringify_signal_value(clip.get("eventId")),
            "eventTitle": stringify_signal_value(clip.get("eventTitle")),
            "eventKind": stringify_signal_value(clip.get("eventKind")),
            "assetKind": asset_kind,
            "rawRelativePath": raw_relative_path,
            "sourceAbsolutePath": source_absolute_path,
            "sourceStem": stringify_signal_value(clip.get("sourceStem")) or Path(source_absolute_path).stem,
        })
    return normalized


def rough_cut_clips_to_namespace_requests(clips):
    return [
        {
            "rawRelativePath": clip["rawRelativePath"],
            "sourceAbsolutePath": clip["sourceAbsolutePath"],
            "sourceStem": clip["sourceStem"],
        }
        for clip in clips
    ]


def ms_to_frame(ms, fps):
    return int(round((float(ms) / 1000.0) * float(fps)))


def apply_timeline_item_audio_gain(timeline_items, clip):
    if not timeline_items:
        raise HostError(
            "resolve_audio_item_missing",
            "Resolve did not return a linked audio TimelineItem for a clip that requires audio gain.",
            {
                "clipId": clip["clipId"],
                "assetId": clip["assetId"],
                "spanId": clip.get("spanId"),
                "requestedAudioGainDb": clip["audioGainDb"],
            },
        )
    target = clip["audioGainDb"]
    for item in timeline_items:
        key = set_writable_timeline_property(
            item,
            ("audio", "gain", "volume", "level"),
            target,
        )
        if key:
            return key
    raise HostError(
        "resolve_audio_gain_unavailable",
        "Resolve did not expose a stable writable TimelineItem audio gain property. Clip gain was not guessed.",
        {
            "clipId": clip["clipId"],
            "assetId": clip["assetId"],
            "spanId": clip.get("spanId"),
            "requestedAudioGainDb": target,
        },
    )


def apply_timeline_item_audio_mute(timeline_items, clip):
    for item in timeline_items:
        result = safe_call(item, "SetClipEnabled", False)
        if result is False or result is None:
            continue
        current = safe_call(item, "GetClipEnabled")
        if current is False:
            return "SetClipEnabled"
    raise HostError(
        "resolve_audio_mute_unavailable",
        "Resolve did not allow disabling the linked audio TimelineItem for a muted rough-cut clip.",
        {
            "clipId": clip["clipId"],
            "assetId": clip["assetId"],
            "spanId": clip.get("spanId"),
        },
    )


def normalize_rough_cut_clip_color_marker_clips(clips):
    normalized = []
    for clip in clips or []:
        clip_index = parse_int(clip.get("clipIndex")) or parse_int(clip.get("index"))
        resolve_name_clip_id = stringify_signal_value(clip.get("resolveNameClipId"))
        source_absolute_path = normalize_filesystem_path(
            stringify_signal_value(clip.get("sourceAbsolutePath"))
            or stringify_signal_value(clip.get("sourceFilePath"))
        )
        source_stem = (
            stringify_signal_value(clip.get("sourceStem"))
            or (Path(source_absolute_path).stem if source_absolute_path else None)
        )
        asset_kind = (stringify_signal_value(clip.get("assetKind")) or "").lower()
        content_kind = (stringify_signal_value(clip.get("contentKind")) or "").lower()
        span_type = (stringify_signal_value(clip.get("spanType")) or "").lower()
        framework_class = (stringify_signal_value(clip.get("frameworkClass")) or "").lower()
        semantic_kind = (stringify_signal_value(clip.get("semanticKind")) or "").lower()
        if not asset_kind:
            asset_kind = "photo" if content_kind == "photo" else "video"
        if not span_type:
            if "timelapse" in (content_kind, framework_class, semantic_kind):
                span_type = "timelapse"
            elif "drive" in (content_kind, framework_class, semantic_kind):
                span_type = "drive"
            elif "aerial" in (content_kind, framework_class, semantic_kind):
                span_type = "aerial"
        marker_clip = {
            "clipId": stringify_signal_value(clip.get("clipId")) or (f"clip-{clip_index:05d}" if clip_index is not None else None),
            "clipIndex": clip_index,
            "assetId": stringify_signal_value(clip.get("assetId")),
            "assetKind": asset_kind,
            "spanId": stringify_signal_value(clip.get("spanId")),
            "spanType": span_type,
            "resolveNameClipId": resolve_name_clip_id,
            "sourceAbsolutePath": source_absolute_path,
            "sourceStem": source_stem,
            "timelineInMs": parse_float(clip.get("timelineInMs")),
            "timelineOutMs": parse_float(clip.get("timelineOutMs")),
            "muteAudio": clip.get("muteAudio") is True,
        }
        if resolve_rough_cut_visual_clip_color_category(marker_clip):
            normalized.append(marker_clip)
    return sorted(
        normalized,
        key=lambda clip: (
            parse_float(clip.get("timelineInMs")) if clip.get("timelineInMs") is not None else 0,
            parse_int(clip.get("clipIndex")) or 0,
            stringify_signal_value(clip.get("sourceStem")) or "",
        ),
    )


def collect_timeline_video_color_marker_entries(timeline):
    entries = []
    track_count = safe_call(timeline, "GetTrackCount", "video") or safe_call(timeline, "GetTrackCount", "Video") or 0
    for track_index in range(1, int(track_count) + 1):
        items = safe_call(timeline, "GetItemListInTrack", "video", track_index)
        if items is None:
            items = safe_call(timeline, "GetItemsInTrack", "video", track_index)
        for item in iter_values(items or []):
            name = stringify_signal_value(safe_call(item, "GetName")) or ""
            source_path = normalize_filesystem_path(extract_timeline_item_file_path(item))
            source_stem = Path(source_path).stem if source_path else None
            if not source_stem and name:
                source_stem = Path(name).stem
            entry = {
                "item": item,
                "trackIndex": track_index,
                "name": name,
                "resolveNameClipId": extract_resolve_name_clip_id(name),
                "sourceAbsolutePath": source_path,
                "sourceStem": source_stem,
                "startFrame": parse_float(safe_call(item, "GetStart")),
                "endFrame": parse_float(safe_call(item, "GetEnd")),
            }
            entries.append(entry)
    return sorted(
        entries,
        key=lambda entry: (
            parse_float(entry.get("startFrame")) if entry.get("startFrame") is not None else 0,
            int(entry.get("trackIndex") or 0),
            stringify_signal_value(entry.get("name")) or "",
        ),
    )


def extract_resolve_name_clip_id(name):
    text = stringify_signal_value(name) or ""
    match = re.match(r"^(clip-\d+)\b", text)
    return match.group(1) if match else None


def build_timeline_color_marker_match_state(clips, timeline_entries):
    return {
        "clipGroupsByResolveNameClipId": group_marker_entries(clips, "resolveNameClipId", sort_clip_marker_entries),
        "clipGroupsBySourceAbsolutePath": group_marker_entries(clips, "sourceAbsolutePath", sort_clip_marker_entries),
        "clipGroupsBySourceStem": group_marker_entries(clips, "sourceStem", sort_clip_marker_entries),
        "timelineGroupsByResolveNameClipId": group_marker_entries(timeline_entries, "resolveNameClipId", sort_timeline_marker_entries),
        "timelineGroupsBySourceAbsolutePath": group_marker_entries(timeline_entries, "sourceAbsolutePath", sort_timeline_marker_entries),
        "timelineGroupsBySourceStem": group_marker_entries(timeline_entries, "sourceStem", sort_timeline_marker_entries),
    }


def group_marker_entries(entries, key, sorter):
    groups = {}
    for entry in entries:
        value = stringify_signal_value(entry.get(key))
        if not value:
            continue
        groups.setdefault(value, []).append(entry)
    for value, group in list(groups.items()):
        groups[value] = sorter(group)
    return groups


def sort_clip_marker_entries(entries):
    return sorted(
        entries,
        key=lambda entry: (
            parse_float(entry.get("timelineInMs")) if entry.get("timelineInMs") is not None else 0,
            parse_int(entry.get("clipIndex")) or 0,
            stringify_signal_value(entry.get("sourceStem")) or "",
        ),
    )


def sort_timeline_marker_entries(entries):
    return sorted(
        entries,
        key=lambda entry: (
            parse_float(entry.get("startFrame")) if entry.get("startFrame") is not None else 0,
            int(entry.get("trackIndex") or 0),
            stringify_signal_value(entry.get("name")) or "",
        ),
    )


def match_existing_rough_cut_video_item(clip, match_state):
    match = match_existing_rough_cut_video_item_by_group(
        clip,
        match_state["clipGroupsByResolveNameClipId"],
        match_state["timelineGroupsByResolveNameClipId"],
        "resolveNameClipId",
    )
    if match:
        return match
    match = match_existing_rough_cut_video_item_by_group(
        clip,
        match_state["clipGroupsBySourceAbsolutePath"],
        match_state["timelineGroupsBySourceAbsolutePath"],
        "sourceAbsolutePath",
    )
    if match:
        return match
    return match_existing_rough_cut_video_item_by_group(
        clip,
        match_state["clipGroupsBySourceStem"],
        match_state["timelineGroupsBySourceStem"],
        "sourceStem",
    )


def match_existing_rough_cut_video_item_by_group(clip, clip_groups, timeline_groups, key):
    value = stringify_signal_value(clip.get(key))
    if not value:
        return None
    clip_group = clip_groups.get(value) or []
    timeline_group = timeline_groups.get(value) or []
    if not timeline_group:
        return None
    occurrence = 0
    for index, candidate in enumerate(clip_group):
        if candidate is clip:
            occurrence = index
            break
        if candidate.get("clipIndex") == clip.get("clipIndex") and candidate.get("timelineInMs") == clip.get("timelineInMs"):
            occurrence = index
            break
    if occurrence < len(timeline_group):
        entry = dict(timeline_group[occurrence])
        entry["method"] = key
        return entry
    if len(timeline_group) == 1:
        entry = dict(timeline_group[0])
        entry["method"] = f"{key}:single"
        return entry
    return None


def count_match_methods(marked):
    result = {}
    for entry in marked:
        method = stringify_signal_value(entry.get("matchMethod")) or "unknown"
        result[method] = int(result.get(method) or 0) + 1
    return result


def apply_rough_cut_visual_clip_group(
    timeline_items,
    clip,
    project,
    existing_groups_by_name,
    groups_by_category,
    summary,
):
    category = resolve_rough_cut_visual_clip_color_category(clip)
    if not category:
        return None
    category_summary = summary.get(category)
    if not category_summary:
        return None
    group_name = stringify_signal_value(category_summary.get("groupName"))
    if not group_name:
        return None
    color_group = groups_by_category.get(category)
    if color_group is None:
        color_group, created = ensure_color_group(project, existing_groups_by_name, group_name)
        groups_by_category[category] = color_group
        category_summary["created"] = bool(category_summary.get("created") or created)
    return apply_rough_cut_clip_group(
        timeline_items,
        clip,
        color_group,
        group_name,
        category_summary,
        "resolve_visual_clip_group_assign_failed",
        f"Resolve did not assign the {category} rough-cut video item to Color Group {group_name}.",
    )


def apply_rough_cut_clip_group(timeline_items, clip, color_group, group_name, summary, error_code, error_message):
    failed = []
    for item in timeline_items:
        summary["checked"] = int(summary.get("checked") or 0) + 1
        current_group = safe_call(item, "GetColorGroup")
        current_group_name = safe_call(current_group, "GetName") if current_group else None
        if current_group_name == group_name:
            summary["alreadyAssigned"] = int(summary.get("alreadyAssigned") or 0) + 1
            continue
        if current_group:
            safe_call(item, "RemoveFromColorGroup")
        result = safe_call(item, "AssignToColorGroup", color_group)
        assigned_group = safe_call(item, "GetColorGroup")
        assigned_group_name = safe_call(assigned_group, "GetName") if assigned_group else None
        if result is not False and assigned_group_name == group_name:
            summary["assigned"] = int(summary.get("assigned") or 0) + 1
            continue
        summary["failed"] = int(summary.get("failed") or 0) + 1
        failed.append(assigned_group_name or stringify_signal_value(result) or "")
    if not failed:
        return group_name
    raise HostError(
        error_code,
        error_message,
        {
            "clipId": clip["clipId"],
            "assetId": clip["assetId"],
            "spanId": clip.get("spanId"),
            "spanType": clip.get("spanType"),
            "requestedGroup": group_name,
            "currentGroups": failed,
        },
    )


def apply_rough_cut_visual_clip_color(timeline_items, clip, summary):
    category = resolve_rough_cut_visual_clip_color_category(clip)
    if not category:
        return None
    category_summary = summary.get(category)
    if not category_summary:
        return None
    return apply_rough_cut_clip_color(
        timeline_items,
        clip,
        category_summary,
        "resolve_visual_clip_color_failed",
        f"Resolve did not apply the {category} rough-cut clip color for {clip['clipId']}.",
    )


def resolve_rough_cut_visual_clip_color_category(clip):
    asset_kind = (stringify_signal_value(clip.get("assetKind")) or "").lower()
    span_type = (stringify_signal_value(clip.get("spanType")) or "").lower()
    if asset_kind == "photo":
        return "photo"
    if span_type == "timelapse":
        return "timelapse"
    if span_type == "drive":
        return "drive"
    if span_type == "aerial":
        return "aerial"
    return None


def apply_rough_cut_audible_clip_color(timeline_items, clip, summary):
    if clip["muteAudio"]:
        return None
    if not timeline_items:
        return None
    return apply_rough_cut_clip_color(
        timeline_items,
        clip,
        summary,
        "resolve_audible_clip_color_failed",
        f"Resolve did not apply the audible rough-cut clip color for {clip['clipId']}.",
    )


def apply_rough_cut_clip_color(timeline_items, clip, summary, error_code, error_message):
    color = summary.get("color") or "Orange"
    failed = []
    for item in timeline_items:
        summary["checked"] = int(summary.get("checked") or 0) + 1
        result = safe_call(item, "SetClipColor", color)
        current = stringify_signal_value(safe_call(item, "GetClipColor")) or ""
        if result is not False and current.lower() == str(color).lower():
            summary["colored"] = int(summary.get("colored") or 0) + 1
            continue
        summary["failed"] = int(summary.get("failed") or 0) + 1
        failed.append(current)
    if not failed:
        return color
    raise HostError(
        error_code,
        error_message,
        {
            "clipId": clip["clipId"],
            "assetId": clip["assetId"],
            "spanId": clip.get("spanId"),
            "spanType": clip.get("spanType"),
            "requestedColor": color,
            "currentColors": failed,
        },
    )


def filter_timeline_items_by_track_type(timeline_items, track_type):
    matched = []
    for item in timeline_items:
        info = safe_call(item, "GetTrackTypeAndIndex")
        if isinstance(info, (list, tuple)) and info and stringify_signal_value(info[0]).lower() == track_type:
            matched.append(item)
    return matched


def collect_linked_timeline_items(timeline_items):
    collected = []
    seen = set()
    for item in timeline_items:
        for candidate in [item, *list(iter_values(safe_call(item, "GetLinkedItems") or []))]:
            unique_id = stringify_signal_value(safe_call(candidate, "GetUniqueId"))
            key = unique_id or str(id(candidate))
            if key in seen:
                continue
            seen.add(key)
            collected.append(candidate)
    return collected


def set_writable_timeline_property(item, key_needles, target, explicit_candidates=()):
    property_map = safe_call(item, "GetProperty")
    candidates = []
    for key in explicit_candidates:
        if key:
            candidates.append(key)
    if isinstance(property_map, dict):
        candidates.extend([
            key
            for key in property_map.keys()
            if isinstance(key, str)
            and any(needle in key.lower() for needle in key_needles)
        ])
    candidates = dedupe_strings(candidates)
    for key in candidates:
        original = property_map.get(key) if isinstance(property_map, dict) else None
        result = safe_call(item, "SetProperty", key, target)
        if result is False or result is None:
            continue
        current = safe_call(item, "GetProperty", key)
        if value_matches_request(current, target):
            return key
        if original is not None:
            safe_call(item, "SetProperty", key, original)
    return None


def value_matches_request(value, requested):
    parsed = parse_float(value)
    target = parse_float(requested)
    if parsed is None or target is None:
        return value == requested
    return abs(parsed - target) <= 0.25


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
            "encodedWidth": parse_int(clip.get("encodedWidth")),
            "encodedHeight": parse_int(clip.get("encodedHeight")),
            "displayWidth": parse_int(clip.get("displayWidth")),
            "displayHeight": parse_int(clip.get("displayHeight")),
            "rotationDegrees": parse_float(clip.get("rotationDegrees")),
            "orientationStatus": stringify_signal_value(clip.get("orientationStatus")),
            "repairTemplateKey": stringify_signal_value(clip.get("repairTemplateKey")) or "default",
            "previousRepairTemplateHash": stringify_signal_value(clip.get("previousRepairTemplateHash")),
            "timelineTransform": clip.get("timelineTransform") if isinstance(clip.get("timelineTransform"), dict) else None,
            "fps": parse_float(clip.get("fps")),
            "codec": stringify_signal_value(clip.get("codec")),
            "rawTags": normalize_string_map(clip.get("rawTags")),
            "detectedProfile": normalize_log_profile(clip.get("detectedProfile")),
            "effectiveProfile": stringify_signal_value(clip.get("effectiveProfile")),
            "profileSource": stringify_signal_value(clip.get("profileSource")) or "unknown",
            "logProfile": normalize_log_profile(clip.get("logProfile")),
            "gyroDataAvailable": clip.get("gyroDataAvailable") is True,
            "gyroEligible": clip.get("gyroEligible") is True,
            "lowlight": clip.get("lowlight") is True,
            "colorCastClass": normalize_color_cast_class(clip.get("colorCastClass")),
            "colorCastConfidence": parse_float(clip.get("colorCastConfidence")),
            "colorCastMetrics": clip.get("colorCastMetrics") if isinstance(clip.get("colorCastMetrics"), dict) else {},
            "exposureSceneClass": normalize_exposure_scene_class(clip.get("exposureSceneClass")),
            "exposureSceneConfidence": parse_float(clip.get("exposureSceneConfidence")),
            "exposureSceneMetrics": clip.get("exposureSceneMetrics") if isinstance(clip.get("exposureSceneMetrics"), dict) else {},
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


def resolve_timeline_fps(project, timeline):
    timeline_settings = safe_call(timeline, "GetSetting") if timeline is not None else None
    if isinstance(timeline_settings, dict):
        fps = parse_float(timeline_settings.get("timelineFrameRate"))
        if fps and fps > 0:
            return fps
        playback = parse_float(timeline_settings.get("timelinePlaybackFrameRate"))
        if playback and playback > 0:
            return playback
    for key in ("timelineFrameRate", "timelinePlaybackFrameRate"):
        fps = parse_float(safe_call(timeline, "GetSetting", key)) if timeline is not None else None
        if fps and fps > 0:
            return fps
    for key in ("timelineFrameRate", "timelinePlaybackFrameRate"):
        fps = parse_float(safe_call(project, "GetSetting", key))
        if fps and fps > 0:
            return fps
    return 30.0


def collect_timeline_track_item_summaries(timeline, track_type, fps, include_details=True):
    result = []
    track_count = safe_call(timeline, "GetTrackCount", track_type) or safe_call(timeline, "GetTrackCount", track_type.title()) or 0
    for track_index in range(1, int(track_count) + 1):
        items = safe_call(timeline, "GetItemListInTrack", track_type, track_index)
        if items is None:
            items = safe_call(timeline, "GetItemsInTrack", track_type, track_index)
        for item in iter_values(items or []):
            summary = summarize_timeline_item(item, track_type, track_index, fps, include_details=include_details)
            if summary:
                result.append(summary)
    return sorted(
        result,
        key=lambda entry: (
            parse_float(entry.get("startFrame")) if entry.get("startFrame") is not None else 0,
            int(entry.get("trackIndex") or 0),
            parse_float(entry.get("endFrame")) if entry.get("endFrame") is not None else 0,
            stringify_signal_value(entry.get("name")),
        ),
    )


def summarize_timeline_item(item, track_type, track_index, fps, include_details=True):
    start_frame = parse_float(safe_call(item, "GetStart"))
    end_frame = parse_float(safe_call(item, "GetEnd"))
    duration_frames = parse_float(safe_call(item, "GetDuration"))
    if start_frame is None and end_frame is not None and duration_frames is not None:
        start_frame = end_frame - duration_frames
    if end_frame is None and start_frame is not None and duration_frames is not None:
        end_frame = start_frame + duration_frames
    source_start_frame = parse_float(safe_call(item, "GetSourceStartFrame"))
    source_end_frame = parse_float(safe_call(item, "GetSourceEndFrame"))
    media_pool_item = safe_call(item, "GetMediaPoolItem")
    file_path = normalize_filesystem_path(extract_timeline_item_file_path(item)) if include_details else ""
    clip_property = safe_call(item, "GetClipProperty") if include_details else None
    property_map = safe_call(item, "GetProperty") if include_details else None
    media_property = safe_call(media_pool_item, "GetClipProperty") if media_pool_item and include_details else None

    summary = {
        "trackType": track_type,
        "trackIndex": track_index,
        "name": stringify_signal_value(safe_call(item, "GetName")),
        "startFrame": start_frame,
        "endFrame": end_frame,
        "durationFrames": duration_frames,
        "timelineInMs": frames_to_ms(start_frame, fps),
        "timelineOutMs": frames_to_ms(end_frame, fps),
        "durationMs": frames_to_ms(duration_frames, fps),
        "sourceStartFrame": source_start_frame,
        "sourceEndFrame": source_end_frame,
        "clipEnabled": safe_call(item, "GetClipEnabled"),
    }
    if include_details:
        summary.update({
            "filePath": file_path,
            "sourceStem": Path(file_path).stem if file_path else "",
            "mediaPoolName": stringify_signal_value(safe_call(media_pool_item, "GetName")) if media_pool_item else "",
            "clipProperty": compact_timeline_property_map(clip_property),
            "property": compact_timeline_property_map(property_map),
            "mediaProperty": compact_timeline_property_map(media_property),
        })
        if track_type == "subtitle":
            summary["text"] = extract_timeline_subtitle_text(summary)
    return summary


def frames_to_ms(frames, fps):
    value = parse_float(frames)
    rate = parse_float(fps)
    if value is None or rate is None or rate <= 0:
        return None
    return value * 1000.0 / rate


def compact_timeline_property_map(value):
    if not isinstance(value, dict):
        return {}
    keys = (
        "Name",
        "Type",
        "File Path",
        "FilePath",
        "Path",
        "Clip Path",
        "Text",
        "Subtitle",
        "Caption",
        "Duration",
        "Start",
        "End",
        "FPS",
        "Frames",
    )
    result = {}
    for key in keys:
        current = value.get(key)
        text = stringify_signal_value(current)
        if text:
            result[key] = text
    return result


def extract_timeline_subtitle_text(summary):
    candidates = [
        summary.get("name"),
        (summary.get("property") or {}).get("Text"),
        (summary.get("property") or {}).get("Subtitle"),
        (summary.get("property") or {}).get("Caption"),
        (summary.get("clipProperty") or {}).get("Text"),
        (summary.get("clipProperty") or {}).get("Subtitle"),
        (summary.get("clipProperty") or {}).get("Caption"),
    ]
    for candidate in candidates:
        text = stringify_signal_value(candidate)
        if text:
            return text
    return ""


def iter_timeline_video_items(timeline):
    for item in iter_timeline_track_items(timeline, "video"):
        yield item


def iter_timeline_relink_items(timeline, track_types):
    for track_type in track_types or ["video"]:
        for item in iter_timeline_track_items(timeline, track_type):
            yield track_type, item


def iter_timeline_track_items(timeline, track_type):
    track_count = (
        safe_call(timeline, "GetTrackCount", track_type)
        or safe_call(timeline, "GetTrackCount", track_type.title())
        or 0
    )
    for track_index in range(1, int(track_count) + 1):
        items = safe_call(timeline, "GetItemListInTrack", track_type, track_index)
        if items is None:
            items = safe_call(timeline, "GetItemsInTrack", track_type, track_index)
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


def ensure_bitrate_render_preset(resolve, project, render_format):
    bitrate = parse_int(render_format.get("bitrateKbps"))
    if not bitrate or not needs_windows_fixed_bitrate_preset(render_format):
        return None
    preset_name = build_transient_render_preset_name(render_format, bitrate)
    export_root = Path(tempfile.mkdtemp(prefix="kairos-resolve-render-preset-"))
    try:
        preset_xml = export_root / f"{preset_name}.xml"
        write_generated_render_preset_xml(preset_xml, preset_name, bitrate, render_format)
        safe_call(project, "DeleteRenderPreset", preset_name)
        import_result = safe_call(resolve, "ImportRenderPreset", str(preset_xml))
        if import_result is not True:
            raise HostError(
                "resolve_render_preset_import_failed",
                "Unable to import transient Resolve render preset for fixed bitrate.",
                {"presetName": preset_name, "bitrateKbps": bitrate, "presetXml": str(preset_xml)},
            )
        load_result = safe_call(project, "LoadRenderPreset", preset_name)
        if load_result is not True:
            raise HostError(
                "resolve_render_preset_load_failed",
                "Unable to load transient Resolve render preset for fixed bitrate.",
                {"presetName": preset_name, "bitrateKbps": bitrate},
            )
        verify_transient_render_preset(resolve, project, preset_name, bitrate, render_format)
        return preset_name
    except HostError:
        safe_call(project, "DeleteRenderPreset", preset_name)
        raise
    finally:
        shutil.rmtree(export_root, ignore_errors=True)


def build_transient_render_preset_name(render_format, bitrate):
    fingerprint = hashlib.sha1(
        json.dumps(
            {
                "format": render_format.get("format"),
                "codec": render_format.get("videoCodec"),
                "audioCodec": render_format.get("audioCodec"),
                "bitrateKbps": bitrate,
                "time": time.time(),
            },
            ensure_ascii=False,
            sort_keys=True,
        ).encode("utf-8"),
    ).hexdigest()[:10]
    return f"__kairos_fixed_bitrate_{bitrate}_{fingerprint}__"


def write_generated_render_preset_xml(preset_xml, preset_name, bitrate, render_format):
    import xml.etree.ElementTree as ET

    encoder_subtype = default_render_encoder_subtype(render_format or {})
    if not encoder_subtype:
        raise HostError(
            "resolve_render_preset_encoder_missing",
            "Unable to derive Resolve encoder subtype for generated render preset.",
            {"presetName": preset_name, "renderFormat": render_format},
        )
    root = ET.Element("SyRecordInfo", {"DbId": str(uuid.uuid4())})
    scalar_fields = {
        "Session": None,
        "Timeline": None,
        "UniqueSequenceId": None,
        "ReplaceHoleWithBlank": "0",
        "ApplyWfmDuringRecord": "0",
        "DisableCcDuringRecording": "0",
        "DisablePtzDuringRecording": "0",
        "RecordStartFrame": "0",
        "RecordEndFrame": "0",
        "RecordTotalFrame": "0",
        "RecordOldFrame": "0",
        "RecordNewFrame": "0",
        "RecordAllowDupImg": "1",
        "RecordClipUniqueName": "false",
        "RecordClipUniqueNameStyle": "0",
        "RecordDigit": "8",
        "RecordBitDepth": "8",
        "RecordAsFloat": "false",
        "FormatWidth": "3840",
        "FormatHeight": "2160",
        "FormatPixelAspectRatio": "1",
        "FormatOption": "-1",
        "RecordTargetDir": "",
        "RecordUseTgtTimeCode": "0",
        "RenderAtSourceResolution": "false",
        "RecordSetTimelineTimecode": "false",
        "UseRecordClipStartFrame": "false",
        "RecordClipStartFrame": "1",
        "RecordPrefix": "",
        "RecordSuffix": "",
        "RecordFormatType": "mp4",
        "RecordFormatSubType": encoder_subtype,
        "RecordInFieldMode": "false",
        "RecordDataLevel": "DATA_LEVEL_AUTO",
        "RecordQuality": "4",
        "RecordFPS": "30",
        "StereoRender": "false",
        "StereoRenderFrameMeshMode": "-1",
        "StereoRenderBothEyesSeparately": "false",
        "StereoRenderSourceType": "0",
        "UserName": "",
        "ProjectName": "",
        "FolderName": "",
        "SessionName": "",
        "CreationTime": "",
        "Status": "READY",
        "RecordSpeed": "0",
        "UsePrefixAndSuffixFromSrc": "1",
        "UseCommercialWorkflow": "0",
        "AlternateOffset": "0",
        "ReelInFolder": "0",
        "ClipInFolder": "0",
        "AlternateInFolder": "0",
        "SrcDirPreserveLevel": "0",
        "SrcDirLevelsMode": "0",
        "NumFramesOfHandles": "0",
        "UseVersionNameForFolder": "0",
        "DestSuffix": "",
        "RecordInfoName": "",
        "VersionIdList": "",
        "VersionNameList": "",
        "CompletionPercentage": "0",
        "RecordSlatePreset": "Same as project",
        "AdditionalOutputFormats": None,
        "RecordAudioEnabled": "true",
        "RecordAudioNumChannels": "2",
        "RecordAudioBitDepth": "16",
        "CustomClips": "",
        "DisplayOrder": "-1",
        "ForceHighestQualitySizing": "0",
        "ForceHighestQualityDebayerRes": "0",
        "RecordMode": "RECORD_MODE_NONE",
    }
    for tag, value in scalar_fields.items():
        child = ET.SubElement(root, tag)
        if value is not None:
            child.text = value
    extra_info = ET.SubElement(root, "ExtraInfoMap")
    for key, value in build_generated_render_preset_extra_info(bitrate, render_format, encoder_subtype).items():
        element = ET.SubElement(extra_info, "Element")
        db_key = ET.SubElement(element, "DbKey")
        db_key.text = key
        db_val = ET.SubElement(element, "DbVal")
        db_val.text = value
    tail_fields = {
        "UseRenderCachedImagesForRecording": "false",
        "TgtSysId": "None",
        "CurSysId": "",
        "TimeTakenToRenderInMs": "0",
        "EstimatedTimeRemainingInMs": "0",
        "ErrorCode": "0",
        "ErrorStr": "",
        "ErrorNotified": "true",
    }
    for tag, value in tail_fields.items():
        child = ET.SubElement(root, tag)
        child.text = value
    tree = ET.ElementTree(root)
    preset_xml.parent.mkdir(parents=True, exist_ok=True)
    tree.write(preset_xml, encoding="UTF-8", xml_declaration=True)


def build_generated_render_preset_extra_info(bitrate, render_format, encoder_subtype):
    audio_codec = stringify_signal_value((render_format or {}).get("audioCodec")) or "aac"
    encoder_map = {
        "rc": "CBR",
        "preset": "balance" if encoder_subtype == "hvc1_qsv" else "balanced",
        "init_qpP": "28",
        "init_qpI": "25",
        "init_qpB": "31",
        "bitrate": str(bitrate),
        "avbr_convergence": "0",
        "avbr_accuracy": "0",
    }
    if encoder_subtype == "hvc1_qsv":
        encoder_map["icq_quality"] = "2"
    return {
        "smpte": "y",
        "aud_qual": "4",
        "aud_rate": "320",
        "aud_codec": audio_codec,
        "h264_level": "-1",
        "h264_passes": "1",
        "subs_enable": "0",
        "h264_bframes": "1",
        "h264_profile": "2" if normalize_codec_family((render_format or {}).get("videoCodec")) == "h265" else "0",
        "h264_datarate": str(bitrate),
        "h264_iframefreq": "0",
        "imf_profile_level": "0",
        "immersive_workflow": "0",
        "aud_bitrate_strategy": "0",
        "legacy_player_compat": "0",
        "network_optimization": "0",
        "h264_prioritize_speed": "n",
        "include_spatial_metadata": "0",
        "encoder_command_param_map": encode_resolve_string_map(encoder_map),
    }


def default_render_encoding_profile(render_format):
    if normalize_codec_family(render_format.get("videoCodec")) == "h265":
        return "Main10"
    return None


def needs_windows_fixed_bitrate_preset(render_format):
    if sys.platform != "win32":
        return False
    container = normalize_lookup_key(str(render_format.get("format") or render_format.get("container") or render_format.get("extension") or ""))
    codec_family = normalize_codec_family(render_format.get("videoCodec"))
    return container == "mp4" and codec_family == "h265"


def default_render_encoder_subtype(render_format):
    container = normalize_lookup_key(str(render_format.get("format") or render_format.get("container") or render_format.get("extension") or ""))
    codec_value = str(render_format.get("videoCodec") or "")
    codec = normalize_lookup_key(codec_value)
    codec_family = normalize_codec_family(codec_value)
    if container == "mp4" and codec_family == "h265":
        if "nvidia" in codec:
            return "hvc1_nvenc"
        if "qsv" in codec or "intel" in codec or needs_windows_fixed_bitrate_preset(render_format):
            return "hvc1_qsv"
        return "hvc1_enc"
    return None


def find_exported_render_preset_xml(export_path):
    candidates = sorted(Path(export_path).glob("*.xml"))
    if not candidates:
        raise HostError(
            "resolve_render_preset_xml_missing",
            "Resolve exported render preset without an XML payload.",
            {"exportPath": str(export_path)},
        )
    return candidates[0]


def patch_render_preset_bitrate(preset_xml, bitrate, render_format=None):
    try:
        tree = parse_xml_file_preserving_comments(preset_xml)
        root = tree.getroot()
        encoder_subtype = default_render_encoder_subtype(render_format or {})
        if encoder_subtype:
            set_xml_text(root, "RecordFormatType", "mp4")
            set_xml_text(root, "RecordFormatSubType", encoder_subtype)
        set_xml_text(root, "RecordPrefix", "")
        set_xml_text(root, "RecordSuffix", "")
        set_xml_text(root, "DestSuffix", "")
        set_xml_text(root, "RecordAllowDupImg", "1")
        set_xml_text(root, "RecordClipUniqueName", "false")
        set_xml_text(root, "RecordClipUniqueNameStyle", "0")
        set_xml_text(root, "UsePrefixAndSuffixFromSrc", "1")
        set_xml_text(root, "CustomClips", "")
        set_xml_text(root, "ReelInFolder", "0")
        set_xml_text(root, "ClipInFolder", "0")
        set_xml_text(root, "AlternateInFolder", "0")
        set_xml_text(root, "UseVersionNameForFolder", "0")
        set_xml_text(root, "SrcDirPreserveLevel", "0")
        set_xml_text(root, "SrcDirLevelsMode", "0")
        set_xml_text(root, "FolderName", "")
        set_xml_text(root, "VersionIdList", "")
        set_xml_text(root, "VersionNameList", "")
        extra_info = root.find("ExtraInfoMap")
        if extra_info is None:
            extra_info = create_xml_child(root, "ExtraInfoMap")
        current_encoder_map = decode_resolve_string_map(
            get_extra_info_value(extra_info, "encoder_command_param_map"),
        )
        patched_encoder_map = dict(current_encoder_map)
        patched_encoder_map.update({
            "rc": "CBR",
            "preset": "balance" if encoder_subtype == "hvc1_qsv" else "balanced",
            "bitrate": str(bitrate),
            "avbr_convergence": "0",
            "avbr_accuracy": "0",
        })
        patched_encoder_map.pop("quality", None)
        patched_encoder_map.pop("icq_quality", None)
        if encoder_subtype == "hvc1_qsv":
            patched_encoder_map["icq_quality"] = "2"
        elif "icq_quality" in current_encoder_map:
            patched_encoder_map["icq_quality"] = "4"
        if normalize_codec_family((render_format or {}).get("videoCodec")) == "h265":
            set_extra_info_value(extra_info, "h264_profile", "2")
        set_extra_info_value(extra_info, "h264_datarate", str(bitrate))
        set_extra_info_value(extra_info, "encoder_command_param_map", encode_resolve_string_map(patched_encoder_map))
        tree.write(preset_xml, encoding="UTF-8", xml_declaration=True)
    except HostError:
        raise
    except Exception as error:
        raise HostError(
            "resolve_render_preset_patch_failed",
            "Unable to patch transient Resolve render preset for fixed bitrate.",
            {"presetXml": str(preset_xml), "bitrateKbps": bitrate, "error": str(error)},
        )


def verify_transient_render_preset(resolve, project, preset_name, bitrate, render_format):
    export_root = Path(tempfile.mkdtemp(prefix="kairos-resolve-render-preset-verify-"))
    try:
        # Resolve 21 on Windows can keep some Deliver-page UI checkboxes sticky
        # after Import/LoadRenderPreset. SaveAsNewRenderPreset captures that
        # current UI state, not the imported preset payload, so verify the named
        # preset directly and let the render-output collector normalize any
        # one-level Event_Version folders Resolve still materializes at render time.
        export_path = export_root / f"{preset_name}.drp"
        export_result = safe_call(resolve, "ExportRenderPreset", preset_name, str(export_path))
        if export_result is not True:
            raise HostError(
                "resolve_render_preset_verify_failed",
                "Unable to verify transient Resolve render preset bitrate.",
                {"presetName": preset_name, "bitrateKbps": bitrate, "stage": "export"},
            )
        preset_xml = find_exported_render_preset_xml(export_path)
        tree = parse_xml_file_preserving_comments(preset_xml)
        root = tree.getroot()
        extra_info = root.find("ExtraInfoMap")
        expected_subtype = default_render_encoder_subtype(render_format)
        verified_subtype = root.findtext("RecordFormatSubType")
        verified_use_source_name = root.findtext("UsePrefixAndSuffixFromSrc")
        verified_allow_duplicate_source_names = root.findtext("RecordAllowDupImg")
        verified_folder_fields = {
            "ReelInFolder": root.findtext("ReelInFolder"),
            "ClipInFolder": root.findtext("ClipInFolder"),
            "AlternateInFolder": root.findtext("AlternateInFolder"),
            "UseVersionNameForFolder": root.findtext("UseVersionNameForFolder"),
            "SrcDirPreserveLevel": root.findtext("SrcDirPreserveLevel"),
            "SrcDirLevelsMode": root.findtext("SrcDirLevelsMode"),
        }
        verified_bitrate = get_extra_info_value(extra_info, "h264_datarate") if extra_info is not None else None
        verified_profile = get_extra_info_value(extra_info, "h264_profile") if extra_info is not None else None
        verified_encoder_map = decode_resolve_string_map(
            get_extra_info_value(extra_info, "encoder_command_param_map") if extra_info is not None else None,
        )
        verified_map_bitrate = parse_int(verified_encoder_map.get("bitrate"))
        verified_rate_control = stringify_signal_value(verified_encoder_map.get("rc"))
        if expected_subtype and verified_subtype != expected_subtype:
            raise HostError(
                "resolve_render_preset_encoder_verify_failed",
                "Resolve did not keep the requested render encoder in the transient render preset.",
                {
                    "presetName": preset_name,
                    "requestedEncoderSubtype": expected_subtype,
                    "verifiedEncoderSubtype": verified_subtype,
                },
            )
        if normalize_codec_family((render_format or {}).get("videoCodec")) == "h265" and stringify_signal_value(verified_profile) != "2":
            raise HostError(
                "resolve_render_preset_profile_verify_failed",
                "Resolve did not keep the requested H.265 Main10 profile in the transient render preset.",
                {
                    "presetName": preset_name,
                    "requestedEncodingProfile": "Main10",
                    "verifiedProfile": verified_profile,
                },
            )
        if verified_rate_control != "CBR":
            raise HostError(
                "resolve_render_preset_rate_control_verify_failed",
                "Resolve did not keep fixed-bitrate rate control in the transient render preset.",
                {
                    "presetName": preset_name,
                    "requestedRateControl": "CBR",
                    "verifiedRateControl": verified_rate_control,
                    "verifiedEncoderMap": verified_encoder_map,
                },
            )
        if verified_use_source_name != "1":
            raise HostError(
                "resolve_render_preset_filename_verify_failed",
                "Resolve did not keep Source Name filename settings in the transient render preset.",
                {
                    "presetName": preset_name,
                    "usePrefixAndSuffixFromSrc": verified_use_source_name,
                },
            )
        if stringify_signal_value(verified_allow_duplicate_source_names) != "1":
            raise HostError(
                "resolve_render_preset_duplicate_name_verify_failed",
                "Resolve did not keep direct Source Name duplicate handling in the transient render preset.",
                {
                    "presetName": preset_name,
                    "recordAllowDupImg": verified_allow_duplicate_source_names,
                },
            )
        bad_folder_fields = {
            key: value
            for key, value in verified_folder_fields.items()
            if stringify_signal_value(value) != "0"
        }
        if bad_folder_fields:
            raise HostError(
                "resolve_render_preset_folder_verify_failed",
                "Resolve did not keep direct-root output folder settings in the transient render preset.",
                {
                    "presetName": preset_name,
                    "folderFields": bad_folder_fields,
                },
            )
        if verified_map_bitrate != bitrate:
            raise HostError(
                "resolve_render_preset_bitrate_verify_failed",
                "Resolve did not keep the requested encoder-map bitrate in the transient render preset.",
                {
                    "presetName": preset_name,
                    "requestedBitrateKbps": bitrate,
                    "verifiedBitrateKbps": verified_map_bitrate,
                    "verifiedEncoderMap": verified_encoder_map,
                },
            )
        if parse_int(verified_bitrate) != bitrate:
            raise HostError(
                "resolve_render_preset_bitrate_verify_failed",
                "Resolve did not keep the requested datarate in the transient render preset.",
                {
                    "presetName": preset_name,
                    "requestedBitrateKbps": bitrate,
                    "verifiedBitrateKbps": verified_bitrate,
                },
            )
    finally:
        shutil.rmtree(export_root, ignore_errors=True)


def parse_xml_file_preserving_comments(path):
    import xml.etree.ElementTree as ET

    parser = ET.XMLParser(target=ET.TreeBuilder(insert_comments=True))
    return ET.parse(path, parser=parser)


def create_xml_child(parent, tag):
    import xml.etree.ElementTree as ET

    child = ET.Element(tag)
    parent.append(child)
    return child


def set_xml_text(parent, tag, value):
    element = parent.find(tag)
    if element is None:
        element = create_xml_child(parent, tag)
    element.text = value
    return element


def find_extra_info_element(extra_info, key):
    for element in list(extra_info):
        db_key = element.find("DbKey")
        if db_key is not None and (db_key.text or "") == key:
            return element
    return None


def get_extra_info_value(extra_info, key):
    element = find_extra_info_element(extra_info, key)
    if element is None:
        return None
    db_val = element.find("DbVal")
    if db_val is None:
        return None
    return db_val.text


def set_extra_info_value(extra_info, key, value):
    import xml.etree.ElementTree as ET

    element = find_extra_info_element(extra_info, key)
    if element is None:
        element = ET.Element("Element")
        db_key = ET.SubElement(element, "DbKey")
        db_key.text = key
        db_val = ET.SubElement(element, "DbVal")
        db_val.text = value
        extra_info.append(element)
        return
    db_val = element.find("DbVal")
    if db_val is None:
        db_val = ET.SubElement(element, "DbVal")
    db_val.text = value


def decode_resolve_string_map(value):
    if not isinstance(value, str) or not value.strip():
        return {}
    try:
        raw = bytes.fromhex(re.sub(r"\s+", "", value))
        cursor = 0

        def read_u32():
            nonlocal cursor
            number = int.from_bytes(raw[cursor:cursor + 4], "big")
            cursor += 4
            return number

        result = {}
        count = read_u32()
        for _ in range(count):
            key_length = read_u32()
            key = raw[cursor:cursor + key_length].decode("utf-16-be")
            cursor += key_length
            value_length = read_u32()
            item = raw[cursor:cursor + value_length].decode("utf-16-be")
            cursor += value_length
            result[key] = item
        return result
    except Exception:
        return {}


def encode_resolve_string_map(value):
    items = list((value or {}).items())
    raw = len(items).to_bytes(4, "big")
    for key, item in items:
        key_bytes = str(key).encode("utf-16-be")
        value_bytes = str(item).encode("utf-16-be")
        raw += len(key_bytes).to_bytes(4, "big") + key_bytes
        raw += len(value_bytes).to_bytes(4, "big") + value_bytes
    return raw.hex()


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


def ensure_render_queue_empty(project):
    render_jobs = safe_call(project, "GetRenderJobList")
    jobs = list(iter_values(render_jobs or []))
    if jobs:
        raise HostError(
            "resolve_render_queue_not_empty",
            "Resolve Render Queue is not empty. Clear it manually before running Kairos color export.",
            {"renderJobCount": len(jobs), "renderJobs": normalize_render_job_list_for_error(jobs)},
        )


def normalize_render_job_list_for_error(jobs):
    normalized = []
    for job in jobs[:20]:
        if isinstance(job, dict):
            normalized.append({
                key: value
                for key, value in job.items()
                if isinstance(value, (str, int, float, bool)) or value is None
            })
        else:
            normalized.append(str(job))
    return normalized


def cleanup_created_render_jobs(project, render_jobs):
    for job in render_jobs:
        job_id = job.get("jobId") if isinstance(job, dict) else None
        if job_id:
            safe_call(project, "DeleteRenderJob", job_id)


def build_day_render_specs(clips, output_root):
    specs = []
    clips_by_dir = {}
    ordered_dirs = []
    for clip in clips:
        relative_dir = portable_parent_dir(clip["rawRelativePath"])
        if relative_dir not in clips_by_dir:
            clips_by_dir[relative_dir] = []
            ordered_dirs.append(relative_dir)
        clips_by_dir[relative_dir].append(clip)
    conflicts = []
    for relative_dir in ordered_dirs:
        dir_clips = clips_by_dir[relative_dir]
        by_stem = {}
        for clip in dir_clips:
            stem_key = str(clip.get("sourceStem") or "").strip().lower()
            if not stem_key:
                continue
            by_stem.setdefault(stem_key, []).append(clip)
        for stem_key, stem_clips in by_stem.items():
            if len(stem_clips) > 1:
                conflicts.append({
                    "relativeDir": relative_dir,
                    "sourceStem": stem_clips[0].get("sourceStem") or stem_key,
                    "rawRelativePaths": [clip["rawRelativePath"] for clip in stem_clips],
                })
        target_dir = output_root
        for segment in [part for part in relative_dir.split("/") if part]:
            target_dir = target_dir / segment
        specs.append({
            "relativeDir": relative_dir,
            "targetDir": target_dir,
            "clips": dir_clips,
        })
    if conflicts:
        raise HostError(
            "resolve_day_render_duplicate_source_stem",
            "A day-level render group contains duplicate source stems; direct Source Name rendering would overwrite files.",
            {"conflicts": conflicts},
        )
    return specs


def collect_root_direct_outputs(render_specs, clips, extension):
    entries = []
    for spec in render_specs:
        entries.extend(collect_direct_outputs_for_clips(
            spec["targetDir"],
            spec["clips"],
            extension,
            spec.get("jobId"),
        ))
    entries_by_key = {entry["rawRelativePath"]: entry for entry in entries}
    missing = [
        clip["rawRelativePath"]
        for clip in clips
        if clip["rawRelativePath"] not in entries_by_key
    ]
    if missing:
        raise HostError(
            "resolve_render_output_missing",
            "Unable to locate every rendered output for root batch.",
            {"rawRelativePaths": missing},
        )
    return [entries_by_key[clip["rawRelativePath"]] for clip in clips]


def collect_direct_outputs_for_clips(render_dir, clips, extension, render_job_id=None):
    if not clips:
        return []
    render_dir = Path(render_dir)
    if not render_dir.is_dir():
        raise HostError(
            "resolve_render_output_missing",
            "Resolve render output directory is missing.",
            {"renderDir": str(render_dir)},
        )
    extension_key = f".{extension.lstrip('.').lower()}"
    candidates = [
        path
        for path in render_dir.iterdir()
        if path.is_file() and path.suffix.lower() == extension_key
    ]
    entries = []
    for clip in clips:
        expected_path = (render_dir / clip["normalizedOutputFilename"]).resolve()
        unexpected_variants = [
            path.resolve()
            for path in candidates
            if path.resolve() != expected_path and rendered_output_is_source_name_variant(path, clip["sourceStem"])
        ]
        if unexpected_variants:
            raise HostError(
                "resolve_render_output_bad_source_name",
                f"Resolve rendered {clip['sourceStem']} with a prefix/suffix instead of exact Source Name.",
                {
                    "rawRelativePath": clip["rawRelativePath"],
                    "renderDir": str(render_dir),
                    "expectedPath": str(expected_path),
                    "candidatePaths": [str(path) for path in sorted(unexpected_variants, key=lambda value: value.name)],
                },
            )
        nested_output = find_single_nested_source_name_output(render_dir, clip, extension_key)
        if nested_output is not None and nested_output_should_replace_expected(nested_output, expected_path):
            promote_nested_source_name_output(nested_output, expected_path, clip)
            candidates.append(expected_path)
        if not expected_path.is_file():
            raise HostError(
                "resolve_render_output_missing",
                f"Unable to locate rendered output for {clip['normalizedOutputFilename']}",
                {
                    "rawRelativePath": clip["rawRelativePath"],
                    "renderDir": str(render_dir),
                    "expectedPath": str(expected_path),
                    "candidatePaths": [str(path) for path in sorted(candidates, key=lambda value: value.name)],
                },
            )
        entries.append({
            "rawRelativePath": clip["rawRelativePath"],
            "outputPath": str(expected_path),
            "normalizedOutputFilename": clip["normalizedOutputFilename"],
            "renderJobId": str(render_job_id) if render_job_id is not None else None,
        })
    return entries


def find_single_nested_source_name_output(render_dir, clip, extension_key):
    expected_name = stringify_signal_value(clip.get("normalizedOutputFilename"))
    if not expected_name:
        return None
    matches = []
    for child in sorted(render_dir.iterdir(), key=lambda value: value.name):
        if not child.is_dir():
            continue
        for candidate in sorted(child.iterdir(), key=lambda value: value.name):
            if candidate.is_file() and candidate.suffix.lower() == extension_key and candidate.name.lower() == expected_name.lower():
                matches.append(candidate)
    if len(matches) > 1:
        raise HostError(
            "resolve_render_output_nested_ambiguous",
            f"Resolve rendered multiple nested outputs for {expected_name}.",
            {
                "rawRelativePath": clip["rawRelativePath"],
                "renderDir": str(render_dir),
                "candidatePaths": [str(path) for path in matches],
            },
        )
    return matches[0] if matches else None


def nested_output_should_replace_expected(nested_output, expected_path):
    if not expected_path.exists():
        return True
    if not expected_path.is_file():
        return True
    try:
        return nested_output.stat().st_mtime >= expected_path.stat().st_mtime
    except OSError:
        return True


def promote_nested_source_name_output(nested_output, expected_path, clip):
    nested_dir = nested_output.parent
    nested_files = [path for path in nested_dir.iterdir() if path.is_file()]
    if len(nested_files) != 1:
        raise HostError(
            "resolve_render_output_nested_dir_not_single_file",
            "Resolve rendered a nested output directory that is not safe to promote.",
            {
                "rawRelativePath": clip["rawRelativePath"],
                "nestedDir": str(nested_dir),
                "nestedFiles": [str(path) for path in nested_files],
            },
        )
    if expected_path.exists():
        if expected_path.is_file():
            expected_path.unlink()
        else:
            raise HostError(
                "resolve_render_output_target_not_file",
                "Cannot promote Resolve nested output because the final target is not a file.",
                {
                    "rawRelativePath": clip["rawRelativePath"],
                    "nestedOutput": str(nested_output),
                    "expectedPath": str(expected_path),
                },
            )
    expected_path.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(nested_output), str(expected_path))
    try:
        nested_dir.rmdir()
    except OSError:
        pass


def safe_path_segment(value):
    text = str(value or "").strip()
    if not text:
        return "unnamed"
    return re.sub(r"[^A-Za-z0-9._-]+", "_", text)


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


def assert_timeline_contains_selected_clips(timeline, raw_local_path, selected_clip_keys):
    remaining = []
    unresolved_count = 0
    for item in iter_timeline_video_items(timeline):
        file_path = extract_clip_like_file_path(item)
        if not file_path:
            unresolved_count += 1
            continue
        try:
            clip_key = to_portable_relative(raw_local_path, file_path)
        except ValueError:
            unresolved_count += 1
            continue
        remaining.append(clip_key)
    remaining_set = set(remaining)
    selected_set = set(selected_clip_keys)
    missing = sorted(selected_set - remaining_set)
    extra = sorted(remaining_set - selected_set)
    duplicate_remaining = sorted({
        clip_key
        for clip_key in remaining
        if remaining.count(clip_key) > 1
    })
    if missing or extra or unresolved_count or duplicate_remaining:
        raise HostError(
            "resolve_timeline_subset_verify_failed",
            "Temporary render timeline does not exactly match the requested day clip set.",
            {
                "missing": missing,
                "extra": extra,
                "duplicateRemaining": duplicate_remaining,
                "unresolvedCount": unresolved_count,
            },
        )


def queue_root_render_job(project, target_dir, render_format, clips):
    Path(target_dir).mkdir(parents=True, exist_ok=True)
    settings = {
        "TargetDir": str(target_dir),
        "SelectAllFrames": True,
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
        settings["FrameRate"] = next(iter(unique_fps_values))
    encoding_profile = default_render_encoding_profile(render_format)
    if encoding_profile and not needs_windows_fixed_bitrate_preset(render_format):
        settings["EncodingProfile"] = encoding_profile
    if render_format.get("audioCodec"):
        settings["AudioCodec"] = render_format["audioCodec"]
    if render_format.get("bitrateKbps") and not needs_windows_fixed_bitrate_preset(render_format):
        settings["VideoQuality"] = max(1, int(round(float(render_format["bitrateKbps"]))))
    set_root_render_settings(project, settings)
    job_id = safe_call(project, "AddRenderJob")
    if job_id is False or job_id is None:
        raise HostError("resolve_add_render_job_failed", "Unable to queue render job for root render batch")
    try:
        assert_render_job_uses_source_names(project, str(job_id), clips)
    except HostError:
        safe_call(project, "DeleteRenderJob", str(job_id))
        raise
    return str(job_id)


def assert_render_job_uses_source_names(project, job_id, clips):
    render_jobs = safe_call(project, "GetRenderJobList")
    jobs = list(iter_values(render_jobs or []))
    if not jobs:
        return
    target_job = None
    for job in jobs:
        if isinstance(job, dict) and stringify_signal_value(job.get("JobId") or job.get("Job ID") or job.get("jobId")) == job_id:
            target_job = job
            break
    if target_job is None:
        return
    output_filename = stringify_signal_value(target_job.get("OutputFilename"))
    if not output_filename:
        return
    first_output = extract_render_job_first_output_filename(output_filename)
    expected_filenames = collect_render_job_expected_filenames(clips)
    expected_stems = collect_render_job_expected_stems(clips)
    if render_job_output_matches_source_name(first_output, expected_filenames, expected_stems):
        return
    raise HostError(
        "resolve_render_job_filename_mode_failed",
        "Resolve queued a render job that is not using Source Name filenames.",
        {
            "jobId": job_id,
            "outputFilename": output_filename,
            "firstOutputFilename": first_output,
            "expectedSourceNameFilenames": sorted(expected_filenames),
            "expectedSourceNameStems": sorted(expected_stems),
        },
    )


def extract_render_job_first_output_filename(output_filename):
    text = stringify_signal_value(output_filename).strip()
    if not text:
        return ""
    # Resolve returns a UI display string here. Recent Windows builds may include
    # English counts ("C0001.mp4 and 24 more") or Chinese localization
    # ("C0001.mp4 及更多") for multi-clip Source Name jobs.
    text = re.sub(r"\s+and(?:\s+\d+)?\s+more\s*$", "", text, flags=re.IGNORECASE)
    text = re.sub(r"\s+及更多\s*$", "", text)
    return text.strip()


def collect_render_job_expected_filenames(clips):
    return {
        stringify_signal_value(clip.get("normalizedOutputFilename")).lower()
        for clip in clips
        if stringify_signal_value(clip.get("normalizedOutputFilename"))
    }


def collect_render_job_expected_stems(clips):
    return {
        stringify_signal_value(clip.get("sourceStem")).lower()
        or Path(stringify_signal_value(clip.get("normalizedOutputFilename"))).stem.lower()
        for clip in clips
        if stringify_signal_value(clip.get("sourceStem"))
        or stringify_signal_value(clip.get("normalizedOutputFilename"))
    }


def render_job_output_matches_source_name(first_output, expected_filenames, expected_stems):
    candidate = stringify_signal_value(first_output).replace("\\", "/").strip()
    if not candidate:
        return True
    candidate_name = candidate.rsplit("/", 1)[-1].strip()
    candidate_lower = candidate_name.lower()
    if candidate_lower in expected_filenames:
        return True
    candidate_stem = Path(candidate_name).stem.lower()
    has_candidate_extension = bool(Path(candidate_name).suffix)
    return not has_candidate_extension and candidate_stem in expected_stems


def set_root_render_settings(project, settings):
    committed_settings = {}
    attempts = []
    base_keys = [
        "TargetDir",
        "SelectAllFrames",
        "ExportVideo",
        "ExportAudio",
    ]
    ordered_keys = [
        "FormatWidth",
        "FormatHeight",
        "FrameRate",
        "EncodingProfile",
        "AudioCodec",
        "RateControl",
        "VideoQuality",
    ]
    for key in base_keys:
        if key in settings:
            committed_settings[key] = settings[key]
    apply_root_render_settings_step(project, "base", committed_settings, settings, attempts)
    for key in ordered_keys:
        if key not in settings:
            continue
        committed_settings[key] = settings[key]
        apply_root_render_settings_step(project, key, committed_settings, settings, attempts)
    return committed_settings


def apply_root_render_settings_step(project, step_name, step_settings, full_settings, attempts):
    attempt = {
        "step": step_name,
        "settings": dict(step_settings),
    }
    attempts.append(attempt)
    method = getattr(project, "SetRenderSettings", None)
    if method is None:
        raise HostError(
            "resolve_render_settings_failed",
            "Resolve object is missing SetRenderSettings",
            {
                "renderSettings": full_settings,
                "failedRenderSetting": step_name,
                "attemptedRenderSettings": attempts,
            },
        )
    error_message = None
    try:
        result = method(dict(step_settings))
    except Exception as error:
        result = False
        error_message = str(error)
    if result is True:
        return
    details = {
        "renderSettings": full_settings,
        "failedRenderSetting": step_name,
        "failedRenderSettings": dict(step_settings),
        "attemptedRenderSettings": attempts,
    }
    if error_message:
        details["error"] = error_message
    raise HostError(
        "resolve_render_settings_failed",
        f"Unable to set render setting {step_name} for root render batch",
        details,
    )


def start_rendering(project, job_ids):
    if job_ids:
        result = safe_call(project, "StartRendering", job_ids, False)
        if result is False:
            result = safe_call(project, "StartRendering", job_ids)
    else:
        result = safe_call(project, "StartRendering", False)
        if result is False:
            result = safe_call(project, "StartRendering")
    if result is False:
        raise HostError("resolve_start_render_failed", "Unable to start Resolve rendering")


def wait_for_render(project, job_ids=None):
    while True:
        in_progress = safe_call(project, "IsRenderingInProgress")
        if not in_progress:
            break
        time.sleep(1)
    for job_id in job_ids or []:
        status = safe_call(project, "GetRenderJobStatus", job_id)
        if render_job_status_failed(status):
            raise HostError(
                "resolve_render_failed_or_stopped",
                "Resolve render job did not complete successfully.",
                {"jobId": job_id, "renderJobStatus": status},
            )


def rendered_output_is_source_name_variant(path, source_stem):
    candidate_stem = path.stem
    if not isinstance(candidate_stem, str) or not candidate_stem:
        return False
    pattern = re.compile(rf"(?:^|[_-]){re.escape(source_stem)}(?:[_-]\d+)?$", re.IGNORECASE)
    return bool(pattern.search(candidate_stem))


def render_job_status_failed(status):
    if not isinstance(status, dict):
        return False
    status_text = str(
        status.get("JobStatus")
        or status.get("Status")
        or status.get("status")
        or ""
    ).strip().lower()
    if any(token in status_text for token in ("fail", "cancel", "stop", "abort", "error")):
        return True
    completion = parse_float(
        status.get("CompletionPercentage")
        or status.get("Completion")
        or status.get("completion")
    )
    if completion is not None and completion < 100 and not any(token in status_text for token in ("complete", "success", "done")):
        return True
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


def save_project(project, resolve=None):
    project_manager = safe_call(resolve, "GetProjectManager") if resolve is not None else None
    saved = safe_call(project_manager, "SaveProject") if project_manager is not None else None
    if saved is False or saved is None:
        safe_call(project, "SaveProject")


def save_project_with_result(project, resolve=None):
    project_manager = safe_call(resolve, "GetProjectManager") if resolve is not None else None
    saved = safe_call(project_manager, "SaveProject") if project_manager is not None else None
    if saved is not False and saved is not None:
        return bool(saved)
    fallback = safe_call(project, "SaveProject")
    return fallback is not False and fallback is not None


def export_project_snapshot(resolve, project, payload, mode, stage):
    snapshot_root_value = (
        stringify_signal_value(payload.get("drpSnapshotRoot"))
        or stringify_signal_value(payload.get("snapshotRoot"))
    )
    if not snapshot_root_value:
        return None
    project_manager = require_method(resolve, "GetProjectManager")()
    project_name = stringify_signal_value(safe_call(project, "GetName")) or payload["resolveProjectName"]
    snapshot_root = Path(snapshot_root_value).expanduser().resolve()
    snapshot_root.mkdir(parents=True, exist_ok=True)
    created_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    timestamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    label = (
        stringify_signal_value(payload.get("drpSnapshotLabel"))
        or stringify_signal_value(payload.get("snapshotLabel"))
        or stage
    )
    chunk_id = stringify_signal_value(payload.get("chunkId"))
    retention = normalize_drp_snapshot_retention(payload.get("retention") or payload.get("snapshotRetention"))
    latest_filename = sanitize_latest_drp_filename(
        stringify_signal_value(payload.get("latestFilename")) or "latest.drp"
    )
    latest_path = snapshot_root / latest_filename
    if retention == "archive":
        snapshots_root = snapshot_root / "snapshots"
        snapshots_root.mkdir(parents=True, exist_ok=True)
        label_parts = [label, chunk_id]
        filename = f"{timestamp}-{sanitize_filename('-'.join([part for part in label_parts if part]))}.drp"
        snapshot_path = snapshots_root / filename
        exported = safe_call(project_manager, "ExportProject", project_name, str(snapshot_path), False)
        if exported is False or not snapshot_path.is_file():
            raise HostError(
                "resolve_project_export_failed",
                f"Unable to export Resolve project snapshot: {snapshot_path}",
                {
                    "projectName": project_name,
                    "snapshotPath": str(snapshot_path),
                },
            )
        shutil.copy2(snapshot_path, latest_path)
    else:
        temp_path = snapshot_root / f".{latest_path.stem}-{timestamp}-{uuid.uuid4().hex[:8]}.tmp.drp"
        try:
            exported = safe_call(project_manager, "ExportProject", project_name, str(temp_path), False)
            if exported is False or not temp_path.is_file():
                raise HostError(
                    "resolve_project_export_failed",
                    f"Unable to export Resolve project snapshot: {temp_path}",
                    {
                        "projectName": project_name,
                        "snapshotPath": str(temp_path),
                    },
                )
            os.replace(temp_path, latest_path)
        finally:
            if temp_path.exists():
                temp_path.unlink()
        snapshot_path = latest_path
    return {
        "projectName": project_name,
        "snapshotPath": str(snapshot_path),
        "latestPath": str(latest_path),
        "createdAt": created_at,
        "mode": mode,
        "retention": retention,
        "action": stringify_signal_value(payload.get("action")) or stage,
        "rootId": stringify_signal_value(payload.get("rootId")),
        "chunkId": chunk_id,
        "database": normalize_database_info(safe_call(project_manager, "GetCurrentDatabase")),
        "detail": f"{stage} exported withStillsAndLUTs=false retention={retention}",
    }


def normalize_drp_snapshot_retention(value):
    text = stringify_signal_value(value)
    return "archive" if text == "archive" else "latest-only"


def normalize_database_info(value):
    if not isinstance(value, dict):
        return None
    normalized = {}
    for key, item in value.items():
        key_text = stringify_signal_value(key)
        if not key_text:
            continue
        if isinstance(item, (str, int, float, bool)) or item is None:
            normalized[key_text] = item
        else:
            normalized[key_text] = stringify_signal_value(item)
    return normalized


def sanitize_filename(value):
    text = stringify_signal_value(value) or "snapshot"
    sanitized = re.sub(r"[^A-Za-z0-9._-]+", "-", text).strip("-")
    return sanitized or "snapshot"


def sanitize_latest_drp_filename(value):
    text = stringify_signal_value(value) or "latest.drp"
    text = re.sub(r'[<>:"/\\|?*\x00-\x1f]+', "-", text).strip()
    text = text.strip(".")
    if not text:
        text = "latest.drp"
    if not text.lower().endswith(".drp"):
        text = f"{text}.drp"
    return text


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
