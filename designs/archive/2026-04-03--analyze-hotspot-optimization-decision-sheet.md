# Kairos - Analyze 热点优化决策单

> 这不是一份直接拍板的实施方案，而是一份供你做决策的“选项说明书”。
> 它的主视角只看 **baseline**，先回答当前默认 Analyze 流水线里，到底是哪些阶段、哪些资产在烧时间；A/B 对照只作为风险和例子的辅助材料。
> 文档中每个选项后面都留了空白栏位，方便你自己决定是否进入下一轮实验。

## 1. 这份文档怎么用

建议这样看：

1. 先只看 baseline 的阶段占比和资产例子
2. 再看每个优化项会打到哪个阶段
3. 重点判断这个优化项是否会改变 `shouldFineScan / fineScanMode / slice recall`
4. 最后在每个选项下填写你自己的决策

这份文档故意把“我建议什么”压低，把“你需要决定什么”放高。

## 2. 当前 baseline 事实

### 2.1 端到端阶段占比

当前 baseline 即默认 `Qwen3-VL-4B-Instruct-8bit` 路径，单轮 Analyze 的阶段分布如下：

| 阶段 | 耗时 | 占整条 pipeline 比例 | 解释 |
| --- | ---: | ---: | --- |
| `prepare` | `114.5s` | `60.9%` | 素材准备主阶段，内部混合了 `scene detect + coarse keyframes + coarse VLM` |
| `finalize` | `37.0s` | `19.7%` | 以 `decision VLM` 为主，也会命中 ASR |
| `fineScan` | `36.4s` | `19.4%` | 重点内容细扫，内部是 `fine keyframes + fine VLM` |
| `chronologyRefresh` | `11ms` | 近似 `0%` | 收尾型写盘，不是热点 |

这说明当前第一层问题不是“零散的小地方慢”，而是：

- `prepare` 已经占掉了整条链路的六成
- `finalize + fineScan` 加起来又是接近四成
- 所以优化不能只看一个函数，而必须按阶段看

### 2.2 子系统占比

如果把阶段再拆到底层子系统，当前 baseline 是这个结构：

| 子系统 | 耗时 | 占比 | 备注 |
| --- | ---: | ---: | --- |
| VLM 总计 | `91.1s` | `48.5%` | coarse / decision / fine-scan 三段累计 |
| `ffmpeg` 总计 | `91.6s` | `48.7%` | `scene detect + keyframe extract` |
| ASR 总计 | `4.9s` | `2.6%` | 只命中两条 talking-head 视频 |
| I/O 总计 | `30ms` | 近似 `0%` | progress / report / slice / chronology 写盘 |

这组数字非常关键，因为它说明：

- 当前 **不是只有 VLM 热**
- baseline 下，`VLM` 和 `ffmpeg` 基本对半
- 所以如果只盯模型，哪怕优化成功，也有很大概率被 `ffmpeg` 固定税吞掉一半收益

### 2.3 当前样本里最值得盯的 baseline 资产

按资产总耗时看，当前 baseline 的前几名是：

| 文件 | baseline 总耗时 | 主要热点 |
| --- | ---: | --- |
| `C1501.MP4` | `68.3s` | `scene detect 33.9s`、`coarse VLM 12.6s`、`decision VLM 9.0s` |
| `DJI_20260217042948_0023_D.MP4` | `52.2s` | `scene detect 15.6s`、`fine VLM 12.1s`、`fineScan 18.7s` |
| `DJI_20260217143122_0268_D.MP4` | `37.5s` | `decision VLM 8.3s`、`fine VLM 5.6s`、`scene detect 5.8s` |
| `DJI_20260217052235_0070_D.MP4` | `25.5s` | `scene detect 8.2s`、`coarse VLM 6.4s`、`decision VLM 7.4s` |
| `0001-2.jpg` | `4.4s` | 基本全是 coarse VLM |

这几条素材分别代表了几种不同问题：

- `C1501.MP4`: 典型静态 talking-head，但 `scene detect` 很贵
- `DJI_20260217042948_0023_D.MP4`: drive 素材，fine-scan 成本明显被放大
- `DJI_20260217143122_0268_D.MP4`: 有 ASR，但主要热点仍然是 VLM
- `DJI_20260217052235_0070_D.MP4`: 纯航拍，coarse + decision VLM 已经不便宜
- `0001-2.jpg`: 极简路径，说明 photo 本身不是重点战场

