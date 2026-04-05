# 2026-04-05 — Analyze 音频合并而非默认第二次视觉决策

> 本文档记录一轮尚未拍板的 Analyze 讨论。
> 它的目标不是产出新的正式方案，而是把这次关于
> “为什么音频阶段还会做第二次视觉分析、是否应该复用粗扫结论”
> 的讨论收口成一份可继续推进的设计笔记。
>
> 当前口径：
>
> - 这是讨论纪要 + 候选重构方向
> - 不是 ADR
> - 不直接改写主文档中的“当前实现事实”

## 背景

本轮讨论的直接触发点，是正式项目里的用户体感：

- `audio-analysis` 看起来比 `coarse-scan` 还慢
- 进度面板把这一步显示成“分析视频内音轨”，但体感上又像混进了别的重活
- 进一步追问后，暴露出一个更具体的问题：
  - 既然粗扫已经做过一次视觉分析，为什么音频阶段还要再做一次视觉相关的决策？

当前实现里，这个体感并不是错觉。

Analyze 主链的当前结构大致是：

- `prepareAssetVisualCoarse()`
  - 少量均匀采样帧
  - 一次 coarse VLM 资产级视觉摘要
  - `hasAudioTrack`
  - `initialClipTypeGuess`
- `finalizePreparedAsset()`
  - embedded ASR / protection fallback
  - `speechWindows`
  - `resolvePreparedAssetPlanning()`
  - 默认仍会进入 `inferUnifiedAnalysisDecision()`

这意味着：

- step 名叫 `audio-analysis`
- 但实际包住的是 `ASR + finalize/merged decision`
- 而这段 merged decision 默认仍会做第二次 decision VLM

所以，当前的“音频阶段”并不是一个纯音频阶段。

## 现状澄清

### 1. 粗扫当前到底做了什么

当前粗扫并不是“完整分析”，它更像一个视觉准备阶段。

视频素材的 coarse prepare 当前主要做：

- 基于时长选少量均匀采样点
- 用 `extractKeyframes()` 抽少量 coarse sample frames
- 用一次 coarse VLM 生成资产级视觉摘要
  - `sceneType`
  - `subjects`
  - `placeHints`
  - `narrativeRole`
  - `description`
- 探测 `hasAudioTrack`
- 给出一个粗粒度 `initialClipTypeGuess`

当前粗扫阶段不会默认做：

- transcript / speechCoverage
- 最终 `clipType`
- 最终 `shouldFineScan / fineScanMode`
- 默认 `scene detect`

粗扫真正落盘的是 `prepared-assets` checkpoint，而不是最终 report。

### 2. 音频阶段当前到底做了什么

当前 step 3 的外层命名是 `audio-analysis`，但内部并不只做音频。

它至少会串过这些工作：

- embedded ASR
- protection audio fallback
- `speechWindows`
- `resolvePreparedAssetPlanning()`
- 默认第二次 decision VLM
- 用 merged result 形成最终 coarse-level report

也就是说，当前 step 3 更准确的语义其实是：

- `audio + merged decision`

而不是：

- `audio only`

### 3. 这次讨论里被反复确认的几个现状约束

- `asset-report.clipTypeGuess` 是 finalize 之后的语义结果，不是 ASR gate 的输入
- `drive` 的 `speech / visual` 语义分离，是下游消费和 `scene detect` 成本控制优化
- 它不是 ASR 入口优化，也没有减少“哪些素材会先跑 ASR”
- 当前第二次 decision VLM 默认仍然存在
- 当前主链并没有把粗扫产物做成“音频阶段可直接消费的完整视觉决策输入”

## 本轮讨论形成的共识

### 1. 粗扫仍然需要保留一次 VLM

系统不能没有常规视觉语义入口。

如果粗扫完全不做 VLM，那么剩下的只有：

- 时长
- `hasAudioTrack`
- 稀疏时间点
- transcript / speechCoverage

这些信号不足以稳定区分：

- `drive`
- `broll`
- `talking-head`
- `aerial`
- `timelapse`

因此，粗扫仍然需要保留一次轻量视觉分析。

### 2. 音频阶段不应该默认再做第二次视觉分析

当前实现里，第二次 decision VLM 的主要任务是：

- 继承粗扫的视觉语义
- 再把后来才拿到的音频信号并进来

但从讨论结果看，更合理的边界应该是：

- 粗扫负责常规视觉语义
- 音频阶段负责把音频证据贴到已有视觉结论上，并做合并
- 第二次视觉分析只保留为升级路径，而不是默认步骤

### 3. “窗口先行”应理解为 provisional analysis windows

讨论中出现过“先切片”的表述，这里统一澄清：

- 这里说的不是一开始就物化正式 `slice`
- 而是先生成 cheap provisional windows，作为分析输入

