#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
import traceback
from pathlib import Path

def _bootstrap_read_json(path):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except Exception:
        return {}


def _bootstrap_workspace_root():
    try:
        script_dir = Path(__file__).resolve().parent
    except NameError:
        script_dir = Path.cwd()
    link = _bootstrap_read_json(script_dir / "kairos_workspace.json")
    root = Path(str(link.get("workspaceRoot") or "")).expanduser()
    if root.exists():
        return root
    for candidate in (script_dir, *script_dir.parents):
        if (candidate / "config" / "runtime.json").exists():
            return candidate
    return None


def _bootstrap_strip_resolve_suffix(name):
    return re.sub(r"\s+\[(?:Edit|Color)\]\s*$", "", str(name or "").strip(), flags=re.IGNORECASE)


def _bootstrap_project_name_from_args():
    args = list(sys.argv or [])
    for index, value in enumerate(args):
        if value == "--project-name" and index + 1 < len(args):
            return args[index + 1]
    if len(args) >= 3 and args[1] == "--synthesize-job":
        job = _bootstrap_read_json(Path(args[2]).expanduser())
        if isinstance(job, dict):
            return str(job.get("projectName") or "")
    return ""


def _bootstrap_project_name_from_resolve():
    try:
        current = globals().get("resolve")
        if not current:
            return ""
        manager = current.GetProjectManager()
        project = manager.GetCurrentProject() if manager else None
        return str(project.GetName() or "") if project else ""
    except Exception:
        return ""


def _bootstrap_project_tmp_root():
    workspace_root = _bootstrap_workspace_root()
    if not workspace_root:
        return Path.home() / "Movies" / "KairosVoiceover"
    project_name = _bootstrap_project_name_from_args() or _bootstrap_project_name_from_resolve()
    wanted = {project_name, _bootstrap_strip_resolve_suffix(project_name)}
    wanted = {value for value in wanted if value}
    projects_root = workspace_root / "projects"
    if wanted and projects_root.exists():
        for project_dir in sorted(projects_root.iterdir()):
            brief = _bootstrap_read_json(project_dir / "config" / "project-brief.json")
            if not isinstance(brief, dict):
                continue
            brief_name = str(brief.get("name") or "")
            voiceover_media = brief.get("voiceoverMedia")
            aliases = voiceover_media.get("resolveProjectAliases") if isinstance(voiceover_media, dict) else []
            keys = {
                project_dir.name,
                _bootstrap_strip_resolve_suffix(project_dir.name),
                brief_name,
                _bootstrap_strip_resolve_suffix(brief_name),
            }
            if isinstance(aliases, list):
                for alias in aliases:
                    alias_text = str(alias or "")
                    if alias_text:
                        keys.add(alias_text)
                        keys.add(_bootstrap_strip_resolve_suffix(alias_text))
            if keys.intersection(wanted):
                return project_dir / ".tmp" / "resolve-volc-voiceover-plugin"
    return workspace_root / ".tmp" / "resolve-volc-voiceover-plugin"


def bootstrap_log(message):
    try:
        log_dir = _bootstrap_project_tmp_root() / "logs"
        log_dir.mkdir(parents=True, exist_ok=True)
        with (log_dir / "resolve-plugin-bootstrap.log").open("a", encoding="utf-8") as handle:
            handle.write(time.strftime("[%Y-%m-%d %H:%M:%S] "))
            handle.write(str(message))
            handle.write("\n")
    except Exception:
        pass


try:
    SCRIPT_DIR = Path(__file__).resolve().parent
except NameError:
    SCRIPT_DIR = Path.cwd()
bootstrap_log(f"bootstrap start file={globals().get('__file__', '<missing>')} cwd={Path.cwd()} argv={sys.argv}")

for module_dir in (
    SCRIPT_DIR / "KairosVolcVoiceoverLib",
    SCRIPT_DIR / "Kairos Volc Voiceover",
    SCRIPT_DIR,
):
    if str(module_dir) not in sys.path:
        sys.path.insert(0, str(module_dir))

bootstrap_log("before core import")
try:
    from kairos_volc_voiceover_core import (  # noqa: E402
        DEFAULT_RESOURCE_ID,
        DEFAULT_TTS_ENDPOINT,
        PLUGIN_VERSION,
        TtsSettings,
        VoiceCloneClient,
        VoiceoverError,
        build_project_plugin_tmp_dir,
        build_project_voiceover_run_dir,
        build_run_dir,
        clean_subtitle_text,
        default_config_path,
        extract_subtitle_text,
        frame_to_timecode,
        frames_to_ms,
        load_config,
        merge_selected_subtitles_for_synthesis,
        safe_segment,
        save_config,
        stable_hash,
        synthesize_unit,
        timecode_to_frame,
        unit_id_for_subtitle,
        write_manifest,
    )
except Exception:
    bootstrap_log("core import failed\n" + traceback.format_exc())
    raise
bootstrap_log("core import ok")


WINDOW_ID = "com.dtysky.kairos.volcvoiceover"
VOICE_TRACK_NAME = "Kairos VO"
VOICE_MEDIA_BIN_NAME = "Kairos Voiceover"
_ACTIVE_WINDOW = None


def startup_log(message):
    try:
        log_dir = _bootstrap_project_tmp_root() / "logs"
        log_dir.mkdir(parents=True, exist_ok=True)
        with (log_dir / "resolve-plugin.log").open("a", encoding="utf-8") as handle:
            handle.write(time.strftime("[%Y-%m-%d %H:%M:%S] "))
            handle.write(str(message))
            handle.write("\n")
    except Exception:
        pass


def _safe_call(obj, method_name, *args):
    if obj is None:
        return None
    method = getattr(obj, method_name, None)
    if not method:
        return None
    try:
        return method(*args)
    except TypeError:
        try:
            return method()
        except Exception:
            return None
    except Exception:
        return None


def _iter_values(value):
    if isinstance(value, dict):
        return value.values()
    if isinstance(value, (list, tuple)):
        return value
    return []


def resolve_bin_name(value, fallback="Timeline"):
    text = str(value or "").strip()
    if not text:
        text = fallback
    text = re.sub(r"[\x00-\x1f\x7f]+", " ", text)
    text = text.replace("/", "／").replace("\\", "＼")
    text = re.sub(r"\s+", " ", text).strip()
    return text[:80] or fallback


