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
    gate: 'none',
    status: 'implemented',
  },
  {
    capabilityId: 'trip.event_table',
    title: 'Trip Event Table',
    summary: 'LLM planning document that integrates Pharos, chronology, GPS, ASR, and asset reports into a reviewed trip/event table.',
    stableInputs: ['analysis/pharos-context.json', 'media/chronology.json', 'store/spans.json', 'analysis/asset-reports/*.json'],
    stableOutputs: ['edits/<editId>/planning/event-table.md'],
    gate: 'human',
    status: 'implemented',
  },
  {
    capabilityId: 'material.archive',
    title: 'Material Archive',
    summary: 'LLM planning document that summarizes material facts, gaps, high-recall evidence, and reusable bundles.',
    stableInputs: ['script/material-overview.facts.json', 'analysis/material-bundles.json', 'analysis/asset-reports/*.json'],
    stableOutputs: ['edits/<editId>/planning/material-archive.md'],
    gate: 'human',
    status: 'implemented',
  },
  {
    capabilityId: 'edit.framework',
    title: 'Edit Framework',
    summary: 'LLM planning document that turns the confirmed rule, event table, and material archive into a reviewed edit framework.',
    stableInputs: ['config/edit-rules/<category>.md', 'edits/<editId>/planning/event-table.md', 'edits/<editId>/planning/material-archive.md'],
    stableOutputs: ['edits/<editId>/planning/edit-framework.md'],
    gate: 'human',
    status: 'implemented',
  },
  {
    capabilityId: 'material.recall',
    title: 'Material Recall',
    summary: 'Reuses segment-plan, material-slots, chosenSpanIds, and material bundles. The rule and reviewed planning artifacts enter the packet; code does not parse markdown for weights.',
    stableInputs: ['edits/<editId>/planning/flow-plan.json', 'planning/*.md', 'analysis/material-bundles.json', 'store/spans.json'],
    stableOutputs: ['edits/<editId>/script/segment-plan.json', 'edits/<editId>/script/material-slots.json'],
    gate: 'human',
    status: 'implemented',
  },
  {
    capabilityId: 'script.generate',
    title: 'Script Generate',
    summary: 'Reuses the existing clean-context script pipeline and injects confirmed flow planning artifacts into stage packets.',
    stableInputs: ['edits/<editId>/script/material-slots.json', 'edits/<editId>/planning/flow-plan.json', 'planning/*.md'],
    stableOutputs: ['edits/<editId>/script/current.json'],
    gate: 'human',
    status: 'implemented',
  },
  {
    capabilityId: 'timeline.generate',
    title: 'Timeline Generate',
    summary: 'Reuses the existing rough-cut-base and segment-cut review pipeline and injects confirmed flow planning artifacts into timeline packets.',
    stableInputs: ['edits/<editId>/script/current.json', 'edits/<editId>/planning/flow-plan.json', 'planning/*.md'],
    stableOutputs: ['edits/<editId>/timeline/current.json'],
    gate: 'human',
    status: 'implemented',
  },
  {
    capabilityId: 'resolve.lock_rough_cut',
    title: 'Resolve Rough Cut Lock',
    summary: 'Placeholder for future Resolve draft sync and lock into locked-rough-cut.json.',
    stableInputs: ['DaVinci Resolve timeline'],
    stableOutputs: ['edits/<editId>/timeline/locked-rough-cut.json'],
    gate: 'human',
    status: 'placeholder',
  },
  {
    capabilityId: 'postlock.subtitle_narration',
    title: 'Post-lock Subtitles and Narration',
    summary: 'Placeholder for source speech subtitle recognition and single narration draft after rough-cut lock.',
    stableInputs: ['edits/<editId>/timeline/locked-rough-cut.json', 'optional config/styles/<category>.md'],
    stableOutputs: ['edits/<editId>/subtitles/*'],
    gate: 'human',
    status: 'placeholder',
  },
];

export function isEditFlowCapabilityId(value: string): value is TEditFlowCapabilityId {
  return (CEDIT_FLOW_CAPABILITY_IDS as readonly string[]).includes(value);
}
