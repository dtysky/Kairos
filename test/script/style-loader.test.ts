import { describe, expect, it } from 'vitest';
import { parseStyleMarkdown } from '../../src/modules/script/style-loader.js';

describe('parseStyleMarkdown', () => {
  it('extracts arrangementStructure and narrationConstraints in the new shape', () => {
    const style = parseStyleMarkdown(`
# 旅行纪录片 风格档案

## 叙事结构
- 先建空间，再进入人物。

## 剪辑节奏与素材编排
- 照片只短暂点缀。
- 航拍用于开场建场和地理重置。

## 参数
主轴: 路线推进
辅助轴: 地点观察 / 情绪回落
章节切分原则: 先空间后人物 / 以路程节点切分
章节转场: 用交通噪声做桥
章节程序1: opening | 先建立地理坐标 | establishing / anchor | 建场 / 地理重置 | smooth-intro | 旁白先收一点
旁白视角: 第一人称贴身观察
旁白备注: 少解释 / 留白
`);

    expect(style.arrangementStructure.primaryAxis).toBe('路线推进');
    expect(style.arrangementStructure.secondaryAxes).toEqual(['地点观察', '情绪回落']);
    expect(style.arrangementStructure.chapterSplitPrinciples).toContain('先空间后人物');
    expect(style.arrangementStructure.chapterPrograms[0]).toMatchObject({
      type: 'opening',
      intent: '先建立地理坐标',
      materialRoles: ['establishing', 'anchor'],
      promotionSignals: ['建场', '地理重置'],
      transitionBias: 'smooth-intro',
      localNarrationNote: '旁白先收一点',
    });
    expect(style.narrationConstraints.perspective).toBe('第一人称贴身观察');
    expect(style.narrationConstraints.notes).toEqual(['少解释', '留白']);
  });
});
