# 2026-04-05 — Analyze 细扫抽帧解耦与流水线并行

> 本文档记录 2026-04-05 关于 Analyze 细扫执行层优化的一轮设计收敛。
> 它描述的是候选执行方案，不是当前已实现事实。
>
> 当前口径：
>
> - 这是讨论纪要 + 候选方案
> - 不是 ADR
> - 不直接改写主文档中的“当前实现”
> - 这份文档只讨论执行层优化，不讨论 clip type / fine-scan policy 的语义改造

## 背景

这轮讨论聚焦的是一个更适合先落地的方向：

- 当前 fine-scan 的主要瓶颈之一，不只是 VLM 本身
- 还包括细扫抽帧与识别阶段的串行执行方式
- 与其先碰窗口语义和判定逻辑，不如先把执行层拆开

因此这份方案的目标不是：

- 改 `shouldFineScan`
- 改 `fineScanMode`
- 改 `interestingWindows`
- 改 `clipType`

而是：

- 把 fine-scan 抽帧从当前单素材串行链路中拆出来
- 改成素材级别的受控并行
- 让 `ffmpeg` 与 `VLM` 能形成流水线重叠
- 在不改语义结果的前提下压缩 wall time

## 当前执行形态的问题定义

当前 fine-scan 的执行形态大致是：

1. 对某条素材生成 `effectiveSlices`
2. 基于 slices 生成 keyframe plans
3. 汇总这条素材所有 fine-scan timestamps
4. 对这条素材做一次 `extractKeyframes(...)`
5. 对抽出的帧按 slice / shot 分组
6. 串行调用 `recognizeShotGroups(...)`
7. 进入下一条素材

这条链路的几个特点是：

- 同一素材内部，fine-scan 抽帧已经是“按素材汇总 timestamps 后统一抽一次”
- 但不同素材之间，抽帧和识别仍然基本串行
- `recognizeShotGroups(...)` 当前仍是逐 group 串行 VLM
- 当前没有把“下一条素材的抽帧”前置到“上一条素材的 VLM”期间

因此它的瓶颈不是：

- “单窗口重复起很多次 `ffmpeg`”

而更像是：

- “素材 A 抽帧完了才开始素材 A 的 VLM，素材 A 全部结束后才轮到素材 B”

这会带来两个直接问题：

1. CPU / 解码 / 磁盘侧的 `ffmpeg` 无法和 GPU 侧的 VLM 形成稳定重叠
2. fine-scan 阶段的 wall time 会显著受串行调度放大

## 本轮结论

### 1. 抽帧要从 fine-scan 识别链路中解耦

本轮确认：

- fine-scan 抽帧应从“生成 slices 后立刻同步执行”的位置上拆出来

更准确地说，后续应该把 fine-scan 拆成两个子阶段：

1. `fine-scan-frame-prefetch`
   - 只负责准备 fine-scan 所需关键帧
2. `fine-scan-recognition`
   - 只负责消费已准备好的关键帧并跑 VLM

也就是说，`buildFineScanSlices(...)` 不应再独占“规划 + 抽帧 + 识别”整条重链。

### 2. 并行单位是素材，不是窗口

本轮明确不采用：

- 窗口级调度
- 每个 window 单独进入一个并行 worker

而采用：

- 素材级调度

也就是：

- 一条素材的 fine-scan 抽帧计划，仍然先在素材内部汇总全部 timestamps
- 调度器并行管理的是“多条素材的抽帧任务”
- 不是“同一素材里很多窗口任务”

这条约束的理由很明确：

- 当前语义窗口已经形成，不需要再回退成窗口级并行
- 窗口级并行会放大调度复杂度和中间产物数量
- 素材级任务更适合 checkpoint / resume / 进度展示

### 3. 并行优化只先落在 `ffmpeg` 侧，不默认并发多个 VLM

本轮确认：

- 这条方案首先优化的是 `ffmpeg` 抽帧并行
- 不默认把多个 fine-scan VLM 请求并发打到同一张卡上

更稳的口径是：

- 同时允许 `1x VLM` worker 持续消费
- 允许 `N x ffmpeg` prefetch worker 在旁边准备后续素材关键帧

