---
name: kairos-analyze
description: >-
  Phase 2: Coarse-first media analysis for Kairos editing projects. Builds
  asset-level reports only; spans and chronology are explicit downstream
  /chronology jobs. It automatically decides whether to fine-scan specific
  assets into report windows. Use when analyzing project footage for
  editing preparation. This is separate from style-analysis.
---

# Kairos: Phase 2 — Analyze

这条 skill 负责 **剪辑素材分析**，不是风格分析。

它的目标是：
- 先对全量素材做轻量粗扫
- 落单素材报告 `analysis/asset-reports/<assetId>.json`
- 自动判断哪些素材值得细扫，并把细扫结果写回 report 的 `fineScanWindows[]`
- 在有空间线索时，为 coarse report 挂上 GPS / 地点上下文

当前 v1 的正式 Analyze 语义口径是：
- `Asset Report Truth -> Explicit Span Rebuild -> Chronology Review`
- `Span` 当前只承载素材片段事实索引，不承载 Pharos/GPS/route/speed 决策
- `slice` 仅作为兼容命名继续存在于少量代码和导出字段中
- 素材主键协议是 `materialIdPolicyVersion=human-source-v1`：`assetId` 必须是短 source locator，例如 `C0506_zve1_day1`，fine-scan `windowId` 和最终 `span.id` 必须追加 type / 可选 semanticKind / 整数秒 source range，例如 `C0506_zve1_day1_drive_speech_s0-7`，不得新写随机 UUID 或 `asset__` / `span__` 前缀式 ID

## 变更工作流规则

只要本轮任务涉及需求、行为、接口、工作流、正式入口或用户路径变更，必须遵守下面顺序：

1. 先进入 `Plan` 模式；如果宿主没有显式 `Plan mode`，先给出结构化计划并得到确认。
2. 计划确认后，先更新相关设计文档，再开始实现。
3. 实现完成后，必须回查并同步受影响的设计文档、rules 和 skills，再结束本轮。
4. 如果变更影响正式入口、监控页、工作流主路径或用户操作方式，还要同步更新 `README.md`、`designs/current-solution-summary.md` 和 `designs/architecture.md`。

## 和风格分析的区别

- `kairos-style-analysis`
  - 面向历史作品
  - 抽取“个人风格”
  - 可以走镜头级 `开始/中间/收尾` 三帧

- `kairos-analyze`
  - 面向当前剪辑项目的原始素材
  - 先粗扫，再自动细扫
  - 默认不对所有素材做镜头级重分析

不要把这两条逻辑混在一起。

## 可用入口

```typescript
analyzeWorkspaceProjectMedia(input: {
  workspaceRoot: string;
  projectId: string;
  assetIds?: string[];
  gpxPaths?: string[];
  gpxMatchToleranceMs?: number;
  budget?: 'coarse' | 'standard' | 'deep';
  progressPath?: string;
}): Promise<{
  projectRoot: string;
  analyzedAssetIds: string[];
  fineScannedAssetIds: string[];
  missingRoots: IMediaRoot[];
  reportCount: number;
  sliceCount: number;
  mlUsed: boolean;
}>
```

Analyze 会从 `project-brief` 的主路径与备选路径中解析当前可读素材目录；
不再读取 `device-media-maps.local.json`。
Analyze 不会隐式补跑 `ingest`、`gps-refresh` 或 Pharos parse。如果用户刚在 `/ingest-gps` 修改过素材 Root、FlightRecord、manual-itinerary、root 时钟偏移、capture-time overrides 或项目内 `pharos/`，必须先回到 `/ingest-gps` 显式点击 `运行 Ingest`；如果只修改了 GPX、Pharos 或 manual-itinerary 空间线索，可先点击 `刷新 GPS 缓存`。

`spatial-refresh` 是 no-ML deterministic repair job：先刷新项目 GPX merged cache、`gps/derived.json` 和 `analysis/pharos-context.json`，再只修补已有 `analysis/asset-reports/*.json` 中的 GPS / Pharos / reverse-geocode 空间字段，并标记 spans / chronology stale。它不抽帧、不转写、不跑 VLM、不生成缺失 report，也不自动重建 `store/spans.json` 或 `media/chronology.json`，也不替代 Ingest 发现新的 `.SRT`、FlightRecord、素材 root 或 capture-time 修正。若只是 Pharos context parser 升级补齐 shot 执行语义，可直接重跑 `chronology-build`，不要要求 `span-rebuild`。

## ML 前置条件

- ML server 是 Analyze 的硬前置条件，不可用时必须直接停掉
- 不允许在 ML server 不可用时继续产出“看起来完成了”的 fallback analyze 结果
- 在真正开始粗扫前，应先检查 ML server health；如果不可用，立刻提示用户启动/修复服务后再继续
- 只有用户明确接受“这轮先不做 analyze”时，才可以停在这里；不能擅自降级成无 ML 的 analyze
- 如果 unified `finalize` 返回 invalid JSON，不要先猜是模型坏了还是 prompt 坏了；当前正式做法是先查看 `projects/<projectId>/.tmp/media-analyze/finalize-attempts/<assetId>/attempt-*.json`
- Analyze 当前会自动对 invalid-JSON `finalize` 做增量 token 重试，默认预算序列为 `512 -> 768 -> 1152`
- 若最终仍失败，应优先依据 attempt 文件判断是 token 截断、格式漂移，还是服务端异常，再决定是否改 prompt 或模型参数

