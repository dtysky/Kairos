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

## 重构后的阶段边界

视频主链改成：

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

对没有音轨的视频，分支应明确是：

- `coarse-scan -> finalize`

也就是说：

- 没音轨视频不会等待 transcript
- 不会因为没有 ASR 就失去视觉语义输出
- unified VLM 仍然照常执行，只是传空 transcript、`speechCoverage = 0`、无 `speechWindows`

因此本方案的统一口径应是：

- 有音轨视频：`coarse-scan -> audio-analysis -> finalize`
- 无音轨视频：`coarse-scan -> finalize`

## ASR 批处理调度约束

如果后续把 `audio-analysis` 拆成更纯的 ASR pass，本轮方案要求：

- 对有音轨视频做整素材级 ASR batch
- 不把固定 `30s` chunk 当成系统级调度单位

这里的判断依据是：

- 总音频计算量本来就是既定的
- 真正想要的优化是吃满 GPU / 显存，提高吞吐
- 而不是把同一条素材先切成很多小段，再在人为碎片上做额外调度

因此调度单位应是：

- 一条素材 = 一个 ASR job

而不是：

- `30s` 小段 = 一个 ASR job

### FIFO 与容量预算

worker 形态应是：

- 常驻 ASR worker
- 维护待转写 FIFO
- 从 FIFO 中取整条素材组成 batch
- 按容量预算决定本批可装入多少素材

这里的“容量预算”不应简单等于：

- 读一眼瞬时剩余显存，然后贪心塞满

更稳的口径应是：

- 以经验校准后的 batch capacity 为主
- 以瞬时显存/设备状态为 safety cap
- 尽量把时长接近的素材放进同一批，减少 padding 浪费

### 16k mono 规范化

本轮方案要求 ASR worker 的统一输入格式是：

- `16kHz`
- `mono`
- 标准化 WAV 中间产物

也就是说：

- 原始视频音轨不应直接作为 batch 推理输入
- 所有待转写素材都应先进入统一的音频规范化步骤
- `wav-ready` 的语义应明确表示“已准备好可直接送入 ASR 的 16k mono 音频”

这样做的目的包括：

- 减少无意义的数据体积
- 稳定 batch 容量估算
- 让不同素材来源进入同一种 ASR 输入分布
- 让 checkpoint / resume 更清晰

因此，后续如果实现整素材 FIFO batch，默认链路应是：

- `asset -> extract/normalize 16k mono wav -> wav-ready -> asr-running`

### segment 时间线是硬约束

本轮方案明确要求：

- 即使后续改成整素材级 ASR batch，ASR 结果也必须保留 segment 级时间线

这里至少应稳定产出：

- `text`
- `startMs`
- `endMs`

也就是说，ASR worker 不能只返回：

- `fullText`

而必须返回：

- `transcriptSegments`

原因很直接：

- `speechWindows` 需要从语音时间线导出
- 基础字幕规划也依赖 segment 级时间线
- 没有时间线，后续只能回退成粗糙的整段语音判断，无法支撑窗口分割

因此更合适的约束是：

- batch 只改变调度和吞吐
- 不改变单素材 ASR 结果的时间线语义

后续链路应保持：

- `transcriptSegments -> speechCoverage -> speechWindows`

而不是：

- `fullText -> 猜测 speechWindows`

这也意味着 checkpoint / resume 至少要能稳定回填：

- `transcript`
- `transcriptSegments`
- `speechCoverage`
- `speechWindows`

### 不默认拆段

本轮讨论明确不倾向把拆段作为默认策略。

原因包括：

- 拆段并不会减少总计算量
- 会引入额外调度复杂度
- 会增加边界管理和回填复杂度
- 会让 checkpoint / progress 语义从“素材”退化成“碎片”

因此默认口径应是：

- batch 的并行化发生在“多素材并行”
- 而不是“单素材先切碎再并行”

如果极长素材未来需要特殊处理，也应被视为例外分支，而不是全局默认调度形态。

### checkpoint 与恢复

这条方案要求音频阶段必须保留清晰的按素材 checkpoint。

更合适的状态语义是：

