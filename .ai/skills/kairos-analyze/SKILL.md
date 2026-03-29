---
name: kairos-analyze
description: >-
  Phase 2: Analyze media assets with shot detection, keyframe extraction,
  ASR/OCR/VLM via ML server, and generate slices with evidence. Use when
  analyzing footage, detecting shots, or the user mentions analyze or slice.
---

# Kairos: Phase 2 — Analyze

对每个资产做镜头检测、关键帧提取、ML 分析，生成带证据的切片（`IKtepSlice[]`）。

## 前置条件

- `store/assets.json` 存在且非空
- ML server 运行中（`curl http://127.0.0.1:8910/health`），或设置了 `KAIROS_ML_URL`
- `ffmpeg` / `ffprobe` 可用

## 可用工具

```typescript
// 镜头边界检测（基于 ffmpeg scene detection）
detectShots(filePath: string, threshold?: number): Promise<IShotBoundary[]>
// IShotBoundary = { timeMs, score }

// 提取指定时间戳的关键帧图片
extractKeyframes(filePath: string, outputDir: string, timestampsMs: number[]): Promise<IKeyframeResult[]>
// IKeyframeResult = { timeMs, path }

// 生成均匀采样时间戳
uniformTimestamps(durationMs: number, intervalMs: number): number[]

// 从镜头边界和密度生成切片
sliceVideo(asset: IKtepAsset, boundaries: IShotBoundary[]): IKtepSlice[]
slicePhoto(asset: IKtepAsset): IKtepSlice

// ML server 客户端
const ml = new MlClient();  // 默认 http://127.0.0.1:8910
ml.asr(audioPath, language?): Promise<IAsrSegment[]>
ml.ocr(imagePath): Promise<IOcrResult[]>
ml.vlmAnalyze(imagePaths, prompt): Promise<IVlmResult>
ml.clipEmbed(imagePaths): Promise<number[][]>

// 高层封装
transcribe(client: MlClient, audioPath: string, language?: string): Promise<ITranscription>
extractOcr(client: MlClient, imagePath: string): Promise<IOcrExtraction>
recognizeFrames(client: MlClient, imagePaths: string[]): Promise<IRecognition>

// 信息密度估计
estimateDensity(input: IDensityInput): IDensityResult

// 采样计划（ISamplerInput: { assetId, durationMs, density, shotBoundaries, clipType?, budget? }）
buildAnalysisPlan(input: ISamplerInput): IMediaAnalysisPlan

// 证据合并
mergeEvidence(slice: IKtepSlice, ...sources: IKtepEvidence[][]): IKtepSlice
evidenceFromPath(filePath: string, folderNotes?: string[]): IKtepEvidence[]
```

## 工作流程

### 对每个视频资产：

1. **镜头检测**

```typescript
const boundaries = await detectShots(asset.sourcePath, 0.3);
```

2. **生成切片**

```typescript
const slices = sliceVideo(asset, boundaries);
```

3. **提取关键帧**（用于 ML 分析）

```typescript
const timestamps = boundaries.map(b => b.timeMs);
const keyframes = await extractKeyframes(asset.sourcePath, outputDir, timestamps);
```

4. **ML 分析**（按需，如果 ML server 可用）

```typescript
const ml = new MlClient();

// ASR：提取语音
const transcription = await transcribe(ml, asset.sourcePath);

// VLM：场景识别
const recognition = await recognizeFrames(ml, keyframes.map(k => k.path));

// OCR：文字识别（可选，针对含文字的画面）
const ocrResult = await extractOcr(ml, keyframes[0].path);
```

5. **合并证据到切片**

Agent 需要将 ASR/VLM 证据按时间范围分配到对应的切片上：

```typescript
for (const slice of slices) {
  // 筛选与该切片时间范围重叠的 ASR 段落
  const sliceAsrEvidence = filterEvidenceByTimeRange(
    transcription.evidence, slice.sourceInMs, slice.sourceOutMs
  );
  // 筛选该切片对应关键帧的 VLM 识别结果
  const sliceVlmEvidence = filterEvidenceByTimeRange(
    recognition.evidence, slice.sourceInMs, slice.sourceOutMs
  );
  mergeEvidence(slice, sliceAsrEvidence, sliceVlmEvidence);
}
```

注：`filterEvidenceByTimeRange` 需要 agent 根据切片的 `sourceInMs`/`sourceOutMs` 自行筛选，或直接对每个切片独立调用 ML。

### 对每个照片资产：

```typescript
const slice = slicePhoto(asset);
// ML 分析同上（VLM + OCR）
```

### 存储

```typescript
await writeJson(join(projectRoot, 'store/slices.json'), allSlices);
```

## 产出

| 文件 | 格式 | 内容 |
|------|------|------|
| `store/slices.json` | `IKtepSlice[]` | 所有切片，带证据标注 |
| `media/keyframes/` | JPG 文件 | 提取的关键帧图片 |
| `analysis/` | JSON | ML 分析中间结果（可选保存） |

## 决策点

- **threshold**：`detectShots` 的 threshold 参数，0.3 是默认值。运动镜头多的素材可以调高到 0.4-0.5
- **是否跳过 ML**：如果 ML server 不可用，可以只做镜头检测和关键帧提取，跳过 ASR/OCR/VLM
- **语言**：ASR 的 language 参数，中文用 `'zh'`，英文用 `'en'`，或不传让模型自动检测
- **采样密度**：长视频不必每帧分析，用 `buildAnalysisPlan` 生成采样计划
