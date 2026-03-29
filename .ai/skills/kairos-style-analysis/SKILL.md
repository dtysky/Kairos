---
name: kairos-style-analysis
description: >-
  Analyze historical video works to extract a detailed style profile by category.
  Supports multiple style categories (travel documentary, city walk, etc.) with
  user-provided guidance prompts. Outputs IStyleProfile compatible with kairos-script.
  Use when the user provides reference videos, wants to analyze their style,
  or mentions style, tone, voice, category, or reference works.
---

# Kairos: Style Analysis — 分类风格提取

从用户的历史成片中提取详细风格档案。支持多分类管理和用户指导词。

## 核心概念

### 分类 (Category)

用户的作品可能有多种类型，每种类型有不同的风格：

```
config/styles/
├── catalog.json                 # 风格目录（注册所有分类）
├── travel-doc.md                # 旅行纪录片风格
├── city-walk.md                 # 城市漫步风格
├── aerial.md                    # 航拍集锦风格
└── vlog.md                      # 日常 vlog 风格
```

每个分类独立分析、独立存储。在 `kairos-script` 阶段，用户选择使用哪个分类的风格。

### 指导词 (Guidance Prompt)

用户在启动风格分析前提供一段指导文本，告诉 agent：
- 这类作品的定位是什么
- 分析时重点关注什么（叙事节奏？画面风格？情绪表达？）
- 忽略什么（如"这几个视频的开头广告部分不是我的风格"）
- 任何创作理念或偏好

指导词会存储在风格档案的 front-matter 中，供后续参考。

## 前置条件

- 用户提供同一分类的 1 到多个历史成片视频文件路径
- 用户提供该分类的名称 + 指导词
- ML server 运行中（ASR 提取旁白文本）
- `ffmpeg` / `ffprobe` 可用

## 可用工具

### 元数据提取

```typescript
probe(filePath: string): Promise<IProbeResult>
```

### 编辑节奏分析

```typescript
detectShots(filePath: string, threshold?: number): Promise<IShotBoundary[]>
computeRhythmStats(shots: IShotBoundary[], totalDurationMs: number): IRhythmStats
estimateDensity(input: IDensityInput): IDensityResult
```

### 关键帧提取

```typescript
extractKeyframes(filePath: string, outputDir: string, timestampsMs: number[]): Promise<IKeyframeResult[]>
uniformTimestamps(durationMs: number, intervalMs: number): number[]
```

### ML 分析

```typescript
const ml = new MlClient();
transcribe(client: MlClient, audioPath: string, language?: string): Promise<ITranscription>
recognizeFrames(client: MlClient, imagePaths: string[]): Promise<IRecognition>
extractOcr(client: MlClient, imagePath: string): Promise<IOcrExtraction>
```

### 风格档案管理

```typescript
loadStyleFromMarkdown(filePath: string, options?: IStyleLoadOptions): Promise<IStyleProfile>
loadStyleByCategory(stylesDir: string, category: string): Promise<IStyleProfile | null>
listStyleCategories(stylesDir: string): Promise<IStyleCatalogEntry[]>
parseStyleMarkdown(markdown: string, options?: IStyleLoadOptions, sourceFiles?: string[]): IStyleProfile
buildStylePrompt(style: IStyleProfile): string

// front-matter 序列化（支持多行 guidancePrompt）
buildFrontMatter(fields: Record<string, string | undefined>): string
```

## 工作流程

### Step 0: 收集输入

向用户确认三项信息：

1. **分类名称**（category）：如 `travel-documentary`、`city-walk`、`aerial`
2. **指导词**（guidance prompt）：一段自由文本，描述分析侧重
3. **参考视频路径**：1-5 个该分类的历史成片

```
示例对话：
用户："分析我的旅行纪录片风格"
Agent："请提供以下信息：
  1. 分类名称建议：travel-documentary
  2. 您的指导词（告诉我分析时重点关注什么）
  3. 参考视频文件路径"
用户："分类就叫 travel-doc。指导词：这是我的长途自驾旅行纪录片，
  重点关注叙事节奏和语言风格，我追求克制的诗意表达。
  视频在 /videos/south-north.mp4 和 /videos/northwest.mp4"
```

### Step 1: 检查已有分类

```typescript
const existing = await listStyleCategories('config/styles');
// 检查该分类是否已存在，提示用户是覆盖还是新建
```

### Step 2: 提取原始数据

对每个参考视频执行：

```typescript
const meta = await probe(videoPath);
const shots = await detectShots(videoPath, 0.3);
```

### Step 3: ASR 提取旁白（最关键）

```typescript
const ml = new MlClient();
const transcript = await transcribe(ml, videoPath, 'zh');
```

将所有视频的 `fullText` 收集起来，这是风格分析的核心材料。

### Step 4: 视觉风格采样

```typescript
const timestamps = uniformTimestamps(meta.durationMs!, 15000);
const keyframes = await extractKeyframes(videoPath, outputDir, timestamps);
const recognition = await recognizeFrames(ml, keyframes.map(k => k.path));
```

### Step 5: 编辑节奏统计

```typescript
const rhythm = computeRhythmStats(shots, meta.durationMs!);
const density = estimateDensity({
  durationMs: meta.durationMs!,
  shotBoundaries: shots,
  asrSegments: transcript.segments,
});
```