- `pending`
- `wav-ready`
- `asr-running`
- `asr-done`
- `finalized`

恢复语义应是：

- 已进入 `asr-done` 的素材，下次直接跳过 ASR
- `pending / wav-ready` 素材重新入队
- progress 统计以素材数为主，而不是以 batch 数或 chunk 数为主

这点被认为是必要要求，而不是附属优化，因为：

- Analyze 本身就是长流程
- 没有清晰 checkpoint 的 batch worker 不适合正式项目场景

### 与 unified finalize 的关系

本轮更倾向的链路不是：

- 每条素材 `ASR -> finalize -> 下一条`

而是：

- 先完成一轮纯 ASR pass
- 再进入后续 unified finalize

也就是说，真正能发挥 batch 吞吐价值的前提是：

- `audio-analysis` 足够纯
- 不再在同一素材循环里夹杂第二个重阶段

否则，多素材 batch 带来的收益会被逐素材 finalize 串行重新吃掉。

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

## 统一 VLM 的输入要求

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

对于没有音轨的视频，这组输入应退化为：

- 空 transcript
- `speechCoverage = 0`
- 无 `speechWindows`

但 unified VLM 不应因此被跳过。

### 来源上下文

这里要求传人写的来源说明，而不是机器猜测的 clip type prior。

`sourceContext` 应包括：

- `rootLabel`
- `rootDescription`
- `rootNotes`
- 如有配置，再补 path-prefix 级别的人写说明

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

## 已确认决议

以下内容在本轮不再视为未决：

1. 视频主链默认只保留一次 unified VLM，并且它发生在 `finalize`
2. `coarse-scan` 不再产出 `visualSummary`，只负责准备 keyframes、`hasAudioTrack` 和 `sourceContext`
3. 有音轨视频走 `coarse-scan -> audio-analysis -> finalize`；无音轨视频走 `coarse-scan -> finalize`
4. `sourceContext` 取代 `initialClipTypeGuess`，允许注入 root 级说明和用户写的 path-prefix 级说明，但不允许再传机器猜测的 clip type prior
5. UI 必须同步改，并按 `coarse-scan / audio-analysis / finalize / deferred-scene-detect` 这套真实语义展示；无音轨素材允许跳过 `audio-analysis`，但不允许把 `finalize` 再伪装成音频阶段
6. 纯 ASR pass 采用整素材 FIFO batch，不以固定 `30s` chunk 作为系统级调度单位
7. ASR batch 的统一输入格式必须是 `16kHz + mono + WAV`
8. ASR 结果必须保留 segment 级时间线，并稳定回填 `transcript / transcriptSegments / speechCoverage / speechWindows`
9. unified VLM 的返回结果直接采用“`visualSummary + decision`”复合结构，不再拆成两轮 VLM
10. `timelapse` 分类必须比其他 clip type 更保守：不能仅凭 transcript 中出现“延时/延时摄影”等字样、三脚架线索、或静态风景画面就判成 `timelapse`；至少需要明确的来源上下文或更强的视觉/拍摄证据
11. 如果 unified VLM 失败，允许回落到保守 heuristic fallback，但 fallback 只能做保守分流，不能在缺少 unified VLM 结果时放宽到更激进的 fine-scan

## 实现细化

以下只保留实现层面的细化事项，不再视为方案分支：

1. photo 路径继续沿用当前轻量单图 summary 路径，不强行并入视频 unified VLM
2. ASR batch capacity 采用“长度分桶 + 保守安全余量 + 瞬时显存 safety cap”的组合口径
3. progress 展示可以继续细化文案，但不得改变这份文档确认的阶段语义
4. `timelapse` 更适合作为受限标签处理：优先依赖 `sourceContext` 或明确拍摄模式证据，而不是让模型从普通 scenic / static footage 中自由猜出

## 建议的下一步

当前更合适的下一步是：

1. 先等当前 analyze run 完成
2. 单独评审这份方案对 checkpoint / resume / progress 命名的影响
3. 再进入代码改造

在那之前，不应把本文档内容回写到主文档中，避免把候选方案误写成现状。
