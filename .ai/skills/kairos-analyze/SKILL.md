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

## 默认分析策略

### 1. 粗扫优先

每条素材先做轻量分析：
- 视频：
  - 低成本 scene detect
  - 均匀少量采样帧
  - 可用时做一次轻量 VLM 总结
- 照片：
  - 直接做轻量视觉总结
- 音频：
  - 先登记资产，视觉细扫跳过

粗扫结果会写到：

```text
analysis/asset-reports/<assetId>.json
```

### 2. 自动细扫

系统根据这些信号自动决定：
- `durationMs`
- `densityScore`
- `interestingWindows`
- `clipTypeGuess`
- 预算档位

输出：
- `shouldFineScan`
- `fineScanMode = skip | windowed | full`

### 3. 只对重点内容产出 slices

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

4. 生成 coarse report

粗扫报告会包含：
- `clipTypeGuess`
- `densityScore`
- `summary`
- `labels`
- `placeHints`
- `interestingWindows`
- `shouldFineScan`
- `fineScanMode`

5. 自动决定是否细扫并生成 slices

6. 更新 chronology

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
| `media/chronology.json` | 带 summary/labels 的时间排序视图 |

## 当前实现边界

- 目前已经实现：
  - workspace-aware analyze
  - coarse report 落盘
  - 自动 fine-scan 决策
  - `full/windowed` 两种 slice 产出
  - chronology 刷新

- 当前还没实现到最深：
  - GPS/人工行程参与 coarse report
  - 更细的 ASR/OCR 参与粗扫打分
  - 基于 fine-scan shot 的更强证据分配

所以这条 skill 目前已经能用于“剪辑前素材准备”，但还在继续增强。
