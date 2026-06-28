import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const exec = promisify(execFile);
const hostPath = join(process.cwd(), 'vendor', 'resolve-color-host', 'resolve-color-host.py');
const pythonPath = process.platform === 'win32'
  ? join(process.cwd(), 'vendor', 'resolve-color-host', '.venv', 'Scripts', 'python.exe')
  : join(process.cwd(), 'vendor', 'resolve-color-host', '.venv', 'bin', 'python');

async function inspectMediaSync(payload: Record<string, unknown>) {
  const code = `
import importlib.util
import json
import sys
from pathlib import Path

host_path = sys.argv[1]
payload = json.loads(sys.argv[2])

spec = importlib.util.spec_from_file_location("resolve_color_host", host_path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class FakeClip:
    def __init__(self, source_path):
        self.source_path = str(Path(source_path).expanduser().resolve())
        self.folder = None

    def GetName(self):
        return Path(self.source_path).name

    def GetClipProperty(self, key=None):
        props = {
            "File Path": self.source_path,
            "FilePath": self.source_path,
            "Type": "Video",
        }
        if key:
            return props.get(key)
        return props


class FakeFolder:
    def __init__(self, name, parent=None):
        self.name = name
        self.parent = parent
        self.clips = []
        self.subfolders = []

    def GetName(self):
        return self.name

    def GetClipList(self):
        return list(self.clips)

    def GetSubFolders(self):
        return list(self.subfolders)

    def GetSubFolderList(self):
        return list(self.subfolders)


class FakeMediaPool:
    def __init__(self, root):
        self.root = root
        self.current_folder = root
        self.import_calls = []
        self.move_calls = []
        self.delete_calls = []

    def GetRootFolder(self):
        return self.root

    def SetCurrentFolder(self, folder):
        self.current_folder = folder
        return True

    def AddSubFolder(self, parent, name):
        folder = FakeFolder(name, parent)
        parent.subfolders.append(folder)
        return folder

    def ImportMedia(self, paths):
        imported = []
        for source_path in paths:
            clip = FakeClip(source_path)
            clip.folder = self.current_folder
            self.current_folder.clips.append(clip)
            imported.append(clip)
            self.import_calls.append({"path": clip.source_path, "folder": folder_path(self.current_folder)})
        return imported

    def MoveClips(self, clips, target_folder):
        for clip in clips:
            source_folder = getattr(clip, "folder", None)
            if source_folder and clip in source_folder.clips:
                source_folder.clips.remove(clip)
            target_folder.clips.append(clip)
            clip.folder = target_folder
            self.move_calls.append({
                "path": clip.source_path,
                "from": folder_path(source_folder) if source_folder else "",
                "to": folder_path(target_folder),
            })
        return True

    def DeleteFolders(self, folders):
        for folder in folders:
            if folder.clips or folder.subfolders:
                return False
        for folder in folders:
            if folder.parent and folder in folder.parent.subfolders:
                folder.parent.subfolders.remove(folder)
            self.delete_calls.append(folder_path(folder))
        return True


class FakeMediaStorage:
    def __init__(self, media_pool):
        self.media_pool = media_pool

    def AddItemListToMediaPool(self, paths):
        return self.media_pool.ImportMedia(paths)


def folder_path(folder):
    if folder is None:
        return ""
    parts = []
    current = folder
    while current is not None:
        parts.append(current.GetName())
        current = current.parent
    return "/".join(reversed(parts))


def ensure_folder_chain(media_pool, root_folder, relative_dir):
    current = root_folder
    for segment in [part for part in str(relative_dir or "").split("/") if part]:
        existing = next((folder for folder in current.subfolders if folder.GetName() == segment), None)
        current = existing or media_pool.AddSubFolder(current, segment)
    return current


def add_clip(folder, source_path):
    clip = FakeClip(source_path)
    clip.folder = folder
    folder.clips.append(clip)
    return clip


def folder_tree(folder):
    return {
        "name": folder.GetName(),
        "clips": [clip.GetName() for clip in folder.clips],
        "children": [folder_tree(child) for child in folder.subfolders],
    }


root = FakeFolder("Root")
media_pool = FakeMediaPool(root)
media_storage = FakeMediaStorage(media_pool)
namespace = media_pool.AddSubFolder(root, "Kairos Project Media")

for entry in payload.get("namespaceClips", []):
    add_clip(ensure_folder_chain(media_pool, namespace, entry.get("relativeDir", "")), entry["sourcePath"])

for relative_dir in payload.get("namespaceEmptyDirs", []):
    ensure_folder_chain(media_pool, namespace, relative_dir)

for entry in payload.get("rootClips", []):
    add_clip(ensure_folder_chain(media_pool, root, entry.get("relativeDir", "")), entry["sourcePath"])

namespace_state = module.collect_namespace_state(namespace)
fallback_state = module.collect_namespace_state(root) if payload.get("useFallback") else None
prepared_entries, summary = module.sync_namespace_clips(
    media_pool,
    media_storage,
    namespace,
    namespace_state,
    payload["clipRequests"],
    dedupe_by_source_path=True,
    fallback_state=fallback_state,
    cleanup_empty_folders=bool(payload.get("cleanupEmptyFolders")),
)

print(json.dumps({
    "summary": summary,
    "preparedCount": len(prepared_entries),
    "tree": folder_tree(namespace),
    "imports": media_pool.import_calls,
    "moves": media_pool.move_calls,
    "deletes": media_pool.delete_calls,
}, ensure_ascii=False))
`;

  const { stdout } = await exec(
    pythonPath,
    ['-c', code, hostPath, JSON.stringify(payload)],
    {
      encoding: 'utf8',
      windowsHide: true,
    },
  );
  return JSON.parse(stdout) as {
    summary: {
      imported: number;
      moved: number;
      reused: number;
      emptyFoldersDeleted: number;
    };
    preparedCount: number;
    tree: {
      name: string;
      clips: string[];
      children: Array<{ name: string; clips: string[]; children: unknown[] }>;
    };
    imports: unknown[];
    moves: Array<{ path: string; from: string; to: string }>;
    deletes: string[];
  };
}

