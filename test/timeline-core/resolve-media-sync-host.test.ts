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

async function inspectAudibleClipColoring() {
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


audible_video_item = FakeTimelineItem()
audible_audio_item = FakeTimelineItem()
muted_item = FakeTimelineItem()
summary = {"color": "Orange", "itemScope": "video-and-linked-audio", "checked": 0, "colored": 0, "failed": 0}

module.apply_rough_cut_audible_clip_color([audible_video_item, audible_audio_item], {
    "clipId": "clip-00001",
    "assetId": "asset-1",
    "muteAudio": False,
}, summary)
module.apply_rough_cut_audible_clip_color([muted_item], {
    "clipId": "clip-00002",
    "assetId": "asset-2",
    "muteAudio": True,
}, summary)

print(json.dumps({
    "summary": summary,
    "audibleVideoColor": audible_video_item.GetClipColor(),
    "audibleAudioColor": audible_audio_item.GetClipColor(),
    "mutedColor": muted_item.GetClipColor(),
    "audibleVideoCalls": audible_video_item.calls,
    "audibleAudioCalls": audible_audio_item.calls,
    "mutedCalls": muted_item.calls,
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
    summary: {
      color: string;
      checked: number;
      colored: number;
      failed: number;
    };
    audibleVideoColor: string;
    audibleAudioColor: string;
    mutedColor: string;
    audibleVideoCalls: unknown[];
    audibleAudioCalls: unknown[];
    mutedCalls: unknown[];
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

describe('Resolve rough-cut audible clip marking', () => {
  it('colors non-muted video items orange and leaves muted items uncolored', async () => {
    const result = await inspectAudibleClipColoring();

    expect(result.summary).toEqual({
      color: 'Orange',
      itemScope: 'video-and-linked-audio',
      checked: 2,
      colored: 2,
      failed: 0,
    });
    expect(result.audibleVideoColor).toBe('Orange');
    expect(result.audibleAudioColor).toBe('Orange');
    expect(result.mutedColor).toBe('');
    expect(result.audibleVideoCalls).toEqual([['SetClipColor', 'Orange']]);
    expect(result.audibleAudioCalls).toEqual([['SetClipColor', 'Orange']]);
    expect(result.mutedCalls).toEqual([]);
  });
});
