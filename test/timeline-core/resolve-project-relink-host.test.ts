import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const exec = promisify(execFile);
const backend = join(process.cwd(), 'vendor', 'resolve-color-host');
const python = join(backend, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');

async function relink(names: string[]) {
  const code = `
import importlib.util, json, sys, tempfile
from pathlib import Path
spec = importlib.util.spec_from_file_location('host', sys.argv[1])
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)
host.time.sleep = lambda seconds: None
events = []
class Clip:
    def __init__(self, path, kind='Video'): self.path, self.kind = path, kind
    def GetName(self): return Path(self.path).name if self.path else 'Nested timeline'
    def GetClipProperty(self, key=None):
        props = {'File Path': self.path, 'Type': self.kind}
        return props.get(key) if key else props
class Folder:
    def __init__(self, clips, children=None): self.clips, self.children = clips, children or []
    def GetClipList(self): return self.clips
    def GetSubFolderList(self): return self.children
class Pool:
    def GetRootFolder(self): return root
    def RelinkClips(self, clips, folder):
        events.append({'relink': [clip.GetName() for clip in clips]})
        for clip in clips: clip.path = str(Path(folder) / Path(clip.path).name)
        return True
class Timeline:
    def __init__(self, name, index): self.name, self.index = name, index
    def GetName(self): return self.name
    def GetUniqueId(self): return str(self.index)
    def GetTrackCount(self, kind): return 1
    def GetItemListInTrack(self, kind, track):
        return [a if self.index == 0 else missing] if kind == 'video' else [voice if self.index == 0 else audio]
class Project:
    def GetName(self): return 'Trip [Edit]'
    def GetMediaPool(self): return Pool()
    def GetTimelineCount(self): return len(timelines)
    def GetTimelineByIndex(self, index): return timelines[index - 1]
    def GetCurrentTimeline(self): events.append('unexpected-current-timeline-read')
    def SetCurrentTimeline(self, timeline): events.append('unexpected-timeline-switch')
class Manager:
    def GetCurrentProject(self): return Project()
    def SaveProject(self): events.append('save'); return True
class Resolve:
    def GetProjectManager(self): return Manager()
with tempfile.TemporaryDirectory() as temp:
    mappings = []
    for root_id, files in [('media', ['a.mp4', 'unused.mp4']), ('voiceover', ['vo.mp3']), ('audio', ['music.mp3'])]:
        local = Path(temp) / root_id
        local.mkdir()
        for name in files: (local / name).touch()
        old_root = '/old/media/voiceover' if root_id == 'voiceover' else '/old/' + root_id
        mappings.append({'rootId': root_id, 'localPath': str(local), 'candidates': [old_root]})
    a, unused = Clip('/old/media/a.mp4'), Clip('/old/media/unused.mp4')
    voice, audio = Clip('/old/media/voiceover/vo.mp3', 'Audio'), Clip('/old/audio/music.mp3', 'Audio')
    missing, unknown = Clip('/old/media/missing.mp4'), Clip('/unconfigured/other.mp4')
    # No Kairos-named bin: unused media and manually reorganized audio still belong to the project.
    root = Folder([Clip('', '时间线')], [Folder([a, unused, missing]), Folder([voice], [Folder([audio, unknown])])])
    timelines = [Timeline(name, index) for index, name in enumerate(json.loads(sys.argv[2]))]
    result = host.relink_edit_media(Resolve(), {
        'resolveProjectName': 'Trip [Edit]', 'roots': mappings,
        'editId': 'nonexistent', 'timelineName': 'Missing timeline', 'namespace': 'Missing bin',
        'timelineTrackTypes': ['video'], 'timelineCountUnmapped': False,
    })
    print(json.dumps({'result': result, 'events': events}))
`;
  const { stdout } = await exec(python, ['-c', code, join(backend, 'resolve-color-host.py'), JSON.stringify(names)], { windowsHide: true });
  return JSON.parse(stdout);
}

describe('project-wide Resolve media relink', () => {
  it.each([
    { names: [] }, { names: ['First cut', 'Second cut'] }, { names: ['Copy [ep1]', 'Another copy [ep1]'] },
  ])('relinks all bins without selecting or requiring any timeline ($names)', async ({ names }) => {
      const { result, events } = await relink(names);
      expect(result.scope).toBe('project');
      expect(result).not.toHaveProperty('timelineName');
      expect(result).not.toHaveProperty('namespace');
      expect(result.hostSummary).toMatchObject({
        relinked: 4, totalMediaItems: 7, localReadable: 4, missingTargetCount: 1,
        unmappedCount: 1, skippedNonFileCount: 1, oldPathRemaining: 0,
        timelineCount: names.length, timelineTrackTypes: ['video', 'audio'],
        timelineItemCount: names.length * 2,
        rootSummaries: {
          media: { relinked: 2, localReadable: 2, missingTargetCount: 1 },
          voiceover: { relinked: 1, localReadable: 1 },
          audio: { relinked: 1, localReadable: 1 },
        },
      });
      expect(events.filter((entry: unknown) => typeof entry === 'string')).toEqual(['save']);
      expect(events.flatMap((entry: { relink?: string[] }) => entry.relink || [])).toContain('unused.mp4');
      expect(result.hostSummary.timelines.map((row: { timelineName: string }) => row.timelineName)).toEqual(names);
      expect(result.hostSummary.timelineMissingTargetCount).toBe(Math.max(0, names.length - 1));
    },
  );
});