function fixturePath(name: string): string {
  return join(tmpdir(), 'kairos-resolve-media-sync-host-test', name);
}

async function inspectRoughCutAppendInfo() {
  const code = `
import importlib.util
import json
import sys

host_path = sys.argv[1]

spec = importlib.util.spec_from_file_location("resolve_color_host", host_path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class FakeMediaPoolItem:
    def GetClipProperty(self, key=None):
        props = {
            "FPS": "30",
            "Start": "0",
            "End": "300",
            "File Path": "H:/media/C0001.mp4",
        }
        if key:
            return props.get(key)
        return props


clip = {
    "clipId": "clip-1",
    "assetId": "asset-1",
    "assetKind": "video",
    "sourceAbsolutePath": "H:/media/C0001.mp4",
    "timelineInMs": 2000,
    "timelineOutMs": 4000,
    "sourceInMs": 1000,
    "sourceOutMs": 3000,
    "fps": 30,
}

info = module.build_rough_cut_append_clip_info(FakeMediaPoolItem(), clip, 30)
print(json.dumps({
    "recordFrame": info.get("recordFrame"),
    "startFrame": info.get("startFrame"),
    "endFrame": info.get("endFrame"),
    "keys": sorted(info.keys()),
}, ensure_ascii=False))
`;

  const { stdout } = await exec(
    pythonPath,
    ['-c', code, hostPath],
    {
      encoding: 'utf8',
      windowsHide: true,
    },
  );
  return JSON.parse(stdout) as {
    recordFrame: number;
    startFrame: number;
    endFrame: number;
    keys: string[];
  };
}

