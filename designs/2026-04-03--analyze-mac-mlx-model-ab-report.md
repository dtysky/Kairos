# Kairos - Analyze Mac MLX 模型 A/B 评估报告

> 本文档记录一次实际的 Mac + MLX `Analyze` 模型 A/B 评估结果。
> 本轮只比较 VLM 模型，不比较 `flash_attention_2`。
> 评价优先级为：`质量优先，其次要求成本不能明显上升`。

## 1. 结论摘要

结论很明确：当前 **不建议** 用 `Qwen3_5-4B-MLX-8bit` 替换现有 `Qwen3-VL-4B-Instruct-8bit`。

主要原因：

- 端到端 `Analyze` 总耗时从 `188.0s` 增加到 `254.1s`，上涨约 `35.1%`
- VLM 总耗时从 `91.1s` 增加到 `162.7s`，上涨约 `78.5%`
- 质量没有出现稳定提升，反而出现了多处明确回退
- 下游结果也发生退化：`sliceCount` 从 `5` 降到 `4`

因此，这个候选模型不满足“效果更好，且开销不增加”的准入条件。

## 2. 实验口径

### 2.1 目标

验证在 Mac + MLX 路径下，把当前 VLM 从：

- baseline: `Qwen3-VL-4B-Instruct-8bit`

替换为：

- candidate: `Qwen3_5-4B-MLX-8bit`

后，是否能在 **不提高成本** 的前提下带来更好的分析质量。

### 2.2 固定条件

本轮 A/B 里，以下条件保持一致：

- 同一个 project: `tmp-current-flow-test-20260401-160735`
- 同一组代表性素材
- 同一个 `budget`: `standard`
- 同一套 GPS 缓存与空间推断前置结果
- 同一个 ASR 模型：`whisper-large-v3-turbo`
- 同一个 ML server / `mps` 设备路径
- 同一套 `Analyze` 代码与 profiling 打点

唯一变化项只有：

- `KAIROS_VLM_MODEL_PATH`

### 2.3 样本集合

本轮固定选择 5 条代表性素材，覆盖 `camera / drone / drone-car / pocket3 / photo`：

| Asset | 文件 | 类型 | 目的 |
| --- | --- | --- | --- |
| `3907112b-c1f5-4e93-af90-76a3754be03b` | `C1501.MP4` | camera / talking-head | 覆盖有人物、语音、静态构图 |
| `50b78bb2-117c-4536-9d15-1acbbcd6cc98` | `DJI_20260217052235_0070_D.MP4` | drone / aerial | 覆盖纯视觉航拍场景 |
| `074b9c90-740c-4294-830a-22dfde53fe6a` | `DJI_20260217042948_0023_D.MP4` | drone-car / drive | 覆盖 drive 判别与窗口细扫 |
| `37abd800-c2d8-4eca-84d5-d937f8273314` | `DJI_20260217143122_0268_D.MP4` | pocket3 / talking-head | 覆盖中文口播 + 场景识别 |
| `e5231536-0d9f-4afb-be33-f45b1feaeefe` | `0001-2.jpg` | photo | 覆盖单图静态素材 |

### 2.4 原始结果文件

原始 profile 已落盘：

- baseline: `.tmp/run/mac-eval-baseline-qwen3vl.json`
- candidate: `.tmp/run/mac-eval-candidate-qwen35.json`

## 3. 总体结果

### 3.1 端到端结果

| 指标 | baseline | candidate | 变化 |
| --- | ---: | ---: | ---: |
| `pipelineTotalMs` | `188.0s` | `254.1s` | `+35.1%` |
| `assetCount` | `5` | `5` | `0` |
| `fineScannedAssetCount` | `4` | `4` | `0` |
| `sliceCount` | `5` | `4` | `-20.0%` |

虽然两轮都细扫了 4 条素材，但**并不是同 4 条**：

