# Kairos - Analyze 性能迭代记录

> 这份文档只保留 `Analyze` 性能工作的当前结论、已拍板取舍和迭代日志。
> 详细分析见：`designs/analyze-performance-optimization.md`、`designs/2026-04-03--analyze-mac-mlx-model-ab-report.md`、`designs/2026-04-03--analyze-mac-mlx-performance-heatmap.html`、`designs/2026-04-03--analyze-hotspot-optimization-decision-sheet.md`

## 1. 当前快照

### Baseline

- 样本：代表性 5 条素材
- 默认模型：`Qwen3-VL-4B-Instruct-8bit`
- 总耗时：`188.0s`
- 阶段占比：`prepare 114.5s / 60.9%`，`finalize 37.0s / 19.7%`，`fineScan 36.4s / 19.4%`
- 子系统占比：`VLM 91.1s / 48.5%`，`ffmpeg 91.6s / 48.7%`，`ASR 4.9s / 2.6%`

### 关键信号

- `scene detect` 4 次共 `63.6s`，且 `shotCount` 全为 `0`
- 共 `13` 次 VLM 请求，`34` 张图
- 单条素材可能经历 `coarse -> decision -> fine-scan`
- 当前热点主线是 `VLM + ffmpeg`
- ASR、GPS、普通 I/O、chronology 写盘都不是优先项

### 模型结论

- `Qwen3_5-4B-MLX-8bit` 暂不采用
- 端到端：`188.0s -> 254.1s`，`+35.1%`
- VLM 总耗时：`91.1s -> 162.7s`，`+78.5%`
- 质量没有稳定提升，且有明确回退

### 最新补充验证

- `extractKeyframes()` 的监控式 sweep（`1 -> 4` 路并发）显示：当前更合适的默认值是 `3` 路
- 在 `18` 点抽帧场景中，`1 -> 3` 可把 wall time 降低约 `47.4% ~ 63.9%`
- 同一组 sweep 里，CPU 总耗时（`user + sys`）仅增加约 `3.4% ~ 14.4%`
- `4` 路虽然在部分素材上还能继续压 wall time，但峰值 CPU / RSS 抬升过快，且在 `C1501.MP4` 上已经比 `3` 路回退
- 端到端 `Analyze` 已完成回填：`188.0s -> 163.1s`，`-13.3%`
- 其中 `keyframeExtractMs`：`28.0s -> 12.5s`，`-55.5%`
- `VLM` 请求数和图片数保持不变：仍为 `13` 次请求、`34` 张图，说明这轮收益不是靠降采样换来的
- 当前判断：抽帧有界并发值得继续保留，当前默认值提升到 `3` 路；这条路线和失败版 `F1` 不同，不会通过复杂 filter graph 放大 `ffmpeg` 内部工作量
- `scene detect` 延后到 provisional decision 之后并按需触发后，当前同一组 `5` 条样本可进一步从 `163.1s -> 107.3s`，`-34.2%`
- 这轮里 `sceneDetectCallCount`：`4 -> 0`，`sceneDetectMs`：`64.3s -> 0`
- `sliceCount`、`VLM` 请求数、`VLM` 图片数仍保持不变：`5 / 13 / 34`
- 当前样本里视频资产最终都落在 `windowed/skip`，所以 deferred gate 没有触发；`full` 模式的 shot-boundary 语义由测试覆盖
- 把 deferred gate 放宽到“selected `windowed` + scenic `drive`”后，同组 `5` 条样本又从 `107.3s -> 165.9s`，`+54.6%`
- 这轮里 `sceneDetectCallCount`：`0 -> 1`，`sceneDetectMs`：`0 -> 57.6s`，且命中的 `074b9c90...` 仍然 `shotCount = 0`
- `sliceCount`、`VLM` 请求数、`VLM` 图片数仍保持不变：`5 / 13 / 34`
- 当前判断：实现方向满足“scenic drive 也能拿到 shot-aware gate”的创作诉求，但在现有样本上重新引回了几乎整笔 `scene detect` 固定税，后续需要继续收紧 gate
- 在 broadened gate 基础上补上 `drive` 时长感知 `scene detect fps`、并把 `drive` 的 speech / visual windows 端到端分语义后，同组 `5` 条样本从 `165.9s -> 122.8s`，`-25.9%`
- 但相对 strict `D1` 仍有 `+14.5%`：唯一命中的 `074b9c90...` 这条 scenic `drive` 仍跑了 `15.6s` `scene detect` 且 `shotCount = 0`
- 这一轮新收益主要来自把 broadened gate 的 `scene detect` 固定税从 `57.6s` 压到 `15.6s`；创作语义收益则来自 `drive visual` 窗口和 slices 被保留下来，而不是来自新的 shot boundaries

