import importlib.util
import sys
import unittest
from pathlib import Path

PLUGIN_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PLUGIN_DIR))

spec = importlib.util.spec_from_file_location(
    "kairos_resolve_volc_voiceover",
    PLUGIN_DIR / "Kairos Volc Voiceover.py",
)
plugin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plugin)


class FakeTimelineItem:
    def __init__(self, start, end):
        self.start = start
        self.end = end

    def GetStart(self, *args):
        return self.start

    def GetEnd(self, *args):
        return self.end


class FakeTimeline:
    def __init__(self, names, items=None, locked=None, enabled=None):
        self.names = dict(names)
        self.items = {index: list(value) for index, value in (items or {}).items()}
        self.locked = set(locked or [])
        self.enabled = dict(enabled or {})

    def GetTrackCount(self, track_type):
        if track_type != "audio":
            return 0
        return len(self.names)

    def GetTrackName(self, track_type, index):
        return self.names.get(index, "")

    def SetTrackName(self, track_type, index, name):
        self.names[index] = name
        return True

    def GetItemListInTrack(self, track_type, index):
        return self.items.get(index, [])

    def GetItemsInTrack(self, track_type, index):
        return self.items.get(index, [])

    def GetIsTrackLocked(self, track_type, index):
        return index in self.locked

    def GetIsTrackEnabled(self, track_type, index):
        return self.enabled.get(index, True)

    def AddTrack(self, track_type, *args):
        index = len(self.names) + 1
        self.names[index] = ""
        self.items[index] = []
        return True


class FakeProject:
    def __init__(self, timeline):
        self.timeline = timeline

    def GetCurrentTimeline(self):
        return self.timeline


class FakeProjectManager:
    def __init__(self, project):
        self.project = project

    def GetCurrentProject(self):
        return self.project


class FakeResolve:
    def __init__(self, timeline):
        self.manager = FakeProjectManager(FakeProject(timeline))

    def GetProjectManager(self):
        return self.manager


class ResolveVoiceoverBridgeTrackTests(unittest.TestCase):
    def bridge_for(self, timeline):
        return plugin.ResolveVoiceoverBridge(FakeResolve(timeline))

    def unit(self, start=10, end=20):
        return {"subtitle": {"startFrame": start, "endFrame": end}}

    def test_empty_a2_wins_over_existing_later_voice_track(self):
        timeline = FakeTimeline(
            names={1: "A1", 2: "", 3: "Kairos VO"},
            items={1: [FakeTimelineItem(0, 100)], 2: [], 3: []},
        )
        track = self.bridge_for(timeline).ensure_voice_track_for_unit(self.unit())
        self.assertEqual(track, 2)
        self.assertEqual(timeline.names[2], "Kairos VO 2")

    def test_existing_voice_track_is_used_when_a2_overlaps(self):
        timeline = FakeTimeline(
            names={1: "A1", 2: "", 3: "Kairos VO"},
            items={2: [FakeTimelineItem(0, 100)], 3: []},
        )
        track = self.bridge_for(timeline).ensure_voice_track_for_unit(self.unit())
        self.assertEqual(track, 3)

    def test_probe_adopts_empty_a2_when_no_voice_track_exists(self):
        timeline = FakeTimeline(names={1: "A1", 2: ""}, items={1: [FakeTimelineItem(0, 100)], 2: []})
        track = self.bridge_for(timeline).ensure_voice_track()
        self.assertEqual(track, 2)
        self.assertEqual(timeline.names[2], "Kairos VO")


if __name__ == "__main__":
    unittest.main()
