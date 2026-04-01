---
name: kairos-analyze
description: >-
  Phase 2: Coarse-first media analysis for Kairos editing projects. Builds
  asset-level reports, updates chronology, and automatically decides whether to
  fine-scan specific assets into slices. Use when analyzing project footage for
  editing preparation. This is separate from style-analysis.
---

# Kairos: Phase 2 — Analyze

这条 skill 负责 **剪辑素材分析**，不是风格分析。

它的目标是：
- 先对全量素材做轻量粗扫
- 落单素材报告 `analysis/asset-reports/<assetId>.json`
- 自动判断哪些素材值得细扫
- 只对重点素材生成 `store/slices.json`
- 更新 `media/chronology.json`
- 在有空间线索时，为 coarse report 挂上 GPS / 地点上下文

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
  deviceMapPath?: string;
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

`deviceMapPath` 通常不用显式传。省略时，Analyze 默认读取当前项目内的
`config/device-media-maps.local.json`。

## 强规则：Analyze 前必须先做 GPS 提示

在任何一次 Analyze 开始前，agent **必须先向用户明确提示并指导当前项目的 GPS 规则**。这一步是强规则，不能因为用户直接说“analyze / 分析 / 继续”就跳过。

开始 Analyze 之前，至少要明确告诉用户：

- 当前空间优先级是：`embedded GPS > project GPX > project-derived-track > none`
- `manual-itinerary` 不再作为 Analyze 阶段的独立顶层 fallback；它会在 ingest 时被编译进 `gps/derived.json`
- `manual-itinerary` 不负责修正素材拍摄时间；拍摄时间仍以 `create_time(UTC)` 为主
- 如果项目里没有 `gps/merged.json` / `gps/tracks/*.gpx`，也没有 `gps/derived.json`，那么**没有 embedded GPS 的素材将拿不到空间 fallback**
- 如果用户刚修改过 `config/manual-itinerary.md` 但还没重新跑 ingest，必须明确提醒：当前 `gps/derived.json` 可能还是旧的
- 如果用户手里有 sidecar `.SRT` 或 DJI FlightRecord 日志，必须提醒：这类数据走的是 `embedded GPS` 标准链路，不是普通项目 GPX

在提示规则后，还必须指导用户当前可选动作：

- 导入项目级 GPX
- 在对应素材源的 `project-brief.md` block 里配置 `飞行记录路径`
- 填写 `config/manual-itinerary.md`
  - 默认推荐一句自然语言一段，例如：`2026.02.17，早上九点左右，开车从新西兰皇后镇出发`
  - 只有需要限制到特定素材源或路径前缀时，再补 `素材源:` / `路径:` 这类结构化字段
- `.SRT` 如果和素材同 basename 放在素材旁，ingest 会自动发现，不需要单独导入
- 如果选择填写或修改了 `manual-itinerary`，先重新跑一次 ingest，刷新 `gps/derived.json`
- 或明确接受“部分素材没有空间结果”后继续