### 2.4 当前 baseline 里最该警惕的信号

下面这几个信号值得直接写进决策文档里，因为它们决定了优化方向：

1. `scene detect` 四次一共花了 `63.6s`
2. 这四条视频在当前 profile 里 `shotCount` 全是 `0`
3. baseline 一共发了 `13` 次 VLM 请求，看了 `34` 张图
4. 一条素材并不是“只过一次模型”，而是可能经历 `coarse -> decision -> fine-scan`
5. ASR 和 I/O 当前不是主要问题

这意味着：

- `ffmpeg` 里至少有一段可能是“高成本固定税”
- VLM 的问题也不只是“单次贵”，还有“次数被结构放大”

## 3. 决策原则

在真正挑优化项之前，先把几个原则钉住，不然后面很容易只看速度，不看素材保真。

### 3.1 先保护“素材召回”，再谈省时

对 Kairos 来说，最危险的不是摘要略微变差，而是：

- 本来应该进入 fine-scan 的素材被错误 `skip`
- 本来应该产生的 slices 没了
- `drive / talking-head / aerial` 的分支被改错，导致后续时间线可用性下降

所以后续所有优化都应优先保护：

- `shouldFineScan`
- `fineScanMode`
- `interestingWindows`
- `slice` 召回

### 3.2 先做“只改执行方式”的优化，再做“改决策逻辑”的优化

从风险上看，大体可以分三层：

- 低风险：不改语义，只改执行成本
- 中风险：只在高置信素材上减少一次判断
- 高风险：直接减少判断步骤或缩减搜索空间

一个简单原则是：

- 先吃低风险的工程优化
- 再做 shadow mode 的中风险决策优化
- 高风险选项不要直接上线

### 3.3 所有会影响分支决策的优化，都应该先 shadow mode

所谓 shadow mode，就是：

- 旧逻辑继续生效
- 新逻辑同时运行，但只记录结果，不真正控制流程
- 统计两者分歧率和 slice 召回差异

这样做的原因很简单：

- 只看 wall time，容易把“少干了活”误当成“优化成功”
- `DJI_20260217042948_0023_D.MP4` 这种案例已经说明了这个风险

## 4. 选项总表

先给你一个总览，后面每项再展开。

| 编号 | 方向 | 主要打击阶段 | 预期收益 | 误判风险 | baseline 例子 | 你的决定 |
| --- | --- | --- | --- | --- | --- | --- |
| `F1` | 多时间点单次抽帧 | `prepare / fineScan` | 中 | 低 | `DJI_20260217042948_0023_D.MP4` | `____` |
| `F2` | scene detect 结果/抽帧结果缓存 | `prepare` | 中 | 低 | 重复跑同一 project / A/B | `____` |
| `F3` | 对高置信 talking-head 做 scene detect gating | `prepare` | 高 | 中高 | `C1501.MP4`、`DJI_20260217143122_0268_D.MP4` | `____` |
| `V1` | 高置信素材跳过第二次 decision VLM | `finalize` | 高 | 中高 | `DJI_20260217052235_0070_D.MP4` | `____` |
| `V2` | 合并相邻 fine-scan groups | `fineScan` | 中 | 中 | `DJI_20260217042948_0023_D.MP4` | `____` |
| `V3` | 每资产 fine-scan 预算上限 | `fineScan` | 中高 | 高 | drive / long clip | `____` |
| `P1` | 跨资产并行 CPU `ffmpeg` 与 VLM | 全链路 wall time | 中 | 低中 | 多资产批处理 | `____` |

## 5. 详细选项

### `F1` 多时间点单次抽帧

#### 背景

当前 `extractKeyframes()` 的问题不是“每次很慢到不可接受”，而是：

- 它会被 coarse 和 fine-scan 两边一起调用
- 时间点一多，就容易产生很多次 `ffmpeg` 子进程
- 这些子进程的固定启动成本会叠加

baseline 里：

- `keyframeExtractMs = 28.0s`
- `keyframeExtractCallCount = 7`
- 单次均值大约 `4.0s`

#### 优化思路