## 强规则：Analyze 前必须先做 GPS 提示

在任何一次 Analyze 开始前，agent **必须先向用户明确提示并指导当前项目的 GPS 规则**。这一步是强规则，不能因为用户直接说“analyze / 分析 / 继续”就跳过。

开始 Analyze 之前，至少要明确告诉用户：

- 当前空间优先级是：`embedded GPS > Pharos GPX > 普通 project GPX > project-derived-track > none`
- `manual-itinerary` 不再作为 Analyze 阶段的独立顶层 fallback；它会在 ingest 时被编译进 `gps/derived.json`
- `Pharos` 解析不在 Analyze 阶段临时补跑；它应由 Ingest / GPS 刷新写入最新 `analysis/pharos-context.json`
- `manual-itinerary` 正文不直接修正拍摄时间，但它末尾的“素材时间校正”表格会在 ingest 时作为 `manual` capture time 真值被消费
- 如果项目里没有 `gps/merged.json` / `gps/tracks/*.gpx`，也没有 `gps/derived.json`，那么**没有 embedded GPS 的素材将拿不到空间 fallback**
- 如果用户刚修改过 `config/manual-itinerary.md` 但还没重新跑 ingest，必须明确提醒：当前 `gps/derived.json` 可能还是旧的
- 如果用户手里有 sidecar `.SRT` 或 DJI FlightRecord 日志，必须提醒：这类数据走的是 `embedded GPS` 标准链路，不是普通项目 GPX
- 如果 `config/manual-itinerary.md` 末尾存在未填写完的“素材时间校正”表格，或者用户刚填完还没 rerun ingest，Analyze 必须停下，先让用户刷新 ingest
- 如果 root 级 `captureTimePolicy.mode=manual-required` 生成了“素材时间校正”项，必须确认这些条目已经显式填写 `正确日期 / 正确时间 / 时区` 并 rerun ingest，不能接受自动建议日期替代人工确认
- 不要把 `导入 / GPS Review` 当成第二份 capture-time 输入；Analyze 只看 rerun ingest 后的 `manual` capture time / asset truth，chronology 需要之后在 `/chronology` 显式刷新

在提示规则后，还必须指导用户当前可选动作：

- 导入项目级 GPX
- 在对应素材源的 `project-brief.md` block 里配置 `飞行记录路径`
- 填写 `config/manual-itinerary.md`
  - 默认推荐一句自然语言一段，例如：`2026.02.17，早上九点左右，开车从新西兰皇后镇出发`
  - 只有需要限制到特定素材源或路径前缀时，再补 `素材源:` / `路径:` 这类结构化字段
- `.SRT` 如果和素材同 basename 放在素材旁，ingest 会自动发现，不需要单独导入
- 如果选择填写或修改了 `manual-itinerary`，先重新跑一次 ingest，刷新 `gps/derived.json`
- 如果只需要刷新已有 GPX / Pharos / manual-itinerary 空间缓存，可在 `/ingest-gps` 使用 `刷新 GPS 缓存`；如果已有 Analyze report 也需要同步新空间结果，再到 `/chronology` 触发 `spatial-refresh`，随后重新生成 spans / chronology
- 需要应用素材时间修正或同源 GPS / FlightRecord 绑定时必须跑 `运行 Ingest`
- 如果 ingest 已把待校正素材写进 `manual-itinerary` 末尾表格，必须先让用户填写 `正确日期 / 正确时间 / 时区`，再 rerun ingest
- 或明确接受“部分素材没有空间结果”后继续

只有在用户明确确认继续后，才可以真正调用 `analyzeWorkspaceProjectMedia()`。

## 强规则：Analyze 前必须先过时间线一致性校验

- Analyze 前必须确认当前项目不存在“素材时间和项目时间线明显冲突”的阻塞项
- 这类阻塞项由 ingest 自动写入 `config/manual-itinerary.md` 末尾的“素材时间校正”表格
- 只要表格里还有未填写或尚未重新 ingest 应用的条目，Analyze 就必须直接停掉，不能继续消耗 ML 预算
- agent 必须明确告诉用户：先填写表格，再 rerun ingest，确认 `store/assets.json / gps/derived.json` 已刷新后，才能继续 Analyze；Analyze 完成后再去 `/chronology` 重建 spans / chronology

底层会复用这些工具：

```typescript
resolveAssetLocalPath(...)
detectShots(...)
estimateDensity(...)
buildAnalysisPlan(...)
extractKeyframes(...)
recognizeFrames(...)
sliceVideo(...)
sliceInterestingWindows(...)
buildAssetCoarseReport(...)
rebuildProjectSpans(...)
buildProjectChronology(...)
```

## 空间上下文优先级

Analyze 阶段如果要给素材补空间上下文，来源优先级必须是：

1. `embedded GPS`
2. `Pharos GPX`
3. 普通 `project GPX`
4. `project-derived-track`
5. 无空间结果

规则：