因此这里所谓“FFmpeg 和 VLM 的并行化”，默认理解为：

- 执行阶段重叠
- 形成流水线

而不是：

- 默认开很多并发 VLM 请求

## 重构目标

### 目标 1. 把 fine-scan 变成可流水线化的两段

目标链路应更接近：

1. 先选出要 fine-scan 的素材
2. 为每条素材生成 fine-scan frame plan
3. 由独立 prefetch 队列统一准备关键帧
4. VLM worker 从“已抽完帧”的素材队列中取任务继续识别
5. 识别结果回填 slices / report

即：

- `plan -> prefetch -> recognize -> persist`

而不是当前更接近：

- `plan + prefetch + recognize + persist` 全部糊在单素材同步函数里

### 目标 2. 抽帧并行度由内存动态控制

本轮确认抽帧并行度不能写死，而应由运行时内存预算动态决定。

这里的“内存”默认指：

- 主机可用内存
- 当前抽帧阶段持有的待消费 frame 数量
- 当前已落盘但尚未被 VLM 消费的 frame cache 体积

不应仅靠：

- CPU 核数
- 固定 `N=4` / `N=8` 这种静态并发值

更稳的口径应是：

- 设置一个保守的 base concurrency
- 运行时根据 host memory / frame cache 占用动态升降
- 当已抽帧缓存积压过高时主动降速或暂停 prefetch

### 目标 3. `ffmpeg` 与 VLM 必须形成稳定重叠

本轮确认，这条方案真正的吞吐收益主要来自：

- `ffmpeg` 在为“下一条素材”准备帧
- 同时 GPU 正在为“当前素材”做 fine-scan VLM

因此实现目标不是：

- 单独把 `ffmpeg` 做快一点

而是：

- 让 `ffmpeg` 和 VLM 处于不同 stage，并长期处于重叠状态

如果仍然是：

- 先等抽帧全部完成
- 再开始 VLM

那么这条方案的收益会被大幅吃掉。

## 建议的新执行结构

### 1. fine-scan plan 阶段

先基于既有 `interestingWindows / shotBoundaries / fineScanMode` 生成：

- `effectiveSlices`
- 每条素材的 fine-scan timestamps
- 预期输出目录
- 所需 frame manifest

这一阶段只做 planning，不执行 `ffmpeg`。

输出应是素材级 manifest，例如：

- `assetId`
- `localPath`
- `timestampsMs`
- `expectedFramePaths`
- `sliceIds`
- `priority`

### 2. frame prefetch 队列

新增一个独立的 fine-scan frame prefetch worker：

- 输入是素材级 manifest
- 输出是“该素材需要的 fine-scan frames 已准备完成”

这条队列的职责只有：

- 执行 `ffmpeg`
- 校验 frame 是否落盘
- 写回 `frames-ready` checkpoint

它不负责：

- 调 VLM
- 写最终 slices
- 改 fine-scan 语义

### 3. recognition 队列

新增一个独立 recognition worker：

- 只消费 `frames-ready` 的素材
- 从 manifest 中恢复分组关系
- 继续调用 VLM 识别
- 落最终 slices / report

默认口径：

- recognition 队列保持单 GPU worker 或极低并发
- 不把它设计成“窗口级海量并发器”

### 4. prefetch 与 recognition 流水线

两条队列之间形成：

- `prefetching`
- `frames-ready`
- `recognizing`
- `recognized`

这样可以稳定做到：

- 素材 A 在 `recognizing`
- 同时素材 B / C 在 `prefetching`

## 动态内存预算

### 1. 为什么要按内存动态控制

抽帧侧真正的风险不是语义错误，而是资源失控：

- 一次并发过多素材，导致内存被大量 frame buffer 和缓存目录占满
- `ffmpeg` 进程过多，反而把磁盘和解码拖慢
- 已抽好的关键帧积压过多，还没来得及被 VLM 消费

因此本轮确认：

- prefetch 队列必须有动态背压

### 2. 建议的预算维度

推荐至少同时看三类量：

1. `hostAvailableMemoryBytes`
2. `prefetchedFrameBytes`
3. `readyAssetCount`

