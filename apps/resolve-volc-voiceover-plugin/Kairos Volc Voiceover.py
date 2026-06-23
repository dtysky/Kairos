#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import traceback
from pathlib import Path

def bootstrap_log(message):
    try:
        log_dir = Path.home() / "Movies" / "KairosVoiceover" / "logs"
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
        build_run_dir,
        clean_subtitle_text,
        default_config_path,
        extract_subtitle_text,
        frame_to_timecode,
        frames_to_ms,
        load_config,
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
_ACTIVE_WINDOW = None


def startup_log(message):
    try:
        log_dir = Path.home() / "Movies" / "KairosVoiceover" / "logs"
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
        added = _safe_call(timeline, "AddTrack", "audio", "mono")
        if added is False:
            added = _safe_call(timeline, "AddTrack", "audio")
        new_count = int(_safe_call(timeline, "GetTrackCount", "audio") or count)
        track_index = new_count if new_count > count else count + 1
        _safe_call(timeline, "SetTrackName", "audio", track_index, VOICE_TRACK_NAME)
        return track_index

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

    def import_and_insert(self, unit_result, audio_track_index):
        media_pool = self.media_pool()
        if not media_pool:
            raise VoiceoverError("resolve_media_pool_missing", "Resolve Media Pool is unavailable.")
        path = unit_result["resolveAudioPath"]
        imported = _safe_call(media_pool, "ImportMedia", [path])
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
                        ui.Button({"ID": "preview", "Text": "Preview"}),
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
        win.On["preview"].Clicked = self.preview
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
            track_index = self.bridge.ensure_voice_track()
            if self.find("replacePrevious").Checked:
                deleted = self.bridge.delete_previous_plugin_audio([unit["unitId"] for unit in units])
                self.log(f"Deleted {deleted} previous Kairos VO clip(s).")
            inserted = []
            for unit in units:
                if self.find("skipOverflow").Checked and unit.get("durationStatus") == "overflow":
                    self.log(f"Skipped overflow unit {unit['unitId']}.")
                    continue
                inserted.append(self.bridge.import_and_insert(unit, track_index))
                self.log(f"Inserted {unit['unitId']} at frame {inserted[-1]['recordFrame']}.")
            manifest_path = self.write_run_manifest(run_dir, units, inserted)
            _safe_call(_safe_call(self.resolve, "GetProjectManager"), "SaveProject")
            self.log(f"Done. Manifest: {manifest_path}")
        except Exception as exc:
            self.log_error(exc)

    def synthesize_selected(self, insert):
        settings = self.ui_settings()
        rows = self.selected_subtitles()
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
            audio_format=str(profile.get("audioFormat") or "mp3"),
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
        audio_format=str(settings_data.get("audioFormat") or "mp3"),
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


def cli_synthesize_job(job_path: Path):
    job = json.loads(job_path.read_text(encoding="utf-8"))
    resolve = _get_resolve()
    if not resolve:
        raise RuntimeError("Unable to connect to DaVinci Resolve.")
    bridge = ResolveVoiceoverBridge(resolve)
    settings = tts_settings_from_job(job) if (job.get("subtitles") or []) else TtsSettings(api_key="", speaker="")
    timeline_id = str(job.get("timelineId") or bridge.timeline_id())
    project_name = str(job.get("projectName") or bridge.project_name())
    run_dir = build_run_dir(project_name, timeline_id, str(job.get("runId") or ""))
    subtitles = job.get("subtitles") or []
    units = [
        synthesize_unit(subtitle, timeline_id, run_dir, settings, force=bool(job.get("force")))
        for subtitle in subtitles
    ]
    inserted = []
    if job.get("mode") == "preview":
        if units:
            open_file(units[0]["resolveAudioPath"])
    else:
        track_index = bridge.ensure_voice_track()
        for unit in units:
            if job.get("skipOverflow") and unit.get("durationStatus") == "overflow":
                continue
            inserted.append(bridge.import_and_insert(unit, track_index))
        _safe_call(_safe_call(resolve, "GetProjectManager"), "SaveProject")
    manifest = {
        "schemaVersion": "kairos-resolve-volc-voiceover-cli-v1",
        "pluginVersion": PLUGIN_VERSION,
        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "mode": job.get("mode") or "insert",
        "projectName": project_name,
        "timelineName": bridge.timeline_name(),
        "timelineId": timeline_id,
        "units": units,
        "inserted": inserted,
    }
    manifest_path = write_manifest(run_dir, manifest)
    return {"ok": True, "manifest": str(manifest_path), "unitCount": len(units), "insertedCount": len(inserted)}


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
        elif len(sys.argv) >= 3 and sys.argv[1] == "--synthesize-job":
            result = cli_synthesize_job(Path(sys.argv[2]).expanduser())
            print(json.dumps(result, ensure_ascii=False, indent=2))
        else:
            main()
    except Exception:
        startup_log(traceback.format_exc())
        if len(sys.argv) >= 2 and sys.argv[1] == "--synthesize-job":
            payload = {"ok": False, "error": traceback.format_exc()}
            print(json.dumps(payload, ensure_ascii=False, indent=2), file=sys.stderr)
            raise SystemExit(1)
        raise


if __name__ == "__main__":
    entrypoint()