async function inspectRoughCutClipColoring() {
  const code = `
import importlib.util
import json
import sys

host_path = sys.argv[1]

spec = importlib.util.spec_from_file_location("resolve_color_host", host_path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class FakeTimelineItem:
    def __init__(self):
        self.color = ""
        self.calls = []

    def SetClipColor(self, color):
        self.calls.append(["SetClipColor", color])
        self.color = color
        return True

    def GetClipColor(self):
        return self.color


ordinary_video_item = FakeTimelineItem()
ordinary_audio_item = FakeTimelineItem()
muted_item = FakeTimelineItem()
photo_video_item = FakeTimelineItem()
timelapse_video_item = FakeTimelineItem()
timelapse_audio_item = FakeTimelineItem()
audible_summary = {
    "color": "Orange",
    "itemScope": "ordinary-video-and-linked-audio; linked-audio-only-when-video-has-visual-category-color",
    "checked": 0,
    "colored": 0,
    "failed": 0,
}
visual_summary = {
    "photo": {"color": "Blue", "itemScope": "video", "checked": 0, "colored": 0, "failed": 0},
    "timelapse": {"color": "Purple", "itemScope": "video", "checked": 0, "colored": 0, "failed": 0},
}

module.apply_rough_cut_audible_clip_color([ordinary_video_item, ordinary_audio_item], {
    "clipId": "clip-00001",
    "assetId": "asset-1",
    "assetKind": "video",
    "muteAudio": False,
}, audible_summary)
module.apply_rough_cut_audible_clip_color([muted_item], {
    "clipId": "clip-00002",
    "assetId": "asset-2",
    "assetKind": "video",
    "muteAudio": True,
}, audible_summary)
module.apply_rough_cut_visual_clip_color([photo_video_item], {
    "clipId": "clip-00003",
    "assetId": "asset-3",
    "assetKind": "photo",
    "muteAudio": True,
}, visual_summary)
module.apply_rough_cut_visual_clip_color([timelapse_video_item], {
    "clipId": "clip-00004",
    "assetId": "asset-4",
    "assetKind": "video",
    "spanType": "timelapse",
    "muteAudio": False,
}, visual_summary)
module.apply_rough_cut_audible_clip_color([timelapse_audio_item], {
    "clipId": "clip-00004",
    "assetId": "asset-4",
    "assetKind": "video",
    "spanType": "timelapse",
    "muteAudio": False,
}, audible_summary)

print(json.dumps({
    "audibleSummary": audible_summary,
    "visualSummary": visual_summary,
    "ordinaryVideoColor": ordinary_video_item.GetClipColor(),
    "ordinaryAudioColor": ordinary_audio_item.GetClipColor(),
    "mutedColor": muted_item.GetClipColor(),
    "photoVideoColor": photo_video_item.GetClipColor(),
    "timelapseVideoColor": timelapse_video_item.GetClipColor(),
    "timelapseAudioColor": timelapse_audio_item.GetClipColor(),
    "ordinaryVideoCalls": ordinary_video_item.calls,
    "ordinaryAudioCalls": ordinary_audio_item.calls,
    "mutedCalls": muted_item.calls,
    "photoVideoCalls": photo_video_item.calls,
    "timelapseVideoCalls": timelapse_video_item.calls,
    "timelapseAudioCalls": timelapse_audio_item.calls,
}, ensure_ascii=False))
`;

  const { stdout } = await exec(
    pythonPath,
    ['-c', code, hostPath],
    {
      encoding: 'utf8',
      windowsHide: true,
    },
  );
  return JSON.parse(stdout) as {
    audibleSummary: {
      color: string;
      itemScope: string;
      checked: number;
      colored: number;
      failed: number;
    };
    visualSummary: Record<string, {
      color: string;
      itemScope: string;
      checked: number;
      colored: number;
      failed: number;
    }>;
    ordinaryVideoColor: string;
    ordinaryAudioColor: string;
    mutedColor: string;
    photoVideoColor: string;
    timelapseVideoColor: string;
    timelapseAudioColor: string;
    ordinaryVideoCalls: unknown[];
    ordinaryAudioCalls: unknown[];
    mutedCalls: unknown[];
    photoVideoCalls: unknown[];
    timelapseVideoCalls: unknown[];
    timelapseAudioCalls: unknown[];
  };
}