把“按时间点逐次起 `ffmpeg`”改成：

- 一次 `ffmpeg` 处理多个目标时间点
- 或者至少按 asset / 窗口批量化

#### 为什么值得考虑

它属于典型的低风险执行优化：

- 不改语义
- 不改 `shouldFineScan`
- 不改 `fineScanMode`
- 不改任何 VLM 判断

只是在保持同样抽帧点的前提下，减少进程开销和重复解码。

#### baseline 例子

`DJI_20260217042948_0023_D.MP4`：

- fine-scan 抽了 `5` 个 fine keyframes
- 这条素材的 `fineScanMs = 18.7s`
- 其中 `fineKeyframeExtractMs = 6.6s`

这类素材很适合作为验证对象，因为它细扫窗口多、抽帧点多，能更容易看出批量抽帧的收益。

#### 预期收益

- 对 `fineScan` 有中等收益
- 对 `prepare` 有一定收益
- 对端到端 wall time 有稳定正收益

#### 风险

低。

如果实现正确，它不会改变内容判断，只会改变执行方式。

#### 建议实验方式

- 先只改抽帧实现，不改任何抽帧点
- 同一组 asset 跑前后 profile
- 重点比较：
  - `keyframeExtractMs`
  - `prepareMs`
  - `fineScanMs`
  - 输出 keyframes 数是否一致

#### 你的决策

- 是否进入下一轮实验：`是`
- 先在哪类素材上试：`你决定`
- 是否允许直接实现，不走 shadow：`看起来没有风险，允许`
- 验收指标：`素材结果不变，性能提升`

### `F2` scene detect / 抽帧结果缓存

#### 背景

这轮 A/B 里，其实对同一组素材重复跑了两轮 analyze。

这类场景会暴露出一个事实：

- 很多 `ffmpeg` 成本并不是“单次正式出片不可避免”
- 而是“重复实验、重复回归、重复调参时的固定税”

#### 优化思路

缓存这些中间产物：

- `scene detect` 结果
- coarse keyframes
- fine-scan keyframes

只要以下条件不变，就直接复用：

- 源素材没变
- 相关参数没变
- 算法版本没变

#### 为什么值得考虑

它对“真实首跑”帮助有限，但对以下场景非常有价值：

- A/B 评估
- 调 prompt
- 调 fine-scan 规则
- 调时间线策略

#### baseline 例子

当前评估本身就是一个例子：

- baseline 跑一次
- candidate 再跑一次
- 对 `ffmpeg` 来说，大量输入素材其实没变

如果这些产物可缓存，就能把很多重复成本压掉。

#### 预期收益

- 对重复实验收益中到高
- 对单次首跑收益低

#### 风险

低，但要小心缓存命中条件。

如果缓存键设计不严谨，会出现：

- 旧规则的结果被新规则误复用
- 造成“看起来跑得快，但结果其实是脏的”

#### 建议实验方式

- 先只对 `scene detect` 和 coarse keyframes 做缓存
- 把算法版本、参数、源文件 mtime 都写进 cache key
- 先在内部评估链路使用，不直接混进正式用户链路

#### 你的决策

对正式项目没有必要，但可能影响A/B结论，不做。

### `F3` 对高置信 talking-head 做 scene detect gating

#### 背景

当前 baseline 里最醒目的一个信号是：

- `sceneDetectMs = 63.6s`
- `sceneDetectCallCount = 4`
- 当前样本里这 4 条视频的 `shotCount` 都是 `0`

这并不自动意味着 scene detect 没价值，但至少说明：

- 在这组素材上，scene detect 的产出非常有限
- 它很可能是一个高成本固定税

#### 优化思路

对明显的高置信静态素材，不跑完整 scene detect。

比如同时满足：

- 语音覆盖很高
- 构图稳定
- 粗扫多帧一致
- root 类型明显偏 `talking-head / vlog speech`

则直接走固定间隔采样或简化采样，不跑完整 `detectShots()`

#### baseline 例子

`C1501.MP4`：

- `sceneDetectMs = 33.9s`
- `coarseKeyframeCount = 3`
- `shotCount = 0`
- 强语音，静态人物画面

`DJI_20260217143122_0268_D.MP4`：

- `sceneDetectMs = 5.8s`
- `shotCount = 0`
- 同样是高 speech coverage 的 talking-head 倾向

