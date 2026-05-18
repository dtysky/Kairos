export const CEDIT_FLOW_CAPABILITY_IDS = [
  'pharos.parse',
  'trip.event_table',
  'material.archive',
  'edit.framework',
  'material.recall',
  'script.generate',
  'timeline.generate',
  'resolve.lock_rough_cut',
  'postlock.subtitle_narration',
] as const;

export type TEditFlowCapabilityId = typeof CEDIT_FLOW_CAPABILITY_IDS[number];

export interface IEditFlowCapability {
  capabilityId: TEditFlowCapabilityId;
  title: string;
  summary: string;
  stableInputs: string[];
  stableOutputs: string[];
  outputKind: 'json' | 'markdown' | 'ktep' | 'resolve-state' | 'subtitle' | 'mixed';
  defaultRunner: 'deterministic' | 'agent' | 'script' | 'manual';
  gate: 'none' | 'human';
  status: 'implemented' | 'placeholder';
}

export const CEDIT_FLOW_CAPABILITY_CATALOG: IEditFlowCapability[] = [
  {
    capabilityId: 'pharos.parse',
    title: 'Parse Pharos Context',
    summary: 'Refreshes analysis/pharos-context.json from project-local pharos/ plan, record, and gpx mirrors.',
    stableInputs: ['project:pharos', 'config/project-brief.json'],
    stableOutputs: ['analysis/pharos-context.json'],
    outputKind: 'json',
    defaultRunner: 'deterministic',
    gate: 'none',
    status: 'implemented',
  },
  {
    capabilityId: 'trip.event_table',
    title: 'Chronology Event Table',
    summary: 'Planning document that reviews confirmed Chronology V2 events, gaps, route continuity, and event-level evidence without loading material spans.',
    stableInputs: ['media/chronology.json'],
    stableOutputs: ['edits/<editId>/planning/event-table.md'],
    outputKind: 'markdown',
    defaultRunner: 'agent',
    gate: 'human',
    status: 'implemented',
  },
  {
    capabilityId: 'material.archive',
    title: 'Material Archive',
    summary: 'LLM planning document that summarizes material facts, gaps, high-recall evidence, and reusable bundles.',
    stableInputs: ['script/material-overview.facts.json', 'analysis/material-bundles.json', 'analysis/asset-reports/*.json'],
    stableOutputs: ['edits/<editId>/planning/material-archive.md'],
    outputKind: 'markdown',
    defaultRunner: 'agent',
    gate: 'human',
    status: 'implemented',
  },
  {
    capabilityId: 'edit.framework',
    title: 'Edit Framework',
    summary: 'LLM planning document that turns the confirmed rule, event table, and material archive into a reviewed edit framework.',
    stableInputs: ['config/edit-rules/<category>.md', 'edits/<editId>/planning/event-table.md', 'edits/<editId>/planning/material-archive.md'],
    stableOutputs: ['edits/<editId>/planning/edit-framework.md'],
    outputKind: 'markdown',
    defaultRunner: 'agent',
    gate: 'human',
    status: 'implemented',
  },
  {
    capabilityId: 'material.recall',
    title: 'Material Recall',
    summary: 'Produces the reviewed material-slots recall table with chosenSpanIds and per-span numeric audio dB / speed treatments. The rule and reviewed planning artifacts enter the Agent stage context; code does not parse markdown for weights.',
    stableInputs: ['edits/<editId>/planning/flow-plan.json', 'planning/*.md', 'analysis/material-bundles.json', 'store/spans.json'],
    stableOutputs: ['edits/<editId>/script/material-slots.json'],
    outputKind: 'json',
    defaultRunner: 'script',
    gate: 'human',
    status: 'implemented',
  },
  {
    capabilityId: 'script.generate',
    title: 'Script Generate',
    summary: 'Reuses the existing clean-context script pipeline and injects confirmed flow planning artifacts into Agent stage context.',
    stableInputs: ['edits/<editId>/script/material-slots.json', 'edits/<editId>/planning/flow-plan.json', 'planning/*.md'],
    stableOutputs: ['edits/<editId>/script/current.json'],
    outputKind: 'json',
    defaultRunner: 'agent',
    gate: 'human',
    status: 'implemented',
  },
  {
    capabilityId: 'timeline.generate',
    title: 'Timeline Generate',
    summary: 'Deterministically places recalled material-slots into a Resolve rough-cut timeline; timeline/current.json is only the KTEP/manifest audit.',
    stableInputs: ['edits/<editId>/planning/edit-framework.md', 'edits/<editId>/script/material-slots.json', 'store/spans.json', 'store/assets.json', 'media/chronology.json'],
    stableOutputs: ['edits/<editId>/timeline/current.json'],
    outputKind: 'mixed',
    defaultRunner: 'deterministic',
    gate: 'human',
    status: 'implemented',
  },
  {
    capabilityId: 'resolve.lock_rough_cut',
    title: 'Resolve Rough Cut Lock',
    summary: 'Manual review and lock of an already generated Resolve rough-cut timeline; it does not create the timeline.',
    stableInputs: ['DaVinci Resolve timeline'],
    stableOutputs: ['edits/<editId>/timeline/locked-rough-cut.json'],
    outputKind: 'resolve-state',
    defaultRunner: 'manual',
    gate: 'human',
    status: 'placeholder',
  },
  {
    capabilityId: 'postlock.subtitle_narration',
    title: 'Post-lock Subtitles and Narration',
    summary: 'Placeholder for source speech subtitle recognition and single narration draft after rough-cut lock.',
    stableInputs: ['edits/<editId>/timeline/locked-rough-cut.json', 'optional config/styles/<category>.md'],
    stableOutputs: ['edits/<editId>/subtitles/*'],
    outputKind: 'subtitle',
    defaultRunner: 'agent',
    gate: 'human',
    status: 'placeholder',
  },
];

export function isEditFlowCapabilityId(value: string): value is TEditFlowCapabilityId {
  return (CEDIT_FLOW_CAPABILITY_IDS as readonly string[]).includes(value);
}