async function inspectRoughCutVisualClipGrouping() {
  const code = `
import importlib.util
import json
import sys

host_path = sys.argv[1]

spec = importlib.util.spec_from_file_location("resolve_color_host", host_path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class FakeColorGroup:
    def __init__(self, name):
        self.name = name

    def GetName(self):
        return self.name


class FakeProject:
    def __init__(self):
        self.groups = [FakeColorGroup("Kairos Timelapse")]
        self.add_calls = []

    def GetColorGroupsList(self):
        return self.groups

    def AddColorGroup(self, name):
        self.add_calls.append(name)
        group = FakeColorGroup(name)
        self.groups.append(group)
        return group


class FakeTimelineItem:
    def __init__(self, group=None):
        self.group = group
        self.calls = []

    def GetColorGroup(self):
        return self.group

    def RemoveFromColorGroup(self):
        group_name = self.group.GetName() if self.group else None
        self.calls.append(["RemoveFromColorGroup", group_name])
        self.group = None
        return True

    def AssignToColorGroup(self, group):
        self.calls.append(["AssignToColorGroup", group.GetName()])
        self.group = group
        return True


project = FakeProject()
summary = {
    "photo": {
        "groupName": "Kairos Photos",
        "itemScope": "video",
        "checked": 0,
        "assigned": 0,
        "alreadyAssigned": 0,
        "failed": 0,
        "created": False,
    },
    "timelapse": {
        "groupName": "Kairos Timelapse",
        "itemScope": "video",
        "checked": 0,
        "assigned": 0,
        "alreadyAssigned": 0,
        "failed": 0,
        "created": False,
    },
}
existing_groups_by_name = module.collect_color_groups_by_name(project)
groups_by_category = {}
ordinary_item = FakeTimelineItem()
photo_item = FakeTimelineItem()
timelapse_item = FakeTimelineItem()
already_grouped_item = FakeTimelineItem(project.groups[0])

ordinary_group = module.apply_rough_cut_visual_clip_group(
    [ordinary_item],
    {
        "clipId": "clip-00001",
        "assetId": "asset-ordinary",
        "assetKind": "video",
        "spanType": "drive",
    },
    project,
    existing_groups_by_name,
    groups_by_category,
    summary,
)
photo_group = module.apply_rough_cut_visual_clip_group(
    [photo_item],
    {
        "clipId": "clip-00002",
        "assetId": "asset-photo",
        "assetKind": "photo",
    },
    project,
    existing_groups_by_name,
    groups_by_category,
    summary,
)
timelapse_group = module.apply_rough_cut_visual_clip_group(
    [timelapse_item],
    {
        "clipId": "clip-00003",
        "assetId": "asset-timelapse",
        "assetKind": "video",
        "spanType": "timelapse",
    },
    project,
    existing_groups_by_name,
    groups_by_category,
    summary,
)
already_grouped = module.apply_rough_cut_visual_clip_group(
    [already_grouped_item],
    {
        "clipId": "clip-00004",
        "assetId": "asset-timelapse-2",
        "assetKind": "video",
        "spanType": "timelapse",
    },
    project,
    existing_groups_by_name,
    groups_by_category,
    summary,
)

print(json.dumps({
    "summary": summary,
    "ordinaryGroup": ordinary_group,
    "photoGroup": photo_group,
    "timelapseGroup": timelapse_group,
    "alreadyGrouped": already_grouped,
    "projectAddCalls": project.add_calls,
    "projectGroupNames": [group.GetName() for group in project.groups],
    "ordinaryCalls": ordinary_item.calls,
    "photoCalls": photo_item.calls,
    "timelapseCalls": timelapse_item.calls,
    "alreadyGroupedCalls": already_grouped_item.calls,
    "photoAssignedGroup": photo_item.GetColorGroup().GetName(),
    "timelapseAssignedGroup": timelapse_item.GetColorGroup().GetName(),
    "alreadyAssignedGroup": already_grouped_item.GetColorGroup().GetName(),
}, ensure_ascii=False))
`;

  const { stdout } = await exec(
    pythonPath,
    ['-c', code, hostPath],
    {
      encoding: 'utf8',
      windowsHide: true,
    },
  );
  return JSON.parse(stdout) as {
    summary: Record<string, {
      groupName: string;
      itemScope: string;
      checked: number;
      assigned: number;
      alreadyAssigned: number;
      failed: number;
      created: boolean;
    }>;
    ordinaryGroup: string | null;
    photoGroup: string;
    timelapseGroup: string;
    alreadyGrouped: string;
    projectAddCalls: string[];
    projectGroupNames: string[];
    ordinaryCalls: unknown[];
    photoCalls: unknown[];
    timelapseCalls: unknown[];
    alreadyGroupedCalls: unknown[];
    photoAssignedGroup: string;
    timelapseAssignedGroup: string;
    alreadyAssignedGroup: string;
  };
}