- 如果素材自身已经带有 GPS，优先使用素材同源 GPS 真值
- 对 DJI 视频，优先检查素材同源 GPS：容器/流 metadata、同 basename sidecar `.SRT`、以及 root 级 DJI FlightRecord 日志切片；它们都比外部 GPX 更优先
- 当前内嵌 GPS 解析已覆盖更宽的 QuickTime / EXIF 变体：`location`、`location-eng`、`com.apple.quicktime.location.iso6709`、`com.apple.quicktime.location_iso6709`、`GPSLatitude/GPSLongitude(+Ref)` 以及简单 rational / DMS 风格坐标
- DJI FlightRecord 日志不是普通项目 GPX；它只有在 ingest 时被识别并成功切到某个素材的时间段后，才按 `embedded GPS` 进入主链
- ingest 会把 dense sidecar / FlightRecord 轨迹规范化写到 `gps/same-source/tracks/*.gpx` + `gps/same-source/index.json`；Analyze 看到的仍然是资产上的轻量 `embeddedGps` 引用，不应把这套内部 cache 当成第二优先级 `project GPX`
- 如果没有可用内嵌 GPS，Analyze 会先看已匹配 planned shot 对应的 Pharos trip GPX timed spatial
- Pharos GPX 只来自 `pharos/<trip_id>/gpx/*.gpx` 的按时取点；planned shot 本身的计划/实际 GPS 字段不作为正式坐标真值
- 如果没有可用 Pharos GPX，Analyze 会再看显式传入的普通 `gpxPaths`
- 如果调用方没有显式传入普通 `gpxPaths`，Analyze 默认读取项目内 `gps/merged.json`；若 merged cache 不存在，再回落到 `gps/tracks/*.gpx`
- 如果没有 GPX 命中，Analyze 再读取项目内 `gps/derived.json`，把它作为第四优先级空间层
- `project-derived-track` 当前 v1 只做保守匹配：
  - embedded-derived 条目只允许 sparse nearest-point 命中
  - manual-itinerary-derived 条目只允许 ingest 预编译好的 bounded window / anchor 命中
  - 不做跨 gap 插值
- `manual-itinerary` 不再直接参与 Analyze 匹配；它只能先通过 ingest 编译进 `project-derived-track`
- 如果 `manual-itinerary` 在上次 ingest 之后被修改，先 rerun ingest，再 analyze
- 当存在内嵌 GPS 时，`project-derived-track`、普通项目 GPX 和 Pharos GPX 都不能覆盖它；同名 `.SRT` / DJI FlightRecord 成功绑定后也属于这一层
- 当前代码入口仍允许通过 `gpxPaths` 显式注入 1..N 个 GPX 文件路径，用于覆盖默认发现
- 默认 GPX 命中策略是：从带 `time` 的 `trkpt / rtept / wpt` 中，按 `capturedAt` 选择容差内最近点
- planned `Pharos shot` 的正式语义当前拆成两层：
  - 素材归属只按 `record.json.actual_time` 精确匹配；只有 `expected / unexpected` 且有完整 actual time 的记录可绑定存在有意义时间重叠的素材，多个单点事件时间窗重叠时只按 `record.json.actual_captures[]` 等显式拍摄类型/设备字段调整优先级，仍同分时优先更窄的 actual window，不从描述、地点或 note 推断语义；`pending / abandoned` 和 planned time segment 不参与素材归属；`plan.gps` 或 `actual_gps` 不参与时间归属
  - 空间位置只按 trip GPX 对素材/span 的时间做反算，不再把 shot 自带计划/实际 GPS 当作正式空间真值
- Pharos 协议 hash 与 `.ai/pharos-protocol-baseline.json` 不匹配时，必须先完成协议同步并刷新 baseline；Analyze 不应基于旧协议假设继续解释 Pharos context
- `manual-itinerary` 正文不直接参与拍摄时间修正；真正的时间修正入口是它末尾的“素材时间校正”表格，并且只有 rerun ingest 后才会生效
- 空间推断结果应落在 coarse report，而不是回写素材真值层
- `locationText` 当前正式只允许来自 reverse geocode：
  - provider 选择、cache key、fallback 与 balanced location 规则对齐 `../Nostos/tools/scan-tool/geocode.ts`
  - 中国境内优先 Amap，境外优先 Geoapify
  - 若素材/span 命中了 planned `Pharos shot`，则 `drive` 使用首尾时刻各取一个 trip GPX 点做反查；非 `drive` 使用中间时刻的 trip GPX 点做反查
  - planned shot 命中但对应时刻没有有效 GPX 点时，保留 `pharos ref`，但不产出 `Pharos` 坐标；此时才允许继续回落到正式空间层选中的单点坐标
  - Chronology V2 route/event 地点同样必须来自 GPS reverse geocode：route 按自身 `startAt/endAt` 取端点 GPS，普通非 Pharos event 按 midpoint 取代表 GPS；`chronology-build` 读取 `gps/reverse-geocode-cache.json`，未命中 provider 请求必须串行限速
  - `Pharos continuous.location`、manual-itinerary route prose、trip/day title 与包含 `→ / -> / 全程` 的 route-stage 文本不能写入 chronology `event.location / route.from / route.to`
  - manual-itinerary route prose、trip/day title 与 route-stage 文本只能留在 `summary / decision reasons / routeRole`，不再冒充 `locationText`

## 轻量空间刷新

当用户已经跑过 Analyze，并且只是空间规则、Pharos context、GPX、derived-track 或 reverse-geocode 逻辑变化时，优先使用 `/chronology` 的 `spatial-refresh`，而不是重跑完整 Analyze。

`spatial-refresh` 的正式刷新范围：

- 已有 `analysis/asset-reports/*.json` 的 `gpsSummary / inferredGps / pharosMatches / primaryPharosRef / pharosMatchConfidence / pharosStatus / pharosDayTitle / locationText / placeHints`
- 标记 `store/spans.meta.json` 与 `media/chronology.json` stale，要求用户随后显式运行 `span-rebuild` 与 `chronology-build`

