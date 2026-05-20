import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  assertConfirmedEditFlowPlan,
  assertEditFrameworkMarkdownContract,
  CEDIT_FLOW_PLANNER_POLICY_VERSION,
  CMATERIAL_ID_POLICY_VERSION,
  CMATERIAL_TIME_POLICY_VERSION,
  loadEditFlowPlanReadOnly,
} from '../../src/modules/edit-flow/index.js';
import { loadEditRuleByCategory } from '../../src/modules/script/edit-rule-loader.js';
import {
  getEditUnitConfigPath,
  getMaterialSlotsPath,
  initProject,
  loadEditFlowPlan,
  loadEditFlowRunRecords,
  saveEditUnitConfig,
  writeEditFlowPlan,
  writeEditFlowRunRecord,
} from '../../src/store/index.js';
import type { IEditFlowPlan, IEditFlowStepRunRecord } from '../../src/protocol/schema.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('Codex-agent Edit Flow policy', () => {
  it('accepts confirmed Codex-authored plans with current policy versions', async () => {
    const { workspaceRoot, projectRoot, editRuleHash } = await createWorkspaceProject('由 Codex Agent 生成 Flow Plan。');
    await writeEditFlowPlan(projectRoot, buildConfirmedPlan(editRuleHash));

    const plan = await assertConfirmedEditFlowPlan({
      workspaceRoot,
      projectRoot,
      editRuleCategory: 'travel-doc',
    });

    expect(plan.plannerPolicyVersion).toBe(CEDIT_FLOW_PLANNER_POLICY_VERSION);
    expect(plan.materialIdPolicyVersion).toBe(CMATERIAL_ID_POLICY_VERSION);
    expect(plan.materialTimePolicyVersion).toBe(CMATERIAL_TIME_POLICY_VERSION);
  });

  it('marks old confirmed plans stale when plannerPolicyVersion is not codex-agent-v1', async () => {
    const { workspaceRoot, projectRoot, editRuleHash } = await createWorkspaceProject('旧计划测试。');
    await writeEditFlowPlan(projectRoot, {
      ...buildConfirmedPlan(editRuleHash),
      plannerPolicyVersion: 'rule-explicit-v2',
    });

    await expect(assertConfirmedEditFlowPlan({
      workspaceRoot,
      projectRoot,
      editRuleCategory: 'travel-doc',
    })).rejects.toThrow('planner policy changed');

    const stale = await loadEditFlowPlan(projectRoot);
    expect(stale?.status).toBe('stale');
    expect(stale?.staleReason).toBe('planner policy changed: codex-agent-v1');
  });

  it('loads stale freshness as a read-only view without rewriting the stored plan', async () => {
    const { workspaceRoot, projectRoot, editRuleHash } = await createWorkspaceProject('只读 freshness。');
    await writeEditFlowPlan(projectRoot, {
      ...buildConfirmedPlan(editRuleHash),
      plannerPolicyVersion: 'rule-explicit-v2',
    });
    const before = await stat(join(projectRoot, 'edits', 'main', 'planning', 'flow-plan.json'));

    const viewed = await loadEditFlowPlanReadOnly(workspaceRoot, projectRoot);
    const after = await stat(join(projectRoot, 'edits', 'main', 'planning', 'flow-plan.json'));
    const stored = await loadEditFlowPlan(projectRoot);

    expect(viewed?.status).toBe('stale');
    expect(viewed?.staleReason).toBe('planner policy changed: codex-agent-v1');
    expect(stored?.status).toBe('confirmed');
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it('saves edit-unit config and stales existing dependent edit artifacts when rule/style changes', async () => {
    const { projectRoot, editRuleHash } = await createWorkspaceProject('初始化测试。');
    await writeEditFlowPlan(projectRoot, buildConfirmedPlan(editRuleHash));
    await writeEditFlowRunRecord(projectRoot, buildRunRecord(), 'main');
    await writeProjectFile(projectRoot, 'edits/main/planning/edit-framework.md', validEditFrameworkMarkdown());
    await writeProjectFile(projectRoot, 'edits/main/script/material-slots.json', JSON.stringify({
      id: 'slots-1',
      projectId: 'project-a',
      generatedAt: '2026-05-20T00:00:00.000Z',
      segments: [],
    }, null, 2));

    const saved = await saveEditUnitConfig(projectRoot, {
      editId: 'main',
      editRuleCategory: 'travel-doc',
      styleCategory: 'travel-style',
    });

    expect(saved.editRuleCategory).toBe('travel-doc');
    expect(await readFile(getEditUnitConfigPath(projectRoot, 'main'), 'utf-8')).toContain('"editRuleCategory": "travel-doc"');
    const stalePlan = await loadEditFlowPlan(projectRoot);
    expect(stalePlan?.status).toBe('stale');
    expect(stalePlan?.staleReason).toContain('edit unit config changed');
    expect((await loadEditFlowRunRecords(projectRoot))[0]?.status).toBe('stale');
    expect(await readFile(join(projectRoot, 'edits', 'main', 'planning', 'edit-framework.md'), 'utf-8')).toContain('kairos-stale: edit-unit-config');
    expect(await readFile(getMaterialSlotsPath(projectRoot, 'main'), 'utf-8')).toContain('"status": "stale"');
  });

  it('rejects edit.framework output that includes a beat boundary index', async () => {
    expect(() => assertEditFrameworkMarkdownContract('## beat 边界索引\n\n| beat | source |\n|---|---|\n')).toThrow(/beat 边界索引/su);
  });

  it('rejects edit.framework output that leaks chronology or material ids', async () => {
    expect(() => assertEditFrameworkMarkdownContract(`${validEditFrameworkMarkdown()}\n\n- evidence: event-pharos-123 / C0506_zve1_day1_drive_speech_s0-7\n`)).toThrow(/event\/route\/gap ids|concrete material id/su);
  });

  it('rejects edit.framework output whose spans column is not countable', async () => {
    expect(() => assertEditFrameworkMarkdownContract([
      '# Edit Framework',
      '',
      '## 全片章节',
      '| 章节 | 时间范围 | 叙事功能 | 情绪 / 节奏 |',
      '|---|---|---|---|',
      '| FW-01 出发 | 2026-05-01 | 建立出发。 | 中速。 |',
      '',
      '## 分段操作稿',
      '| 事件 | 时间 | spans | 叙事 |',
      '|---|---|---|---|',
      '| FW-01-01 出发口播 | 2026.05.01 08:00-08:10 | 多段：高密度素材组，含口播 | 车内说明行程。 |',
      '',
      '## 给 material.recall 的执行索引',
      '- 按分段操作稿顺序召回。',
    ].join('\n'))).toThrow(/spans column/su);
  });
});

