export const CEDIT_FLOW_CAPABILITY_IDS = [
  'pharos.parse',
  'trip.event_table',
  'material.archive',
  'edit.framework',
  'material.recall',
  'script.generate',
  'resolve.media_sync',
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
    summary: 'Optional planning document that reviews confirmed Chronology V2 events, gaps, route continuity, and event-level evidence without loading material spans. Use only when the edit rule explicitly asks for a separate event or itinerary table.',
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
    summary: 'Optional planning document that summarizes material facts, gaps, high-recall evidence, and reusable bundles. Use only when the edit rule explicitly asks for a separate material archive or material-library document.',
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
    summary: 'LLM planning handoff that turns the confirmed rule and declared evidence into chapter overview plus one executable FW beat table. It may consume chronology/spans/assets when declared, but must not expose evidence ids.',
    stableInputs: ['config/edit-rules/<category>.md', 'Flow Plan declared inputRefs such as media/chronology.json, store/spans.json, store/assets.json'],
    stableOutputs: ['edits/<editId>/planning/edit-framework.md'],
    outputKind: 'markdown',
    defaultRunner: 'agent',
    gate: 'human',
    status: 'implemented',
  },
  {
    capabilityId: 'material.recall',
    title: 'Material Recall',
    summary: 'Produces the reviewed material-slots recall table with chosenSpanIds and sparse numeric audio dB / speed treatment overrides. It consumes the current Flow Plan material.recall step context plus the reviewed framework and fresh spans/assets; corrected asset.capturedAt provides material time.',
    stableInputs: ['edits/<editId>/planning/flow-plan.json', 'edits/<editId>/planning/edit-framework.md', 'store/spans.json', 'store/assets.json'],
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
    capabilityId: 'resolve.media_sync',
    title: 'Resolve Media Sync',
    summary: 'Synchronizes chronology-event media into the edit Resolve Media Pool namespace for engineering archive/bin organization only. The Resolve project is the archive truth; Kairos only records run summaries.',
    stableInputs: ['store/spans.json', 'store/assets.json', 'media/chronology.json', 'config/project-brief.json'],
    stableOutputs: ['DaVinci Resolve Media Pool'],
    outputKind: 'resolve-state',
    defaultRunner: 'deterministic',
    gate: 'none',
    status: 'implemented',
  },
  {
    capabilityId: 'timeline.generate',
    title: 'Timeline Generate',
    summary: 'Deterministically places recalled material-slots in their declared order from already-synced Resolve Media Pool items into a Resolve rough-cut timeline, writes a source-speech SRT companion for manual Resolve import, keeps the KTEP/manifest audit temporary under project .tmp, and attempts a project-level [Edit] DRP snapshot after successful timeline writes.',
    stableInputs: ['DaVinci Resolve Media Pool', 'edits/<editId>/planning/edit-framework.md', 'edits/<editId>/script/material-slots.json', 'store/spans.json', 'store/assets.json', 'media/chronology.json'],
    stableOutputs: ['DaVinci Resolve Timeline', '.tmp/edit-flow/<editId>/timeline/current.json', '.tmp/edit-flow/<editId>/timeline/current.srt', 'edits/resolve-project-map.json', 'edits/resolve-projects/<safe-project-key>/<Resolve项目名>.drp'],
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
