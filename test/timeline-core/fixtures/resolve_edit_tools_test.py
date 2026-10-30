import base64
import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
BACKEND = ROOT / 'vendor/resolve-color-host'
sys.path.insert(0, str(BACKEND))
import resolve_edit_tools as edit
spec = importlib.util.spec_from_file_location('host', BACKEND / 'resolve-color-host.py')
h = importlib.util.module_from_spec(spec)
spec.loader.exec_module(h)


class Item:
    def __init__(self, name='a'):
        self.name, self.end, self.source_end, self.speed = name, 473, 1151, 100
        self.fades, self.properties, self.links = {'FadeIn': 0, 'FadeOut': 0}, {'Opacity': 50}, []
    def GetUniqueId(self): return self.name
    def GetName(self): return self.name
    def GetType(self): return 'video'
    def GetStart(self): return 0
    def GetEnd(self): return self.end
    def GetSourceStartFrame(self): return 205
    def GetSourceEndFrame(self): return self.source_end
    def GetSpeed(self): return {'Percentage': self.speed}
    def GetLinkedItems(self): return self.links
    def SetSpeed(self, options):
        self.speed = options['Percentage']
        self.end = round(473 / (self.speed / 100))
        self.source_end = 205 + self.end * 2 * (self.speed / 100)
        for link in self.links: link.SetSpeed(options)
        return True
    def SetFades(self, options): self.fades = options; return True
    def GetFades(self): return self.fades
    def GetProperties(self): return self.properties
    def CopyAttributes(self, targets, options):
        for target in targets: target.properties = dict(self.properties)
        return True


class Timeline:
    def __init__(self):
        self.items, self.locked, self.backups = [Item('a'), Item('b')], False, []
    def GetName(self): return 'Episode [ep]'
    def GetUniqueId(self): return 'timeline-id'
    def GetTrackCount(self, kind): return 1 if kind == 'video' else 0
    def GetItemListInTrack(self, kind, track): return self.items if kind == 'video' else []
    def GetIsTrackLocked(self, kind, track): return self.locked
    def GetSelectedClips(self): return [self.items[1]]
    def GetStartFrame(self): return 100
    def GetEndFrame(self): return 1000
    def DuplicateTimeline(self, name): self.backups.append(name); return self
    def ExportFrame(self, offset, options): return {'success': True, 'data': base64.b64encode(b'\x89PNG\r\n\x1a\nfixture').decode()}


class Project:
    def __init__(self): self.timeline = Timeline()
    def GetName(self): return 'Trip [Edit]'
    def GetUniqueId(self): return 'project-id'
    def GetMediaPool(self): return object()
    def GetCurrentTimeline(self): return self.timeline
    def SetCurrentTimeline(self, timeline): self.timeline = timeline; return True
    def GetTimelineCount(self): return 1
    def GetTimelineByIndex(self, index): return self.timeline


class Resolve:
    def __init__(self): self.project, self.saves = Project(), 0
    def GetVersionString(self): return '21.1.2.10'
    def GetProjectManager(self): return self
    def GetCurrentProject(self): return self.project
    def SaveProject(self): self.saves += 1; return True