## 2. 当前取舍


| 项目                       | 状态     | 当前结论                              |
| ------------------------ | ------ | --------------------------------- |
| `F1` 多时间点单次抽帧            | 回退     | 失败版实现已回退，等待新的方案，不再继续沿用这版 |
| `F3` 音频先导窗口变体            | 做      | 已有效命中 talking-head，继续保守推进 |
| `K1` 抽帧有界并发（`1 -> 3`） | 做      | 当前默认值已更新为 `3` 路；端到端 `Analyze`：`188.0s -> 163.1s`，且 `VLM` 请求数/图片数不变 |
| `D1` 延后 `scene detect`       | 做      | 当前 `5` 条样本端到端：`163.1s -> 107.3s`，`sceneDetectCallCount` 从 `4` 降到 `0`；当前样本无 `video full`，full-path 已有测试兜底 |
| `D2` 放宽 deferred gate        | 已实现，待收紧 | 当前 `5` 条样本端到端：`107.3s -> 165.9s`；只命中 `074b9c90...` 这条 scenic `drive`，但 `scene detect` 仍产出 `0` shots，收益未覆盖成本 |
| `D3` `drive` 动态 `scene detect fps` + speech / visual 窗口语义分离 | 做 | 在 `D2` 基础上把同组 `5` 条样本拉回 `165.9s -> 122.8s`，`sceneDetectMs`：`57.6s -> 15.6s`；但相对 strict `D1` 仍慢 `14.5%`，`074b9c90...` 仍然 `0` shots，不过 `drive visual` slices 已独立保留 |
| `V1` 跳过第二次 decision VLM  | 放弃     | 已放弃，不再继续 shadow 或扩大样本 |
| `F2` scene detect / 抽帧缓存 | 不做     | 对正式首跑价值低，且会干扰 A/B 判断 |
| `V2` 合并 fine-scan groups | 不做     | 过于激进 |
| `V3` fine-scan 预算上限      | 不做     | 误伤素材召回不可接受 |
| `P1` `ffmpeg` 与 VLM 并行   | 暂缓     | 工程复杂度较高，后面再说 |


## 3. 当前执行顺序

1. 保留 `K1 + F3 + D1` 作为当前最稳的性能基线
2. `D2 + D3` 已实现，用于保留 scenic `drive` 的创作召回；当前创作收益主要来自 coarse visual windows 的独立保留，不是 `scene detect` 命中
3. 下一轮如果继续优化 scenic `drive`，优先改进“视觉变化召回”而不是继续放大 `scene detect` 成本面
4. `F1` 等待新方案

暂不处理：`F2 / V2 / V3 / P1`

## 4. 迭代日志

### Iteration 0 - `2026-04-03`

- 结果：完成 baseline profiling 和 Mac MLX 模型 A/B
- 结论：当前优化主线是 `VLM + ffmpeg`，不是换模型
- 产物：
  - `.tmp/run/mac-eval-baseline-qwen3vl.json`
  - `.tmp/run/mac-eval-candidate-qwen35.json`
  - `designs/2026-04-03--analyze-mac-mlx-model-ab-report.md`
  - `designs/2026-04-03--analyze-mac-mlx-performance-heatmap.html`

### Iteration 1 - `2026-04-03`