- baseline 细扫了：`C1501.MP4`、`DJI_20260217042948_0023_D.MP4`、`DJI_20260217143122_0268_D.MP4`、`0001-2.jpg`
- candidate 细扫了：`C1501.MP4`、`DJI_20260217052235_0070_D.MP4`、`DJI_20260217143122_0268_D.MP4`、`0001-2.jpg`

也就是说，candidate 没有保持相同决策，而是把一次细扫预算从 `drive` 素材转移到了另一条 `aerial` 素材上。

### 3.2 阶段耗时

| 阶段 | baseline | candidate | 变化 |
| --- | ---: | ---: | ---: |
| `prepareMs` | `114.5s` | `145.0s` | `+26.6%` |
| `finalizeMs` | `37.0s` | `66.4s` | `+79.3%` |
| `fineScanMs` | `36.4s` | `42.6s` | `+17.1%` |
| `chronologyRefreshMs` | `0.0s` | `0.0s` | 近似持平 |

最明显的放大发生在 `finalize` 阶段，这与决策阶段的 VLM 请求显著变慢高度一致。

## 4. 热点拆解

### 4.1 先看整条链路的构成，不要只盯模型

这轮 baseline 的一个关键结论是：**当前 Analyze 不是“VLM 一家独大”，而是 `VLM` 和 `ffmpeg` 基本各占半壁江山。**

| 子系统 | baseline | candidate | baseline 占比 | candidate 占比 | 说明 |
| --- | ---: | ---: | ---: | ---: | --- |
| VLM 总耗时 | `91.1s` | `162.7s` | `48.5%` | `64.0%` | 包含 coarse / decision / fine-scan 三段 |
| `ffmpeg` 总耗时 | `91.6s` | `87.1s` | `48.7%` | `34.3%` | 包含 `scene detect + keyframe extract` |
| ASR 总耗时 | `4.9s` | `3.9s` | `2.6%` | `1.5%` | 只覆盖 embedded 音轨，本轮未触发 protection audio |
| I/O 总耗时 | `30ms` | `27ms` | `0.0%` | `0.0%` | 进度、报告、切片、chronology 写盘几乎可忽略 |

几个直接结论：

- baseline 下，**VLM 和 `ffmpeg` 是同量级热点**，并不是只有模型
- candidate 把整条链路的构成改成了“`VLM` 压倒性主导”，这才是总耗时显著上涨的根本原因
- 这轮的冷启动装载成本很小：baseline `loadMs = 2410ms`，candidate `loadMs = 2207ms`
- 也就是说，本轮最贵的不是“第一次把模型载入内存”，而是后续每次请求里的 `generate`

### 4.2 VLM 的问题不只是“模型不同”，而是热路径整体变慢

| 桶 | baseline 请求数 | candidate 请求数 | baseline 单次均值 | candidate 单次均值 | 总耗时变化 |
| --- | ---: | ---: | ---: | ---: | ---: |
| coarse VLM | `5` | `5` | `7.1s` | `13.3s` | `35.7s -> 66.4s` |
| decision VLM | `4` | `4` | `8.0s` | `15.6s` | `32.2s -> 62.5s` |
| fine-scan VLM | `4` | `3` | `5.8s` | `11.2s` | `23.3s -> 33.7s` |

这里最重要的是两点：

- candidate 并不是因为“请求次数更多”才慢
- candidate 即使在请求更少的 bucket 上，**单次请求仍然明显更慢**

这说明本轮回退不是调度层偶发问题，而是 candidate 在 MLX 上的热路径本身就更贵。

### 4.3 请求放大与结构性成本

从请求放大的角度看，这轮也能更清楚地看到 `Analyze` 的结构成本：

