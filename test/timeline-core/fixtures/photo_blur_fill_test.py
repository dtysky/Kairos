"""Behavioral contract tests; no running Resolve or media files required."""
import copy
import importlib.util
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location('blur', ROOT / 'scripts/resolve-apply-photo-blur-fill.py')
b = importlib.util.module_from_spec(spec)
spec.loader.exec_module(b)


class Output:
    def __init__(self, tool): self.tool = tool
    def GetTool(self): return self.tool


class Input:
    def __init__(self, key, tool): self.key, self.tool = key, tool
    def GetAttrs(self): return {'INPS_ID': self.key}
    def GetConnectedOutput(self): return Output(self.tool)


class Tool:
    def __init__(self, kind, name):
        self.kind, self.name = kind, name
        self.values, self.data, self.links = {}, {}, {}
    def GetAttrs(self):
        return {'TOOLS_Name': self.name, 'TOOLS_RegID': self.kind,
                'TOOLS_Clip_MediaID': self.values.get('MediaID')}
    def SetAttrs(self, attrs): self.name = attrs['TOOLS_Name']
    def SetInput(self, key, value): self.values[key] = value
    def GetInput(self, key, time=None):
        assert key not in ('Input', 'Foreground', 'Background'), 'Never evaluate image inputs'
        return self.values.get(key)
    def SetData(self, key, value): self.data[key] = value
    def GetData(self, key): return self.data.get(key)
    def ConnectInput(self, key, source, output): self.links[key] = source
    def GetInputList(self): return {k: Input(k, t) for k, t in self.links.items()}


class Comp:
    def __init__(self, fail=False):
        self.tools = [Tool('MediaIn', 'MediaIn1'), Tool('MediaOut', 'MediaOut1')]
        self.fail = fail
    def GetToolList(self, *args): return dict(enumerate(self.tools))
    def AddTool(self, kind, *args):
        if self.fail: return None
        t = Tool(kind, kind + str(len(self.tools)))
        self.tools.append(t)
        return t


class Media:
    def __init__(self, uid='pool-uid', mid='fusion-id'): self.uid, self.mid = uid, mid
    def GetUniqueId(self): return self.uid
    def GetMediaId(self): return self.mid
    def GetName(self): return 'photo.jpg'
    def GetClipProperty(self, key): return '/original/photo.jpg' if key == 'File Path' else ''


class Folder:
    def __init__(self): self.items, self.name = [Media()], 'Original photos'
    def GetUniqueId(self): return 'folder'
    def GetName(self): return self.name
    def GetClipList(self): return self.items
    def GetSubFolderList(self): return []


class Pool:
    def __init__(self): self.folder = Folder()
    def GetRootFolder(self): return self.folder
    def ImportMedia(self, *args): raise AssertionError('No source imports')
    def DeleteClips(self, *args): raise AssertionError('No automatic pool cleanup')


class Item:
    def __init__(self, pool):
        self.pool, self.comps, self.added, self.active = pool, {}, 0, None
        self.inject_pool_item = False
        self.fail_new = False
        self.fail_load = False
        self.props = dict(Scaling=0, ZoomGang=True, ZoomX=1, ZoomY=1, Pan=0, Tilt=0)
    def GetUniqueId(self): return 'photo-on-timeline'
    def GetMediaPoolItem(self): return self.pool.folder.items[0]
    def GetName(self): return 'photo'
    def GetStart(self): return 50
    def GetEnd(self): return 80
    def GetSourceStartFrame(self): return 0
    def GetSourceEndFrame(self): return 29
    def GetClipEnabled(self): return True
    def GetProperty(self): return dict(self.props)
    def SetProperty(self, key, value): self.props[key] = value; return True
    def GetFusionCompNameList(self): return list(self.comps)
    def GetFusionCompByName(self, name): return self.comps.get(name)
    def ImportFusionComp(self, *args): raise AssertionError('No path-based comp import')
    def AddFusionComp(self):
        self.added += 1
        c = Comp(self.fail_new)
        self.comps['Comp' + str(self.added)] = c
        self.active = 'Comp' + str(self.added)
        if self.inject_pool_item: self.pool.folder.items.append(Media('unexpected', 'unexpected-media'))
        return c
    def RenameFusionCompByName(self, old, new):
        if old not in self.comps or new in self.comps: return False
        self.comps[new] = self.comps.pop(old)
        if self.active == old: self.active = new
        return True
    def DeleteFusionCompByName(self, name):
        if name not in self.comps: return False
        if len(self.comps) > 1 and self.active == name: return False
        del self.comps[name]
        return True
    def LoadFusionCompByName(self, name):
        if self.fail_load:
            self.fail_load = False
            return None
        self.active = name
        return self.comps.get(name)


