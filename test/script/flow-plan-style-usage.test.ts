import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertConfirmedEditFlowPlan, CEDIT_FLOW_PLANNER_POLICY_VERSION } from '../../src/modules/edit-flow/index.js';
import { loadEditRuleByCategory } from '../../src/modules/script/edit-rule-loader.js';
import { saveStyleSourcesConfig, writeEditFlowPlan } from '../../src/store/index.js';
import type { IEditFlowPlan } from '../../src/protocol/schema.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function createWorkspace(): Promise<{ workspaceRoot: string; projectRoot: string; editRuleHash: string }> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'kairos-flow-style-test-'));
  roots.push(workspaceRoot);
  const projectRoot = join(workspaceRoot, 'projects', 'project-a');
  await mkdir(join(workspaceRoot, 'config', 'edit-rules'), { recursive: true });
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(workspaceRoot, 'config', 'edit-rules', 'travel-doc.md'), [
    '---',
    'name: Travel Doc Rule',
    'category: travel-doc',
    '---',
    '# Travel Doc Rule',
    '',
    '需要参考风格档案的文学和剪辑技法层。',
    '',
  ].join('\n'), 'utf-8');
  const editRule = await loadEditRuleByCategory(workspaceRoot, 'travel-doc');
  return { workspaceRoot, projectRoot, editRuleHash: editRule.contentHash };
}

function buildPlan(editRuleHash: string, styleUsage: IEditFlowPlan['styleUsage']): IEditFlowPlan {
  return {
    schemaVersion: '1.0',
    plannerPolicyVersion: CEDIT_FLOW_PLANNER_POLICY_VERSION,
    materialIdPolicyVersion: 'human-source-v1',
    materialTimePolicyVersion: 'normalized-captured-at-v1',
    id: 'plan-a',
    editId: 'main',
    editRuleCategory: 'travel-doc',
    editRuleHash,
    generatedAt: '2026-05-16T00:00:00.000Z',
    status: 'confirmed',
    confirmedAt: '2026-05-16T00:00:00.000Z',
    assumptions: [],
    styleUsage,
    steps: [{
      id: 'script',
      capabilityId: 'script.generate',
      inputRefs: [],
      outputRefs: [],
      gate: 'human',
      notes: [],
    }],
  };
}

async function writeStyleProfile(workspaceRoot: string, markdown: string): Promise<void> {
  await saveStyleSourcesConfig(workspaceRoot, {
    defaultCategory: 'travel-doc-style',
    categories: [{
      categoryId: 'travel-doc-style',
      displayName: 'Travel Doc Style',
      overwriteExisting: false,
      profilePath: 'travel-doc-style.md',
      sources: [],
    }],
  });
  await writeFile(join(workspaceRoot, 'config', 'styles', 'travel-doc-style.md'), markdown, 'utf-8');
}

describe('Flow Plan styleUsage gates', () => {
  it('blocks confirmation when a style layer is enabled without styleCategory', async () => {
    const { workspaceRoot, projectRoot, editRuleHash } = await createWorkspace();
    await writeEditFlowPlan(projectRoot, buildPlan(editRuleHash, {
      layers: {
        literary: { mode: 'soft', appliesTo: ['script-current'] },
        artistic: { mode: 'off', appliesTo: [] },
        editingTechnical: { mode: 'off', appliesTo: [] },
      },
    }));

    await expect(assertConfirmedEditFlowPlan({
      workspaceRoot,
      projectRoot,
      editRuleCategory: 'travel-doc',
    })).rejects.toThrow('requires styleCategory');
  });

  it('blocks confirmation when the selected style profile is legacy', async () => {
    const { workspaceRoot, projectRoot, editRuleHash } = await createWorkspace();
    await writeStyleProfile(workspaceRoot, [
      '---',
      'name: Travel Doc Style',
      'category: travel-doc-style',
      '---',
      '# Travel Doc Style',
      '',
      '旧格式风格档案。',
      '',
    ].join('\n'));
    await writeEditFlowPlan(projectRoot, buildPlan(editRuleHash, {
      styleCategory: 'travel-doc-style',
      layers: {
        literary: { mode: 'soft', appliesTo: ['script-current'] },
        artistic: { mode: 'off', appliesTo: [] },
        editingTechnical: { mode: 'off', appliesTo: [] },
      },
    }));

    await expect(assertConfirmedEditFlowPlan({
      workspaceRoot,
      projectRoot,
      editRuleCategory: 'travel-doc',
    })).rejects.toThrow('legacy');
  });

  it('confirms when requested layers point at a layered-v1 profile', async () => {
    const { workspaceRoot, projectRoot, editRuleHash } = await createWorkspace();
    await writeStyleProfile(workspaceRoot, [
      '---',
      'name: Travel Doc Style',
      'category: travel-doc-style',
      'styleProfileVersion: layered-v1',
      '---',
      '# Travel Doc Style',
      '',
      '## 文学风格',
      '',
      'summary: 克制表达。',
      '',
      '## 艺术风格',
      '',
      'summary: 地理尺度感。',
      '',
      '## 技术分析（剪辑技法）',
      '',
      'summary: 行车镜头承担路线推进。',
      '',
    ].join('\n'));
    await writeEditFlowPlan(projectRoot, buildPlan(editRuleHash, {
      styleCategory: 'travel-doc-style',
      styleProfileVersion: 'layered-v1',
      layers: {
        literary: { mode: 'soft', appliesTo: ['script-current'] },
        artistic: { mode: 'off', appliesTo: [] },
        editingTechnical: { mode: 'soft', appliesTo: ['segment-plan'] },
      },
    }));

    const confirmed = await assertConfirmedEditFlowPlan({
      workspaceRoot,
      projectRoot,
      editRuleCategory: 'travel-doc',
    });

    expect(confirmed.status).toBe('confirmed');
  });
});