`spatial-refresh` 必须保留原 report 的 ML、ASR、视觉与细扫事实字段，例如 `summary / labels / transcript / transcriptSegments / sampleFrames / interestingWindows / fineScanWindows`。它只刷新空间 / Pharos 派生层，不重建 downstream indexes。

不能使用 `spatial-refresh` 的场景：

- 新增或修改同名 `.SRT`
- 新增或修改 FlightRecord
- 修改素材 root / path mapping
- 修改 root clock offset、capture-time override 或 `captureTimePolicy`
- 缺少正式 Analyze report 的素材

这些情况必须先跑 Ingest，必要时再跑正式 Analyze 或 `spatial-refresh`。

## 默认分析策略

### 1. 视觉粗扫

先做面向全量素材的低成本视觉分析：
- 视频：
  - 均匀少量采样帧
  - `scene detect` 不再作为默认前置；它会在 coarse + audio + finalize decision 之后，只对真正需要 shot 结构的素材延后触发
  - 当前 deferred gate 至少覆盖：
    - `video + fineScanMode === full` 的 hard gate
    - selected `windowed` non-drive 的 fragmented-window soft gate
    - scenic `drive` 复用 finalize unified VLM 语义的单独 soft gate
- 照片：
  - 直接做轻量视觉总结
- 音频：
  - 当前正式项目的主路径不是纯音频资产，而是“视频素材里的音轨”
  - 如果未来项目真的包含独立音频资产，再单独补这条 analyze 分支；不要让它干扰当前主流程理解

这一步的目标是先得到视觉侧的基础判断：
- 这条素材大概是什么
- 是否存在值得深挖的视觉时间窗
- 是否值得进入后续更高成本分析

这里的“基础判断”当前主要来自 cheap metadata / sample timestamps / source context，而不是一轮正式 coarse VLM 结果。视频素材的正式 `visualSummary` 在默认主链里由 `finalize` 统一产出。

### 2. 音频分析（细扫决策前）

对符合条件的视频，在视觉粗扫之后、细扫决策之前补一段音频分析：

- 先对视频内主音轨做轻量音频健康检查
- 提取 `transcript / transcriptSegments / speechCoverage`
- 当前默认 ASR 质量目标是跨平台一致：
  - Apple Silicon 默认 `mlx-whisper / whisper-large-v3-turbo`
  - Windows + CUDA 与 CPU fallback 优先使用完整可用的本地 `faster-whisper / large-v3`（CTranslate2）checkpoint
- 项目 Analyze caller 当前默认固定传 `language='zh'`
- TS 侧会在 refined transcript segmentation 之后统一做 Han 文本简体归一：
  - 只转换 Han 文本为简体中文
  - 规范中文标点与中西文空格
  - 英文、数字和其他脚本保持原样
- 非 MLX 路径不允许在正式 `/asr` 请求里隐式卡住等待远端模型下载：
  - 大模型 cache 完整时直接使用
  - 只有不完整 cache 时，Analyze 必须回退到完整可用的本地 Whisper checkpoint，而不是把音频分析整个挂死
- Apple Silicon / MLX 与 `faster-whisper` 路径当前都会请求词级时间戳
- Analyze 在 TS 侧统一重建 refined `transcriptSegments`：
  - 有 `words` 时按词级停顿、标点与长度约束细分
  - 没有 `words` 时按 segment 文本的标点与长度做保守细分
- 如果资产已绑定 `protectionAudio`，先对 embedded 与 protection 都做轻量音频健康检查，重点观察低电平、静音比例、语音线索偏弱等问题
- 把 ASR 命中的语音时间窗并入 `interestingWindows`
- `interestingWindows` 现在需要区分两层语义：
  - `startMs / endMs` 保留 focus/evidence window
  - `editStartMs / editEndMs` 作为后续 Script/Timeline 默认消费的 edit-friendly bounds
- 但要把“极稀疏语音”当噪声处理：如果 `speechCoverage` 低到只剩零星词片段（当前阈值为 `< 0.05`），应直接丢弃整段 transcript 上下文，不写入 coarse report，也不要让它推动 `interestingWindows` 或 fine-scan
- 不要把“高 coverage 但内容本来就简单/重复”的素材误判为 ASR 故障；那类结果可以保留，只是后续由剪辑策略自己决定值不值得用
- `report.transcriptSegments` 当前应理解为 refined transcript segmentation，而不是直接照搬后端的粗 segment
- `report.transcript`、`report.transcriptSegments`、source-speech spans 与 timeline subtitle 输入当前统一使用简体归一后的文本
- 当前保护音轨策略是保守 fallback，不是双主音轨竞争：
  - 视频内无线 mic 仍是默认主音轨
  - `protectionAudio` 只是同目录同 basename 的 sidecar 兜底来源
  - 现在会先做双健康检查再选边，只对最终被选中的一路跑 ASR
  - `alignment === mismatch` 时强制保留 embedded；protection 只有在健康分数明显更优时才切换
  - 一旦 protection 被选中，它就直接成为正式 `report.transcriptSegments`

这一步默认仍属于 Analyze phase，但不再和“视觉粗扫”混写成同一个子步骤。

### 3. 自动细扫决策