| 指标 | baseline | candidate | 解读 |
| --- | ---: | ---: | --- |
| 总 VLM 请求数 | `13` | `12` | 5 条素材最终放大成 12 到 13 次 VLM 请求 |
| 总 VLM 图片数 | `34` | `31` | candidate 看过的图片更少，但仍然更慢 |
| `scene detect` 调用数 | `4` | `4` | 4 条视频都做了一次完整 scene pass，photo 不参与 |
| `keyframe extract` 调用数 | `7` | `7` | 粗扫与细扫叠加后形成多次抽帧 |
| 粗扫 keyframe 数 | `12` | `12` | 两轮完全一致 |
| 细扫 keyframe 数 | `9` | `6` | candidate 不是更高效，而是细扫分配变了 |

这组数据反过来说明：

- baseline 的 5 条素材平均已经会放大成 `2.6` 次 VLM 请求
- candidate 平均也还有 `2.4` 次 VLM 请求
- 所以当前 Analyze 的结构问题不是“只跑一次模型”，而是同一资产会经历 `coarse -> decision -> fine-scan` 的多段 ML 调用
- candidate 细扫 keyframe 更少，但整体反而更慢，进一步证明核心问题不是抽帧数量，而是 VLM 单次生成代价

### 4.4 `ffmpeg` 仍然是稳定的大头，而且是模型外最值得优化的一段

`ffmpeg` 在这轮里不是主因，但它绝对不是可以忽略的小头。

| 指标 | baseline | candidate | 变化 |
| --- | ---: | ---: | ---: |
| `sceneDetectMs` | `63.6s` | `63.3s` | `-0.4%` |
| `sceneDetectCallCount` | `4` | `4` | `0` |
| 单次 scene detect 均值 | `15.9s` | `15.8s` | 近似持平 |
| `keyframeExtractMs` | `28.0s` | `23.8s` | `-15.1%` |
| `keyframeExtractCallCount` | `7` | `7` | `0` |
| 单次 keyframe extract 均值 | `4.0s` | `3.4s` | 略降 |

这段可以拆成两个不同性质的问题：

- `scene detect` 是**稳定税**，与模型几乎无关，两轮都稳定吃掉约 `63s`
- `keyframe extract` 会随着细扫策略变化而浮动，因为细扫窗口和抽帧点数会变

本轮 candidate 的 `keyframeExtractMs` 略低，并不是因为它的 `ffmpeg` 更高效，而是因为：

- baseline 在 `DJI_20260217042948_0023_D.MP4` 上做了更多 fine-scan keyframes
- candidate 则把这部分预算挪到了另一条素材上，整体细扫 keyframes 从 `9` 降到 `6`

因此，`ffmpeg` 部分给我们的真实结论是：

- 它不是本轮退化主因
- 但在 baseline 下，它和 VLM 一样大
- 所以即使未来 VLM 优化掉了，`scene detect` 仍然会是必须处理的固定瓶颈

### 4.5 ASR、保护音轨和音频链路在本轮里不是热点

| 指标 | baseline | candidate | 说明 |
| --- | ---: | ---: | --- |
| embedded ASR 请求数 | `2` | `2` | 只在两条 talking-head 视频上触发 |
| embedded ASR 总耗时 | `4.9s` | `3.9s` | 每次约 `2.4s` 与 `1.9s` |
| `wavExtractMs` | `413ms` | `450ms` | 音频抽 wav 成本很低 |
| protection ASR 请求数 | `0` | `0` | 本轮没有 sidecar / protection audio 分支命中 |

这里需要特别说明两点：

- 本轮数据可以证明：**embedded ASR 不是当前主热点**
- 但它**不能**用来代表未来 protection audio 方案的真实成本，因为那条支路这次没有触发

也就是说，这份报告能支持“音频链路当前不是 Analyze 热点”，但不能直接得出“保护音轨机制未来也一定便宜”的结论。

### 4.6 I/O、chronology、GPS 和其他非热点