- 目标：`F1`、`F3`、`V1` shadow
- profile：`.tmp/run/mac-eval-optimized-f1-f3-v1shadow.json`
- 结果：
  - 总耗时：`188.0s -> 408.4s`
  - `prepareMs`：`114.5s -> 235.5s`
  - `finalizeMs`：`37.0s -> 35.4s`
  - `fineScanMs`：`36.4s -> 137.5s`
  - `sceneDetectMs`：`63.6s -> 61.4s`
  - `keyframeExtractMs`：`28.0s -> 253.5s`
  - `sliceCount`：`5 -> 5`
- 结论：
  - `F1` 当前实现失败，批量抽帧把 `ffmpeg` 抽帧成本显著放大，不能继续按这版推进
  - `F3` 有效命中 talking-head，`interestingWindows` 已收口到 `speech-window`
  - `V1 shadow` 命中 1 条纯 aerial，无语音样本，且出现 `1` 次分歧；该方向现已放弃
- 当前代码状态：失败版 `F1` 实现已回退，仅保留 `F3`

### Iteration 2 - `2026-04-03`

- 目标：验证“单纯并发”的抽帧方案会不会把 CPU 开销顶高
- 方法：绕过 `ML server`，只对真实素材上的 `extractKeyframes()` 做局部基准，对比 `keyframeExtractConcurrency=1` 和 `2`
- 样本结果：
  - `C1501.MP4`，`6` 个时间点：wall time `2903ms -> 1665ms`，`-42.6%`；CPU 总耗时 `11.20s -> 12.09s`，`+7.9%`
  - `C1501.MP4`，`18` 个时间点：wall time `9147ms -> 5177ms`，`-43.4%`；CPU 总耗时 `38.32s -> 42.12s`，`+9.9%`
  - `DJI_20260217042948_0023_D.MP4`，`18` 个时间点：wall time `19543ms -> 10028ms`，`-48.7%`；CPU 总耗时 `35.88s -> 36.16s`，`+0.8%`
- 结论：
  - `2` 路有界并发显著改善抽帧 wall time
  - CPU 总耗时没有出现同量级放大，更像是少量 CPU 增量换取明显等待时间收益
  - 这条路线和失败版 `F1` 不同，不是通过复杂 filter graph 放大 `ffmpeg` 内部工作量
- 限制：
  - 端到端 `Analyze` 回填暂未完成；本次尝试时 `MLX server` 在首次真正进模型时崩于 `libmlx`，导致整条分析链卡住，当前只能先记局部抽帧结论
- 当前代码状态：
  - `extractKeyframes()` 已改为默认 `2` 路有界并发
  - 可通过 `runtimeConfig.keyframeExtractConcurrency` 显式回退到 `1`

### Iteration 3 - `2026-04-03`

- 目标：做更激进的抽帧并发 sweep，并通过系统开销监控决定默认并发数
- 方法：
  - 新增 `scripts/keyframe-concurrency-benchmark.mjs`
  - 对 `extractKeyframes()` 做 `1 / 2 / 3 / 4` 路 sweep
  - 监控指标包含：wall time、`user + sys` CPU 总耗时、进程树平均/峰值 CPU、峰值 RSS、峰值 `ffmpeg` 数
- 产物：
  - `.tmp/run/keyframe-concurrency-c1501-dense.json`
  - `.tmp/run/keyframe-concurrency-drone-car-dense.json`
- 样本结果：
  - `C1501.MP4`，`18` 点：`1 -> 3`，wall time `9625ms -> 5058ms`，`-47.4%`；CPU 总耗时 `41.26s -> 47.19s`，`+14.4%`
  - `C1501.MP4`，`18` 点：`3 -> 4`，wall time `5058ms -> 5353ms`，反而回退；峰值 RSS `2957.94MB -> 3743.28MB`
  - `DJI_20260217042948_0023_D.MP4`，`18` 点：`1 -> 3`，wall time `19008ms -> 6865ms`，`-63.9%`；CPU 总耗时 `35.58s -> 36.79s`，`+3.4%`
  - `DJI_20260217042948_0023_D.MP4`，`18` 点：`3 -> 4`，wall time `6865ms -> 5547ms`，仍有收益；但峰值 CPU `516.9% -> 975.8%`，峰值 RSS `2511.81MB -> 3518.03MB`