系统根据 coarse inputs + 音频分析 + 可用空间线索的合并信号自动决定：
- `durationMs`
- `densityScore`
- `interestingWindows`
- `clipTypeGuess`
- `speechCoverage`
- `transcriptSegments`
- 预算档位

这里的语音信号默认指视频素材内部抽出的语音线索，而不是独立音频文件批处理。

当前扩窗口径：

- `talking-head / speech-window`：保持更紧的 edit bounds，避免破坏原声链路
- `broll / aerial / timelapse / unknown`：把 focus window 扩成更可剪的 edit bounds
  - `drive`：只给出更宽的 edit bounds；speed 策略不进入 span 生成流程，后续单独设计

输出：
- `shouldFineScan`
- `fineScanMode = skip | windowed | full`

如果 provisional 结果最终需要 shot 结构（当前包括视频 `full` hard gate、selected `windowed` non-drive soft gate，以及 scenic `drive` 的 finalize-semantic soft gate）：

- 再补跑一次 deferred `scene detect`
- 只重算 shot-sensitive 的 planning pieces
- 不重跑 finalize VLM / ASR
- 没命中 gate 的 `windowed / skip` 默认不再支付这笔成本

到这一步之后，才会形成用于后续流程的 coarse-level report。这个 report 可以已经带上 transcript 字段，但概念上它不是“纯视觉粗扫结果”，而是“coarse inputs + audio-analysis + finalize unified VLM”之后的分析结果。

分析结果会写到：

```text
analysis/asset-reports/<assetId>.json
```

当前恢复口径补充：

- coarse prepared state 会写到 `analysis/prepared-assets/<assetId>.json`
- audio state 会写到 `analysis/audio-checkpoints/<assetId>.json`
  - 当前正式口径是 `selectedTranscript / selectedTranscriptSource / embeddedHealth / protectionHealth / protectedAudio / decisionHints`
- speech-boundary 补充分析是 Analyze 语境下的 no-ML repair：读取已有 `store/assets.json + store/spans.json`，对 speech/mixed span 周边音频做轻量包络/阈值分析，每个素材诊断明细写到 `analysis/speech-boundaries/<assetId>.json`；正式下游只消费 `store/spans.json` 中的 `effectiveSpeechStartMs / effectiveSpeechEndMs` 两个 source-ms 字段，不把完整分析结构塞进 span，也不覆盖 `sourceInMs/sourceOutMs`、`editSourceInMs/editSourceOutMs` 或 `transcriptSegments`
- report 里的 `fineScanCompletedAt / fineScanSliceCount` 用来标记 `fine-scan` 是否真正完成
- `analysis/fine-scan-checkpoints/<assetId>.json` 只代表 fine-scan 的 durable 中间态，不代表当前一定存在 live fine-scan worker
- 新启动的 Analyze job 不读取 `progress.json.step` 作为恢复指针，而是重新计算 `pendingAssets` 和 `pendingFineScanEntries`；如果 `pendingAssets=0` 且存在待 fine-scan report，首个 live progress 必须直接写 `fine-scan-prefetch`，避免监控页误显示“从 prepare 重新开始”。
- `retry / resume` 后 ETA 不继承上一轮估算，而是按当前阶段重新估；当前阶段完成数 `< 3` 时，面板不显示 ETA

### 4. report -> spans 派生索引

Analyze 运行过程中和阶段末都不再写 `store/spans.json`；span 由 `/chronology` 的 `span-rebuild` 显式生成：

- `direct`
  - 只写 asset report，span 后续从 report `summary / interestingWindows` 派生；`summary` 必须来自有效 VLM 视觉描述，缺失时 Analyze 失败而不是由 span 重建补猜；`materialPatterns` 只在 span 重建阶段由本地 qwen 文本 LM 从 span 级文本事实生成
- `fine-scan`
  - 只写 report `fineScanWindows[]`；recognized/dropped 都保存，只有 recognized 窗口可派生 span；窗口内不保存 `recognitionRaw` 或 `materialPatterns`
- `skip/drop`
  - 只保留 report，不派生 span

如果 fine-scan report 缺少完整 `fineScanWindows[]`，或 recognized window 缺少 `visualObservation`，新版 span 重建必须失败并提示重新 Analyze/fine-scan；不能用旧 spans、空 recognized window 或下游猜测兜底。

`store/spans.json` 的当前正式语义：

