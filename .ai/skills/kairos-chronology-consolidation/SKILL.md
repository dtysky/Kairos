---
name: kairos-chronology-consolidation
description: >-
  Consolidate semantically continuous ordinary Chronology V2 candidate events
  after chronology-build and before human chronology review.
---

# Kairos：编年史事件语义归并

本阶段位于确定性 `chronology-build` 之后、人工 Chronology 审查之前。它只减少启发式候选事件的语义碎片，不重跑 Analyze、span-builder、口播审查或 GPS 解析。

## 输入

- 读取 `.tmp/chronology/event-consolidation-agent-handoff.md`。
- 读取当前 `media/chronology.json`、`store/spans.json`，必要时只读 `analysis/asset-reports/*.json` 和 `analysis/pharos-context.json` 理解相邻事件语义。
- 候选 chronology 中的时间、地点、路线、event/span 顺序和 Pharos 边界都是事实输入。

## 决策

- 普通模式只输出确实应该合并的相邻且地点一致的普通 `pending event`；无需合并的事件完全省略。
- Pharos 吸收模式可以让一个 confirmed `event-pharos-*` 作为 `anchorEventId`，吸收前后语义上属于同一行程的相邻普通 `pending event`。这是周边事件向 Pharos 锚点归并，不能把 Pharos 锚点改造成普通事件。
- 可以跨自然日零点合并，例如同一活动恰好从 23:59 延续到次日 00:05。日期变化本身不是边界。
- 不得跨越 `route`、`gap` 或另一个 Pharos event。普通模式不得包含 confirmed/rejected event；Pharos 模式只能包含唯一锚点及普通 pending event。
- 普通 merge group 内事件地点必须一致。Pharos 吸收允许周边 GPS 地点字符串与锚点地点标签不同，但必须从语义、口播、视觉和上下文确认属于同一行程。
- 判断要结合标题、摘要、口播、视觉描述和相邻上下文；不要只按固定时间间隔决定。
- 普通模式输出 `sourceEventIds / title / summary / reason`。Pharos 吸收额外输出 `anchorEventId`，且 `title` 必须原样使用锚点标题；程序始终保留锚点 id、标题、地点和 confirmed 状态。摘要使用简体中文；不能返回或修改 GPS、地点、路线、起止时间、spanIds 和 reviewStatus。

## 写回

1. 将决定写入 handoff 指定的 `.tmp/chronology/event-consolidation-decisions.json`。
2. 在仓库根目录运行 handoff 给出的应用命令。
3. 应用程序会重新读取候选 chronology，校验 inputs/candidate hash、完整相邻性、受保护边界、普通组地点一致性、Pharos 锚点唯一性、组间无重复及 span 无遗漏/重复。
4. 校验通过后，程序写回 draft `media/chronology.json`、completed state 和带合并前后事件的独立审计文件；随后 `/chronology` 才开放人工审查。

任何决定不合法时整批失败，不允许部分写回，也不要直接手改 `media/chronology.json` 绕过校验。