| 指标 | baseline | candidate | 解读 |
| --- | ---: | ---: | --- |
| `progressWriteCount` | `23` | `23` | 进度写盘次数固定 |
| `progressWriteMs` | `15ms` | `13ms` | 基本可忽略 |
| `reportWriteCount` | `5` | `5` | 每条素材写一份报告 |
| `reportWriteMs` | `4ms` | `3ms` | 可忽略 |
| `sliceAppendCount` | `4` | `4` | 发生 4 次切片落盘 |
| `sliceAppendMs` | `10ms` | `10ms` | 可忽略 |
| `chronologyWriteCount` | `1` | `1` | 收尾一次 |
| `chronologyWriteMs` | `1ms` | `1ms` | 可忽略 |
| `chronologyRefreshMs` | `11ms` | `11ms` | 不是瓶颈 |
| `missingRootCount` | `0` | `0` | 没有缺失素材根目录 |

这部分基本可以把几个常见怀疑点排除掉：

- GPS 前置缓存不是本轮性能问题
- 普通写盘和进度刷新不是问题
- chronology 刷新几乎不占时间
- 也不存在路径缺失、fallback 扫描之类的额外开销

## 5. 质量与行为对比

本节重点不是只看摘要文本是否“像样”，而是看它是否对后续分析决策更有帮助，包括：

- `summary`
- `labels`
- `placeHints`
- `clipTypeGuess`
- `shouldFineScan / fineScanMode`
- 最终 `slice` 输出

### 5.1 `C1501.MP4`

baseline：

- 识别为静态人物 + 山野环境
- `fineScanMode = windowed`
- `placeHints` 为 `mountains / field / wildflowers`

candidate：

- 视觉描述更具体一些，能说出 `curly hair`、`yellow flowers`
- 但 `placeHints` 退化为更泛化的 `mountainous region / field`
- `fineScanMode` 从 `windowed` 变成了 `full`

判断：

- 视觉文案有轻微提升
- 但细扫策略更激进、更贵
- 这类提升不足以抵消成本上涨

### 5.2 `DJI_20260217052235_0070_D.MP4`

baseline：

- 正确识别为 `aerial`
- 给出 `cows / green fields / mountains / fog`
- `placeHints` 有 `rural countryside / mountainous region / foggy weather`
- 判定 `shouldFineScan = false`

candidate：

- 仍然识别为 `aerial`
- 文案基本同义，没有明显信息增量
- `placeHints` 直接丢失
- 却把策略改成了 `shouldFineScan = true`，`fineScanMode = windowed`

判断：

- 这不是“更聪明”，更像“更贵但没有更有用”
- 对纯航拍粗扫结果来说，candidate 引入了没有明显收益的额外细扫

### 5.3 `DJI_20260217042948_0023_D.MP4`

baseline：

- 正确识别为 `drive`
- `placeHints` 能到 `New Zealand / Lake Wakatipu / Queenstown`
- 保留了两个 `interestingWindows`
- `fineScanMode = windowed`
- 最终追加了 `2` 个 slices

candidate：

- 仍识别为 `drive`
- 但 `placeHints` 退化成 `New Zealand / mountainous region`
- 丢掉了 `interestingWindows`
- `fineScanMode` 退化成 `skip`
- 最终没有新增 slices

判断：

- 这是本轮最关键的行为回退之一
- candidate 看上去在这条素材上“更快”，但那是因为它**直接少做了有价值的细扫工作**
- 这个回退会直接影响后续时间线素材可用性

### 5.4 `DJI_20260217143122_0268_D.MP4`

baseline：

- 有较准确的人像 + 山谷口播判断
- `placeHints` 能到 `New Zealand / Fiordland National Park / Milford Sound`
- `fineScanMode = windowed`

candidate：

- 视觉描述强调了 `walks along a gravel shoulder`
- 但 `placeHints` 退化成 `mountainous region / glacier`
- `fineScanMode` 变成 `full`

判断：

- 如果只看纯视觉描述，candidate 不算完全退步
- 但它没有把现有口播语义很好地转成更精确的地点提示
- 同时把细扫策略变贵，整体仍然不如 baseline 稳定

