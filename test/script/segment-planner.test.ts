import { describe, expect, it } from 'vitest';
import type { IProjectMaterialDigest } from '../../src/protocol/schema.js';
import { buildSegmentPlanningPrompt } from '../../src/modules/script/segment-planner.js';
import { parseStyleMarkdown } from '../../src/modules/script/style-loader.js';

const CDIGEST: IProjectMaterialDigest = {
  id: 'digest-1',
  projectId: 'project-1',
  generatedAt: '2026-04-03T00:00:00.000Z',
  totalAssets: 12,
  totalDurationMs: 180_000,
  roots: [],
  topLabels: ['drive', 'coast'],
  topPlaceHints: ['Tasman Sea'],
  clipTypeDistribution: {
    drive: 6,
    aerial: 2,
    broll: 4,
  },
  mainThemes: ['road', 'sea'],
  recommendedNarrativeAxes: ['journey', 'location'],
  summary: '沿海自驾素材，适合按空间与推进关系组织。',
};

describe('segment-planner style rhythm grammar', () => {
  it('surfaces rhythm sections and stable material-grammar parameters', () => {
    const style = parseStyleMarkdown(`
# 旅行纪录片 风格档案

## 一、叙事结构
先建空间，再进入人物。

## 五、剪辑节奏与素材编排
照片通常只在回望或停顿处短暂出现，不会连续成段。延时更常出现在建场之后，用来把时间推快。航拍更像开场建场和地理重置，不会无缘无故插入。

## 九、关键参数
| 参数 | 值 |
|------|-----|
| 节奏模式 | 前段缓，中段推进，尾段抬升 |
| 照片使用策略 | 少量点缀，不主导段落 |
| 照片编排方式 | 常与运动视频交替，避免照片连打 |
| 延时使用关系 | 常接在 establishing 之后 |
| 航拍插入时机 | 开场建场、路线转场、地理重置 |
| 空镜/B-roll 关系 | 承担呼吸和空间解释 |
| 节奏抬升触发点 | 进入长段独白或空间切换时 |
`);

    const prompt = buildSegmentPlanningPrompt(
      CDIGEST,
      '请先做一版可审查的段落方案。',
      style,
    );

    expect(prompt).toMatch(/节奏与素材编排：/u);
    expect(prompt).toMatch(/照片通常只在回望或停顿处短暂出现/u);
    expect(prompt).toMatch(/节奏编排参数：/u);
    expect(prompt).toMatch(/照片编排方式: 常与运动视频交替，避免照片连打/u);
    expect(prompt).toMatch(/航拍插入时机: 开场建场、路线转场、地理重置/u);
    expect(prompt).toMatch(/空镜\/B-roll 关系: 承担呼吸和空间解释/u);
  });
});