def _get_resolve():
    existing = globals().get("resolve")
    if existing:
        return existing
    try:
        import DaVinciResolveScript as dvr_script
    except ImportError:
        modules = "/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting/Modules"
        if modules not in sys.path:
            sys.path.append(modules)
        import DaVinciResolveScript as dvr_script
    return dvr_script.scriptapp("Resolve")


def _get_bmd_module():
    existing = globals().get("bmd")
    if existing:
        return existing
    try:
        import DaVinciResolveScript as dvr_script
    except ImportError:
        modules = "/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting/Modules"
        if modules not in sys.path:
            sys.path.append(modules)
        import DaVinciResolveScript as dvr_script
    return dvr_script


class ResolveVoiceoverBridge:
    def __init__(self, resolve):
        self.resolve = resolve

    def project(self):
        manager = _safe_call(self.resolve, "GetProjectManager")
        return _safe_call(manager, "GetCurrentProject")

    def timeline(self):
        project = self.project()
        return _safe_call(project, "GetCurrentTimeline")

    def media_pool(self):
        project = self.project()
        return _safe_call(project, "GetMediaPool")

    def fps(self):
        project = self.project()
        timeline = self.timeline()
        for obj in (timeline, project):
            settings = _safe_call(obj, "GetSetting")
            if isinstance(settings, dict):
                for key in ("timelineFrameRate", "timelinePlaybackFrameRate"):
                    try:
                        value = float(settings.get(key) or 0)
                    except (TypeError, ValueError):
                        value = 0
                    if value > 0:
                        return value
            for key in ("timelineFrameRate", "timelinePlaybackFrameRate"):
                try:
                    value = float(_safe_call(obj, "GetSetting", key) or 0)
                except (TypeError, ValueError):
                    value = 0
                if value > 0:
                    return value
        return 24.0

    def timeline_id(self):
        timeline = self.timeline()
        unique_id = _safe_call(timeline, "GetUniqueId")
        if unique_id:
            return str(unique_id)
        return stable_hash(_safe_call(timeline, "GetName") or "timeline", 12)

    def project_name(self):
        project = self.project()
        return str(_safe_call(project, "GetName") or "Resolve Project")

    def timeline_name(self):
        timeline = self.timeline()
        return str(_safe_call(timeline, "GetName") or "Timeline")

    def collect_subtitles(self):
        timeline = self.timeline()
        if not timeline:
            raise VoiceoverError("resolve_timeline_missing", "No current Resolve timeline.")
        fps = self.fps()
        results = []
        track_count = _safe_call(timeline, "GetTrackCount", "subtitle") or 0
        for track_index in range(1, int(track_count) + 1):
            items = _safe_call(timeline, "GetItemListInTrack", "subtitle", track_index)
            if items is None:
                items = _safe_call(timeline, "GetItemsInTrack", "subtitle", track_index)
            for item in _iter_values(items):
                summary = self.summarize_item(item, "subtitle", track_index, fps)
                if summary:
                    results.append(summary)
        results.sort(key=lambda row: (row.get("startFrame") or 0, row.get("trackIndex") or 0))
        for index, row in enumerate(results, start=1):
            row["subtitleIndex"] = index
            row["unitId"] = unit_id_for_subtitle(self.timeline_id(), row)
        return results

    def summarize_item(self, item, track_type, track_index, fps):
        start = self._timeline_number(item, "GetStart")
        end = self._timeline_number(item, "GetEnd")
        duration = self._timeline_number(item, "GetDuration")
        if start is None and end is not None and duration is not None:
            start = end - duration
        if end is None and start is not None and duration is not None:
            end = start + duration
        property_map = _safe_call(item, "GetProperty")
        clip_property = _safe_call(item, "GetClipProperty")
        summary = {
            "trackType": track_type,
            "trackIndex": track_index,
            "name": str(_safe_call(item, "GetName") or ""),
            "startFrame": start,
            "endFrame": end,
            "durationFrames": duration,
            "timelineInMs": frames_to_ms(start, fps),
            "timelineOutMs": frames_to_ms(end, fps),
            "durationMs": frames_to_ms(duration, fps),
            "property": property_map if isinstance(property_map, dict) else {},
            "clipProperty": clip_property if isinstance(clip_property, dict) else {},
        }
        summary["text"] = extract_subtitle_text(summary)
        summary["startTimecode"] = frame_to_timecode(start or 0, fps)
        summary["endTimecode"] = frame_to_timecode(end or 0, fps)
        return summary

    def _timeline_number(self, item, method_name):
        value = _safe_call(item, method_name)
        if value is None:
            value = _safe_call(item, method_name, False)
        try:
            return float(value)
        except (TypeError, ValueError):
            return None

    def current_frame(self):
        timeline = self.timeline()
        if not timeline:
            return None
        timecode = _safe_call(timeline, "GetCurrentTimecode")
        return timecode_to_frame(str(timecode), self.fps())

    def mark_range(self):
        timeline = self.timeline()
        mark = _safe_call(timeline, "GetMarkInOut")
        if not isinstance(mark, dict):
            return None
        for key in ("all", "video", "audio"):
            current = mark.get(key)
            if isinstance(current, dict) and "in" in current and "out" in current:
                return float(current["in"]), float(current["out"])
        if "in" in mark and "out" in mark:
            return float(mark["in"]), float(mark["out"])
        return None

    def ensure_voice_track(self):
        timeline = self.timeline()
        if not timeline:
            raise VoiceoverError("resolve_timeline_missing", "No current Resolve timeline.")
        count = int(_safe_call(timeline, "GetTrackCount", "audio") or 0)
        for index in range(1, count + 1):
            if _safe_call(timeline, "GetTrackName", "audio", index) == VOICE_TRACK_NAME:
                return index
        return self.create_voice_track()

    def create_voice_track(self):
        timeline = self.timeline()
        if not timeline:
            raise VoiceoverError("resolve_timeline_missing", "No current Resolve timeline.")
        count = int(_safe_call(timeline, "GetTrackCount", "audio") or 0)
        name = self.next_voice_track_name()
        added = _safe_call(timeline, "AddTrack", "audio", "stereo")
        if added is False:
            added = _safe_call(timeline, "AddTrack", "audio")
        if added is False:
            raise VoiceoverError("resolve_audio_track_create_failed", "Unable to create Kairos VO audio track.")
        new_count = int(_safe_call(timeline, "GetTrackCount", "audio") or count)
        track_index = new_count if new_count > count else count + 1
        _safe_call(timeline, "SetTrackName", "audio", track_index, name)
        return track_index

    def next_voice_track_name(self):
        timeline = self.timeline()
        count = int(_safe_call(timeline, "GetTrackCount", "audio") or 0) if timeline else 0
        existing = set()
        for index in range(1, count + 1):
            existing.add(str(_safe_call(timeline, "GetTrackName", "audio", index) or ""))
        if VOICE_TRACK_NAME not in existing:
            return VOICE_TRACK_NAME
        suffix = 2
        while True:
            candidate = f"{VOICE_TRACK_NAME} {suffix}"
            if candidate not in existing:
                return candidate
            suffix += 1

    def voice_track_indexes(self):
        timeline = self.timeline()
        count = int(_safe_call(timeline, "GetTrackCount", "audio") or 0) if timeline else 0
        indexes = []
        for index in range(1, count + 1):
            name = str(_safe_call(timeline, "GetTrackName", "audio", index) or "")
            if name == VOICE_TRACK_NAME or name.startswith(f"{VOICE_TRACK_NAME} "):
                indexes.append(index)
        return indexes

    def ensure_voice_track_for_unit(self, unit_result):
        target_start, target_end = self.unit_timeline_range(unit_result)
        for index in self.voice_track_indexes():
            if not self.audio_track_has_overlap(index, target_start, target_end):
                return index
        adopted = self.adopt_available_audio_track(target_start, target_end)
        if adopted is not None:
            return adopted
        return self.create_voice_track()

    def adopt_available_audio_track(self, target_start, target_end):
        timeline = self.timeline()
        if not timeline:
            return None
        count = int(_safe_call(timeline, "GetTrackCount", "audio") or 0)
        voice_indexes = set(self.voice_track_indexes())
        for index in range(2, count + 1):
            if index in voice_indexes:
                continue
            if self.audio_track_locked_or_disabled(index):
                continue
            if self.audio_track_has_overlap(index, target_start, target_end):
                continue
            _safe_call(timeline, "SetTrackName", "audio", index, self.next_voice_track_name())
            return index
        return None

    def audio_track_locked_or_disabled(self, track_index):
        timeline = self.timeline()
        locked = _safe_call(timeline, "GetIsTrackLocked", "audio", track_index)
        if locked is True:
            return True
        enabled = _safe_call(timeline, "GetIsTrackEnabled", "audio", track_index)
        if enabled is False:
            return True
        return False

    def unit_timeline_range(self, unit_result):
        subtitle = unit_result.get("subtitle") or {}
        start = self._number(subtitle.get("startFrame"), 0.0)
        end = self._number(subtitle.get("endFrame"), None)
        if end is None:
            duration_frames = self._number(subtitle.get("durationFrames"), None)
            if duration_frames is None:
                duration_ms = self._number(unit_result.get("durationMs"), self._number(subtitle.get("durationMs"), 1000.0))
                duration_frames = max(1.0, duration_ms * self.fps() / 1000.0)
            end = start + duration_frames
        if end <= start:
            end = start + 1
        return start, end

    def audio_track_has_overlap(self, track_index, target_start, target_end):
        timeline = self.timeline()
        items = _safe_call(timeline, "GetItemListInTrack", "audio", track_index)
        if items is None:
            items = _safe_call(timeline, "GetItemsInTrack", "audio", track_index)
        for item in _iter_values(items):
            item_start = self._timeline_item_number(item, "GetStart")
            item_end = self._timeline_item_number(item, "GetEnd")
            if item_start is None or item_end is None:
                continue
            if item_start < target_end and target_start < item_end:
                return True
        return False

    def _timeline_item_number(self, item, method_name):
        for args in ((False,), (True,), ()):
            value = _safe_call(item, method_name, *args)
            number = self._number(value, None)
            if number is not None:
                return number
        return None

    def _number(self, value, fallback=None):
        try:
            return float(value)
        except (TypeError, ValueError):
            return fallback

    def voiceover_media_folder(self, timeline_name=None):
        media_pool = self.media_pool()
        if not media_pool:
            raise VoiceoverError("resolve_media_pool_missing", "Resolve Media Pool is unavailable.")
        root_folder = _safe_call(media_pool, "GetRootFolder")
        if not root_folder:
            raise VoiceoverError("resolve_media_pool_root_missing", "Resolve Media Pool root folder is unavailable.")
        root_bin = self.ensure_child_folder(media_pool, root_folder, VOICE_MEDIA_BIN_NAME)
        timeline_bin = self.ensure_child_folder(
            media_pool,
            root_bin,
            resolve_bin_name(timeline_name or self.timeline_name(), "Timeline"),
        )
        return timeline_bin

    def ensure_child_folder(self, media_pool, parent_folder, folder_name):
        wanted = resolve_bin_name(folder_name, "Folder")
        existing = self.find_child_folder(parent_folder, wanted)
        if existing:
            return existing
        created = _safe_call(media_pool, "AddSubFolder", parent_folder, wanted)
        if created and created is not True:
            return created
        existing = self.find_child_folder(parent_folder, wanted)
        if existing:
            return existing
        raise VoiceoverError(
            "resolve_media_pool_bin_failed",
            f"Unable to create or find Media Pool bin: {wanted}",
        )

    def find_child_folder(self, parent_folder, folder_name):
        children = _safe_call(parent_folder, "GetSubFolderList")
        if children is None:
            children = _safe_call(parent_folder, "GetSubFolders")
        for child in _iter_values(children):
            if str(_safe_call(child, "GetName") or "") == folder_name:
                return child
        return None

    def delete_previous_plugin_audio(self, unit_ids):
        timeline = self.timeline()
        if not timeline:
            return 0
        count = int(_safe_call(timeline, "GetTrackCount", "audio") or 0)
        to_delete = []
        wanted = set(unit_ids)
        for track_index in range(1, count + 1):
            items = _safe_call(timeline, "GetItemListInTrack", "audio", track_index)
            if items is None:
                items = _safe_call(timeline, "GetItemsInTrack", "audio", track_index)
            for item in _iter_values(items):
                markers = _safe_call(item, "GetMarkers")
                if marker_has_unit(markers, wanted):
                    to_delete.append(item)
        if not to_delete:
            return 0
        result = _safe_call(timeline, "DeleteClips", to_delete, False)
        if result is False:
            result = _safe_call(timeline, "DeleteClips", to_delete)
        if result is False:
            raise VoiceoverError("resolve_delete_previous_failed", "Failed to delete previous plugin audio.")
        return len(to_delete)

    def import_and_insert(self, unit_result, audio_track_index, media_folder=None):
        media_pool = self.media_pool()
        if not media_pool:
            raise VoiceoverError("resolve_media_pool_missing", "Resolve Media Pool is unavailable.")
        path = unit_result["resolveAudioPath"]
        target_folder = media_folder or self.voiceover_media_folder()
        previous_folder = _safe_call(media_pool, "GetCurrentFolder")
        switched = _safe_call(media_pool, "SetCurrentFolder", target_folder)
        if switched is False:
            raise VoiceoverError("resolve_media_pool_bin_select_failed", "Unable to select Kairos Voiceover Media Pool bin.")
        try:
            imported = _safe_call(media_pool, "ImportMedia", [path])
        finally:
            if previous_folder:
                _safe_call(media_pool, "SetCurrentFolder", previous_folder)
        item = None
        for candidate in _iter_values(imported):
            item = candidate
            break
        if item is None:
            raise VoiceoverError("resolve_import_failed", f"Unable to import generated audio: {path}")
        subtitle = unit_result["subtitle"]
        clip_info = {
            "mediaPoolItem": item,
            "mediaType": 2,
            "trackIndex": audio_track_index,
            "recordFrame": int(round(float(subtitle.get("startFrame") or 0))),
        }
        appended = _safe_call(media_pool, "AppendToTimeline", [clip_info])
        appended_item = None
        for candidate in _iter_values(appended):
            appended_item = candidate
            break
        if appended_item is None:
            raise VoiceoverError("resolve_append_failed", f"Unable to append generated audio: {path}")
        unit_id = unit_result["unitId"]
        _safe_call(appended_item, "SetName", f"Kairos VO {unit_id}")
        _safe_call(appended_item, "AddMarker", 0, "Blue", "Kairos VO", "", 1, f"kairosVoiceoverUnitId={unit_id}")
        return {
            "unitId": unit_id,
            "trackIndex": audio_track_index,
            "recordFrame": clip_info["recordFrame"],
            "itemName": _safe_call(appended_item, "GetName") or "",
            "mediaPoolBin": f"{VOICE_MEDIA_BIN_NAME}/{resolve_bin_name(self.timeline_name(), 'Timeline')}",
        }