### 5.5 `0001-2.jpg`

baseline：

- 能产出完整的山河描述
- 标签有 `river / forest / mountains / clouds`
- `placeHints` 甚至给到 `Patagonia / South Island, New Zealand / glacial river`

candidate：

- `summary` 为空字符串
- 标签退化成 `broll / unknown`
- `placeHints` 全空

判断：

- 这是一次明确且严重的质量回退
- 对单图静态素材来说，candidate 甚至没有保持最低可用输出

## 6. 资产级执行路径与耗时

### 6.1 每条素材到底跑了哪些子流程

这张表比单看总耗时更重要，因为它能直接解释“为什么有的素材更慢、有的素材更快”。

| 文件 | baseline 路径 | candidate 路径 | 结果解释 |
| --- | --- | --- | --- |
| `0001-2.jpg` | `coarse VLM -> +1 slice` | `coarse VLM -> +1 slice` | 路径完全相同，差异几乎纯粹来自 VLM 本身更慢且结果更差 |
| `C1501.MP4` | `scene detect -> coarse VLM -> ASR -> decision VLM -> fine-scan(2 frames / 1 req) -> +1 slice` | `scene detect -> coarse VLM -> ASR -> decision VLM -> fine-scan(2 frames / 1 req) -> +1 slice` | 路径相同，candidate 的退化主要是同一路径上 VLM 更慢、细扫更激进 |
| `DJI_20260217042948_0023_D.MP4` | `scene detect -> coarse VLM -> decision VLM -> fine-scan(5 frames / 2 req) -> +2 slices` | `scene detect -> coarse VLM -> decision VLM -> skip fine -> +0 slice` | candidate 变快不是优化，而是少做了细扫工作 |
| `DJI_20260217052235_0070_D.MP4` | `scene detect -> coarse VLM -> decision VLM -> skip fine -> +0 slice` | `scene detect -> coarse VLM -> decision VLM -> fine-scan(2 frames / 1 req) -> +1 slice` | candidate 变慢来自决策漂移，额外做了未必有价值的细扫 |
| `DJI_20260217143122_0268_D.MP4` | `scene detect -> coarse VLM -> ASR -> decision VLM -> fine-scan(2 frames / 1 req) -> +1 slice` | `scene detect -> coarse VLM -> ASR -> decision VLM -> fine-scan(2 frames / 1 req) -> +1 slice` | 路径相同，差异主要来自 decision 和 fine-scan VLM 都变慢 |

这个表说明了一件很关键的事：

- 有些差异是**同一路径更慢**
- 有些差异是**走了不同路径**
- 所以不能把所有耗时变化都简单解释成“模型快慢”

### 6.2 三种不同类型的退化

把 5 条素材按退化类型分组，其实更容易看清问题：

#### A. 同路径纯粹变慢

包括：

- `0001-2.jpg`
- `C1501.MP4`
- `DJI_20260217143122_0268_D.MP4`

这类素材的共同点是：

- baseline 和 candidate 经过的主链路基本相同
- 没有多出额外 `ffmpeg` 分支
- 最核心差异就是 VLM 的 coarse / decision / fine-scan 都更慢

这类样本最能说明 candidate 的**单次推理性能回退是真实存在的**。

#### B. 因为决策漂移而多做了活

代表素材：

- `DJI_20260217052235_0070_D.MP4`

这条在 baseline 中：

- 做完 coarse + decision 后直接 `skip fine`
- 没有额外 fine keyframes
- 没有额外 fine VLM
- 没有新增 slices

而在 candidate 中：

- 被改判成 `windowed fine-scan`
- 多出 `2` 个 fine keyframes
- 多出 `1` 次 fine VLM
- 最终新增 `1` 个 slice

这类回退不只是“模型慢”，而是**模型让流水线多跑了一段额外分支**。