- 结论：
  - `3` 路是当前更合适的默认并发：它已经覆盖了大部分 wall time 收益，同时没有像 `4` 路那样继续明显抬高峰值系统开销
  - `4` 路可保留为可配置实验值，但当前不适合作为默认
- 当前代码状态：
  - `extractKeyframes()` 默认并发已从 `2` 提升到 `3`
  - 默认上限放宽到 `6`
  - 可通过 `runtimeConfig.keyframeExtractConcurrency` 显式覆盖

### Iteration 4 - `2026-04-03`

- 目标：把 `K1` 默认 `3` 路抽帧并发回填到端到端 `Analyze`
- 方法：
  - 复用代表性 `5` 条素材样本
  - 通过项目级 runtime override 把 `mlServerUrl` 指到健康的 `8911`
  - 保持当前默认 `keyframeExtractConcurrency=3`
  - 不改采样点数量，不改 `VLM` 请求数目标，不额外降采样
- profile：`.tmp/run/mac-eval-keyframe-concurrency-3-f3.json`
- 结果：
  - 总耗时：`188.0s -> 163.1s`，`-13.3%`
  - `prepareMs`：`114.5s -> 101.1s`，`-11.7%`
  - `finalizeMs`：`37.0s -> 33.8s`，`-8.7%`
  - `fineScanMs`：`36.4s -> 28.1s`，`-22.7%`
  - `sceneDetectMs`：`63.6s -> 64.3s`，`+1.2%`
  - `keyframeExtractMs`：`28.0s -> 12.5s`，`-55.5%`
  - `VLM` 总 round-trip：`91.1s -> 82.0s`，`-10.0%`
  - `ASR` 总 round-trip：`4.9s -> 3.8s`，`-21.7%`
  - `VLM` 请求数：`13 -> 13`
  - `VLM` 图片数：`34 -> 34`
  - `sliceCount`：`5 -> 5`
- 结论：
  - `K1` 默认 `3` 路并发已证明能带来端到端收益，不只是局部抽帧 benchmark 好看
  - 主要收益来源仍然落在 `keyframeExtractMs`，`sceneDetect` 基本没变，符合预期
  - 由于 `VLM` 请求数与图片数都没变，这轮收益不是靠减少分析密度换来的
  - 本轮 `VLM` 总耗时也略有下降，但这部分不应完全归因于 `K1`；新端口 `8911` 上的 `MLX server` 在正式跑前已做过一次 warm-up
- 当前代码状态：
  - `extractKeyframes()` 默认保留 `3` 路有界并发
  - `runtimeConfig.keyframeExtractConcurrency` 仍可用于显式回退或继续实验

### Iteration 5 - `2026-04-03`

- 目标：把 `scene detect` 从 unconditional coarse prepare 挪到 provisional decision 之后，只在真正需要 shot 结构的路径上触发
- 方法：
  - `prepareAssetVisualCoarse()` 不再前置调用 `detectShots()`
  - 先走 coarse keyframes / coarse VLM / ASR / provisional decision
  - 只在 deferred gate 命中时才补跑 `detectShots()`
  - 当前 gate 保守收在 `video + fineScanMode === full`；`windowed/skip` 继续保持 coarse-first
  - profiling 新增 `sceneDetectPhases.prepare/finalize/fine-scan`
- profile：`.tmp/run/mac-eval-deferred-scene-detect-k1-f3.json`
- 结果：
  - 相对 baseline：总耗时 `188.0s -> 107.3s`，`-43.0%`
  - 相对 `K1 + F3`：总耗时 `163.1s -> 107.3s`，`-34.2%`
  - `prepareMs`：`101.1s -> 41.3s`，`-59.1%`
  - `finalizeMs`：`33.8s -> 37.3s`，`+10.2%`
  - `fineScanMs`：`28.1s -> 28.6s`，`+1.8%`
  - `sceneDetectMs`：`64.3s -> 0`，`-100%`
  - `sceneDetectCallCount`：`4 -> 0`
  - `keyframeExtractMs`：`12.5s -> 12.7s`，基本持平
  - `sliceCount`：`5 -> 5`
  - `VLM` 请求数：`13 -> 13`
  - `VLM` 图片数：`34 -> 34`
