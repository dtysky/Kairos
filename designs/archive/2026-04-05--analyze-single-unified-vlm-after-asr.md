# 2026-04-05 — Analyze 改为 finalize 单次 unified VLM

> 本文档记录 2026-04-05 的一轮 Analyze 设计收敛。
> 它描述的是候选重构方向，不是当前已实现事实。
>
> 当前口径：
>
> - 这是讨论纪要 + 候选方案
> - 不是 ADR
> - 不直接改写主文档中的“当前实现”
> - 本文档明确区别于同日另一份“保留 coarse VLM、移除默认第二次 VLM”的较保守方案

## 背景

这轮讨论最终收敛到一个更激进、也更直接的判断：

- 当前 Analyze 默认跑两次 VLM
- 两次 VLM 消费的视觉输入本质上是同一批 coarse keyframes
- 第二次 VLM 只是额外获得了 transcript / speechCoverage / windows 等后续信号
- 这不构成再次独立跑一轮视觉分析的充分理由

因此，这轮讨论的结论不再是：

- “保留 coarse VLM，只取消默认第二次 decision VLM”

而是进一步收敛为：

- “整条视频主链默认只保留一次 unified VLM”

## 当前实现的问题定义

当前实现的视频主链大致是：

- `coarse-scan`
  - 抽少量 keyframes
  - 跑一次 coarse VLM
  - 产出 `visualSummary`
  - 探测 `hasAudioTrack`
  - 保留来源上下文
- `audio-analysis / finalize`
  - 跑 ASR
  - 生成 `speechWindows`
  - 默认再跑一次 decision VLM
  - 输出最终 `clipType / fineScanMode / report`

这条链路的问题是：

1. 两次 VLM 看到的是同一批视觉输入
2. 第二次 VLM 并没有额外获得更细的视觉时序信息
3. 两次 VLM 的区分主要只剩 prompt 任务不同，而不是输入模态不同
4. “coarse-scan” 和 “audio-analysis” 的阶段边界因此显得不干净
5. 性能上会把本应一次完成的判断拆成两次 ML 往返

## 本轮结论

### 1. 默认只保留一次 unified VLM

视频主链默认应只有一次 VLM。

这次 VLM 发生在 finalize，而不是 coarse prepare。

它的输入应直接包括：

- coarse keyframes
- transcript
- transcriptSegments
- speechCoverage
- provisional windows
- budget
- density
- manual spatial hints

它的输出应同时承担两类职责：

- 视觉语义摘要
- 分流决策

也就是同时产出：

- `visualSummary`
  - `sceneType`
  - `subjects`
  - `mood`
  - `placeHints`
  - `narrativeRole`
  - `description`
- `decision`
  - `clipType`
  - `shouldFineScan`
  - `fineScanMode`
  - `decisionReasons`

### 2. coarse-scan 不再产出 `visualSummary`

这轮讨论明确接受：

- `coarse-scan` 不再产出 `visualSummary`

这不是问题，因为最终 report 本来就属于 finalize 的职责边界。

`coarse-scan` 只保留这些产物：

- `sampleFrames`
- `coarseSampleTimestamps`
- `hasAudioTrack`
- `sourceContext`
- 必要的 cheap metadata

也就是说，coarse prepare 退回为：

- “准备视觉输入”

而不是：

- “先做一轮正式视觉语义判断”

### 3. 第二次 VLM 不存在“保留意义”

本轮讨论明确否定了“默认两次 VLM 仍有必要”的说法。

原因很简单：

- 如果第二次 VLM 还是看同一批 keyframes
- 那么把 transcript 和其他信号直接并进第一次也是等价的

因此，这轮结论不是：

- “第二次 VLM 改成升级路径”

而是更彻底地收敛为：

- “把两次 VLM 合成一次 unified VLM”

## 候选重构后的阶段边界

视频主链更倾向变成：

1. `coarse-scan`
   - 抽少量 keyframes
   - 探测 `hasAudioTrack`
   - 写 prepared checkpoint
2. `audio-analysis`
   - 跑 ASR
   - 生成 transcript / speechCoverage / speechWindows
3. `finalize`
   - 进行一次 unified VLM
   - 同时产出 `visualSummary + decision`
   - 决定 `interestingWindows / shouldFineScan / fineScanMode`
4. `deferred-scene-detect`
   - 仅在 unified decision 判定需要时触发

如果 UI 层仍然只保留原有 step 数量，也应至少在文案上承认：

- step 3 不是纯音频
- 它更接近 “音频 + unified finalize”

## UI 同步要求

本轮方案要求：

- 如果后续实现这条方案，UI 必须同步改
- 不接受“后端已经改成单次 unified VLM，但前端仍沿用旧的 `coarse-scan + audio-analysis` 误导文案”

至少需要同步修改这些用户可见层：

- progress step 命名
- progress detail 文案
- supervisor / console 里的 Analyze 阶段展示
- 任何直接向用户解释当前 Analyze 阶段的状态文案

目标是让用户在 UI 上看到的语义，和真实执行边界一致。

也就是说，实施本方案时，UI 需要明确传达：

