import { spawn } from 'node:child_process';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { loadServiceRecord } from './state.js';
import { findPortListenerPid, getMlServiceStatus, killPid, killPortOccupant } from './runtime.js';

const execFile = promisify(execFileCallback);

async function main(): Promise<void> {
  const action = process.argv[2] ?? 'status';
  const workspaceRoot = process.cwd();
  const port = 8940;

  switch (action) {
    case 'up':
    case 'start':
      await startSupervisor(workspaceRoot, port);
      return;
    case 'down':
    case 'stop':
      await stopSupervisor(workspaceRoot, port, false);
      return;
    case 'down-all':
    case 'stop-all':
      await stopSupervisor(workspaceRoot, port, true);
      return;
    case 'restart':
      await stopSupervisor(workspaceRoot, port, false);
      await startSupervisor(workspaceRoot, port);
      return;
    case 'status':
      console.log(JSON.stringify(await getStatus(workspaceRoot, port), null, 2));
      return;
    case 'open':
      await openUrl(`http://127.0.0.1:${port}/`);
      return;
    case 'logs':
      console.log('Use the dashboard or GET /api/logs/:scope to inspect service and job logs.');
      return;
    default:
      throw new Error(`Unsupported supervisor action: ${action}`);
  }
}

async function startSupervisor(workspaceRoot: string, port: number): Promise<void> {
  const existingPid = await findPortListenerPid(port);
  if (existingPid) {
    await killPid(existingPid);
  }

  const child = spawn(
    process.execPath,
    [
      fileUrlPath(new URL('./daemon.js', import.meta.url)),
      '--workspaceRoot', workspaceRoot,
      '--port', String(port),
    ],
    {
      cwd: workspaceRoot,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    },
  );
  child.unref();
  console.log(`Started Kairos Supervisor on http://127.0.0.1:${port}/`);
}

async function stopSupervisor(workspaceRoot: string, port: number, stopMl: boolean): Promise<void> {
  await killPortOccupant(port);
  if (stopMl) {
    const ml = await loadServiceRecord(workspaceRoot, 'ml');
    if (ml?.listenerPid) {
      await killPid(ml.listenerPid);
    }
    console.log('Stopped Kairos Supervisor and ML service listeners if present.');
    return;
  }
  console.log('Stopped Kairos Supervisor listener. ML service was left untouched.');
}

async function getStatus(workspaceRoot: string, port: number): Promise<unknown> {
  const dashboardPid = await findPortListenerPid(port);
  const ml = await getMlServiceStatus(workspaceRoot);
  return {
    dashboard: {
      running: Boolean(dashboardPid),
      listenerPid: dashboardPid,
      url: `http://127.0.0.1:${port}/`,
    },
    ml,
  };
}

async function openUrl(url: string): Promise<void> {
  if (process.platform === 'win32') {
    await execFile('cmd', ['/c', 'start', '', url], { windowsHide: true });
    return;
  }
  const command = process.platform === 'darwin' ? 'open' : 'xdg-open';
  await execFile(command, [url]);
}

function fileUrlPath(url: URL): string {
  return decodeURIComponent(url.pathname.replace(/^\/([A-Za-z]:\/)/u, '$1'));
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