def marker_has_unit(markers, unit_ids):
    if not isinstance(markers, dict):
        return False
    for marker in markers.values():
        if not isinstance(marker, dict):
            continue
        custom_data = str(marker.get("customData") or "")
        for unit_id in unit_ids:
            if f"kairosVoiceoverUnitId={unit_id}" in custom_data:
                return True
    return False


class VoiceoverWindow:
    def __init__(self, resolve, fusion, bmd_module):
        self.resolve = resolve
        self.fusion = fusion
        self.bmd = bmd_module
        self.bridge = ResolveVoiceoverBridge(resolve)
        self.ui = fusion.UIManager
        self.dispatcher = bmd_module.UIDispatcher(self.ui)
        self.config = load_config()
        self.subtitles = []
        self.tree_item_ids = {}
        self.window = None

    def run(self):
        existing = self.ui.FindWindow(WINDOW_ID)
        if existing:
            startup_log("Existing window found; raising")
            existing.Show()
            existing.Raise()
            return
        startup_log("Adding window")
        self.window = self.dispatcher.AddWindow(
            {
                "ID": WINDOW_ID,
                "Geometry": [100, 100, 980, 760],
                "WindowTitle": f"Kairos Volc Voiceover {PLUGIN_VERSION}",
            },
            self.layout(),
        )
        if not self.window:
            raise RuntimeError("Fusion UIManager failed to create the plugin window.")
        startup_log("Binding window events")
        self.bind_events()
        startup_log("Applying config")
        self.apply_config_to_ui()
        startup_log("Showing window")
        self.window.Show()
        startup_log("Refreshing subtitles")
        self.refresh_subtitles(None)
        startup_log("Entering RunLoop")
        self.dispatcher.RunLoop()
        startup_log("RunLoop exited")

    def layout(self):
        ui = self.ui
        return ui.VGroup(
            [
                ui.Label({"Text": "Kairos Volc Voiceover", "Weight": 0, "Font": ui.Font({"PixelSize": 18})}),
                ui.HGroup(
                    {"Weight": 0},
                    [
                        ui.Button({"ID": "refresh", "Text": "Refresh Subtitles"}),
                        ui.Button({"ID": "playhead", "Text": "Use Playhead Subtitle"}),
                        ui.Button({"ID": "mark", "Text": "Select Resolve I/O"}),
                        ui.Button({"ID": "probe", "Text": "Probe"}),
                    ],
                ),
                ui.Tree(
                    {
                        "ID": "subtitles",
                        "Weight": 1.0,
                        "SelectionMode": "ExtendedSelection",
                        "AlternatingRowColors": True,
                        "RootIsDecorated": False,
                    }
                ),
                ui.TextEdit({"ID": "subtitleListText", "Weight": 0.35, "ReadOnly": True, "AcceptRichText": False}),
                ui.HGroup(
                    {"Weight": 0},
                    [
                        ui.Label({"Text": "Selected IDs fallback:", "Weight": 0}),
                        ui.LineEdit({"ID": "selectedIds", "Text": "", "PlaceholderText": "1,2,3"}),
                    ],
                ),
                ui.Label({"Text": "Voice", "Weight": 0, "Font": ui.Font({"PixelSize": 14})}),
                ui.VGroup(
                    {"Weight": 0},
                    [
                        ui.HGroup(
                            {"Weight": 0},
                            [
                                ui.Label({"Text": "API Key", "Weight": 0}),
                                ui.LineEdit({"ID": "apiKey", "EchoMode": "Password", "PlaceholderText": "X-Api-Key"}),
                                ui.CheckBox({"ID": "saveApiKey", "Text": "Save local", "Checked": False}),
                            ],
                        ),
                        ui.HGroup(
                            {"Weight": 0},
                            [
                                ui.Label({"Text": "Speaker", "Weight": 0}),
                                ui.LineEdit({"ID": "speaker", "PlaceholderText": "speaker_id"}),
                                ui.Label({"Text": "Resource", "Weight": 0}),
                                ui.LineEdit({"ID": "resourceId", "Text": DEFAULT_RESOURCE_ID}),
                            ],
                        ),
                        ui.HGroup(
                            {"Weight": 0},
                            [
                                ui.Label({"Text": "Model", "Weight": 0}),
                                ui.LineEdit({"ID": "model", "PlaceholderText": "optional"}),
                                ui.Label({"Text": "Language", "Weight": 0}),
                                ui.LineEdit({"ID": "language", "Text": "zh-cn"}),
                                ui.Label({"Text": "Speed", "Weight": 0}),
                                ui.LineEdit({"ID": "speed", "PlaceholderText": "optional"}),
                            ],
                        ),
                        ui.Label({"Text": "Context / style prompt", "Weight": 0}),
                        ui.TextEdit({"ID": "contextText", "Weight": 0.35, "AcceptRichText": False}),
                    ],
                ),
                ui.Label({"Text": "Clone", "Weight": 0, "Font": ui.Font({"PixelSize": 14})}),
                ui.VGroup(
                    {"Weight": 0},
                    [
                        ui.HGroup(
                            {"Weight": 0},
                            [
                                ui.LineEdit({"ID": "cloneAudio", "PlaceholderText": "Prompt audio path, 14-30s recommended"}),
                                ui.LineEdit({"ID": "cloneSpeaker", "PlaceholderText": "speaker_id or custom speaker id"}),
                            ],
                        ),
                        ui.HGroup(
                            {"Weight": 0},
                            [
                                ui.LineEdit({"ID": "cloneDemo", "PlaceholderText": "Demo text"}),
                                ui.CheckBox({"ID": "cloneConsent", "Text": "I confirm voice-owner consent", "Checked": False}),
                                ui.Button({"ID": "cloneCreate", "Text": "Create Clone"}),
                            ],
                        ),
                    ],
                ),
                ui.HGroup(
                    {"Weight": 0},
                    [
                        ui.CheckBox({"ID": "replacePrevious", "Text": "Replace previous Kairos VO for selected subtitles", "Checked": False}),
                        ui.CheckBox({"ID": "skipOverflow", "Text": "Skip clips > subtitle duration +250ms", "Checked": False}),
                    ],
                ),
                ui.HGroup(
                    {"Weight": 0},
                    [
                        ui.Button({"ID": "synthesizeInsert", "Text": "Synthesize + Insert"}),
                        ui.Button({"ID": "saveConfig", "Text": "Save Config"}),
                        ui.Button({"ID": "close", "Text": "Close"}),
                    ],
                ),
                ui.TextEdit({"ID": "log", "Weight": 0.55, "ReadOnly": True, "AcceptRichText": False}),
            ]
        )

    def bind_events(self):
        win = self.window
        win.On[WINDOW_ID].Close = self.close
        win.On["close"].Clicked = self.close
        win.On["refresh"].Clicked = self.refresh_subtitles
        win.On["playhead"].Clicked = self.select_playhead
        win.On["mark"].Clicked = self.select_mark
        win.On["probe"].Clicked = self.probe
        win.On["synthesizeInsert"].Clicked = self.synthesize_insert
        win.On["saveConfig"].Clicked = self.save_config
        win.On["cloneCreate"].Clicked = self.create_clone

    def find(self, element_id):
        return self.window.Find(element_id)

    def log(self, message):
        current = self.find("log").PlainText or ""
        line = time.strftime("[%H:%M:%S] ") + str(message)
        self.find("log").PlainText = (current + "\n" + line).strip()

    def apply_config_to_ui(self):
        mapping = {
            "apiKey": "apiKey",
            "speaker": "speaker",
            "resourceId": "resourceId",
            "model": "model",
            "language": "language",
            "contextText": "contextText",
        }
        for control, key in mapping.items():
            value = self.config.get(key)
            if value:
                if control == "contextText":
                    self.find(control).PlainText = str(value)
                else:
                    self.find(control).Text = str(value)

    def ui_settings(self):
        speed = self.find("speed").Text.strip()
        speed_value = None
        if speed:
            try:
                speed_value = float(speed)
            except ValueError:
                raise VoiceoverError("invalid_speed", "Speed must be numeric.")
        return TtsSettings(
            api_key=self.find("apiKey").Text.strip(),
            speaker=self.find("speaker").Text.strip(),
            resource_id=self.find("resourceId").Text.strip() or DEFAULT_RESOURCE_ID,
            model=self.find("model").Text.strip(),
            language=self.find("language").Text.strip() or "zh-cn",
            speed_ratio=speed_value,
            context_text=self.find("contextText").PlainText.strip(),
        )

    def save_config(self, ev):
        config = {
            "speaker": self.find("speaker").Text.strip(),
            "resourceId": self.find("resourceId").Text.strip() or DEFAULT_RESOURCE_ID,
            "model": self.find("model").Text.strip(),
            "language": self.find("language").Text.strip() or "zh-cn",
            "contextText": self.find("contextText").PlainText.strip(),
        }
        if self.find("saveApiKey").Checked:
            config["apiKey"] = self.find("apiKey").Text.strip()
        path = save_config(config)
        self.config = config
        self.log(f"Saved local config: {path}")

    def refresh_subtitles(self, ev):
        try:
            self.subtitles = self.bridge.collect_subtitles()
            self.populate_tree()
            missing = len([row for row in self.subtitles if not row.get("text")])
            self.log(f"Loaded {len(self.subtitles)} subtitle items from {self.bridge.timeline_name()}. Missing text: {missing}.")
        except Exception as exc:
            self.log_error(exc)

    def populate_tree(self):
        tree = self.find("subtitles")
        self.tree_item_ids = {}
        try:
            tree.Clear()
        except Exception:
            pass
        try:
            tree.ColumnCount = 6
            tree.HeaderLabels = ["ID", "Track", "In", "Out", "Ms", "Text"]
        except Exception:
            pass
        for row in self.subtitles:
            try:
                item = tree.NewItem()
                values = [
                    str(row.get("subtitleIndex") or ""),
                    str(row.get("trackIndex") or ""),
                    str(row.get("startTimecode") or ""),
                    str(row.get("endTimecode") or ""),
                    str(int(row.get("durationMs") or 0)),
                    clean_subtitle_text(row.get("text"))[:100],
                ]
                for column, value in enumerate(values):
                    item.Text[column] = value
                tree.AddTopLevelItem(item)
                self.tree_item_ids[str(row.get("subtitleIndex"))] = item
            except Exception:
                pass
        lines = []
        for row in self.subtitles:
            lines.append(
                "{id}. T{track} {start}-{end} {text}".format(
                    id=row.get("subtitleIndex") or "",
                    track=row.get("trackIndex") or "",
                    start=row.get("startTimecode") or "",
                    end=row.get("endTimecode") or "",
                    text=clean_subtitle_text(row.get("text"))[:160],
                )
            )
        self.find("subtitleListText").PlainText = "\n".join(lines)

    def selected_subtitles(self):
        selected_ids = set()
        try:
            for item in self.find("subtitles").SelectedItems():
                selected_ids.add(str(item.Text[0]))
        except Exception:
            pass
        fallback = self.find("selectedIds").Text.strip()
        if fallback:
            for token in fallback.split(","):
                token = token.strip()
                if token:
                    selected_ids.add(token)
        rows = [row for row in self.subtitles if str(row.get("subtitleIndex")) in selected_ids]
        if not rows:
            raise VoiceoverError("subtitle_selection_missing", "Select at least one subtitle in the plugin list.")
        missing = [row for row in rows if not row.get("text")]
        if missing:
            ids = ", ".join(str(row.get("subtitleIndex")) for row in missing[:10])
            raise VoiceoverError("subtitle_text_missing", f"Selected subtitles have no readable text: {ids}")
        return rows

    def set_selected_ids(self, ids):
        ids = [str(value) for value in ids]
        self.find("selectedIds").Text = ",".join(ids)
        try:
            for item_id, item in self.tree_item_ids.items():
                item.Selected = item_id in ids
        except Exception:
            pass

    def select_playhead(self, ev):
        frame = self.bridge.current_frame()
        if frame is None:
            self.log("Unable to read current playhead timecode.")
            return
        ids = [
            row.get("subtitleIndex")
            for row in self.subtitles
            if (row.get("startFrame") or 0) <= frame < (row.get("endFrame") or 0)
        ]
        self.set_selected_ids(ids)
        self.log(f"Selected {len(ids)} subtitle(s) at playhead frame {frame}.")

    def select_mark(self, ev):
        mark = self.bridge.mark_range()
        if not mark:
            self.log("No Resolve In/Out range found. Set it on the timeline with I and O, then click Select Resolve I/O.")
            return
        start, end = mark
        ids = [
            row.get("subtitleIndex")
            for row in self.subtitles
            if ranges_overlap(start, end, row.get("startFrame"), row.get("endFrame"))
        ]
        self.set_selected_ids(ids)
        self.log(f"Selected {len(ids)} subtitle(s) in Resolve In/Out.")

    def probe(self, ev):
        try:
            project = self.bridge.project()
            timeline = self.bridge.timeline()
            if not project or not timeline:
                raise VoiceoverError("resolve_context_missing", "No current Resolve project/timeline.")
            subtitles = self.bridge.collect_subtitles()
            can_read_text = any(row.get("text") for row in subtitles)
            track_index = self.bridge.ensure_voice_track()
            self.log(
                "Probe OK: "
                f"project={self.bridge.project_name()}, timeline={self.bridge.timeline_name()}, "
                f"fps={self.bridge.fps()}, subtitles={len(subtitles)}, "
                f"readableText={can_read_text}, voiceTrack={track_index}."
            )
            if not can_read_text:
                self.log("Warning: Resolve exposed subtitle ranges but no subtitle text.")
        except Exception as exc:
            self.log_error(exc)

    def preview(self, ev):
        try:
            units, run_dir = self.synthesize_selected(insert=False)
            if units:
                path = units[0]["resolveAudioPath"]
                open_file(path)
                self.log(f"Preview generated: {path}")
            self.write_run_manifest(run_dir, units, [])
        except Exception as exc:
            self.log_error(exc)

    def synthesize_insert(self, ev):
        try:
            units, run_dir = self.synthesize_selected(insert=False)
            if self.find("replacePrevious").Checked:
                deleted = self.bridge.delete_previous_plugin_audio([unit["unitId"] for unit in units])
                self.log(f"Deleted {deleted} previous Kairos VO clip(s).")
            inserted = []
            for unit in units:
                if self.find("skipOverflow").Checked and unit.get("durationStatus") == "overflow":
                    self.log(f"Skipped overflow unit {unit['unitId']}.")
                    continue
                track_index = self.bridge.ensure_voice_track_for_unit(unit)
                inserted.append(self.bridge.import_and_insert(unit, track_index))
                self.log(f"Inserted {unit['unitId']} at frame {inserted[-1]['recordFrame']} on A{track_index}.")
            manifest_path = self.write_run_manifest(run_dir, units, inserted)
            _safe_call(_safe_call(self.resolve, "GetProjectManager"), "SaveProject")
            self.log(f"Done. Manifest: {manifest_path}")
        except Exception as exc:
            self.log_error(exc)

    def synthesize_selected(self, insert):
        settings = self.ui_settings()
        rows = merge_selected_subtitles_for_synthesis(self.selected_subtitles())
        run_dir = build_run_dir(self.bridge.project_name(), self.bridge.timeline_id())
        units = []
        for row in rows:
            unit = synthesize_unit(row, self.bridge.timeline_id(), run_dir, settings)
            units.append(unit)
            status = unit.get("durationStatus")
            overflow = unit.get("overflowMs")
            suffix = f", overflow={overflow:.0f}ms" if isinstance(overflow, (int, float)) else ""
            self.log(f"Synthesized {unit['unitId']} ({status}{suffix}).")
        return units, run_dir

    def write_run_manifest(self, run_dir, units, inserted):
        manifest = {
            "schemaVersion": "kairos-resolve-volc-voiceover-manifest-v1",
            "pluginVersion": PLUGIN_VERSION,
            "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "resolveProject": self.bridge.project_name(),
            "timelineName": self.bridge.timeline_name(),
            "timelineId": self.bridge.timeline_id(),
            "units": units,
            "inserted": inserted,
        }
        return write_manifest(run_dir, manifest)

    def create_clone(self, ev):
        try:
            api_key = self.find("apiKey").Text.strip()
            audio_path = Path(self.find("cloneAudio").Text.strip()).expanduser()
            speaker = self.find("cloneSpeaker").Text.strip()
            demo = self.find("cloneDemo").Text.strip()
            consent = self.find("cloneConsent").Checked
            request_speaker_id = "custom_speaker_id" if speaker.startswith("custom_") else speaker
            custom_speaker_id = speaker if speaker.startswith("custom_") else ""
            result = VoiceCloneClient().create_clone(
                api_key=api_key,
                speaker_id=request_speaker_id,
                audio_path=audio_path,
                demo_text=demo,
                custom_speaker_id=custom_speaker_id,
                consent_confirmed=consent,
            )
            clone_log = default_config_path().parent / "voice-clone-last-result.json"
            clone_log.parent.mkdir(parents=True, exist_ok=True)
            clone_log.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            self.log(f"Clone request submitted. Result: {clone_log}")
        except Exception as exc:
            self.log_error(exc)

    def close(self, ev):
        self.dispatcher.ExitLoop()

    def log_error(self, exc):
        if isinstance(exc, VoiceoverError):
            self.log(f"ERROR {exc.code}: {exc}")
            if exc.details:
                self.log(json.dumps(exc.details, ensure_ascii=False)[:1200])
        else:
            self.log("ERROR: " + str(exc))
            self.log(traceback.format_exc()[-2000:])


