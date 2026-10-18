import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const exec = promisify(execFile);
const backend = join(process.cwd(), 'vendor/resolve-color-host');
const python = join(backend, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');

async function snapshot(mode: string, retention = 'latest-only') {
  const code = `
import importlib.util, json, sys, tempfile, zipfile
from pathlib import Path
spec = importlib.util.spec_from_file_location('host', sys.argv[1])
host = importlib.util.module_from_spec(spec); spec.loader.exec_module(host)
host.configure_stdio()
mode, retention = sys.argv[2:4]
events = []
class Project:
    def GetName(self): return 'Trip [Edit]'
    def GetTimelineCount(self): raise AssertionError('Backup must not inspect timelines')
    def SetCurrentTimeline(self, value): raise AssertionError('Backup must not select timelines')
class Manager:
    def GetCurrentProject(self): return None if mode == 'missing' else Project()
    def LoadProject(self, name): events.append('load'); return None
    def CreateProject(self, name): raise AssertionError('Backup must never create a project')
    def SaveProject(self): events.append('save'); return mode != 'save-failed'
    def ExportProject(self, name, path, extras):
        events.append('export')
        if mode == 'export-failed': return False
        if mode == 'corrupt': Path(path).write_bytes(b'broken'); return True
        with zipfile.ZipFile(path, 'w') as z: z.writestr('project.xml', '<project/>')
        return None if mode == 'no-result' else True
class Resolve:
    def GetProjectManager(self): return Manager()
with tempfile.TemporaryDirectory() as root:
    latest = Path(root) / 'Trip [Edit].drp'; latest.write_bytes(b'previous successful backup')
    try:
        result = host.save_drp_snapshot(Resolve(), {'resolveProjectName':'Trip [Edit]', 'snapshotRoot':root,
            'latestFilename':latest.name, 'retention':retention})
        output = {'status':'succeeded', 'snapshot': result['snapshot']}
    except host.HostError as e:
        output = e.to_payload()
    output.update(events=events, previousPreserved=latest.read_bytes()==b'previous successful backup',
        tempFiles=len(list(Path(root).glob('*.tmp.drp'))), archives=len(list(Path(root).glob('snapshots/*.drp'))))
    print(json.dumps(output))
`;
  const { stdout } = await exec(python, ['-c', code, join(backend, 'resolve-color-host.py'), mode, retention], { windowsHide: true });
  return JSON.parse(stdout.trim());
}

describe('Resolve project backup safety', () => {
  it('blocks missing projects without creating or selecting a timeline', async () => {
    expect(await snapshot('missing')).toMatchObject({ code: 'resolve_edit_project_unavailable', events: ['load'], previousPreserved: true });
  });
  it('blocks a failed SaveProject before export', async () => {
    expect(await snapshot('save-failed')).toMatchObject({ code: 'resolve_project_save_failed', events: ['save'], previousPreserved: true });
  });
  it.each(['export-failed', 'no-result'])('requires explicit export success: %s', async mode => {
    expect(await snapshot(mode)).toMatchObject({ code: 'resolve_project_export_failed', previousPreserved: true, tempFiles: 0 });
  });
  it.each(['latest-only', 'archive'])('preserves the last valid backup after corrupt export: %s', async retention => {
    expect(await snapshot('corrupt', retention)).toMatchObject({ code: 'resolve_project_snapshot_invalid', previousPreserved: true, tempFiles: 0 });
  });
  it.each(['latest-only', 'archive'])('exports and validates the existing project: %s', async retention => {
    expect(await snapshot('ok', retention)).toMatchObject({ status: 'succeeded', previousPreserved: false,
      events: ['save', 'export'], tempFiles: 0, archives: retention === 'archive' ? 1 : 0 });
  });
});