async function createWorkspaceProject(ruleBody: string): Promise<{
  workspaceRoot: string;
  projectRoot: string;
  editRuleHash: string;
}> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'kairos-flow-policy-test-'));
  roots.push(workspaceRoot);
  const projectRoot = join(workspaceRoot, 'projects', 'project-a');
  await mkdir(join(workspaceRoot, 'config', 'edit-rules'), { recursive: true });
  await initProject(projectRoot, 'Project A');
  await writeFile(join(workspaceRoot, 'config', 'edit-rules', 'travel-doc.md'), [
    '---',
    'name: Travel Doc Rule',
    'category: travel-doc',
    '---',
    '# Travel Doc Rule',
    '',
    ruleBody,
    '',
  ].join('\n'), 'utf-8');
  const editRule = await loadEditRuleByCategory(workspaceRoot, 'travel-doc');
  return { workspaceRoot, projectRoot, editRuleHash: editRule.contentHash };
}

function buildConfirmedPlan(editRuleHash: string): IEditFlowPlan {
  return {
    schemaVersion: '1.0',
    plannerPolicyVersion: CEDIT_FLOW_PLANNER_POLICY_VERSION,
    materialIdPolicyVersion: CMATERIAL_ID_POLICY_VERSION,
    materialTimePolicyVersion: CMATERIAL_TIME_POLICY_VERSION,
    id: 'plan-a',
    editId: 'main',
    editRuleCategory: 'travel-doc',
    editRuleHash,
    generatedAt: '2026-05-20T00:00:00.000Z',
    updatedAt: '2026-05-20T00:00:00.000Z',
    status: 'confirmed',
    confirmedAt: '2026-05-20T00:00:00.000Z',
    assumptions: [],
    steps: [{
      id: 'edit-framework',
      capabilityId: 'edit.framework',
      inputRefs: ['media/chronology.json', 'store/spans.json', 'store/assets.json'],
      outputRefs: ['edits/<editId>/planning/edit-framework.md'],
      runner: 'agent',
      gate: 'human',
      notes: [],
    }],
  };
}

function buildRunRecord(): IEditFlowStepRunRecord {
  return {
    schemaVersion: '1.0',
    runId: 'run-a',
    editId: 'main',
    flowPlanId: 'plan-a',
    stepId: 'edit-framework',
    capabilityId: 'edit.framework',
    runner: 'agent',
    status: 'completed',
    startedAt: '2026-05-20T00:00:00.000Z',
    updatedAt: '2026-05-20T00:00:00.000Z',
    completedAt: '2026-05-20T00:00:00.000Z',
    inputRefs: [],
    outputRefs: [],
    inputSnapshot: {},
    outputPaths: [],
    summary: {},
    review: { status: 'confirmed' },
  };
}

function validEditFrameworkMarkdown(): string {
  return [
    '# Edit Framework',
    '',
    '## 全片章节',
    '| 章节 | 时间范围 | 叙事功能 | 情绪 / 节奏 |',
    '|---|---|---|---|',
    '| FW-01 出发 | 2026-05-01 | 建立出发和路线尺度。 | 中速。 |',
    '',
    '## 分段操作稿',
    '',
    '### FW-01 出发',
    '',
    '| 事件 | 时间 | spans | 叙事 |',
    '|---|---|---|---|',
    '| FW-01-01 出发口播 | 2026.05.01 08:00-08:10 | 共2段：行车1（有语音1/无语音0）、照片1 | 车内说明行程，随后有出发照片。 |',
    '',
    '## 不可用 / 缺口',
    '',
    '- 无。',
    '',
    '## 人工审查点',
    '',
    '1. 确认开场节奏。',
    '',
    '## 给 material.recall 的执行索引',
    '',
    '- 按分段操作稿顺序召回。',
    '- 静音候选：无语音行车、照片。',
  ].join('\n');
}

async function writeProjectFile(projectRoot: string, relativePath: string, content: string): Promise<void> {
  const target = join(projectRoot, relativePath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, 'utf-8');
}