def ranges_overlap(left_start, left_end, right_start, right_end):
    try:
        return float(left_start) < float(right_end) and float(right_start) < float(left_end)
    except (TypeError, ValueError):
        return False


def open_file(path):
    try:
        if sys.platform == "darwin":
            subprocess.Popen(["open", path])
        elif sys.platform.startswith("win"):
            os.startfile(path)  # type: ignore[attr-defined]
        else:
            subprocess.Popen(["xdg-open", path])
    except Exception:
        pass


def _optional_float(value):
    text = str(value or "").strip()
    if not text:
        return None
    return float(text)


def load_workspace_link() -> dict:
    link_path = SCRIPT_DIR / "kairos_workspace.json"
    if link_path.exists():
        return json.loads(link_path.read_text(encoding="utf-8"))
    for candidate in (SCRIPT_DIR, *SCRIPT_DIR.parents):
        runtime_path = candidate / "config" / "runtime.json"
        if runtime_path.exists():
            return {"workspaceRoot": str(candidate), "runtimeConfigPath": str(runtime_path)}
    return {}


def load_workspace_root() -> Path:
    workspace_root = Path(str(load_workspace_link().get("workspaceRoot") or "")).expanduser()
    if not workspace_root.exists():
        raise VoiceoverError(
            "voiceover_workspace_missing",
            "Installed plugin cannot find the Kairos workspace root.",
            {"workspaceRoot": str(workspace_root)},
        )
    return workspace_root