class Timeline:
    def __init__(self, item): self.item, self.legacy = item, False
    def GetUniqueId(self): return 'timeline'
    def GetName(self): return 'Photos [photos]'
    def GetStartFrame(self): return 0
    def GetEndFrame(self): return 80
    def GetTrackCount(self, kind): return (2 if self.legacy else 1) if kind == 'video' else 0
    def GetTrackName(self, kind, index): return 'Kairos Photo Foreground' if index == 2 else 'Video 1'
    def GetItemListInTrack(self, kind, index): return [self.item]
    def DeleteClips(self, *args): raise AssertionError('Never clear a legacy track')


class Project:
    def __init__(self, pool, timeline): self.pool, self.timeline = pool, timeline
    def GetName(self): return 'Project [Edit]'
    def GetMediaPool(self): return self.pool


class PhotoBlurContract(unittest.TestCase):
    def setUp(self):
        self.pool = Pool()
        self.item = Item(self.pool)
        self.timeline = Timeline(self.item)
        self.project = Project(self.pool, self.timeline)
        self.args = SimpleNamespace(project='Project [Edit]', timeline='Photos [photos]',
            photo_group='Kairos Photos', photo_color='Blue', comp_name=b.CDEFAULT_COMP_NAME,
            foreground_track=b.CDEFAULT_FOREGROUND_TRACK_NAME, name_contains='', limit=0,
            dry_run=False, replace_existing=False, no_save=False)
        self.entry = dict(item=self.item, trackIndex=1, name='photo', sourcePath='/original/photo.jpg',
                          sourceStem='photo', sourceWidth=4096, sourceHeight=2731, startFrame=50, endFrame=80)
        for target, value in [
            ('load_resolve', lambda: object()),
            ('load_existing_project', lambda *a: (self.project, self.project.GetName())),
            ('find_existing_edit_timeline', lambda *a: self.timeline),
            ('resolve_timeline_fps', lambda *a: 30),
            ('save_project_with_result', lambda *a: True),
        ]:
            patcher = patch.object(b.host, target, value)
            patcher.start(); self.addCleanup(patcher.stop)
        for target, value in [
            ('resolve_timeline_resolution', lambda *a: (3840, 2160)),
            ('collect_photo_items', lambda *a: [dict(self.entry)]),
        ]:
            patcher = patch.object(b, target, value)
            patcher.start(); self.addCleanup(patcher.stop)

    def test_first_apply_reuses_existing_source_and_second_apply_does_nothing(self):
        before = b.snapshot_media_pool(self.pool)
        first = b.run(self.args)
        self.assertEqual(first['appliedCount'], 1)
        comp = self.item.comps[b.CDEFAULT_COMP_NAME]
        src = b.tool_map(comp)['MediaIn1']
        self.assertEqual(src.GetAttrs()['TOOLS_Clip_MediaID'], 'fusion-id')
        self.assertEqual(src.GetData('MEDIA_ID'), 'fusion-id')
        self.assertNotEqual(src.GetData('MEDIA_ID'), self.item.GetMediaPoolItem().GetUniqueId())
        second = b.run(self.args)
        self.assertEqual(second['alreadyAppliedCount'], 1)
        self.assertEqual(second['appliedCount'], 0)
        self.assertEqual(self.item.added, 1)
        self.assertEqual(before, b.snapshot_media_pool(self.pool))

    def test_wrong_binding_and_disconnected_graph_are_not_silently_skipped(self):
        b.run(self.args)
        nodes = b.tool_map(self.item.comps[b.CDEFAULT_COMP_NAME])
        nodes['MediaIn1'].SetData('MEDIA_ID', 'duplicate-id')
        with self.assertRaisesRegex(b.ToolError, 'original MediaPool'): b.run(self.args)
        nodes['MediaIn1'].SetData('MEDIA_ID', 'fusion-id')
        nodes['MediaOut1'].links.clear()
        with self.assertRaisesRegex(b.ToolError, 'connection'): b.run(self.args)
        self.assertEqual(self.item.added, 1)

    def test_unexpected_pool_addition_stops_and_does_not_delete_unknown_media(self):
        self.item.inject_pool_item = True
        with self.assertRaises(b.ToolError) as error: b.run(self.args)
        self.assertEqual(error.exception.code, 'photo_media_pool_changed')
        self.assertEqual(error.exception.details['added'], ['unexpected'])
        self.assertFalse(self.item.comps)
        self.assertEqual(len(self.pool.folder.items), 2)
        self.assertEqual(self.item.props['Scaling'], 0)

    def test_move_or_replace_of_same_count_pool_is_detected(self):
        before = b.snapshot_media_pool(self.pool)
        self.pool.folder.name = 'Moved folder'
        with self.assertRaises(b.ToolError): b.assert_media_pool_unchanged(before, b.snapshot_media_pool(self.pool))
        self.pool.folder.name = 'Original photos'
        self.pool.folder.items[0].mid = 'replaced-source'
        with self.assertRaises(b.ToolError): b.assert_media_pool_unchanged(before, b.snapshot_media_pool(self.pool))

    def test_failed_replacement_retains_previous_comp_and_mapping(self):
        b.run(self.args)
        old = self.item.comps[b.CDEFAULT_COMP_NAME]
        props = dict(self.item.props)
        self.args.replace_existing = True
        self.item.fail_new = True
        with self.assertRaises(b.ToolError): b.run(self.args)
        self.assertEqual(self.item.comps, {b.CDEFAULT_COMP_NAME: old})
        self.assertEqual(self.item.props, props)
        self.item.fail_new = False
        self.item.fail_load = True
        with self.assertRaises(b.ToolError): b.run(self.args)
        self.assertEqual(self.item.comps, {b.CDEFAULT_COMP_NAME: old})
        self.assertEqual(self.item.active, b.CDEFAULT_COMP_NAME)

    def test_successful_replacement_has_one_comp_and_unchanged_pool(self):
        b.run(self.args)
        old = self.item.comps[b.CDEFAULT_COMP_NAME]
        before = b.snapshot_media_pool(self.pool)
        self.args.replace_existing = True
        result = b.run(self.args)
        self.assertEqual(result['appliedCount'], 1)
        self.assertEqual(len(self.item.comps), 1)
        self.assertIsNot(self.item.comps[b.CDEFAULT_COMP_NAME], old)
        self.assertEqual(before, b.snapshot_media_pool(self.pool))

    def test_dry_run_and_missing_source_do_not_modify_timeline(self):
        self.args.dry_run = True
        self.assertEqual(b.run(self.args)['wouldApplyCount'], 1)
        self.assertFalse(self.item.comps)
        self.pool.folder.items[0].mid = ''
        with self.assertRaises(b.ToolError): b.run(self.args)
        self.assertEqual(self.item.added, 0)

    def test_legacy_foreground_track_is_preserved_and_blocks(self):
        self.timeline.legacy = True
        with self.assertRaises(b.ToolError) as error: b.run(self.args)
        self.assertEqual(error.exception.code, 'legacy_photo_foreground_track')
        self.assertEqual(self.item.added, 0)

    def test_layout_preserves_complete_photo_and_background_covers_canvas(self):
        for w, h in [(4096, 2731), (2731, 4096), (4096, 3070), (8000, 2000)]:
            entry = dict(self.entry, sourceWidth=w, sourceHeight=h)
            layout = b.photo_layout(entry, 3840, 2160)
            self.assertLessEqual(w * layout['foregroundScale'], 3840.001)
            self.assertLessEqual(h * layout['foregroundScale'], 2160.001)
            self.assertGreaterEqual(layout['backgroundWidth'], 3840)
            self.assertGreaterEqual(layout['backgroundHeight'], 2160)


if __name__ == '__main__': unittest.main(verbosity=2)