这两条都很像“scene detect 花了钱，但没有带来镜头切分收益”的例子。

#### 预期收益

对 `prepare` 可能有高收益。

#### 风险

中高。

最大风险不是摘要文案，而是：

- 你以为它是稳定 talking-head
- 实际上里面夹了 cutaway、动作变化、插图、镜头切换
- 结果 scene detect 被跳过，后面细扫窗口信息变差

#### 建议实验方式

不要直接上线，先 shadow mode：

- 旧逻辑照常跑 scene detect
- 新逻辑只记录“如果跳过会怎样”
- 统计 `slice` 是否减少、窗口是否漂移

#### 你的决策

或许我们可以让这个流程更优化一些：
1. 对于`talking-head / vlog speech`，先按照音频分析确定窗口
2. 按照音频窗口进行视觉分析
3. 如果相邻窗口间时间间隔较大，再补上视觉分析，看是否有转场

### `V1` 高置信素材跳过第二次 decision VLM

#### 背景

当前 baseline 的 `finalize` 基本就是第二次 VLM 判断的成本：

- `finalizeMs = 37.0s`
- 其中 `decisionVlm = 32.2s`

这意味着：

- 很多素材在 coarse 已经做过一次 VLM
- finalize 又再做一次 decision VLM
- 这很可能是结构性重复

#### 优化思路

只对高置信素材，减少第二次 VLM：

- coarse 结果很稳定
- 多帧语义一致
- ASR 或 root hint 没有冲突
- clip type 已经很明显

则允许直接进入后续决策，不再补第二次 decision VLM。

#### baseline 例子

`DJI_20260217052235_0070_D.MP4`：

- `coarseRoundTripMs = 6.4s`
- `decisionRoundTripMs = 7.4s`
- baseline 最终还是 `skip fine-scan`

这类纯航拍素材很像“coarse 已经足够明确”的候选。

但这里必须强调风险例子：

- candidate 版本在这条素材上，把 baseline 的 `skip` 漂移成了 `windowed`
- 说明这类判断并没有想象中那么稳定

所以这个选项值得做，但不能草率。

#### 预期收益

对 `finalize` 有高收益。

#### 风险

中高。

如果错了，后果不是“描述略差”，而是：

- `fineScanMode` 漂移
- `slice` 召回变差
- 某些素材被错误 `skip`

#### 建议实验方式

先挑非常保守的命中条件：

- talking-head + 高 speech coverage + coarse 多帧高度一致
- 或纯 aerial + 无语音 + coarse 明确一致

且只做 shadow mode。

#### 你的决策

- 是否进入 shadow mode 实验：`允许`
- 只允许命中的高置信条件：`纯 aerial + 无语音 + coarse 明确一致`
- 明确不能命中的条件：`无`
- 验收指标：`素材分析一致，性能有优化`

### `V2` 合并相邻 fine-scan groups

#### 背景

fine-scan 的成本不是只由单次 VLM 决定，还取决于：

- 有几个 group
- 每个 group 要不要单独发一次 VLM

如果相邻 group 其实语义差不多，串行逐组发请求就会形成放大。

#### 优化思路

在不丢失窗口召回的前提下，把相邻或高度相似的 fine-scan groups 合并：

- 减少 fine VLM 请求数
- 减少相邻窗口重复抽帧

#### baseline 例子

`DJI_20260217042948_0023_D.MP4`：

- `fineRequestCount = 2`
- `fineRoundTripMs = 12.1s`
- `fineKeyframeCount = 5`
- 最终产出 `2` 个 slices

这条素材适合做 group merge 实验，因为它确实有多个 fine-scan 请求。

#### 预期收益

对 `fineScan` 有中等收益。

#### 风险

中。

风险不是像硬 budget 那样“直接砍掉窗口”，而是：

- 合并后窗口太粗
- 细节丢失
- 一个 group 里混进了两个不同语义片段

#### 建议实验方式

- 先只允许合并时间相邻且 coarse 标签相近的 group
- 不要直接把 group 数压到 1
- 先看 fine VLM 请求数是否下降，再看 `slice` 召回是否持平

#### 你的决策

不做，看起来太激进了，因为窗口的生成在视频光流分析就做过了。