def project_plugin_tmp_summary(resolve_project_name: str) -> dict:
    tmp_dir, metadata = build_project_plugin_tmp_dir(load_workspace_root(), resolve_project_name)
    tmp_dir.mkdir(parents=True, exist_ok=True)
    (tmp_dir / "logs").mkdir(parents=True, exist_ok=True)
    (tmp_dir / "jobs").mkdir(parents=True, exist_ok=True)
    return metadata


def load_runtime_voiceover_config() -> dict:
    link = load_workspace_link()
    runtime_path = Path(str(link.get("runtimeConfigPath") or "")).expanduser()
    if not runtime_path.exists():
        raise VoiceoverError(
            "voiceover_runtime_missing",
            f"Kairos runtime config is missing: {runtime_path or 'config/runtime.json'}",
        )
    runtime = json.loads(runtime_path.read_text(encoding="utf-8"))
    voiceover = runtime.get("voiceover") if isinstance(runtime, dict) else None
    if not isinstance(voiceover, dict):
        voiceover = {}
    profiles = voiceover.get("profiles")
    if not isinstance(profiles, list):
        profiles = []
    normalized_profiles = [
        profile for profile in profiles
        if isinstance(profile, dict) and str(profile.get("name") or "").strip()
    ]
    return {
        "runtimeConfigPath": str(runtime_path),
        "volcApiKey": str(voiceover.get("volcApiKey") or ""),
        "defaultProfile": str(voiceover.get("defaultProfile") or ""),
        "profiles": normalized_profiles,
    }