只有在用户明确确认继续后，才可以真正调用 `analyzeWorkspaceProjectMedia()`。

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
buildMediaChronology(...)
```

## 空间上下文优先级

Analyze 阶段如果要给素材补空间上下文，来源优先级必须是：

1. `embedded GPS`
2. `project GPX`
3. `project-derived-track`
4. 无空间结果

规则：

- 如果素材自身已经带有 GPS，优先使用素材同源 GPS 真值
- 对 DJI 视频，优先检查素材同源 GPS：容器/流 metadata、同 basename sidecar `.SRT`、以及 root 级 DJI FlightRecord 日志切片；它们都比外部 GPX 更优先
- 当前内嵌 GPS 解析已覆盖更宽的 QuickTime / EXIF 变体：`location`、`location-eng`、`com.apple.quicktime.location.iso6709`、`com.apple.quicktime.location_iso6709`、`GPSLatitude/GPSLongitude(+Ref)` 以及简单 rational / DMS 风格坐标
- DJI FlightRecord 日志不是普通项目 GPX；它只有在 ingest 时被识别并成功切到某个素材的时间段后，才按 `embedded GPS` 进入主链
- ingest 会把 dense sidecar / FlightRecord 轨迹规范化写到 `gps/same-source/tracks/*.gpx` + `gps/same-source/index.json`；Analyze 看到的仍然是资产上的轻量 `embeddedGps` 引用，不应把这套内部 cache 当成第二优先级 `project GPX`
- 如果没有可用内嵌 GPS，Analyze 会先看显式传入的 `gpxPaths`
- 如果调用方没有显式传入 `gpxPaths`，Analyze 默认读取项目内 `gps/merged.json`；若 merged cache 不存在，再回落到 `gps/tracks/*.gpx`
- 如果没有 GPX 命中，Analyze 再读取项目内 `gps/derived.json`，把它作为第三优先级空间层
- `project-derived-track` 当前 v1 只做保守匹配：
  - embedded-derived 条目只允许 sparse nearest-point 命中
  - manual-itinerary-derived 条目只允许 ingest 预编译好的 bounded window / anchor 命中
  - 不做跨 gap 插值
- `manual-itinerary` 不再直接参与 Analyze 匹配；它只能先通过 ingest 编译进 `project-derived-track`
- 如果 `manual-itinerary` 在上次 ingest 之后被修改，先 rerun ingest，再 analyze
- 当存在内嵌 GPS 时，`project-derived-track` 和 GPX 都不能覆盖它
- 当前代码入口仍允许通过 `gpxPaths` 显式注入 1..N 个 GPX 文件路径，用于覆盖默认发现
- 默认 GPX 命中策略是：从带 `time` 的 `trkpt / rtept / wpt` 中，按 `capturedAt` 选择容差内最近点
- `manual-itinerary` 不负责修正素材拍摄时间；素材时间仍以 `create_time(UTC)` 为主
- 空间推断结果应落在 coarse report，而不是回写素材真值层

## 默认分析策略

### 1. 视觉粗扫

先做面向全量素材的低成本视觉分析：
- 视频：
  - 低成本 scene detect
  - 均匀少量采样帧
  - 可用时做一次轻量 VLM 总结
- 照片：
  - 直接做轻量视觉总结
- 音频：
  - 当前正式项目的主路径不是纯音频资产，而是“视频素材里的音轨”
  - 如果未来项目真的包含独立音频资产，再单独补这条 analyze 分支；不要让它干扰当前主流程理解

这一步的目标是先得到视觉侧的基础判断：
- 这条素材大概是什么
- 是否存在值得深挖的视觉时间窗
- 是否值得进入后续更高成本分析

### 2. 音频分析（细扫决策前）

对符合条件的视频，在视觉粗扫之后、细扫决策之前补一段音频分析：

- 对视频内音轨跑轻量 ASR
- 提取 `transcript / transcriptSegments / speechCoverage`
- 把 ASR 命中的语音时间窗并入 `interestingWindows`

这一步默认仍属于 Analyze phase，但不再和“视觉粗扫”混写成同一个子步骤。

### 3. 自动细扫决策

系统根据视觉粗扫 + 音频分析 + 可用空间线索的合并信号自动决定：
- `durationMs`
- `densityScore`
- `interestingWindows`
- `clipTypeGuess`
- `speechCoverage`
- `transcriptSegments`
- 预算档位

这里的语音信号默认指视频素材内部抽出的语音线索，而不是独立音频文件批处理。

输出：
- `shouldFineScan`
- `fineScanMode = skip | windowed | full`

到这一步之后，才会形成用于后续流程的 coarse-level report。这个 report 可以已经带上 transcript 字段，但概念上它不是“纯视觉粗扫结果”，而是“粗扫 + 音频分析合并后的分析结果”。

分析结果会写到：

```text
analysis/asset-reports/<assetId>.json
```

### 4. 只对重点内容产出 slices

- `full`
  - 对整条素材切成 shot slices
- `windowed`
  - 只把 `interestingWindows` 变成 slices
- `skip`
  - 只保留 coarse report，不生成 slices

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
const localPath = resolveAssetLocalPath(projectId, asset, roots, deviceMaps);
```

4. 生成视觉粗扫结果

5. 在细扫决策前补充视频内音轨分析

6. 合并视觉/音频信号，生成 coarse-level report

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
- `interestingWindows`
- `shouldFineScan`
- `fineScanMode`

7. 自动决定是否细扫并生成 slices

8. 更新 chronology

## 进度展示

素材分析复用 Kairos 通用进度页，而不是复用风格分析的业务逻辑。

- 默认进度文件建议写到：

```text
projects/<projectId>/.tmp/media-analyze/progress.json
```

- 本地网页可直接复用：

```text
scripts/kairos-progress.ps1
scripts/kairos-progress.sh
```

- `progress.json` 的关键字段包括：
  - `pipelineKey / pipelineLabel`
  - `step / stepLabel / stepIndex / stepTotal`
  - `fileIndex / fileTotal`
  - `current / total / unit`
  - `etaSeconds`

## 产出

| 文件 | 内容 |
|------|------|
| `analysis/asset-reports/*.json` | 单素材粗扫报告 |
| `store/slices.json` | 只包含自动进入细扫的重点素材切片 |
| `media/chronology.json` | 带 summary/labels/ASR evidence 的时间排序视图 |

## 当前实现边界

- 目前已经实现：
  - workspace-aware analyze
  - coarse report 落盘
  - 自动 fine-scan 决策
  - `full/windowed` 两种 slice 产出
  - chronology 刷新
  - 视频内语音的 ASR -> speech windows -> transcript/slice 贯通
  - `embedded GPS > project GPX > project-derived-track` 空间优先级
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