- 只读取 `store/assets.json` 与 `analysis/asset-reports/*.json` 生成，不读取 Pharos context、GPS cache 或 chronology
- `sourceInMs / sourceOutMs` 继续保留兼容性的 focus/evidence window
- `editSourceInMs / editSourceOutMs` 承载 edit-friendly bounds，供 Script/Timeline 默认优先使用
- 不写 `speedCandidate / pharosRefs / grounding / spatialEvidence / location / routeRole / chronology event`
- `source-speech` 的持久化目标是素材事实窗口；Analyze 生成 speech windows 和 `span-rebuild` 重建候选 spans 时都必须做 speech 专用合并：同 asset、speech/mixed 通道、相邻间隔 `<=3000ms`、合并后 `<=45s` 且可见中文 transcript `<=160` 字才合并，跨素材、跨语义通道、大停顿或过长口播不合并；合并后保留 transcriptSegments 顺序，任一来源为 `mixed` 时结果为 `mixed`，否则为 `speech`
- speech/mixed 与 visual 是同一素材内可重叠共存的双通道 truth：speech span 只承载口播 truth，visual span 保留完整视觉窗口与 `visualObservation`，不得因为 speech 重叠被切断、缩短或继承 transcript；后置 Codex/Agent speech-window review 只能修 speech 候选，不得破坏重叠 visual span
- `effectiveSpeechStartMs / effectiveSpeechEndMs` 是音频边界分析后的有效口播首尾 source ms；它们只用于后续 source-speech 取源窗与 handle 计算，不改变 chronology/recall 使用的素材事实窗口
- 行车 visual fallback/fine-scan 窗口应按 passage 降碎片，默认同 asset、visual 通道、相邻 source gap `<=60s`、单段 `<=90s`；speech/mixed 行车 span 仍独立存在并可与 visual passage 重叠
- 细粒度 utterance / pause timing 继续保留在 `transcriptSegments`
- `materialPatterns` 固定为中文 `string[]`，只保存脚本阶段可消费的素材事实短语；`span-rebuild` 的 LM prompt 只请求 7 项 provisional tags，不再请求或解析口播可用性裁决。前四项固定为 `拍摄视角/构图形态 / 当前环境 / 天气光线 / 口播语音`，其中视角来自受控词表，环境是从当前 span 文本事实提取的短语，天气光线只写可观察自然现象；第 4 项在 speech review pending 时只是候选口径，最终必须由 Agent review 根据裁切/drop/visual-only 结果重写到与 speech truth 一致；第 1 项只描述素材自身可观察的拍摄视角/构图形态，不得重复 `type` 的照片/视频载体语义，也不得写“建场/记录/成果”等后续剪辑用途；slot1/slot2/slot3 的画面语义支持性由 prompt/rubric 要求 LM 自判，代码校验受控词表并用结构字段和错槽保留词拦截硬冲突（如 `photo + 行车/运动/口播视角`、`drive + 航拍视角`、`无口播语音 + 口播视角`、视角/口播 tag 出现在环境或天气槽），不用关键词正则做支持性二次判定；第 5 项是 LLM 短情景故事或 `情景不明`，第 6-7 项是 LLM 短 factual free tags；代码只做协议校验、JSON 壳容错和失败原因反馈，不做启发式补写、旧词替换或兼容映射；重试时可以把具体 slot issue、期望口播槽值和 expected row count 反馈给 LM 重新生成，仍不合格则 `span-rebuild` 失败
- `visualObservation?: string` 保存 span 级一句视觉事实描述；所有 keep 的非音频 material span 都必须有该字段，缺失属于 Analyze 阶段失败
- GPS / 时间 / Pharos 归属不进入 `materialPatterns`，应从 chronology / spatial / Pharos context 层 join
- 旧五轴语义树 `narrativeFunctions / shotGrammar / viewpointRoles / subjectStates / span.evidence` 不再属于正式 span 输出
- `store/spans.meta.json` 固定记录 freshness、input hash、counts 和 warnings；hash 不包含 labels、speed hints、Pharos、GPS cache 或 chronology，但包含 material-pattern prompt version

## 工作流程

1. 读取项目资产

```typescript
const assets = await loadAssets(projectRoot);
const reports = await loadAssetReports(projectRoot);
```

2. 选择待分析资产

- 默认只分析还没有 coarse report 的资产
- 如果用户明确指定 `assetIds`，只分析指定素材

3. 解析真实本机路径

```typescript
const localPath = resolveAssetLocalPath(asset, roots);
```

4. 生成视觉粗扫结果

5. 在细扫决策前补充视频内音轨分析

6. 合并视觉/音频信号，生成 provisional decision / plan

7. 仅当 final plan 命中 deferred gate 时，补跑 `scene detect` 并只重算 shot-sensitive plan

这个 report 会包含：
- `clipTypeGuess`
- `densityScore`
- `summary`
- `labels`
- `placeHints`
- `gpsSummary`
- `inferredGps`
- `transcript`
- `transcriptSegments`
- `speechCoverage`
- 可选 `protectedAudio` 注释与保守推荐
- `interestingWindows`
- `fineScanWindows`（仅细扫完成或 dropped 细扫窗口时写入）
- `shouldFineScan`
- `fineScanMode`

注意：当前 `interestingWindows` 不是“单一最终剪辑窗口”，而是细扫前计划；新生成的窗口必须有稳定 `windowId`。`fineScanWindows` 才是细扫后的窗口观察结果，必须保留 `sourceInterestingWindowIds / sourceWindowReason`，speech/mixed 窗口还要保存裁剪后的 `transcript / transcriptSegments / speechCoverage`；visual 窗口即使时间上覆盖 transcript，也不能自动继承 speech truth。只要 asset report 已有完整 coarse facts 和 `fineScanWindows`，`span-rebuild` 不应重新视觉分析或重跑 ASR；历史 recognized fine-scan window 只有在缺 `semanticKind`、自身或来源证据为 `speech-window` 且与 transcriptSegments 重叠时，才保守恢复 speech truth。它只启动本地 ML 服务调用 qwen 文本 LM，对纯文本 span facts 返回 `materialPatterns` ordered rows，再由代码按素材时间 chunk 顺序写回候选 spans 并严格校验必需槽；第 1 槽是拍摄视角/构图形态，不是剪辑用途或载体类型；第 4 槽在 speech review pending 时只是候选口径，最终由 Agent review 与 speech truth 对齐；第 5-7 项必须来自 LM。缺失、旧词或冲突输出进入 failed span 列表并单条重试，重试后仍不合格则失败，不启发式替换。缺失 `visualObservation` 不是 `情景不明` 输入，而是 Analyze/fine-scan 失败。