### `V3` 每资产 fine-scan 预算上限

#### 背景

从工程角度看，这是一个很自然的想法：

- 每条 asset 最多只允许 N 次 fine VLM
- 超过就截断

它的收益通常比较直接，因为 fine-scan 是最容易被窗口数量放大的地方。

#### baseline 例子

`DJI_20260217042948_0023_D.MP4`：

- `fineRequestCount = 2`
- `fineScanMs = 18.7s`
- `appendedSliceCount = 2`

如果强行把这条 asset 的 fine budget 压到 1，很可能立刻省时。

但问题也同样直接：

- 这 `2` 个 fine 请求也许恰恰都是真有价值的

#### 预期收益

对 `fineScan` 有中高收益。

#### 风险

高。

这是非常典型的“省时最直接，误伤也最直接”的方案。

最容易出现的问题是：

- 把后半段有价值窗口裁掉
- 让 drive / long clip 的素材召回明显下降

#### 建议实验方式

如果要试，也只能 shadow mode：

- 不直接真截断
- 只模拟“如果 budget=1 会少掉什么”
- 重点看少掉的 slices 是否真的低价值

#### 你的决策

不做，对于一个剪辑软件，素材误判是不可接受的。

### `P1` 跨资产并行 CPU `ffmpeg` 与 VLM

#### 背景

当前链路大体上是串行的：

- 先处理这个 asset 的 `ffmpeg`
- 再等 VLM
- 再进下一个 asset

但从资源类型看：

- `ffmpeg` 更偏 CPU / decode / IO
- MLX VLM 更偏 GPU / 设备推理

理论上，这两者可能存在一定的重叠空间。

#### 优化思路

对不同 asset 做受控并行：

- 当前 asset 在跑 VLM 时
- 后一个 asset 先在 CPU 上跑 `scene detect` 或抽帧

#### 为什么值得考虑

它的特点是：

- 不改判断逻辑
- 不改输出
- 主要优化 wall time

#### baseline 例子

当前 baseline 中：

- `VLM` 与 `ffmpeg` 都在 `90s` 左右
- 这意味着如果能安全 overlap，一部分 wall time 理论上可以压缩

#### 风险

低中。

它不太会带来误判，但会带来工程层面的风险：

- MPS / CPU 争抢
- 磁盘和视频解码并发抖动
- 机器温度和能耗上升

#### 建议实验方式

- 先只允许 `1 个 VLM + 1 个 ffmpeg` overlap
- 不要直接多并发
- 先在同一组素材上比较 wall time 是否下降，且输出是否完全一致

#### 你的决策

工程上比较复杂的优化，下一步再说吧。

## 6. 当前不建议优先做的事

以下方向当前不建议排在前面：

### 6.1 先碰 ASR

原因：

- baseline 中 ASR 只有 `4.9s`
- 占比只有 `2.6%`
- 即使优化成功，端到端收益也有限

### 6.2 先碰 I/O / chronology

原因：

- progress / report / slice / chronology 合计只有几十毫秒
- 基本不可能是当前瓶颈

### 6.3 直接上高风险 hard cut

比如：

- 全局砍掉 scene detect
- 全局压缩 fine-scan 次数
- 一刀切减少 decision VLM

这类方案理论收益高，但最容易把“少干了活”误当成“优化成功”。

## 7. 我建议你重点做的决策，不是拍板优化本身

如果把“你现在最应该决定什么”压缩成几个问题，我会写成：

1. 你是否愿意先只做低风险工程优化？
2. 你是否接受任何会影响 `fineScanMode` 的优化必须先 shadow mode？
3. 你对 `slice` 召回的容忍底线是什么？
4. 你更在意首跑速度，还是重复实验速度？
5. 你是否愿意先做 `ffmpeg` 执行优化，再动 VLM 决策逻辑？

## 8. 待你填写

别搞这么麻烦了，直接按照我上面的评估开干吧。

## 9. 结尾提示

如果你暂时不想立刻选太多项，一个很稳的选择组合通常是：

- 先从 `F1` 或 `F2` 这种低风险工程项里选一个
- 再从 `F3 / V1 / V2 / V3` 里挑一个只做 shadow mode

这样既能尽快开始省时，也不会太早把误判风险直接引进正式链路。