当前更被接受的理解是：

- 先定义临时 visual windows
- 再定义 speech windows
- 再在合并阶段决定它们如何进入正式 `interestingWindows`
- 只有最终 `skip/windowed/full` 决策稳定后，才物化正式 slice

### 4. 不接受把粗扫升级成更重的窗口级 VLM 输出

这轮讨论明确否定了一个方向：

- 让粗扫一次 VLM 直接吐出很重的窗口级结构化视觉 JSON

原因已经比较明确：

- token 会显著增加
- 响应时间可能变长
- 输出结构更脆
- 解析错误面会扩大

因此，当前更偏好的方向不是：

- “粗扫做更重的窗口级 VLM”

而是：

- 保持当前轻量资产级 coarse VLM
- 用 cheap rules 从 coarse sample timestamps 生成 provisional visual windows
- 再用音频证据和这些窗口做合并

## 当前更倾向的重构方向

### 首选方向

当前更被接受的方案是：

`1x coarse VLM(asset-level) + cheap visual windows + speech windows + rule merge`

它的边界是：

- 每资产默认仍只有 1 次 coarse VLM
- 音频阶段默认不再重看图
- provisional visual windows 主要由 cheap rules 生成
- 规则合并器消费：
  - coarse asset-level visual summary
  - provisional visual windows
  - speech windows
  - transcript / speechCoverage
  - budget / density / spatial hints

### 可保留的升级路径

第二次 decision VLM 不是完全删除，而是保留成升级路径。

当前讨论接受的升级思路是：

- 只有歧义素材才升级到第二次 decision VLM

这里的“歧义素材”在本轮没有拍死阈值，只保留了方向，例如：

- 粗扫视觉语义太弱或太模糊
- 音频证据和视觉证据明显冲突
- `clipType` 或 `skip/windowed/full` 落在临界分流附近

### 明确需要避免的方案

本轮已经较明确否定的路线包括：

- 每窗口单独跑 VLM
- 把 coarse prompt 扩成高 token、重结构化的窗口级视觉输出
- 一开始就物化正式 `slice`
- 仅仅把第二次 decision VLM 挪位置，而不是从默认路径里拿掉

## 合并语义的临时口径

以下内容仍属于讨论中的建议，不应被误读为现状事实。

### 1. 合并原则

更倾向的原则是：

- 同语义窗口可 merge
- 跨语义窗口先关联，不要过早塌平成一个窗口

这意味着：

- `speech` 和 `visual` 重叠时，不默认合成一个“万能窗口”
- 先保留它们各自的语义来源
- 最终是否 merge，要晚于“时间重叠”这一步

### 2. `talking-head`

`talking-head` 仍然倾向保留 speech-led 逻辑：

- `speechWindows` 是主导输入
- 视觉窗口主要用于补 gap、补 context
- 不应回到“视觉窗口和语音窗口完全等权”的状态

### 3. `drive`

`drive` 继续保持 `speech / visual` 双轨：

- `speech` path 面向 transcript / 原声消费
- `visual` path 面向景色摘要与 `speedCandidate`
- 两条路径即使时间重叠，也不应该过早塌平

这条约束和 2026-04-03 的 `drive` 语义分离结论保持一致。

## 当前未决问题

以下问题本轮讨论没有拍死，后续需要单独评审：

1. 默认规则合并器的具体阈值
2. 哪些条件算“歧义素材”，足以触发升级 decision VLM
3. 是否需要把阶段命名从 `audio-analysis` 改成更准确的 `audio-merge` / `decision-merge`
4. 是否先只做文档沉淀，再进入实现方案评审
5. 若后续进入实现，性能验收应以：
   - decision VLM request count
   - `finalize` wall time
   - 分流结果漂移率
   为主，还是先以更小范围样本验证行为一致性为主

## 这份文档要回答什么

后续阅读者至少应该能通过本文快速回答：

- 为什么当前“音频阶段”里还会触发 VLM
- 当前实现里哪一部分是现状，哪一部分只是讨论中的重构方向
- 本轮讨论否定了哪些路线
- 当前更倾向的方案是什么
- 哪些点已经形成共识，哪些仍未拍板

## 当前结论

本轮还没有新的拍板实现方案，但已经形成了一个比较清楚的方向：

- 保留粗扫的一次轻量 VLM
- 不把粗扫扩成更重的窗口级视觉模型输出
- 让音频阶段默认做“音频证据 + 视觉结论”的规则合并
- 只把第二次 decision VLM 留给歧义素材

在进入实现前，下一轮更适合做的是：

- 一次更正式的实现方案评审
- 明确规则合并器与歧义升级条件
- 再决定是否真正改 Analyze 的阶段边界与性能口径