async function inspectExistingRoughCutClipColorMatching() {
  const code = `
import importlib.util
import json
import sys
from pathlib import Path

host_path = sys.argv[1]

spec = importlib.util.spec_from_file_location("resolve_color_host", host_path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class FakeTimelineItem:
    def __init__(self, name, source_path, start):
        self.name = name
        self.source_path = str(Path(source_path).expanduser().resolve())
        self.start = start
        self.color = ""
        self.calls = []

    def GetName(self):
        return self.name

    def GetStart(self):
        return self.start

    def GetEnd(self):
        return self.start + 30

    def GetClipProperty(self, key=None):
        props = {"File Path": self.source_path}
        if key:
            return props.get(key)
        return props

    def GetMediaPoolItem(self):
        return self

    def SetClipColor(self, color):
        self.calls.append(["SetClipColor", color])
        self.color = color
        return True

    def GetClipColor(self):
        return self.color


class FakeTimeline:
    def __init__(self, items):
        self.items = items

    def GetTrackCount(self, track_type):
        return 1 if str(track_type).lower() == "video" else 0

    def GetItemListInTrack(self, track_type, track_index):
        return self.items if str(track_type).lower() == "video" and track_index == 1 else []


photo_item = FakeTimelineItem("clip-00164 photo DSC0001", "media/DSC0001.jpg", 10)
timelapse_item = FakeTimelineItem("TL0001.mp4", "media/TL0001.mp4", 40)
ordinary_item = FakeTimelineItem("clip-00166 ordinary C0001", "media/C0001.mp4", 70)
clips = module.normalize_rough_cut_clip_color_marker_clips([
    {
        "index": 1,
        "resolveNameClipId": "clip-00164",
        "contentKind": "photo",
        "sourceFilePath": "media/DSC0001.jpg",
        "sourceStem": "DSC0001",
        "timelineInMs": 1000,
    },
    {
        "index": 2,
        "contentKind": "timelapse",
        "frameworkClass": "timelapse",
        "sourceFilePath": "media/TL0001.mp4",
        "sourceStem": "TL0001",
        "timelineInMs": 2000,
    },
    {
        "index": 3,
        "contentKind": "drive",
        "sourceFilePath": "media/C0001.mp4",
        "sourceStem": "C0001",
        "timelineInMs": 3000,
    },
])
entries = module.collect_timeline_video_color_marker_entries(FakeTimeline([photo_item, timelapse_item, ordinary_item]))
state = module.build_timeline_color_marker_match_state(clips, entries)
summary = {
    "photo": {"color": "Blue", "itemScope": "video", "checked": 0, "colored": 0, "failed": 0},
    "timelapse": {"color": "Purple", "itemScope": "video", "checked": 0, "colored": 0, "failed": 0},
}
marked = []
for clip in clips:
    match = module.match_existing_rough_cut_video_item(clip, state)
    color = module.apply_rough_cut_visual_clip_color([match["item"]], clip, summary)
    marked.append({"clipIndex": clip["clipIndex"], "method": match["method"], "color": color})

print(json.dumps({
    "normalizedCount": len(clips),
    "marked": marked,
    "summary": summary,
    "photoColor": photo_item.GetClipColor(),
    "timelapseColor": timelapse_item.GetClipColor(),
    "ordinaryColor": ordinary_item.GetClipColor(),
    "photoCalls": photo_item.calls,
    "timelapseCalls": timelapse_item.calls,
    "ordinaryCalls": ordinary_item.calls,
}, ensure_ascii=False))
`;

  const { stdout } = await exec(
    pythonPath,
    ['-c', code, hostPath],
    {
      encoding: 'utf8',
      windowsHide: true,
    },
  );
  return JSON.parse(stdout) as {
    normalizedCount: number;
    marked: Array<{ clipIndex: number; method: string; color: string }>;
    summary: Record<string, {
      color: string;
      itemScope: string;
      checked: number;
      colored: number;
      failed: number;
    }>;
    photoColor: string;
    timelapseColor: string;
    ordinaryColor: string;
    photoCalls: unknown[];
    timelapseCalls: unknown[];
    ordinaryCalls: unknown[];
  };
}

