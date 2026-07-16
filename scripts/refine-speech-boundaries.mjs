#!/usr/bin/env node
import { resolve } from 'node:path';
import { refineProjectSpeechBoundaries } from '../dist/modules/media/index.js';

const args = process.argv.slice(2);
const projectId = args.find(arg => !arg.startsWith('--'));
if (!projectId) {
  console.error('Usage: node scripts/refine-speech-boundaries.mjs <projectId> [--workspaceRoot=.] [--write] [--assetId=<id> ...]');
  process.exit(2);
}

const workspaceRoot = resolve(readFlagValue('workspaceRoot') ?? process.cwd());
const writeSpans = args.includes('--write');
const assetIds = args
  .filter(arg => arg.startsWith('--assetId='))
  .map(arg => arg.slice('--assetId='.length).trim())
  .filter(Boolean);

const result = await refineProjectSpeechBoundaries({
  workspaceRoot,
  projectId,
  assetIds: assetIds.length > 0 ? assetIds : undefined,
  writeSpans,
});

console.log(JSON.stringify({
  ...result,
  writeSpans,
}, null, 2));

function readFlagValue(name) {
  const prefix = `--${name}=`;
  const matched = args.find(arg => arg.startsWith(prefix));
  return matched ? matched.slice(prefix.length) : undefined;
}