## Chronology V2

- `media/chronology.json` 是项目级编年史文档，不是一素材一行的摘要表。
- 正式 schema 只暴露 `schemaVersion/status/generatedAt/updatedAt/confirmedAt/inputsHash/assetIndex/events`。
- `events[]` 只允许 `event / route / gap`、`reviewStatus`、标题摘要、时间地点、路线和 `spanIds`；不得写入 Pharos、`origin`、`source`、`confidence`、`assetIds`、`materialChannels` 或 `speechAnchors`。
- `assetIndex[]` 只保留 `assetId / sortCapturedAt` 作为兼容索引；`sortCapturedAt` 必须等于 corrected `asset.capturedAt`。素材集合必须从 `spanIds -> spans -> assetId` 反查。
- Pharos 只作为生成输入；生成后必须折叠成普通事件、路线或缺口。
- `gap` 可以没有 `spanIds`，表示行程确认存在但素材未覆盖或待补。
- `chronology-build` 先按 Pharos 单点真实时间窗归属：span 与 `expected / unexpected` 且非 `continuous` 的 actual window 存在有意义重叠时可直接进入该普通 `event`；多个重叠 point 先按显式 `actual_captures[]` 优先级归属，仍同分时优先更窄 actual window。Pharos 单点事件是 route 硬边界，Pharos `continuous` 只提供 route 的时间 / summary 上下文，不把多个事件间 route 强行合并，也不得把 continuous route prose 写入 chronology 地点字段。
- Pharos 单点事件来自人工行程事实，生成后默认 `reviewStatus=confirmed`；无素材命中的 Pharos `gap` 仍默认 `pending`，等待人工判断缺口是否可接受。
- 项目级 `chronology-build` 写 chronology 时必须使用 GPS reverse-geocode service；service 显式不可用、无 provider 且 cache miss、或任一 route/event GPS anchor 反查失败都必须报错并停止写入，不允许退回 `placeHints` / `materialPatterns` / Pharos continuous prose / 英文通用地点。
- 剩余 span 只按 chronology 顺序合并连续段：GPS 来源优先级为 Pharos trip GPX / 项目 `gps/merged.json` / `gps/derived.json` / report 中 `pharos|gpx|derived-track` / embedded GPS 兜底；单 span 起止 `<=200m` 是静态候选，相邻代表点 `<=400m` 可合并为同地点事件；移动中的非 route 观察可在相邻时间间隔 `<=5min` 且两点间速度连续合理时合并为同一 event。
- `route` 只由结构化 `drive` 素材和 route cluster 的短间隔伴随片段产生；普通非 Pharos 照片不参与一阶 event/route 切分，不能作为 event 打断 route；照片先按时间范围优先挂到 route，剩余照片再按时间最近挂到普通 event 的 `spanIds`；`materialPatterns / visualObservation / transcript` 中的 `公路 / 道路 / highway / road / 车内 / 航拍跟随` 等词只可进入摘要，不得触发 event/route 聚合判定；反查地名、标题和素材语义也不得参与聚合。
- `chronology-build` 写出的 V2 默认是 `draft`，必须经 `/chronology` 人工确认后 Script / Timeline 才能消费。

8. 自动决定是否细扫，并只把结果写入 `fineScanWindows`

9. 阶段结束；后续由 `/chronology` 显式运行 `span-rebuild` 和 `chronology-build`

## 进度展示

素材分析的正式监控入口是 `Supervisor + React console`，而不是旧静态 HTML 监控页。

重要提示：
- 只要开始执行一个可能持续较久的 Analyze，就应同步启动或刷新本地监控面板，而不是只在后台静默运行
- 启动 Analyze 后，agent 应主动把监控面板 URL 告诉用户；如果分析已经开始但面板还没打开，应立即补开
- 正式 Analyze 监控路由是 `http://127.0.0.1:8940/analyze`
- `/chronology` 页面会显示活跃 `spatial-refresh / span-rebuild / chronology-build` jobs；`spatial-refresh / chronology-build` 不启动 Kairos ML，`span-rebuild` 会启动本地 ML 服务按 8 个 candidate span 一批调用 qwen 文本 LM 做 provisional materialPatterns 归纳，LM 只返回 ordered pattern rows，代码按 chunk 顺序写回候选 spans，但不重跑 VLM / ASR，也不做最终 speech-window 裁切；已完成 checkpoint 和 failed span 列表写入 `.tmp/chronology/span-rebuild.partial.json`，正式 `store/spans.json` 只在全量收口后写入。若存在 speech/mixed candidates，meta 必须是 `pending-speech-review` 并展示 `.tmp/chronology/speech-window-agent-handoff.md`，`chronology-build` 必须 disabled 直到 Agent 写回 `fresh`；handoff/SubAgent 分片必须以约 1500 candidates 为单 shard 上限。`chronology-build` 必须覆盖同一 progress 文件为自己的 live 阶段，不得显示旧 span-rebuild cache；长循环中至少按批次更新 span 时空归属解析、event/route 聚合计数和 GPS reverse-geocode 地名解析计数。
- `React console` 的 Analyze 监控读取项目内 `.tmp/media-analyze/progress.json`，Chronology 监控读取 `.tmp/chronology/progress.json`；当前项目上下文必须正确，不能把面板混到别的项目进度目录
- Console 刷新时，默认项目上下文应优先跟随最新的 active project-scoped job；只有当前没有活跃项目 job 时，才回退到本地记忆的上次选择
- 如果多个项目 display name 相同，项目选择器必须直接显示 `projectId`，避免把 Analyze monitor 请求到同名旧项目
- `scripts/kairos-supervisor.ps1/.sh start` 只会启动 `Supervisor + React console`，不会自动恢复旧的 analyze job；服务起来不等于分析已经重新开始
- `scripts/kairos-supervisor.ps1/.sh start` 也不会自动启动 ML；Analyze 是否能跑要单独看 ML health 和 live job
- `progress.json`、`audio-checkpoints`、`fine-scan-checkpoints` 都是 durable cache，不是 live job 证据；只看到旧进度、旧 step、旧当前文件名，不能直接断言 Analyze 还在跑
- React console 当前会把 Analyze 直接展示成三段结构化流水线：
  - `粗扫队列`：素材级抽帧 worker、prepared checkpoint、活跃素材
  - `音频队列`：local health/routing、ASR queue、活跃素材
  - `细扫流水线`：`已预抽 / 已识别 / ready queue / active workers`