describe('Resolve edit media sync host', () => {
  it('skips an existing MediaPoolItem already in the target event folder', async () => {
    const sourcePath = fixturePath('same-event.mp4');

    const result = await inspectMediaSync({
      namespaceClips: [{ relativeDir: '001-Arrival', sourcePath }],
      clipRequests: [{
        assetId: 'asset-1',
        rawRelativePath: '001-Arrival/same-event.mp4',
        sourceAbsolutePath: sourcePath,
        sourceStem: 'same-event',
      }],
      cleanupEmptyFolders: true,
    });

    expect(result.summary).toEqual({
      imported: 0,
      moved: 0,
      reused: 1,
      emptyFoldersDeleted: 0,
    });
    expect(result.imports).toEqual([]);
    expect(result.moves).toEqual([]);
  });

  it('moves an existing MediaPoolItem to a changed event folder and prunes empty folders', async () => {
    const sourcePath = fixturePath('moved-event.mp4');

    const result = await inspectMediaSync({
      namespaceClips: [{ relativeDir: '001-Old Event', sourcePath }],
      namespaceEmptyDirs: ['002-Empty Event'],
      clipRequests: [{
        assetId: 'asset-1',
        rawRelativePath: '003-New Event/moved-event.mp4',
        sourceAbsolutePath: sourcePath,
        sourceStem: 'moved-event',
      }],
      cleanupEmptyFolders: true,
    });

    expect(result.summary).toEqual({
      imported: 0,
      moved: 1,
      reused: 0,
      emptyFoldersDeleted: 2,
    });
    expect(result.imports).toEqual([]);
    expect(result.moves[0]?.from).toBe('Root/Kairos Project Media/001-Old Event');
    expect(result.moves[0]?.to).toBe('Root/Kairos Project Media/003-New Event');
    expect(result.deletes).toEqual([
      'Root/Kairos Project Media/001-Old Event',
      'Root/Kairos Project Media/002-Empty Event',
    ]);
    expect(result.tree.children.map(child => child.name)).toEqual(['003-New Event']);
  });

  it('reuses a matching source path already elsewhere in the Media Pool instead of importing it again', async () => {
    const sourcePath = fixturePath('loose-existing.mp4');

    const result = await inspectMediaSync({
      rootClips: [{ relativeDir: 'Loose Imports', sourcePath }],
      useFallback: true,
      clipRequests: [{
        assetId: 'asset-1',
        rawRelativePath: '001-Arrival/loose-existing.mp4',
        sourceAbsolutePath: sourcePath,
        sourceStem: 'loose-existing',
      }],
      cleanupEmptyFolders: true,
    });

    expect(result.summary).toEqual({
      imported: 0,
      moved: 1,
      reused: 0,
      emptyFoldersDeleted: 0,
    });
    expect(result.imports).toEqual([]);
    expect(result.moves[0]?.from).toBe('Root/Loose Imports');
    expect(result.moves[0]?.to).toBe('Root/Kairos Project Media/001-Arrival');
  });
});

