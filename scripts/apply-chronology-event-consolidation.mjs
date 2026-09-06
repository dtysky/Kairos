import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  applyProjectChronologyEventConsolidation,
  prepareProjectChronologyEventConsolidation,
} from '../dist/modules/media/chronology-event-consolidation.js';

const args = parseArgs(process.argv.slice(2));
const workspaceRoot = resolve(args.workspaceRoot ?? process.cwd());
const projectId = requiredArg(args, 'projectId');

if (args.prepare === 'true') {
  const result = await prepareProjectChronologyEventConsolidation({ workspaceRoot, projectId });
  process.stdout.write(`${JSON.stringify(result.state, null, 2)}\n`);
} else {
  const decisionsPath = resolve(requiredArg(args, 'decisions'));
  const submission = JSON.parse(await readFile(decisionsPath, 'utf-8'));
  const result = await applyProjectChronologyEventConsolidation({
    workspaceRoot,
    projectId,
    submission,
  });
  process.stdout.write(`${JSON.stringify(result.state, null, 2)}\n`);
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const part = argv[index];
    if (!part?.startsWith('--')) continue;
    const key = part.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      result[key] = next;
      index += 1;
    } else {
      result[key] = 'true';
    }
  }
  return result;
}

function requiredArg(args, key) {
  const value = args[key];
  if (!value) throw new Error(`Missing required --${key}`);
  return value;
}