运行时决策不应该只看单一指标。

更稳的策略是：

- 当 `hostAvailableMemoryBytes` 低于阈值时，降低 prefetch 并行度
- 当 `prefetchedFrameBytes` 超过安全阈值时，暂停新增抽帧
- 当 `readyAssetCount` 已经积压到上限时，停止继续预取

### 3. 并行度不是无限开

本轮明确不追求：

- 只要机器还能跑，就无限制多开 `ffmpeg`

而应采用：

- 保守 base concurrency
- 动态上调
- 更保守的下调与暂停

也就是说，调度器应优先保护：

- 系统稳定性
- 当前 analyze run 的可持续性

而不是一味追求峰值并发数。

## 与 VLM 的关系

### 1. 默认不做窗口级 VLM 并发

这轮确认不把重点放在：

- fine-scan 每个 group / window 的 VLM 并发

原因包括：

- 当前 GPU 主路径更适合稳定串行消费
- 多 VLM 并发更容易引入显存竞争和吞吐抖动
- 这条方案要先吃的是流水线重叠收益，而不是 GPU 侧过度并发

因此初版建议是：

- `1x recognition worker`
- `N x prefetch workers`

### 2. VLM 只负责消费已准备好的素材

VLM 识别端不再等待：

- 临时抽帧
- 实时 frame 发现

而是只处理：

- “frames-ready” 的素材

这样做的收益是：

- VLM worker 负载更平滑
- 可观测性更清楚
- 抽帧异常和识别异常边界更清楚

## checkpoint 与恢复

### 1. 需要新增 fine-scan 执行态 checkpoint

如果实施本方案，fine-scan 至少应补出这些素材级状态：

- `fine-scan-pending`
- `frame-plan-ready`
- `prefetching`
- `frames-ready`
- `recognizing`
- `recognized`
- `persisted`

这组状态的目标是让中断恢复时：

- 已抽完帧但未识别的素材，不必重复抽帧
- 已识别完成但未落盘的素材，可以只补写结果
- 仍在 prefetch 的素材，可以安全回退到最近稳定状态

### 2. progress 语义必须仍以素材为主

本轮确认：

- UI / progress 统计仍应以素材为主
- 不要把用户暴露成“当前第 218 个 frame group / 第 901 张关键帧”
- progress 必须持续写盘，不能只存在内存里

因此即使内部新增了 prefetch 队列，外部展示仍应更接近：

- “已为 120 / 637 条待细扫素材准备关键帧”
- “正在识别第 41 / 637 条待细扫素材”

而不是展示过细的中间碎片。

这里的“持续写盘”包含两层要求：

- 细扫执行态要有素材级 checkpoint
- 面向用户的 `progress.json` 也要持续落盘并可在重启后恢复

也就是说，如果 analyze 中断或进程重启，系统至少应能恢复这些信息：

- 已完成多少条待细扫素材的抽帧
- 已完成多少条待细扫素材的识别
- 当前恢复后应从 `prefetch` 还是 `recognition` 继续
- 当前细扫阶段的 `current / total / fileIndex / eta` 应如何重新估算

### 3. 缓存语义要短生命周期

本轮不建议把这条方案直接扩成长期跨 run 的抽帧缓存系统。

初版更适合的口径是：

- 面向当前 analyze run 的临时执行缓存
- 优先解决“同一轮 run 内的抽帧与识别解耦”

至于跨 run 复用，则属于后续可选增强，不应和本轮一起打包。

## 与现有语义层的边界

### 1. 不改 fine-scan 召回逻辑

这份方案明确不改：

- `shouldFineScan`
- `fineScanMode`
- `interestingWindows`
- `drive / talking-head / broll / aerial` 语义约束

也就是说：

- 进入 fine-scan 的素材还是同一批
- 每条素材的 windows 还是同一组
- 只是这些 windows 对应的关键帧准备方式和执行顺序被重构

### 2. 不改每条素材内部的 timestamps 规划

这轮也不改：

- `buildFineScanKeyframePlans(...)`
- `groupKeyframesByShot(...)`

它们仍然决定：

- 该素材要抽哪些时间点
- 后续按什么 grouping 去做识别

