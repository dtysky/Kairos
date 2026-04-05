# 2026-04-05 — Analyze 恢复检查点与 ETA 重置

## 背景

本轮 `Analyze` 在正式项目中暴露出两个设计问题：

1. 旧实现只在 `finalize -> writeAssetReport()` 时才把素材分析结果正式落盘。
2. `retry / resume` 后的 ETA 沿用了“本次新进程启动时间 + 全量进度口径”的混合算法，容易在面板上出现夸张倒计时。

旧链路的实际行为是：

- `coarse-scan` 先把剩余素材批量转成内存里的 `preparedAnalyses`
- 然后才进入 `audio-analysis / finalize`
- `fine-scan` 再从 `finalizedAnalyses` 继续推进
- 只有 `asset report` 和 `slices` 属于正式落盘结果

这意味着：

- 进程一旦在 `coarse-scan` 或 `audio-analysis` 中途被停掉，已经完成但尚未写 report 的素材会整批丢失
- `fine-scan` 如果只完成了一部分，也缺少“已完成”标记，恢复时很难精确知道该从哪里继续
- ETA 会把“这次新进程刚跑出来的几个慢样本”外推出整夜剩余时长，误导用户

## 决策

### 1. Analyze 改为分阶段可恢复

对每条素材增加 3 层恢复状态：

1. `coarse prepared checkpoint`
2. `audio analysis checkpoint`
3. `fine-scan completed marker`

具体落盘位置：

- `analysis/prepared-assets/<assetId>.json`
  - 保存 coarse 阶段可直接复用的 `sampleFrames / coarseSampleTimestamps / visualSummary / hasAudioTrack ...`
- `analysis/audio-checkpoints/<assetId>.json`
  - 保存 `transcript` 与 `protectedAudio` 的轻量结果
- `analysis/asset-reports/<assetId>.json`
  - 新增 `fineScanCompletedAt / fineScanSliceCount`

恢复规则：

- 有 `prepared-assets` 时，`coarse-scan` 不再重做同一素材的粗扫
- 有 `audio-checkpoints` 时，`audio-analysis` 不再重做同一素材的 ASR / protection fallback
- 如果 `report.shouldFineScan === true`，但还没有 `fineScanCompletedAt`，且对应 `slices` 未完成，则允许从 `report + checkpoint` 直接恢复 `fine-scan`
- `report` 写成功但仍需 `fine-scan` 时，保留 `prepared-assets`
- `fine-scan` 真正完成后，再回写 report 完成态并清理 `prepared-assets`
- `audio-checkpoints` 在正式 report 写出后即可清理

### 2. `report` 仍然是正式分析产物，checkpoint 是可恢复中间态

正式可供后续流程消费的 Analyze 结果仍然只有：

- `analysis/asset-reports/*.json`
- `store/slices.json`
- `media/chronology.json`

`prepared-assets` 与 `audio-checkpoints` 的定位是：

- durable resume cache
- 为了跨进程恢复而持久化
- 不作为 Script / Timeline 的直接正式输入

### 3. 保护音轨回到保守 fallback 语义

新的保护音轨策略：

- 只有素材资产本身绑定了 `protectionAudio`，才进入保护音轨兜底逻辑
- 保护音轨默认不做独立健康检查
- 只有主音轨明显偏弱或需要兜底时，才升级到 transcript 对比

### 4. VLM 与 Whisper 不再同时常驻显存

ML server 调整为：

- 进入 `/asr` 前先卸载 `VLM`
- 进入 `/vlm/analyze` 前先卸载 `Whisper`

目标是避免本地单卡环境里 `Qwen3-VL-4B + Whisper` 同时占用 VRAM。

### 5. `retry / resume` 后 ETA 直接重置

新的 ETA 规则：

- ETA 只按“当前阶段、当前这次进程”的样本吞吐重新估算
- `coarse-scan / audio-analysis / fine-scan` 分别维护自己的阶段起点
- 当前阶段完成数 `< 3` 时，不显示 ETA
- 不做跨进程 ETA 继承，也不把上一轮的已耗时强行混入当前估算

## 结果

这轮调整后的预期效果：

- 中断后不再整批丢失已完成的 coarse / audio 结果
- `fine-scan` 可以明确知道哪些素材已经完成，哪些只是“coarse report 已写但仍待细扫”
- 面板的进度口径与 ETA 口径解耦，避免出现几十小时级别的误导性倒计时
- 单卡环境下的显存占用回到更可控的互斥装载模型

## 当前限制

- 当前正在运行的旧 worker 无法热升级吃到这些恢复逻辑；必须在新 worker 启动后才生效
- ETA 现在是保守重置版，不是跨进程的“全程真实预估”
- `prepared-assets` / `audio-checkpoints` 仍然属于项目内恢复缓存，需要后续再决定是否补统一清理命令