#### C. 看上去更快，但其实是少做了有价值的工作

代表素材：

- `DJI_20260217042948_0023_D.MP4`

这条在 baseline 中：

- 保留了 `interestingWindows`
- 做了 `windowed fine-scan`
- 抽了 `5` 个 fine keyframes
- 发了 `2` 次 fine VLM
- 最终追加 `2` 个 slices

candidate 则：

- 直接退化成 `skip`
- 0 次 fine VLM
- 0 个 fine keyframes
- 0 个新增 slices

所以它的耗时下降并不代表质量更好，而是代表**决策层把本来应该保留的编辑价值删掉了**。

### 6.3 明显更贵的素材

| 文件 | baseline | candidate | 变化 | 主要原因 |
| --- | ---: | ---: | ---: | --- |
| `0001-2.jpg` | `4.4s` | `12.8s` | `+191%` | 纯 VLM 回退，且输出质量更差 |
| `DJI_20260217052235_0070_D.MP4` | `25.5s` | `54.9s` | `+115%` | 细扫决策漂移，导致多走一段 fine-scan |
| `DJI_20260217143122_0268_D.MP4` | `37.5s` | `58.5s` | `+55.9%` | 同路径下 coarse / decision / fine-scan VLM 都更慢 |
| `C1501.MP4` | `68.3s` | `80.1s` | `+17.2%` | 路径相同，但 candidate 把细扫策略变得更重 |

### 6.4 看上去更快，但其实是工作退化的素材

`DJI_20260217042948_0023_D.MP4`：

- baseline 约 `52.2s`
- candidate 约 `47.8s`

这条表面上更快，但原因是：

- baseline 做了 `windowed fine-scan`
- candidate 直接退化成 `skip`
- baseline 新增 `2` 个 slices，candidate 为 `0`

所以它不是“更优”，而是“少干了活”。

## 7. 对性能热点的实际启示

这轮结果可以回答一个很实际的问题：**下一步到底该优化哪里。**

答案是：

### 7.1 第一优先级：VLM

优先级应继续放在：

- 降低 `coarse + decision + fine-scan` 的 VLM 调用总成本
- 优先优化 `VLM request multiplicity`
- 其次再看单次 VLM latency

原因：

- baseline 下，VLM 与 `ffmpeg` 已是同量级热点
- candidate 下，VLM 明显成为压倒性热点
- 本轮换模型没有带来质量收益，说明“直接换一个 MLX 模型”不是当前正确方向

### 7.2 第二优先级：`ffmpeg scene detect`

即使不换模型，`sceneDetectMs` 仍稳定在约 `63s`。

这说明：

- `scene detect` 是当前最稳定的非 ML 热点
- 即便未来 VLM 降下来，它仍会继续占住较大比例

### 7.3 当前不应优先投入的方向

本轮数据不支持优先去做：

- GPS 链路优化
- ASR 优化
- 进度写盘或普通 I/O 优化
- 继续投入 `Qwen3_5-4B-MLX-8bit` 的替换验证

它们都不是本轮的主要问题来源。

## 8. 最终判断

从“质量优先，且成本不能明显上升”的标准看：

- `Qwen3-VL-4B-Instruct-8bit` 继续保留
- `Qwen3_5-4B-MLX-8bit` 暂不进入默认链路

原因可以压缩成一句话：

> `Qwen3_5-4B-MLX-8bit` 在本轮 Mac MLX 实测中，既没有给出稳定更好的 Analyze 质量，又把最贵的 VLM 热点进一步放大，因此不具备替换价值。

## 9. 后续建议

建议后续工作直接转向下面两条：

1. 拆解 `coarse / decision / fine-scan` 的 VLM 调用乘数，确认哪些请求可以合并、复用或少调
2. 针对 `ffmpeg scene detect` 评估是否能降采样、换阈值策略，或避免对某些素材类型做完整 pass
