#!/usr/bin/env node
import { readFile, realpath } from 'node:fs/promises';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { submitColorAgentClassification, refreshColorAgentInputView } from '../dist/modules/color/agent-classification.js';

const [command, projectId, rootId, argument, ...extra] = process.argv.slice(2);
if (!['submit', 'input'].includes(command) || !projectId || !rootId || !argument || extra.length
  || [projectId, rootId].some(id => id === '.' || id === '..' || /[\\/\0]/.test(id))) {
  console.error('Usage: node scripts/color-agent-classify.mjs submit <projectId> <rootId> <submissionFile>\n       node scripts/color-agent-classify.mjs input <projectId> <rootId> <batchFingerprint>');
  process.exitCode = 1;
} else {
  try {
    const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const projects = await realpath(resolve(workspace, 'projects'));
    const project = await realpath(resolve(projects, projectId));
    const diff = relative(projects, project);
    if (!diff || diff.startsWith('..') || isAbsolute(diff)) throw new Error('项目必须位于当前工作区 projects 内');
    const result = command === 'input'
      ? await refreshColorAgentInputView(project, rootId, argument)
      : await submitColorAgentClassification(project, rootId, JSON.parse(await readFile(resolve(argument), 'utf8')));
    console.log(JSON.stringify(result, null, 2));
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
