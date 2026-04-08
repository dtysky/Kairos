import { describe, expect, it } from 'vitest';
import { parseStyleMarkdown } from '../../src/modules/script/style-loader.js';

describe('parseStyleMarkdown v2 derived protocol fields', () => {
  it('does not inject travel archetypes when the markdown lacks matching signals', () => {
    const style = parseStyleMarkdown(`
# 城市观察 风格档案

## 一、叙事
以街头观察和人物停顿为主，不强调路线推进，也不做景点导览。

## 二、语言
句子克制，像站在现场轻声记录。

## 三、剪辑节奏与素材编排
段落之间更像观察切换，而不是路线闯关。画面常停留在人群、橱窗、路口等待与短暂发呆。

## 四、关键参数
| 参数 | 值 |
|------|-----|
| 节奏模式 | 观察式缓推进 |
| 编排主轴 | 人物状态与城市呼吸 |
| 空镜/B-roll 关系 | 作为呼吸与停顿，不承担景点说明 |
`);

    expect(style.segmentArchetypes).toHaveLength(1);
    expect(style.segmentArchetypes[0]?.id).toBe('generic-observational');
    expect(style.segmentArchetypes.map(item => item.id)).not.toContain('opening-intro');
    expect(style.segmentArchetypes.map(item => item.id)).not.toContain('route-advance');
    expect(style.segmentArchetypes.map(item => item.id)).not.toContain('closure');
    expect(style.arrangementStructure.arrangementPrograms).toEqual([]);
    expect(style.functionBlocks).toEqual([]);
    expect(style.transitionRules).toEqual([]);
  });

  it('prefers explicit arrangement programs over inferred archetype fallbacks', () => {
    const style = parseStyleMarkdown(`
# 埃及风格档案

## 一、叙事
关注文明想象与现实摩擦并置。

## 二、组织模式与段落程序
- 组织模式：叙事段落驱动
- 先用高辨识度国家意象快速开门
- 很快落到必须亲自进入现场的个人动机
- 用道路、车内行进和空间切换证明路线真的在发生
- 用交通混乱、导航误导和现场摩擦把真实感压出来
- 最后用判断句把观众送进这个国家当下的真实现场
`);

    expect(style.arrangementStructure.organizationModes).toContain('叙事段落驱动');
    expect(style.arrangementStructure.arrangementPrograms.map(item => item.phrase)).toEqual([
      '先用高辨识度国家意象快速开门',
      '很快落到必须亲自进入现场的个人动机',
      '用道路、车内行进和空间切换证明路线真的在发生',
      '用交通混乱、导航误导和现场摩擦把真实感压出来',
      '最后用判断句把观众送进这个国家当下的真实现场',
    ]);
  });
});