def find_voiceover_profile(config: dict, name: str) -> dict:
    profile_name = str(name or "").strip()
    profiles = config.get("profiles") or []
    if profile_name:
        for profile in profiles:
            if str(profile.get("name") or "") == profile_name:
                return profile
        raise VoiceoverError("voiceover_profile_missing", f"Voice profile is not configured: {profile_name}")
    if profiles:
        default_name = str(config.get("defaultProfile") or "").strip()
        for profile in profiles:
            if default_name and str(profile.get("name") or "") == default_name:
                return profile
        return profiles[0]
    raise VoiceoverError("voiceover_profile_missing", "No voice profiles configured in config/runtime.json voiceover.profiles.")


def tts_settings_from_job(job: dict) -> TtsSettings:
    settings_data = job.get("settings") or {}
    profile_name = str(settings_data.get("profileName") or "").strip()
    if profile_name:
        config = load_runtime_voiceover_config()
        profile = find_voiceover_profile(config, profile_name)
        speed_override = _optional_float(settings_data.get("speedRatio"))
        loudness_override = _optional_float(settings_data.get("loudnessRatio"))
        return TtsSettings(
            api_key=str(config.get("volcApiKey") or ""),
            speaker=str(profile.get("speakerId") or profile.get("speaker") or ""),
            resource_id=str(profile.get("resourceId") or DEFAULT_RESOURCE_ID),
            endpoint=str(profile.get("endpoint") or DEFAULT_TTS_ENDPOINT),
            audio_format="mp3",
            sample_rate=int(profile.get("sampleRate") or 24000),
            model=str(profile.get("model") or ""),
            language=str(profile.get("language") or "zh-cn"),
            speed_ratio=speed_override if speed_override is not None else _optional_float(profile.get("defaultSpeed")),
            loudness_ratio=(
                loudness_override if loudness_override is not None else _optional_float(profile.get("defaultLoudness"))
            ),
            context_text=str(profile.get("contextText") or ""),
        )
    return TtsSettings(
        api_key=str(settings_data.get("apiKey") or ""),
        speaker=str(settings_data.get("speaker") or ""),
        resource_id=str(settings_data.get("resourceId") or DEFAULT_RESOURCE_ID),
        endpoint=str(settings_data.get("endpoint") or DEFAULT_TTS_ENDPOINT),
        audio_format="mp3",
        sample_rate=int(settings_data.get("sampleRate") or 24000),
        model=str(settings_data.get("model") or ""),
        language=str(settings_data.get("language") or "zh-cn"),
        speed_ratio=_optional_float(settings_data.get("speedRatio")),
        loudness_ratio=_optional_float(settings_data.get("loudnessRatio")),
        context_text=str(settings_data.get("contextText") or ""),
    )


