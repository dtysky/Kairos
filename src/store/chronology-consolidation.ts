import { join } from 'node:path';
import {
  IChronologyEventConsolidationAudit,
  IChronologyEventConsolidationState,
  type IChronologyEventConsolidationAudit as TChronologyEventConsolidationAudit,
  type IChronologyEventConsolidationState as TChronologyEventConsolidationState,
  type IProjectChronology,
} from '../protocol/schema.js';
import { readJsonOrNull, writeJson } from './writer.js';

export function getChronologyEventConsolidationStatePath(projectRoot: string): string {
  return join(projectRoot, '.tmp', 'chronology', 'event-consolidation-state.json');
}

export function getChronologyEventConsolidationHandoffPath(projectRoot: string): string {
  return join(projectRoot, '.tmp', 'chronology', 'event-consolidation-agent-handoff.md');
}

export function getChronologyEventConsolidationDecisionsPath(projectRoot: string): string {
  return join(projectRoot, '.tmp', 'chronology', 'event-consolidation-decisions.json');
}

export function getChronologyEventConsolidationAuditPath(
  projectRoot: string,
  inputsHash: string,
  candidateHash: string,
): string {
  return join(
    projectRoot,
    '.tmp',
    'chronology',
    `event-consolidation-audit-${inputsHash.slice(0, 8)}-${candidateHash.slice(0, 8)}.json`,
  );
}

export async function loadChronologyEventConsolidationState(
  projectRoot: string,
): Promise<TChronologyEventConsolidationState | null> {
  return readJsonOrNull(
    getChronologyEventConsolidationStatePath(projectRoot),
    IChronologyEventConsolidationState,
  );
}

export async function writeChronologyEventConsolidationState(
  projectRoot: string,
  state: TChronologyEventConsolidationState,
): Promise<void> {
  await writeJson(
    getChronologyEventConsolidationStatePath(projectRoot),
    IChronologyEventConsolidationState.parse(state),
  );
}

export async function writeChronologyEventConsolidationAudit(
  path: string,
  audit: TChronologyEventConsolidationAudit,
): Promise<void> {
  await writeJson(path, IChronologyEventConsolidationAudit.parse(audit));
}

export async function assertChronologyEventConsolidationReady(
  projectRoot: string,
  chronology: IProjectChronology,
): Promise<TChronologyEventConsolidationState | null> {
  const state = await loadChronologyEventConsolidationState(projectRoot);
  if (chronology.status === 'confirmed') return state;
  if (!state || state.inputsHash !== chronology.inputsHash || !['completed', 'not-required'].includes(state.status)) {
    throw new Error('Human Chronology review requires completed Agent event consolidation. Use the /chronology Agent handoff first.');
  }
  return state;
}