- 结论：
  - 这次收益几乎全部来自“移除前置 scene detect 固定税”，不是来自降采样或减少 `VLM` 轮次
  - 当前样本里没有任何视频资产最终落到 `full`，因此 deferred gate 没有触发，`sceneDetect` 成本被完整消除
  - `finalizeMs` 小幅上升是正常的：coarse-only decision 还在这里做完，但原先那笔 `scene detect` 已经不再算在前面
  - `full` 路径仍通过测试保证：当视频资产最终需要 `full` 时，会在 deferred stage 里补跑 `detectShots()`
- 当前代码状态：
  - Analyze 现在真正变成 `coarse-first`
  - `scene detect` 不再是所有视频的强制前置步骤
  - `sceneDetectPhases` 可直接用于后续 heatmap / profile 解读

### Iteration 6 - `2026-04-03`

- 目标：在保留 `full` hard gate 的前提下，把 deferred gate 放宽到“selected `windowed` non-drive + scenic `drive`”
- 方法：
  - `windowed` 非 `drive` 只在窗口足够分散、明显需要 shot snapping 时触发
  - `drive` 不进 generic `windowed` gate，而是复用已有 coarse VLM 语义做 scenic trigger
  - gate 命中后只重算 shot-sensitive planning，不重跑 coarse VLM / ASR
- profile：`.tmp/run/mac-eval-soft-gate-deferred-scene-detect-k1-f3.json`
- 结果：
  - 相对 baseline：总耗时 `188.0s -> 165.9s`，`-11.8%`
  - 相对 `D1`：总耗时 `107.3s -> 165.9s`，`+54.6%`
  - 相对 `K1 + F3`：总耗时 `163.1s -> 165.9s`，`+1.7%`
  - `prepareMs`：`41.3s -> 42.1s`，`+1.9%`
  - `finalizeMs`：`37.3s -> 95.1s`，`+155.3%`
  - `fineScanMs`：`28.6s -> 28.6s`，基本持平
  - `sceneDetectMs`：`0 -> 57.6s`
  - `sceneDetectCallCount`：`0 -> 1`
  - `sliceCount`：`5 -> 5`
  - `VLM` 请求数：`13 -> 13`
  - `VLM` 图片数：`34 -> 34`
- 结论：
  - 当前样本里只有 `074b9c90...` 这条 scenic `drive` 命中了 broadened gate；两条 `talking-head` 仍是连续单段 `speech-window`，没有触发新的 `windowed` soft gate
  - 这次重新引回的成本几乎全部落在 `074b9c90...`：`scene detect` 花了 `57.6s`，但 `shotCount` 仍为 `0`
  - 该素材最终 `interestingWindows` 仍是原来的 `coarse-sample-window`，`sliceCount` / `fineScanVlm` 都没有增加，说明这次 broadened gate 在当前样本上只付出了成本，没有换回额外 shot-aware 收益
  - 当前实现满足了“scenic drive 可进入 deferred gate”的能力目标，但默认触发条件还不够保守，后续需要继续收紧
- 当前代码状态：
  - 两级 deferred gate、`drive` coarse-semantic trigger、以及“不重跑 coarse VLM / ASR 的 shot-sensitive recompute”都已实现并有测试覆盖
  - 当前 `5` 条样本验证不支持直接把这轮 broadened gate 视为性能正收益

### Iteration 7 - `2026-04-03`

- 目标：保留 scenic `drive` 的 broadened gate 与创作语义，同时回收 `scene detect` 的大头固定税，并把 `drive` speech / visual windows 端到端分开
- 方法：
  - `detectShots()` 新增 clip-aware fps policy：显式 runtime override 仍然优先；其他 non-drive deferred path 默认 `2fps`
  - `drive` 的 deferred `scene detect` 改为时长感知 fps，按目标帧预算把有效 fps 收口在 `0.5 ~ 2`
  - `IInterestingWindow` / `IKtepSlice` / recall candidate 新增 `semanticKind`
  - `drive` 的 speech windows 和 visual windows 不再 merge，并分别保留 transcript / visual summary 的后续行为