def _tsv_escape(value) -> str:
    return str(value or "").replace("\\", "\\\\").replace("\t", "\\t").replace("\n", "\\n")


def voiceover_config_summary_tsv() -> str:
    try:
        config = load_runtime_voiceover_config()
        lines = [
            "VERSION\t" + _tsv_escape(PLUGIN_VERSION),
            "CONFIG\t" + _tsv_escape(config.get("runtimeConfigPath")),
            "HAS_API_KEY\t" + ("1" if str(config.get("volcApiKey") or "").strip() else "0"),
            "DEFAULT\t" + _tsv_escape(config.get("defaultProfile")),
        ]
        for profile in config.get("profiles") or []:
            name = str(profile.get("name") or "")
            display = str(profile.get("displayName") or name)
            lines.append("PROFILE\t" + _tsv_escape(name) + "\t" + _tsv_escape(display))
        return "\n".join(lines) + "\n"
    except Exception as exc:
        return "ERROR\t" + _tsv_escape(exc) + "\n"


def project_temp_root_tsv(resolve_project_name: str) -> str:
    try:
        summary = project_plugin_tmp_summary(resolve_project_name)
        return "TMP\t" + _tsv_escape(summary.get("tmpDir")) + "\n"
    except Exception as exc:
        if isinstance(exc, VoiceoverError):
            return "ERROR\t" + _tsv_escape(exc.code) + "\t" + _tsv_escape(str(exc)) + "\n"
        return "ERROR\tunknown\t" + _tsv_escape(exc) + "\n"