- Analyze 正常结束、失败退出或用户中断后，必须把 Kairos 官方管理的 ML service 对账回 `stopped`；`spatial-refresh` 不启动也不停止 ML；监控面板和其他本轮辅助进程也要同步收尾
- 清理边界只包含 agent 本轮主动启动的进程；不要顺手杀掉用户原本就在跑的 ML 服务、别的项目面板或无关后台服务

- 遇到“页面看起来还在跑，但 GPU / ML 没动静”时，必须先按这个顺序核查，而不是盲目重启或沿用旧结论：
  - `Supervisor` 当前是否真的存在 `running analyze` job；若是在 `/chronology` 页面，则核查 `spatial-refresh / span-rebuild / chronology-build`
  - `progress.json` 的 `LastWriteTime / updatedAt` 是否持续推进
  - GPU / ML 活跃迹象是否与当前 phase 相符
- 如果正式流程没起来，就要先查为什么没有 live job；不要把 stale `progress.json` 当成“正式流程其实已经在跑”
- 如果 `Supervisor` 已启动但没有对应 running job，需要显式重新发起；不要假设 `Supervisor` 重启会帮你自动恢复

- 默认进度文件建议写到：

```text
projects/<projectId>/.tmp/media-analyze/progress.json
```

- 正式监控入口：

```text
scripts/kairos-supervisor.ps1
scripts/kairos-supervisor.sh
```

- 推荐做法：
  - macOS / Linux：先用 `bash scripts/kairos-supervisor.sh start` 启动 `Supervisor + React console`
  - Windows：先用 `powershell -ExecutionPolicy Bypass -File scripts/kairos-supervisor.ps1 start` 启动 `Supervisor + React console`
  - 监控 Analyze 时，默认打开 `http://127.0.0.1:8940/analyze`
  - 收尾时：
    - macOS / Linux：`bash scripts/kairos-supervisor.sh stop`
    - Windows：`powershell -ExecutionPolicy Bypass -File scripts/kairos-supervisor.ps1 stop`
  - 如果本轮 Analyze 是 agent 临时拉起 ML server 才跑起来的，收尾时也要配套执行：
    - macOS / Linux：`bash scripts/ml-server.sh stop`
    - Windows：`powershell -ExecutionPolicy Bypass -File scripts/ml-server.ps1 stop`

- `progress.json` 的关键字段包括：
  - `pipelineKey / pipelineLabel`
  - `step / stepLabel / stepIndex / stepTotal`
  - `fileIndex / fileTotal`
  - `current / total / unit`
  - `etaSeconds`

## 产出

| 文件 | 内容 |
|------|------|
| `analysis/asset-reports/*.json` | 单素材粗扫报告（含 focus windows、edit bounds、ASR、fine-scan windows、空间字段） |
| `store/spans.json` | 由 `/chronology` 的 `span-rebuild` 显式生成的 stripped 素材片段索引 |
| `store/spans.meta.json` | spans freshness / hash / counts / warnings |
| `media/chronology.json` | 由 `/chronology` 的 `chronology-build` 显式生成的 Chronology V2 项目级编年史 |

## 当前实现边界

- 目前已经实现：
  - workspace-aware analyze
  - coarse report 落盘
  - 自动 fine-scan 决策
  - `full/windowed` 两种 slice 产出
  - 显式 span rebuild / chronology build 准备链
  - 视频内语音的 ASR -> speech windows -> transcript/slice 贯通
  - `embedded GPS > Pharos GPX > 普通 project GPX > project-derived-track` 空间优先级
  - 更宽的 DJI / QuickTime / EXIF embedded GPS 解析
  - sidecar `.SRT` 与 root 级 DJI FlightRecord 日志的同源 GPS 绑定
  - 项目级 `gps/tracks/*.gpx` + `gps/merged.json` + `gps/derived.json` 默认发现
  - ingest 时从 embedded GPS / `manual-itinerary` 刷新 `project-derived-track`

- 当前还没实现到最深：
  - merged cache 的自动失效检测 / 地图 UI / 可视化轨迹审阅
  - 独立音频资产的 analyze 分支
  - OCR 更深地参与 coarse/fine 召回
  - 已有旧 report / slice 的 transcript backfill

所以这条 skill 目前已经能用于“剪辑前素材准备”，但还在继续增强。
