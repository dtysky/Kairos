import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const exec = promisify(execFile);
const backend = join(process.cwd(), 'vendor', 'resolve-color-host');
const python = join(backend, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');

async function lookup(names: string[], requested: string) {
  const code = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('host', sys.argv[1])
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)
class Timeline:
    def __init__(self, name): self.name = name
    def GetName(self): return self.name
class Project:
    def __init__(self, names): self.timelines = [Timeline(name) for name in names]
    def GetTimelineCount(self): return len(self.timelines)
    def GetTimelineByIndex(self, index): return self.timelines[index - 1]
    def SetCurrentTimeline(self, timeline): raise AssertionError('Lookup must not change the current timeline')
try:
    timeline = host.find_existing_edit_timeline(Project(json.loads(sys.argv[2])), sys.argv[3])
    print(json.dumps({'name': timeline.GetName() if timeline else None}))
except host.HostError as error:
    print(json.dumps(error.to_payload()))
`;
  const { stdout } = await exec(python, ['-c', code, join(backend, 'resolve-color-host.py'), JSON.stringify(names), requested], { windowsHide: true });
  return JSON.parse(stdout.trim());
}

describe('Resolve edit timeline maintenance identity', () => {
  it('finds a translated or manually renamed display label using the stable edit id', async () => {
    expect(await lookup(['闽南海岸 [ep1-minnan-coast]', '另一集 [ep2]'], 'ep1-minnan-coast [ep1-minnan-coast]'))
      .toEqual({ name: '闽南海岸 [ep1-minnan-coast]' });
  });

  it('blocks ambiguous copies even when one has the requested exact label', async () => {
    expect(await lookup(['ep1 [ep1]', '精剪副本 [ep1]'], 'ep1 [ep1]')).toMatchObject({
      code: 'resolve_edit_timeline_ambiguous', details: { editId: 'ep1', timelines: ['ep1 [ep1]', '精剪副本 [ep1]'] },
    });
  });

  it('does not match prefixes, other episodes, or backup names with trailing text', async () => {
    expect(await lookup(['第一集 [ep10]', '第一集 [ep1] backup', '第一集'], 'ep1 [ep1]')).toEqual({ name: null });
  });

  it('preserves exact-name lookup for legacy requests without an edit id', async () => {
    expect(await lookup(['Legacy cut', 'Other cut'], 'Legacy cut')).toEqual({ name: 'Legacy cut' });
    expect(await lookup(['Legacy cut'], 'Missing cut')).toEqual({ name: null });
  });
});

async function maintain(operation: string, names: string[]) {
  const code = `
import importlib.util, json, sys, tempfile
spec = importlib.util.spec_from_file_location('host', sys.argv[1])
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)
operation = sys.argv[2]
events = []
class Item:
    color = ''
    def GetName(self): return 'clip-00001 photo'
    def GetStart(self): return 0
    def GetEnd(self): return 30
    def GetClipColor(self): return self.color
    def SetClipColor(self, color):
        events.append('color')
        self.color = color
        return True
class Timeline:
    def __init__(self, name): self.name = name
    def GetName(self): return self.name
    def GetTrackCount(self, kind): return 1 if kind == 'video' else 0
    def GetItemListInTrack(self, kind, track): return [Item()] if kind == 'video' else []
    def GetSetting(self, key): return '30'
class Folder:
    def GetName(self): return 'Kairos Project Media'
    def GetSubFolders(self): return []
    def GetClipList(self): return []
class Root:
    def GetSubFolders(self): return [Folder()]
class Pool:
    def GetRootFolder(self): return Root()
class Project:
    def __init__(self, names): self.timelines = [Timeline(name) for name in names]
    def GetName(self): return 'Project [Edit]'
    def GetMediaPool(self): return Pool()
    def GetTimelineCount(self): return len(self.timelines)
    def GetTimelineByIndex(self, index): return self.timelines[index - 1]
    def SetCurrentTimeline(self, timeline):
        events.append('select:' + timeline.GetName())
        return True
    def GetSetting(self, key): return '30'
class Resolve:
    def OpenPage(self, page): return True
project = Project(json.loads(sys.argv[3]))
host.load_existing_project = lambda resolve, name: (project, project.GetName())
host.save_project_with_result = lambda project, resolve: True
payload = {
    'resolveProjectName': project.GetName(), 'timelineName': 'ep1 [ep1]',
    'roots': [{'rootId': 'media', 'localPath': tempfile.gettempdir()}],
    'clips': [{'clipId': 'clip-00001', 'resolveNameClipId': 'clip-00001', 'assetKind': 'photo'}],
}
class ResumeReached(Exception): pass
if operation == 'regenerate_rough_cut_suffix':
    host.normalize_rough_cut_clips = lambda clips: [{'sourceAbsolutePath': '/media/photo.jpg'}]
    host.collect_namespace_state = lambda folder: {'clipBySourcePath': {'/media/photo.jpg': object()}}
    def reject_creation(*args):
        events.append('unexpected-creation')
        raise RuntimeError('Resume must not create, rename, move, or change timeline settings')
    for name in ['ensure_namespace_folder', 'rename_legacy_timeline_if_needed',
                 'apply_project_timeline_spec_before_create', 'ensure_timeline',
                 'move_timeline_media_pool_item', 'apply_timeline_spec']:
        setattr(host, name, reject_creation)
    def validate(project, timeline, spec): events.append('validate:' + timeline.GetName())
    host.assert_timeline_matches_spec = validate
    def resume(project, pool, timeline, clips, payload):
        events.append('resume:' + timeline.GetName())
        raise ResumeReached()
    host.prepare_rough_cut_suffix_resume = resume
try:
    result = getattr(host, operation)(Resolve(), payload)
    print(json.dumps({'timelineName': result['timelineName'], 'events': events}))
except ResumeReached:
    print(json.dumps({'resumed': True, 'events': events}))
except host.HostError as error:
    print(json.dumps({'error': error.to_payload(), 'events': events}))
`;
  const { stdout } = await exec(python, ['-c', code, join(backend, 'resolve-color-host.py'), operation, JSON.stringify(names)], { windowsHide: true });
  return JSON.parse(stdout.trim());
}

describe.each([
  'export_edit_timeline_clip_packet',
  'mark_existing_rough_cut_clip_colors',
  'regenerate_rough_cut_suffix',
])('%s existing target integration', (operation) => {
  it('uses the uniquely identified timeline despite a changed display label', async () => {
    const result = await maintain(operation, ['闽南海岸 [ep1]', '下一集 [ep2]']);
    expect(result.error).toBeUndefined();
    expect(result.events).toContain('select:闽南海岸 [ep1]');
    expect(result.events).not.toContain('unexpected-creation');
    if (operation === 'regenerate_rough_cut_suffix') {
      expect(result).toEqual({ resumed: true, events: [
        'validate:闽南海岸 [ep1]', 'select:闽南海岸 [ep1]', 'resume:闽南海岸 [ep1]',
      ] });
    } else {
      expect(result.timelineName).toBe('闽南海岸 [ep1]');
    }
  });

  it('blocks a missing target before selection or mutation', async () => {
    expect(await maintain(operation, ['下一集 [ep2]'])).toMatchObject({
      error: { code: 'resolve_edit_timeline_missing' }, events: [],
    });
  });

  it('blocks duplicate edit identities before selection or mutation', async () => {
    expect(await maintain(operation, ['ep1 [ep1]', '手剪副本 [ep1]'])).toMatchObject({
      error: { code: 'resolve_edit_timeline_ambiguous' }, events: [],
    });
  });
});