def cli_synthesize_job(job_path: Path):
    job = json.loads(job_path.read_text(encoding="utf-8"))
    resolve = _get_resolve()
    if not resolve:
        raise RuntimeError("Unable to connect to DaVinci Resolve.")
    bridge = ResolveVoiceoverBridge(resolve)
    settings = tts_settings_from_job(job) if (job.get("subtitles") or []) else TtsSettings(api_key="", speaker="")
    timeline_id = str(job.get("timelineId") or bridge.timeline_id())
    timeline_name = str(job.get("timelineName") or bridge.timeline_name())
    project_name = str(job.get("projectName") or bridge.project_name())
    workspace_root = load_workspace_root()
    run_dir, voiceover_media = build_project_voiceover_run_dir(
        workspace_root,
        project_name,
        timeline_id,
        str(job.get("runId") or ""),
        timeline_name=timeline_name,
    )
    tmp_dir, _ = build_project_plugin_tmp_dir(workspace_root, project_name)
    artifact_root = Path(voiceover_media["selectedRootPath"])
    cache_root = tmp_dir / "cache"
    subtitles = merge_selected_subtitles_for_synthesis(job.get("subtitles") or [])
    units = [
        synthesize_unit(
            subtitle,
            timeline_id,
            run_dir,
            settings,
            force=bool(job.get("force")),
            cache_root=cache_root,
            artifact_root=artifact_root,
        )
        for subtitle in subtitles
    ]
    inserted = []
    if job.get("mode") == "preview":
        if units:
            open_file(units[0]["resolveAudioPath"])
    else:
        media_folder = bridge.voiceover_media_folder(timeline_name)
        for unit in units:
            if job.get("skipOverflow") and unit.get("durationStatus") == "overflow":
                continue
            track_index = bridge.ensure_voice_track_for_unit(unit)
            inserted.append(bridge.import_and_insert(unit, track_index, media_folder=media_folder))
        _safe_call(_safe_call(resolve, "GetProjectManager"), "SaveProject")
    manifest = {
        "schemaVersion": "kairos-resolve-volc-voiceover-cli-v1",
        "pluginVersion": PLUGIN_VERSION,
        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "mode": job.get("mode") or "insert",
        "projectName": project_name,
        "timelineName": timeline_name,
        "timelineId": timeline_id,
        "voiceoverMedia": voiceover_media,
        "units": units,
        "inserted": inserted,
    }
    debug_manifest_dir = tmp_dir / "manifests" / safe_segment(str(job.get("runId") or time.strftime("%Y%m%d-%H%M%S")), "run")
    debug_manifest_path = write_manifest(debug_manifest_dir, manifest)
    return {
        "ok": True,
        "mediaDir": str(run_dir),
        "debugManifest": str(debug_manifest_path),
        "unitCount": len(units),
        "insertedCount": len(inserted),
    }


def main():
    startup_log("Launching Kairos Volc Voiceover")
    bootstrap_log("main start")
    resolve = _get_resolve()
    bootstrap_log(f"resolve connected={bool(resolve)}")
    if not resolve:
        raise RuntimeError("Unable to connect to DaVinci Resolve.")
    fusion = globals().get("fusion") or _safe_call(resolve, "Fusion")
    bmd_module = _get_bmd_module()
    bootstrap_log(f"fusion={bool(fusion)} bmd_module={bool(bmd_module)}")
    if not fusion or not bmd_module:
        raise RuntimeError("Fusion UIManager is unavailable; run this script from inside DaVinci Resolve.")
    bootstrap_log("creating window")
    global _ACTIVE_WINDOW
    _ACTIVE_WINDOW = VoiceoverWindow(resolve, fusion, bmd_module)
    _ACTIVE_WINDOW.run()


def entrypoint():
    try:
        if len(sys.argv) >= 2 and sys.argv[1] == "--voiceover-config-summary":
            print(voiceover_config_summary_tsv(), end="")
        elif len(sys.argv) >= 2 and sys.argv[1] == "--project-temp-root":
            project_name = ""
            if len(sys.argv) >= 4 and sys.argv[2] == "--project-name":
                project_name = sys.argv[3]
            print(project_temp_root_tsv(project_name), end="")
        elif len(sys.argv) >= 3 and sys.argv[1] == "--synthesize-job":
            result = cli_synthesize_job(Path(sys.argv[2]).expanduser())
            print(json.dumps(result, ensure_ascii=False, indent=2))
        else:
            main()
    except Exception:
        startup_log(traceback.format_exc())
        if len(sys.argv) >= 2 and sys.argv[1] == "--synthesize-job":
            exc = sys.exc_info()[1]
            if isinstance(exc, VoiceoverError):
                payload = {
                    "ok": False,
                    "code": exc.code,
                    "message": str(exc),
                    "details": exc.details,
                }
            else:
                payload = {"ok": False, "error": traceback.format_exc()}
            print(json.dumps(payload, ensure_ascii=False, indent=2))
            raise SystemExit(1)
        raise


if __name__ == "__main__":
    entrypoint()