class Tests(unittest.TestCase):
    def setUp(self):
        self.resolve = Resolve()
        self.timeline = self.resolve.project.timeline
        self.payload = {'action': 'fades', 'resolveProjectName': 'Trip [Edit]', 'timelineName': 'Episode [ep]',
                        'timelineId': 'timeline-id', 'itemIds': ['a'], 'FadeIn': 3, 'FadeOut': 4}
    def run_edit(self, **changes): return edit.execute(h, self.resolve, {**self.payload, **changes})
    def test_capabilities_does_not_access_project(self):
        with patch.object(self.resolve, 'GetProjectManager', side_effect=AssertionError):
            self.assertTrue(edit.execute(h, self.resolve, {'action': 'capabilities'})['capabilities']['frame']['documentedForVersion'])
    def test_inspect_reports_real_selection_and_never_writes(self):
        out = self.run_edit(action='inspect')
        self.assertEqual(out['selectedItemIds'], ['b'])
        self.assertEqual([r['selected'] for r in out['items']], [False, True])
        self.assertEqual(self.resolve.saves, 0)
        with patch.object(self.timeline, 'GetSelectedClips', return_value=None):
            with self.assertRaises(h.HostError): self.run_edit(action='inspect')
    def test_transition_inventory_allows_only_returned_transition_additions(self):
        transition = Item('transition'); transition.end = 4
        transition.properties = {'TransitionType':'Cross Dissolve', 'TransitionCategory':'simple', 'TransitionDuration':4, 'TransitionAlignment':'right'}
        def add(options): self.timeline.items.append(transition); return transition
        with patch.object(self.timeline.items[0], 'AddTransition', side_effect=add, create=True):
            out = self.run_edit(action='transition', position='start', duration=4, apply=True)
        self.assertTrue(out['applied'])
        self.assertEqual(out['createdTransitionIds'], ['transition'])
    def test_duplicate_selecting_its_copy_restores_explicit_target(self):
        original = self.timeline
        backup = Timeline()
        backup.GetUniqueId = lambda: 'backup'
        def duplicate(name):
            self.resolve.project.timeline = backup
            return backup
        with patch.object(original, 'DuplicateTimeline', side_effect=duplicate):
            self.assertTrue(self.run_edit(apply=True)['applied'])
        self.assertIs(self.resolve.project.timeline, original)
    def test_wrong_project_timeline_and_item_block_before_backup(self):
        for changes in ({'resolveProjectName': 'Other'}, {'timelineId': 'old'}, {'itemIds': ['missing']}, {'itemIds': ['a','a']}, {'timelineId': None}, {'FadeIn': 500}):
            with self.assertRaises(h.HostError): self.run_edit(apply=True, **changes)
        self.assertEqual(self.timeline.backups, [])
    def test_locked_track_and_audio_attributes_block(self):
        self.timeline.locked = True
        with self.assertRaises(h.HostError): self.run_edit(apply=True)
        self.timeline.locked = False
        for attribute in ('audioVolume', 'colorCorrection', 'allVideoAttributes', 'retimeEffect'):
            with self.assertRaises(h.HostError): self.run_edit(action='copy-video-attributes', sourceId='b', attributes=[attribute], apply=True)
        self.assertEqual(self.timeline.backups, [])
    def test_dry_run_does_not_write(self):
        self.assertFalse(self.run_edit()['applied'])
        self.assertEqual(self.timeline.backups, [])
    def test_recovery_saved_before_edit_and_kept(self):
        item = self.timeline.items[0]
        def fade(options):
            self.assertEqual(self.resolve.saves, 1)
            self.assertEqual(len(self.timeline.backups), 1)
            item.fades = options
            return True
        with patch.object(item, 'SetFades', side_effect=fade):
            out = self.run_edit(apply=True)
        self.assertTrue(out['applied'])
        self.assertIn('recovery', out)
        self.assertEqual(self.resolve.saves, 2)
    def test_failure_returns_recovery_without_claiming_success(self):
        with patch.object(self.timeline.items[0], 'SetFades', return_value=False):
            with self.assertRaises(h.HostError) as error: self.run_edit(apply=True)
        self.assertTrue(error.exception.details['partialChangesPossible'])
        self.assertIn('recovery', error.exception.details)
    def test_failed_recovery_save_prevents_edit(self):
        with patch.object(self.resolve, 'SaveProject', return_value=False), patch.object(self.timeline.items[0], 'SetFades') as write:
            with self.assertRaises(h.HostError): self.run_edit(apply=True)
            write.assert_not_called()
    def test_copy_whitelisted_properties_and_readback(self):
        self.timeline.items[0].properties['Opacity'] = 100
        out = self.run_edit(action='copy-video-attributes', sourceId='b', attributes=['opacity'], apply=True)
        self.assertTrue(out['applied'])
        self.assertEqual(self.timeline.items[0].properties['Opacity'], 50)
    def test_frame_range_and_exclusive_output(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'preview.png'
            self.run_edit(action='frame', frameOffset=0, outputPath=str(path))
            before = path.read_bytes()
            with self.assertRaises(h.HostError): self.run_edit(action='frame', frameOffset=0, outputPath=str(path))
            self.assertEqual(path.read_bytes(), before)
            with self.assertRaises(h.HostError): self.run_edit(action='frame', frameOffset=900)
        self.assertEqual(self.timeline.backups, [])
    def test_speed_version_gate_precedes_any_timeline_mutation(self):
        with patch.object(self.resolve, 'GetVersionString', return_value='21.0.4'), patch.object(h, 'load_existing_project', return_value=(self.resolve.project, 'Trip [Edit]')):
            with self.assertRaises(h.HostError) as error:
                h.create_rough_cut_timeline(self.resolve, {'resolveProjectName': 'Trip [Edit]', 'timelineName':'Episode [ep]', 'clips':[{
                    'clipId':'clip-1','assetId':'a','sourceAbsolutePath':'/media/a.mp4','speed':2,'spanType':'drive',
                    'timelineInMs':0,'timelineOutMs':1000,'audioGainDb':0}]})
            self.assertEqual(error.exception.code, 'resolve_speed_unsupported')
    def test_speed_preserves_source_and_linked_audio_with_rounding(self):
        for speed in (2,3,4,5):
            item = Item(); item.links = [Item('linked')]
            h.apply_rough_cut_speed(item, {'clipId':'c','speed':speed,'fps':60}, 30)
            self.assertEqual(item.speed, speed*100)
            self.assertEqual(item.links[0].end, item.end)
    def test_speed_rejects_false_success_source_drift_and_link_mismatch(self):
        item = Item()
        with patch.object(item, 'SetSpeed', return_value=True):
            with self.assertRaises(h.HostError): h.apply_rough_cut_speed(item, {'clipId':'c','speed':2,'fps':60},30)
        item = Item()
        with patch.object(item, 'GetSourceEndFrame', side_effect=[1151, 900]):
            with self.assertRaises(h.HostError): h.apply_rough_cut_speed(item, {'clipId':'c','speed':2,'fps':60},30)
        item = Item(); item.links = [Item('linked')]
        with patch.object(item.links[0], 'SetSpeed', return_value=True):
            with self.assertRaises(h.HostError): h.apply_rough_cut_speed(item, {'clipId':'c','speed':2,'fps':60},30)


if __name__ == '__main__': unittest.main()
