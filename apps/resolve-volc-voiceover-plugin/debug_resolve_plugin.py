#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import math
import sys
import time
import wave
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
for module_dir in (SCRIPT_DIR, SCRIPT_DIR / "KairosVolcVoiceoverLib"):
    if str(module_dir) not in sys.path:
        sys.path.insert(0, str(module_dir))

RESOLVE_MODULES = "/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting/Modules"
if RESOLVE_MODULES not in sys.path:
    sys.path.append(RESOLVE_MODULES)

import DaVinciResolveScript as bmd  # noqa: E402
from kairos_volc_voiceover_core import build_run_dir, write_manifest  # noqa: E402


def load_plugin_module():
    path = SCRIPT_DIR / "Kairos Volc Voiceover.py"
    spec = importlib.util.spec_from_file_location("kairos_volc_voiceover_plugin_smoke", path)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


def create_wav(path: Path, duration_s: float = 1.0, sample_rate: int = 48000):
    path.parent.mkdir(parents=True, exist_ok=True)
    total = int(sample_rate * duration_s)
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(sample_rate)
        frames = bytearray()
        for i in range(total):
            value = int(12000 * math.sin(2 * math.pi * 440 * i / sample_rate))
            frames.extend(value.to_bytes(2, byteorder="little", signed=True))
        handle.writeframes(bytes(frames))


def main():
    resolve = bmd.scriptapp("Resolve")
    if not resolve:
        raise SystemExit("DaVinci Resolve is not running or scripting is disabled.")
    pm = resolve.GetProjectManager()
    if not pm:
        raise SystemExit("Resolve ProjectManager is unavailable.")

    project_name = "Kairos Volc Voiceover Debug"
    existing = pm.LoadProject(project_name)
    project = existing or pm.CreateProject(project_name)
    if not project:
        raise SystemExit(f"Unable to load or create Resolve project: {project_name}")
    media_pool = project.GetMediaPool()
    timeline_name = "Kairos VO Debug Timeline"
    timeline = None
    for index in range(1, int(project.GetTimelineCount() or 0) + 1):
        candidate = project.GetTimelineByIndex(index)
        if candidate and candidate.GetName() == timeline_name:
            timeline = candidate
            break
    if timeline is None:
        timeline = media_pool.CreateEmptyTimeline(timeline_name)
    if not timeline:
        raise SystemExit("Unable to create debug timeline.")
    project.SetCurrentTimeline(timeline)
    resolve.OpenPage("edit")

    plugin = load_plugin_module()
    bridge = plugin.ResolveVoiceoverBridge(resolve)
    subtitles = bridge.collect_subtitles()
    track_index = bridge.ensure_voice_track()

    run_dir = build_run_dir(project_name, bridge.timeline_id(), "debug-smoke")
    wav_path = run_dir / "resolve" / "debug-tone.wav"
    create_wav(wav_path)
    unit = {
        "unitId": "debug_tone",
        "resolveAudioPath": str(wav_path),
        "subtitle": {
            "trackIndex": 1,
            "subtitleIndex": 1,
            "startFrame": 0,
            "endFrame": 24,
            "durationMs": 1000,
            "text": "Kairos debug tone",
        },
    }
    inserted = bridge.import_and_insert(unit, track_index)
    manifest = {
        "schemaVersion": "kairos-resolve-volc-voiceover-debug-v1",
        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "resolveVersion": resolve.GetVersionString(),
        "project": project_name,
        "timeline": timeline_name,
        "subtitleCount": len(subtitles),
        "voiceTrackIndex": track_index,
        "inserted": inserted,
        "wavPath": str(wav_path),
    }
    manifest_path = write_manifest(run_dir, manifest)
    pm.SaveProject()
    print(json.dumps({"ok": True, "manifest": str(manifest_path), **manifest}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