describe('Resolve rough-cut host source ranges', () => {
  it('does not contain the temporary source-probe timeline flow', async () => {
    const hostSource = await readFile(hostPath, 'utf8');

    expect(hostSource).not.toContain('Kairos Rough Cut Source Probe');
    expect(hostSource).not.toContain('probe_rough_cut_source_frame_offsets');
    expect(hostSource).not.toContain('native-probe-offset');
    expect(hostSource).not.toContain('sourceFrameOffset');
  });

  it('passes direct media-relative source frames to Resolve appends', async () => {
    const info = await inspectRoughCutAppendInfo();

    expect(info.recordFrame).toBe(60);
    expect(info.startFrame).toBe(30);
    expect(info.endFrame).toBe(90);
    expect(info.keys).toEqual(['endFrame', 'mediaPoolItem', 'recordFrame', 'startFrame', 'trackIndex']);
  });
});

describe('Resolve rough-cut timeline settings', () => {
  it('rejects timelines whose playback frame rate does not match the requested fps', async () => {
    const code = `
import importlib.util
import json
import sys

host_path = sys.argv[1]

spec = importlib.util.spec_from_file_location("resolve_color_host", host_path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class FakeProject:
    def GetSetting(self, key=None):
        settings = {
            "timelineFrameRate": "30",
            "timelinePlaybackFrameRate": "24",
        }
        if key:
            return settings.get(key)
        return settings


class FakeTimeline:
    def GetName(self):
        return "Main [main]"

    def GetSetting(self, key=None):
        settings = {
            "timelineFrameRate": "30",
            "timelinePlaybackFrameRate": "24",
        }
        if key:
            return settings.get(key)
        return settings


try:
    module.assert_timeline_matches_spec(FakeProject(), FakeTimeline(), {"fps": 30})
    print(json.dumps({"ok": True}, ensure_ascii=False))
except module.HostError as error:
    print(json.dumps(error.to_payload(), ensure_ascii=False))
`;

    const { stdout } = await exec(
      pythonPath,
      ['-c', code, hostPath],
      {
        encoding: 'utf8',
        windowsHide: true,
      },
    );
    const payload = JSON.parse(stdout) as {
      code?: string;
      details?: { actualPlaybackFps?: number; expectedFps?: number };
    };

    expect(payload.code).toBe('resolve_timeline_fps_mismatch');
    expect(payload.details?.expectedFps).toBe(30);
    expect(payload.details?.actualPlaybackFps).toBe(24);
  });
});

