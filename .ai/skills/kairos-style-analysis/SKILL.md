---
name: kairos-style-analysis
description: >-
  Analyze historical video works to extract a detailed style profile. Extracts
  ASR transcripts, shot rhythm, visual themes, and narration patterns from
  reference videos. Outputs an IStyleProfile compatible with kairos-script.
  Use when the user provides reference videos, wants to analyze their style,
  or mentions style, tone, voice, or reference works.
---

# Kairos: Style Analysis — 从历史作品提取风格

从用户的历史成片中提取详细风格档案，产出可直接供 `kairos-script` 使用的 `IStyleProfile`。

## 前置条件

- 用户提供 1 到多个历史成片视频文件路径
- ML server 运行中（ASR 提取旁白文本）
- `ffmpeg` / `ffprobe` 可用

## 可用工具

### 元数据提取

```typescript
probe(filePath: string): Promise<IProbeResult>
// { durationMs, width, height, fps, codec, creationTime, rawTags }
```

### 编辑节奏分析

```typescript
detectShots(filePath: string, threshold?: number): Promise<IShotBoundary[]>
// 返回镜头切换点 { timeMs, score }

computeRhythmStats(shots: IShotBoundary[], totalDurationMs: number): IRhythmStats
// 编辑节奏统计：
// { shotCount, cutsPerMinute,
//   shotDurationMs: { min, max, median, mean },
//   introRhythm, bodyRhythm, outroRhythm }

estimateDensity(input: IDensityInput): IDensityResult
// 综合密度评分 { score, shotRate, speechRatio, ocrDensity }
```

### 关键帧提取

```typescript
extractKeyframes(filePath: string, outputDir: string, timestampsMs: number[]): Promise<IKeyframeResult[]>
uniformTimestamps(durationMs: number, intervalMs: number): number[]
```

### ML 分析

```typescript
const ml = new MlClient();

// ASR：提取旁白/解说文本（风格分析最核心的输入）
transcribe(client: MlClient, audioPath: string, language?: string): Promise<ITranscription>
// { segments: IAsrSegment[], fullText: string, evidence }

// VLM：场景类型、主体、情绪分析
recognizeFrames(client: MlClient, imagePaths: string[]): Promise<IRecognition>
// { sceneType, subjects, mood, placeHints, narrativeRole, description }

// OCR：画面中的文字
extractOcr(client: MlClient, imagePath: string): Promise<IOcrExtraction>
```

### 风格档案工具

```typescript
// 从 markdown 解析为 IStyleProfile
parseStyleMarkdown(markdown: string, name?: string, sourceFiles?: string[]): IStyleProfile

// 生成风格提示词（用于验证产出是否完整）
buildStylePrompt(style: IStyleProfile): string
```

## 工作流程

### Step 1: 提取原始数据

对每个参考视频执行：

```typescript
const meta = await probe(videoPath);
const shots = await detectShots(videoPath, 0.3);
const density = estimateDensity({
  durationMs: meta.durationMs!,
  shotBoundaries: shots,
});
```

### Step 2: ASR 提取旁白（最关键）

```typescript
const ml = new MlClient();
const transcript = await transcribe(ml, videoPath, 'zh');
// transcript.fullText 就是完整旁白文本
```

将所有视频的 `fullText` 收集起来，这是风格分析的核心材料。

### Step 3: 视觉风格采样

从每个视频均匀采样关键帧，分析视觉主题：

```typescript
const timestamps = uniformTimestamps(meta.durationMs!, 15000); // 每15秒一帧
const keyframes = await extractKeyframes(videoPath, outputDir, timestamps);
const recognition = await recognizeFrames(ml, keyframes.map(k => k.path));
```

### Step 4: 编辑节奏统计

```typescript
const rhythm = computeRhythmStats(shots, meta.durationMs!);
// rhythm.cutsPerMinute — 平均每分钟切换次数
// rhythm.shotDurationMs.median — 镜头时长中位数
// rhythm.introRhythm / bodyRhythm / outroRhythm — 三段切换密度

const density = estimateDensity({
  durationMs: meta.durationMs!,
  shotBoundaries: shots,
  asrSegments: transcript.segments,
});
// density.speechRatio — 旁白覆盖率
```

Agent 综合这些数据归纳编辑节奏特征：快切 vs 长镜头，开头密结尾疏还是均匀，旁白密度等。

### Step 5: Agent 撰写风格档案（核心创意环节）

Agent 综合以上所有数据，撰写结构化的风格档案 markdown。

**分析维度清单**（每个维度写成一个 `## 章节`）：

1. **叙事结构**
   - 三幕式还是线性？段落如何组织？
   - 开头/结尾的惯例手法
   - 段落间的过渡方式

2. **语言风格**
   - 人称（第一/第二/第三？）
   - 句式特征（短句主导？排比？省略句？）
   - 用词偏好和高频词
   - 基调（克制？热情？诗意？口语？）

3. **情绪层次**
   - 情绪光谱从低到高的层次
   - 情绪表达的克制程度
   - 触发情绪高潮的典型场景

4. **摄影/画面语言**
   - 核心拍摄母题（延时、航拍、行车等）
   - 光线描写体系
   - 运镜相关的叙述词汇

5. **主题与价值观**
   - 反复出现的核心主题
   - 文化引用习惯
   - 个人标签/品牌元素

6. **风格禁区**
   - 应避免的表达方式（每条单独列出）

7. **关键参数**
   - 以表格形式列出供脚本生成模块使用的参数

**输出格式参考**：`test/style-profile.md` 是一个完整的风格档案样板，agent 应按照类似结构撰写。

### Step 6: 存储

将撰写好的 markdown 保存到项目中：

```typescript
import { writeFile } from 'node:fs/promises';
await writeFile(join(projectRoot, 'config/style-profile.md'), markdownContent, 'utf-8');
```

同时可以解析为结构化对象验证完整性：

```typescript
const profile = parseStyleMarkdown(markdownContent, '风格档案', videoPaths);
await writeJson(join(projectRoot, 'config/style-profile.json'), profile);
```

## 产出

| 文件 | 格式 | 内容 |
|------|------|------|
| `config/style-profile.md` | Markdown | 人类可读的完整风格档案 |
| `config/style-profile.json` | `IStyleProfile` | 结构化风格数据 |
| `analysis/reference-transcripts/` | TXT | 每个参考视频的 ASR 全文（保留备查） |

## 与下游对接

`kairos-script` 阶段直接加载：

```typescript
const style = await loadStyleFromMarkdown('config/style-profile.md');
```

`style.rawReference` 包含完整 markdown 原文，`buildStylePrompt(style)` 会优先使用它来指导旁白创作。

## 决策点

- **参考视频数量**：1 个也可以，但 3-5 个能更准确地归纳规律，区分共性和个例
- **语言**：ASR 的 `language` 参数，中文用 `'zh'`
- **采样密度**：关键帧采样间隔，15 秒适合快节奏视频，30 秒适合慢节奏
- **是否保留旧档案**：如果已有 `config/style-profile.md`，确认是覆盖还是对比融合
- **多作者**：如果参考视频来自不同创作者，应该分别分析而非混合

## 备选路径

如果不想通过 ML 提取数据，也可以：
- 用户直接提供旁白文稿（手动或从字幕文件导入）
- 用户手写风格档案 markdown
- 用已有的 `test/style-profile.md` 直接使用