- `coarse-scan` 只是在准备 keyframes 和基础输入
- `audio-analysis` 只负责 ASR 与语音信号提取
- `finalize` 才是 unified VLM 产出 `visualSummary + decision` 的阶段

这里允许后续再讨论具体命名，但不允许把 UI 改动降级成“以后再说”的附属事项。

## 统一 VLM 的建议输入

### 视觉输入

- coarse keyframes
- 不新增更密的逐窗口视觉采样
- 不引入视频序列模型输入

### 音频与规则信号

- transcript excerpt
- transcriptSegments 概览
- speechCoverage
- speech windows
- base interesting windows
- density score
- budget
- manual spatial hints / transport
- source context

### 来源上下文

这里更倾向传人写的来源说明，而不是机器猜测的 clip type prior。

`sourceContext` 更适合包括：

- `rootLabel`
- `rootDescription`
- `rootNotes`
- 如有必要，再补 path-prefix 级别的人写说明

这里明确不建议再传：

- `initialClipTypeGuess`
- 任意伪装成正式分类结果的弱启发式标签

原因是：

- `drive / broll / talking-head / aerial / timelapse` 这类标签会天然带偏 unified VLM
- 用户写的来源说明更像弱背景线索，而不是结论
- 统一 VLM 应优先依据 keyframes 和 transcript 做判断，再把来源说明当弱 hint 消费

### prompt 目标

一次 prompt 同时要求模型返回：

- 视觉摘要
- 语义 clip type
- fine-scan policy
- decision reasons

也就是说，不再拆成：

- “一次视觉摘要 prompt”
- “一次后续决策 prompt”

## prepared checkpoint 的预期变化

如果实施本方案，`prepared-assets/<assetId>.json` 的职责会收缩。

它应主要保存：

- `sampleFrames`
- `coarseSampleTimestamps`
- `hasAudioTrack`
- `sourceContext`
- `shotBoundariesResolved` 相关状态

它不再需要把 `visualSummary` 作为粗扫必备产物落盘。

这意味着：

- resume coarse prepare 时仍可复用已抽帧结果
- 但视觉语义需要在 finalize 阶段重新产出

## 对现有规则层的影响

### 1. fallback heuristic 仍可保留

虽然默认只保留一次 unified VLM，但规则层仍有价值。

它可以继续承担：

- 无 ML / 请求失败时的兜底判断
- 纯 cheap metadata 的先验估计
- deferred `scene detect` 的触发前粗判断

但它不应再依赖 coarse `visualSummary` 作为默认前置。

### 2. `drive` 与 `talking-head` 语义约束继续保留

本轮讨论没有推翻以下下游语义约束：

- `talking-head` 继续偏 speech-led
- `drive` 继续保持 `speech / visual` 双轨
- `interestingWindows` 仍应保留语义来源，而不是过早塌平

变化只在于：

- 这些约束将建立在 finalize 单次 unified VLM 的输出之上

而不是 coarse VLM + decision VLM 的串联结果之上。

## 预期收益

如果实施本方案，预期收益包括：

- 默认视频主链从 `2x VLM` 收敛到 `1x VLM`
- 阶段边界更清楚
- 粗扫阶段更轻
- `audio-analysis` 的性能归因更真实
- 不再让两次 VLM 在同一批 keyframes 上重复劳动

## 已知代价

这轮讨论也接受了几个明确代价：

1. 粗扫阶段不再拥有正式视觉语义结果
2. `visualSummary` 的产出时间整体后移
3. prepared checkpoint 的信息密度会下降
4. 如果 finalize 前中断，用户只能拿到 keyframes 和轻量 metadata，拿不到正式视觉摘要

这些代价被认为是可接受的，因为：

- 最终 report 本来就属于 finalize
- 用户真正消费的是最终 coarse report，而不是 prepared checkpoint

## 需要避免的误解

### 1. 这不等于“粗扫完全不做事”

粗扫仍然保留：

- keyframe extraction
- has-audio detection
- checkpoint 准备

只是它不再承担正式视觉语义生成。

### 2. 这不等于“序列模型替代静态帧”

本轮方案没有引入：

- 整段视频序列输入
- 更密的窗口级视觉采样
- 每窗口单独 VLM

当前仍是：

- 少量 keyframes
- 一次 unified VLM

### 3. 这不等于“取消规则层”

规则层仍然保留，只是不再默认建立在 coarse `visualSummary` 之上。

## 未决问题

以下问题仍需后续实现评审时拍板：

1. unified VLM 的返回 schema 是否直接扩成 “summary + decision” 复合结构
2. photo 路径是否也统一进同一类 prompt，还是继续保留当前轻量单图 summary 路径
3. `sourceContext` 的边界是否只保留 root 级说明，还是允许 path-prefix 级说明一并注入
4. UI 层最终采用 `3-step` 还是 `4-step` 展示，但无论哪种都必须真实反映 unified finalize 的存在
5. 若 unified VLM 失败，fallback heuristic 的保守策略如何收紧

## 建议的下一步

当前更合适的下一步是：

1. 先等当前 analyze run 完成
2. 单独评审这份方案对 checkpoint / resume / progress 命名的影响
3. 再进入代码改造

在那之前，不应把本文档内容回写到主文档中，避免把候选方案误写成现状。