### Step 6: Agent 撰写风格档案（核心创意环节）

Agent 综合以上所有数据 + 用户指导词，撰写风格档案 markdown。

**关键**：用户的指导词是分析的"指南针"，agent 应该：
- 优先关注指导词提到的维度
- 在指导词提到"忽略"的方面简化分析
- 将指导词中的创作理念融入风格总结

**生成 markdown 时使用 `buildFrontMatter` 确保多行 `guidancePrompt` 正确序列化**：

```typescript
const header = buildFrontMatter({
  category,
  name: '旅行纪录片风格',
  guidancePrompt,  // 多行文本自动用 YAML block literal (|) 语法
});
const markdownContent = header + bodyMarkdown;
```

**输出 markdown 格式**（带 front-matter，多行 guidancePrompt 用 `|` 语法）：

```markdown
---
category: travel-doc
name: 旅行纪录片风格
guidancePrompt: |
  这是我的长途自驾旅行纪录片，
  重点关注叙事节奏和语言风格，
  我追求克制的诗意表达。
---

# 旅行纪录片 风格档案

> 基于 N 篇历史作品归纳而成。

---

## 一、叙事结构
...

## 二、语言风格
...

## 三、情绪层次与表达
...

## 四、摄影/画面语言
...

## 五、主题与价值观
...

## 六、结构模板（抽象）
...

## 七、风格禁区
...

## 八、关键参数
| 参数 | 值 |
|------|-----|
| ... | ... |
```

**分析维度清单**：

1. **叙事结构** — 三幕式？线性？段落组织？开头结尾惯例？
2. **语言风格** — 人称、句式、用词偏好、基调
3. **情绪层次** — 情绪光谱、表达克制度、高潮触发
4. **摄影/画面语言** — 拍摄母题、光线体系、运镜词汇
5. **主题与价值观** — 核心主题、文化引用、个人标签
6. **结构模板** — 抽象化的段落结构模板
7. **风格禁区** — 应避免的表达方式
8. **关键参数** — 定量参数表格

### Step 7: 存储

**保存风格档案**：

```typescript
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

await mkdir(join(projectRoot, 'config/styles'), { recursive: true });
await writeFile(join(projectRoot, `config/styles/${category}.md`), markdownContent, 'utf-8');
```

**更新目录注册**：

```typescript
const catalogPath = join(projectRoot, 'config/styles/catalog.json');
const catalog: IStyleCatalog = await readJsonOrNull(catalogPath, IStyleCatalog) ?? { entries: [] };

const entry: IStyleCatalogEntry = {
  id: randomUUID(),
  category,
  name: '旅行纪录片风格',
  description: '基于 N 篇历史作品，侧重叙事节奏和克制诗意',
  profilePath: `${category}.md`,
  sourceVideoCount: videoPaths.length,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

// 替换同分类或追加
const idx = catalog.entries.findIndex(e => e.category === category);
if (idx >= 0) catalog.entries[idx] = entry;
else catalog.entries.push(entry);

await writeJson(join(projectRoot, 'config/styles/catalog.json'), catalog);
```

**保存 ASR 原文备查**：

```typescript
await mkdir(join(projectRoot, 'analysis/reference-transcripts'), { recursive: true });
for (const [videoPath, transcript] of transcripts) {
  const name = basename(videoPath, extname(videoPath));
  await writeFile(join(projectRoot, `analysis/reference-transcripts/${category}--${name}.txt`), transcript.fullText, 'utf-8');
}
```

## 产出

| 文件 | 格式 | 内容 |
|------|------|------|
| `config/styles/{category}.md` | Markdown (带 front-matter) | 该分类的完整风格档案 |
| `config/styles/catalog.json` | `IStyleCatalog` | 所有分类的注册表 |
| `analysis/reference-transcripts/{category}--{name}.txt` | TXT | ASR 原文备查 |

## 与下游对接

`kairos-script` 阶段根据用户选择的分类加载：

```typescript
// 方式 1：按分类名加载
const style = await loadStyleByCategory('config/styles', 'travel-doc');

// 方式 2：直接加载文件
const style = await loadStyleFromMarkdown('config/styles/travel-doc.md');

// 查看所有可用分类
const categories = await listStyleCategories('config/styles');
```

`style.guidancePrompt` 会传递到旁白创作阶段，提醒 agent 遵循用户的创作理念。

## 决策点

| 决策 | 说明 |
|------|------|
| 分类命名 | 用短横线连接的英文小写，如 `travel-doc`、`city-walk` |
| 参考视频数量 | 1 个也可以，3-5 个更准确 |
| 语言 | ASR 的 `language` 参数，中文用 `'zh'` |
| 采样密度 | 关键帧间隔 15s（快节奏）或 30s（慢节奏） |
| 已有分类 | 如已存在，确认覆盖还是追加参考视频后重新分析 |
| 指导词长度 | 不限，但建议 50-500 字，重点突出 |

## 备选路径

- 用户直接提供旁白文稿而非视频 → 跳过 Step 2-5，直接用文稿分析
- 用户手写风格档案 markdown → 直接放入 `config/styles/{category}.md` 并注册
- 用户想对比两个分类 → 分别执行分析后，agent 总结差异