变化只在于：

- 执行时机
- 任务调度方式
- 与 VLM 的衔接方式

## UI 同步要求

如果实施本方案，UI / console 也应同步承认 fine-scan 已经被拆成两段。

至少需要能表达：

- 当前有多少待细扫素材处于 `frame-plan-ready`
- 当前有多少素材已经 `frames-ready`
- 当前 VLM 正在识别哪条素材

但这不要求把 UI 变成复杂调度面板。

更合适的展示口径是：

- `fine-scan-prefetch`
- `fine-scan-recognition`

或在细扫主阶段下补 detail 文案，例如：

- “正在为后续细扫预抽关键帧”
- “正在识别已准备好的细扫素材”

## 预期收益

如果实施本方案，预期收益包括：

1. fine-scan wall time 下降
2. CPU/解码侧与 GPU 侧资源利用更均衡
3. `ffmpeg` 不再总是卡在 VLM 前后同步等待
4. 长队列素材在细扫阶段的吞吐更稳定
5. 这条优化可以先于更大规模的 Analyze 语义重构落地

## 已知代价

本轮也接受几个明确代价：

1. fine-scan 执行态会更复杂
2. 需要额外 manifest / checkpoint
3. 需要处理抽帧成功但识别失败的中间状态
4. 调度器需要引入内存背压与缓存清理
5. UI / progress 文案需要同步更新

这些代价被认为是可接受的，因为：

- 它们属于执行层复杂度
- 不直接触碰语义判断
- 更适合作为当前阶段的先行优化项

## 需要避免的误解

### 1. 这不是窗口级并行方案

本轮明确：

- 不把每个 fine-scan window 变成独立调度单元

调度单元仍然是：

- 素材

### 2. 这不是默认多 VLM 并发方案

本轮明确：

- 重点是 `ffmpeg` 与 VLM 的重叠
- 不是先把 GPU 侧并发拉高

### 3. 这不是跨 run 长期缓存方案

初版目标是：

- 当前 run 内的执行解耦与流水线化

不是：

- 先做复杂的长期抽帧缓存系统

## 已确认决议

以下内容在本轮不再视为未决：

1. fine-scan 抽帧要从同步识别链路中解耦，形成独立 `prefetch` 阶段
2. 并行单位是素材，不是窗口
3. fine-scan 优化优先做 `ffmpeg` 侧素材级并行，不默认做多 VLM 并发
4. `ffmpeg` 与 VLM 必须形成流水线重叠，而不是仍然串行排队
5. prefetch 并行度必须按内存与缓存积压动态控制，不能写死固定并发
6. checkpoint / progress 必须新增 fine-scan 执行态，但外部展示仍以素材语义为主
7. 进度必须持久化保存到可恢复的进度文件中，不能只依赖内存态；中断恢复后应继续显示细扫已完成的素材级进度
8. 这条方案默认不改 fine-scan 召回和 clip 语义，可先于更大的 Analyze 语义重构单独落地

## 实现细化

以下只保留实现层细化事项，不再视为方案分支：

1. fine-scan manifest 应显式记录 `assetId / timestampsMs / expectedFramePaths / sliceIds / priority`
2. prefetch worker 应在 `frames-ready` 后尽快释放临时内存占用，只保留必要落盘结果
3. recognition worker 默认保持单 GPU worker 或极低并发，后续如需放宽再单独评审
4. prefetch 队列需要有背压机制，避免“ready 太多但 VLM 消费不过来”的 frame 积压
5. UI 至少要能分辨“预抽帧中”和“识别中”，否则用户无法理解 fine-scan 进度变化
6. `progress.json` 需要补充能反映 fine-scan 两段执行态的字段，并在 resume 后从已落盘状态重建，而不是重置成“从头细扫”

## 建议的下一步

当前更合适的下一步是：

1. 先等当前 analyze run 完成
2. 单独评审这份执行层方案对 checkpoint / temp dir / progress 的影响
3. 确认素材级 prefetch manifest 的落盘位置和生命周期
4. 再进入代码实现

在那之前，不应把本文档内容回写到主文档中，避免把候选执行方案误写成现状。