- profile：`.tmp/run/mac-eval-drive-fps-window-semantics.json`
- 结果：
  - 相对 baseline：总耗时 `188.0s -> 122.8s`，`-34.7%`
  - 相对 strict `D1`：总耗时 `107.3s -> 122.8s`，`+14.5%`
  - 相对 `D2`：总耗时 `165.9s -> 122.8s`，`-25.9%`
  - `prepareMs`：`42.1s -> 41.6s`，基本持平
  - `finalizeMs`：`95.1s -> 52.2s`，`-45.1%`
  - `fineScanMs`：`28.6s -> 28.9s`，基本持平
  - `sceneDetectMs`：`57.6s -> 15.6s`，`-73.0%`
  - `sceneDetectCallCount`：`1 -> 1`
  - `sliceCount`：`5 -> 5`
  - `074b9c90...` 仍是唯一命中的 scenic `drive`，且 `shotCount` 仍为 `0`
- 结论：
  - `drive` 动态 fps 已经显著回收 broadened gate 的 `scene detect` 固定税，但还没有把这条 scenic `drive` 稳定转成有效 shot boundaries
  - 当前创作收益主要来自 coarse VLM 视觉窗口在后续 slices 中被保留下来，而不是来自 `scene detect` 真的打出了 cut points
  - `drive` 的 speech / visual 语义分离已完成并进入正式产物，这比单纯看 wall time 更接近实际剪辑需求
- 当前代码状态：
  - non-drive deferred `scene detect` 默认 `2fps`，仍允许通过 runtime config 显式覆盖
  - `drive` deferred `scene detect` 采用时长感知 fps
  - `drive` speech / visual windows 与 slices 已端到端携带 `semanticKind`

### Iteration 8 - `2026-04-05`

- 目标：补齐 Analyze 的中断恢复能力，避免长跑任务在 `coarse / audio / fine-scan` 中途停止后整批白跑；同时修正 `retry / resume` 后的 ETA 误导
- 方法：
  - coarse 完成后写 `analysis/prepared-assets/<assetId>.json`
  - audio 完成后写 `analysis/audio-checkpoints/<assetId>.json`
  - `asset report` 新增 `fineScanCompletedAt / fineScanSliceCount`
  - `fine-scan` 恢复时允许从 `report + checkpoint` 直接继续，而不是只认“有没有 report”
  - ETA 改为按 `coarse-scan / audio-analysis / fine-scan` 三个阶段分别重估；当前阶段完成数 `< 3` 时不显示 ETA
  - ML server 在 `VLM` 和 `Whisper` 之间互斥卸载，避免双模型同时常驻显存
  - 保护音轨 fallback 改为“仅对已绑定 `protectionAudio` 的素材触发，且默认不做独立健康检查”
- profile：无统一 wall-time profile；本轮主要是恢复能力与面板口径修复，不是吞吐 benchmark
- 结果：
  - Analyze 现在具备 coarse / audio / fine-scan 三段可恢复状态
  - `retry / resume` 后 ETA 不再沿用上一轮的全局起点，不再出现几十小时级别的误导性倒计时
  - 单卡环境里 `VLM + Whisper` 不再同时常驻
- 结论：
  - 这轮优先解决的是“长任务可恢复性”和“用户感知正确性”，不是单纯压缩 wall time
  - 未来如果要做更激进的 ETA，需要单独设计跨进程吞吐统计，而不是把本轮的保守重置逻辑继续复杂化
- 当前代码状态：
  - `analysis/prepared-assets/` 与 `analysis/audio-checkpoints/` 已成为 Analyze 的 durable resume cache
  - `asset report` 已携带 fine-scan 完成态
  - ETA 当前遵循“重试后直接重置，阶段内样本不足不显示”的保守规则