describe('Resolve rough-cut clip color marking', () => {
  it('colors audible, photo, and timelapse items with separate batch colors', async () => {
    const result = await inspectRoughCutClipColoring();

    expect(result.audibleSummary).toEqual({
      color: 'Orange',
      itemScope: 'ordinary-video-and-linked-audio; linked-audio-only-when-video-has-visual-category-color',
      checked: 3,
      colored: 3,
      failed: 0,
    });
    expect(result.visualSummary).toMatchObject({
      photo: {
        color: 'Blue',
        itemScope: 'video',
        checked: 1,
        colored: 1,
        failed: 0,
      },
      timelapse: {
        color: 'Purple',
        itemScope: 'video',
        checked: 1,
        colored: 1,
        failed: 0,
      },
    });
    expect(result.ordinaryVideoColor).toBe('Orange');
    expect(result.ordinaryAudioColor).toBe('Orange');
    expect(result.mutedColor).toBe('');
    expect(result.photoVideoColor).toBe('Blue');
    expect(result.timelapseVideoColor).toBe('Purple');
    expect(result.timelapseAudioColor).toBe('Orange');
    expect(result.ordinaryVideoCalls).toEqual([['SetClipColor', 'Orange']]);
    expect(result.ordinaryAudioCalls).toEqual([['SetClipColor', 'Orange']]);
    expect(result.mutedCalls).toEqual([]);
    expect(result.photoVideoCalls).toEqual([['SetClipColor', 'Blue']]);
    expect(result.timelapseVideoCalls).toEqual([['SetClipColor', 'Purple']]);
    expect(result.timelapseAudioCalls).toEqual([['SetClipColor', 'Orange']]);
  });

  it('creates and assigns photo and timelapse Color Groups for rough-cut batch effects', async () => {
    const result = await inspectRoughCutVisualClipGrouping();

    expect(result.summary.photo).toEqual({
      groupName: 'Kairos Photos',
      itemScope: 'video',
      checked: 1,
      assigned: 1,
      alreadyAssigned: 0,
      failed: 0,
      created: true,
    });
    expect(result.summary.timelapse).toEqual({
      groupName: 'Kairos Timelapse',
      itemScope: 'video',
      checked: 2,
      assigned: 1,
      alreadyAssigned: 1,
      failed: 0,
      created: false,
    });
    expect(result.ordinaryGroup).toBeNull();
    expect(result.photoGroup).toBe('Kairos Photos');
    expect(result.timelapseGroup).toBe('Kairos Timelapse');
    expect(result.alreadyGrouped).toBe('Kairos Timelapse');
    expect(result.projectAddCalls).toEqual(['Kairos Photos']);
    expect(result.projectGroupNames).toEqual(['Kairos Timelapse', 'Kairos Photos']);
    expect(result.ordinaryCalls).toEqual([]);
    expect(result.photoCalls).toEqual([['AssignToColorGroup', 'Kairos Photos']]);
    expect(result.timelapseCalls).toEqual([['AssignToColorGroup', 'Kairos Timelapse']]);
    expect(result.alreadyGroupedCalls).toEqual([]);
    expect(result.photoAssignedGroup).toBe('Kairos Photos');
    expect(result.timelapseAssignedGroup).toBe('Kairos Timelapse');
    expect(result.alreadyAssignedGroup).toBe('Kairos Timelapse');
  });

  it('matches existing timeline photo and timelapse items without recoloring ordinary video', async () => {
    const result = await inspectExistingRoughCutClipColorMatching();

    expect(result.normalizedCount).toBe(2);
    expect(result.marked).toEqual([
      { clipIndex: 1, method: 'resolveNameClipId', color: 'Blue' },
      { clipIndex: 2, method: 'sourceAbsolutePath', color: 'Purple' },
    ]);
    expect(result.summary.photo).toMatchObject({ checked: 1, colored: 1, failed: 0 });
    expect(result.summary.timelapse).toMatchObject({ checked: 1, colored: 1, failed: 0 });
    expect(result.photoColor).toBe('Blue');
    expect(result.timelapseColor).toBe('Purple');
    expect(result.ordinaryColor).toBe('');
    expect(result.photoCalls).toEqual([['SetClipColor', 'Blue']]);
    expect(result.timelapseCalls).toEqual([['SetClipColor', 'Purple']]);
    expect(result.ordinaryCalls).toEqual([]);
  });
});
