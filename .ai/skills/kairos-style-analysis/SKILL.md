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

## 变更工作流规则

只要本轮任务涉及需求、行为、接口、工作流、正式入口或用户路径变更，必须遵守下面顺序：

1. 先进入 `Plan` 模式；如果宿主没有显式 `Plan mode`，先给出结构化计划并得到确认。
2. 计划确认后，先更新相关设计文档，再开始实现。
3. 实现完成后，必须回查并同步受影响的设计文档、rules 和 skills，再结束本轮。
4. 如果变更影响正式入口、监控页、工作流主路径或用户操作方式，还要同步更新 `README.md`、`designs/current-solution-summary.md` 和 `designs/architecture.md`。

## 核心概念

### 分类 (Category)

用户的作品可能有多种类型，每种类型有不同的风格：

```
<workspaceRoot>/config/styles/
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

- 用户提供同一分类的 1 到多个历史成片视频文件路径，或一个包含这些视频的目录路径
- 用户提供一段辅助说明（会作为 guidance prompt 存储）
- 最好提供该分类的名称；若未提供，可由 agent 结合路径和说明帮助命名
- ML server 运行中（ASR 提取旁白文本）
- 如果 ML server 不可用，必须直接停下并提示用户修复；不要静默退化成“无 ASR / 无 VLM”的风格分析结果
- 如果当前平台是 **Windows + NVIDIA GPU**，优先使用 **Windows 原生 Python + CUDA** 启动 ML server / VLM，不要从 WSL 拉起
- `ffmpeg` / `ffprobe` 可用；Windows 上优先从项目的 `config/runtime.json` 读取原生路径
- Windows 上建议先用 `powershell -ExecutionPolicy Bypass -File scripts/ml-server.ps1 status` 检查，再用 `powershell -ExecutionPolicy Bypass -File scripts/ml-server.ps1 start` 复用或拉起 `kairos-ml`
- 只有在你明确需要重载 Python 环境或模型时，才用 `powershell -ExecutionPolicy Bypass -File scripts/ml-server.ps1 restart`
- 默认分析代理规格推荐统一为 `1024w + yuv420p(8bit)`；风格分析里的场景检测和大多数预处理都应优先落到这一层
- 对长视频的场景检测，默认可进一步降到低帧率采样（例如 `sceneDetectFps = 4`），避免在正式抽帧和 VLM 之前耗太久
- 如果本轮风格分析是 agent 临时拉起 ML server 才开始的，任务结束、失败或中断后也必须主动把这个 ML server 停掉；不要留下孤儿推理服务
- 但如果 ML server 是用户本来就在跑的长期服务，则不要擅自停止

## 临时文件约定

- 风格分析过程中产生的关键帧、探测结果、临时摘要等中间产物，统一放在 **当前 workspaceRoot** 下的 `.tmp/`，例如 `.tmp/style-analysis/{category}/`
- 不要把这类临时产物写到 `C:` 盘系统临时目录或用户目录外的随机位置
- `.tmp/` 应加入 `.gitignore`
- 当风格档案已经写入 `config/styles/` 且不再需要调试时，默认清理对应的临时目录，只保留正式产物：
  - `<workspaceRoot>/config/styles/{category}.md`
  - `<workspaceRoot>/config/styles/catalog.json`
  - `<workspaceRoot>/analysis/reference-transcripts/...`
  - `<workspaceRoot>/analysis/style-references/...`
- 如果 agent 在本轮风格分析里启动过监控页或 ML server，也应在收尾阶段同步停止对应进程

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

### Step 0: 问询式收集输入

进入风格分析时，不要直接开始分析，先走一个固定问询流程。

必须向用户索取这几项：

1. **参考文件或目录路径**：可以是 1 到多个视频文件，也可以是一个目录
2. **辅助说明**：一段自由文本，说明这批作品的定位、希望重点关注什么、希望忽略什么
3. **分类名称**（可选但推荐）：如 `travel-doc`、`city-walk`、`aerial`

规则：

- 如果用户给的是**目录路径**，先从目录中识别可用视频文件，再向用户确认是否按这批文件继续
- 如果用户只给了文件/目录路径，没有分类名，允许 agent 根据路径名和辅助说明先给出一个建议分类名
- “辅助说明”就是后续存入风格档案 front-matter 的 `guidancePrompt`
- 如果用户给了多个文件，要先确认这些文件是否属于**同一风格分类**

推荐开场问法：

```text
请先给我两样东西：
1. 参考视频的文件路径，或包含这些视频的目录路径
2. 一段辅助说明，告诉我这类作品的定位、希望我重点分析什么、哪些部分不要算进你的个人风格

如果你已经想好了，也可以顺手给一个分类名，比如 travel-doc。
```

目录路径场景下的追问模板：

```text
我会先把这个目录里的视频识别出来，再按同一分类分析。
如果这个目录里混有别的作品类型，请在辅助说明里告诉我哪些该排除。
```

示例对话：

```text
用户："分析我的旅行纪录片风格"
Agent："请先给我两样东西：
1. 参考视频的文件路径，或包含这些视频的目录路径
2. 一段辅助说明，告诉我这类作品的定位、希望我重点分析什么、哪些部分不要算进你的个人风格

如果你已经想好了，也可以顺手给一个分类名，比如 travel-doc。"

用户："目录在 /videos/travel-doc/。辅助说明：这是我的长途自驾旅行纪录片，
重点关注叙事节奏和语言风格，我追求克制的诗意表达。
目录里如果有花絮和广告片头，不要算进去。分类就叫 travel-doc。"
```

### Step 1: 检查已有分类

```typescript
const stylesDir = join(workspaceRoot, 'config/styles');
const existing = await listStyleCategories(stylesDir);
// 检查该分类是否已存在，提示用户是覆盖还是新建
```

### Step 2: 提取原始数据

对每个参考视频执行：

```typescript
const meta = await probe(videoPath);
const shots = await detectShots(videoPath, 0.3);
```

如果输入里有多个参考视频，必须先对每个视频分别落地一份“单视频分析结果”，再做共同风格综合。不要一开始就把全部素材混成一个大输入。

推荐顺序：

1. 每个视频单独完成：
   - 元数据提取
   - 内容洞察
   - 剪辑节奏统计
   - 镜头级视觉分析
   - ASR 转写
2. 将每个视频的结果分别保存
3. 最后再把多份“单视频分析结果”综合成共同风格

推荐保存路径：

```text
<workspaceRoot>/analysis/style-references/{category}/{video-stem}.json
```

### Step 3: ASR 提取旁白（最关键）

```typescript
const ml = new MlClient();
const transcript = await transcribe(ml, videoPath, 'zh');
```

将所有视频的 `fullText` 收集起来，这是风格分析的核心材料。

### Step 4: 视觉风格采样

风格分析不要再用“统一每隔 N 秒抽一帧，然后固定批量送 VLM”的方式。
正式策略应改为：

- 先用 `detectShots()` 得到镜头边界
- 再把每个镜头区间转成一个 `shot`
- 每个 `shot` 至少抽 `开始 / 中间 / 收尾` 三帧
- VLM 以 **每个 shot 为单位** 分析，而不是把多个镜头混成一批描述

这样得到的是“镜头级视觉证据”，而不是“批次级混合摘要”。

```typescript
const outputDir = join(workspaceRoot, '.tmp/style-analysis', category, 'keyframes');
const shotPlans = planShotKeyframes(shots, meta.durationMs!, 3);
const timestamps = flattenShotKeyframePlans(shotPlans);
const keyframes = await extractKeyframes(videoPath, outputDir, timestamps);
const shotGroups = groupKeyframesByShot(shotPlans, keyframes);
const recognition = await recognizeShotGroups(ml, shotGroups);
```

每条 `recognition` 应对应一个 shot，并至少包含：

```json
{
  "shotId": "shot-012",
  "startMs": 120000,
  "endMs": 128500,
  "framePaths": ["...", "...", "..."],
  "recognition": {
    "sceneType": "interior",
    "mood": "melancholic",
    "description": "..."
  }
}
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

如果输入包含多个参考视频，这一步不要直接把所有 transcript 和视觉描述混成一个大文本。应该先把每个视频组织成独立的参考报告，再让 LLM 做“共同风格归纳”。

推荐的数据结构：

```typescript
type IStyleReferenceVideoAnalysis = {
  sourceFile: string;
  transcript?: string;
  guidancePrompt?: string;
  contentInsights?: string[];
  rhythm?: Partial<IRhythmStats>;
  shotRecognitions?: IShotRecognition[];
};
```

也就是说：

- `video A` 先形成自己的风格分析报告
- `video B` 先形成自己的风格分析报告
- 最后才做 `A + B + ... => shared style`

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

**节奏 / 素材 / 运镜章节合同（当前默认口径）**：

- 不要再把风格分析写成“叙事语气 + 一句节奏描述”的长文摘要
- 风格档案至少要同时产出两层：
  - 给人读的长文 section：解释这种风格为什么这样组织
  - 给下游直接消费的结构：稳定标题、参数表、禁区和功能位偏好
- markdown 中建议至少单独有这些章节：
  - `## 节奏阶段拆解`
  - `## 剪辑节奏与素材编排`
  - `## 摄影 / 画面 / 运镜语言`
  - `## 镜头语法与功能分配`
  - `## 风格禁区`
  - `## 关键参数`
- 节奏章节不要只写 `前快中稳后抬`，而要尽量拆成更可消费的阶段特征，例如：
  - 开场如何进场、靠什么建立气质
  - 中前段如何建立地点、议题或人物
  - 中段如何转入观察、停顿或铺垫
  - 后段如何抬升、释放或收束
- 素材编排章节至少应明确：
  - `aerial / timelapse / drive / talking-head / broll / nat sound` 各自承担什么角色
  - 它们通常在什么时机插入，承担建场、转场、地理重置、情绪释放还是人物承接
  - 哪些镜头语法只适合 `开场建场`，哪些更适合 `地理重置`，哪些更适合 `情绪释放`
  - 不要把航拍和延时只写成“好看素材”；要说明它们为什么在该风格里重要
- 运镜章节至少应明确：
  - 高频手法：推进、拉远、横移、俯冲、跟车、固定机位延时、高位建场等哪些常见
  - 低频或谨慎使用的手法
  - 这些手法主要服务空间建立、人物跟随、地理重置还是情绪释放
- 风格禁区要尽量拆开：
  - `素材禁区`
  - `镜头禁区`
- 禁区条目尽量使用 `1. **标题** — 说明` 的格式，便于 loader 稳定提取 `antiPatterns`
- `参数` 表中应尽量使用稳定 key；即使值只是 `少用 / 偶尔 / 不明显 / 仅在某阶段` 也比完全缺失更好
- 推荐 key：
  - `节奏阶段一`
  - `节奏阶段二`
  - `节奏阶段三`
  - `节奏阶段四`
  - `aerial角色`
  - `timelapse角色`
  - `drive角色`
  - `talking-head角色`
  - `broll角色`
  - `nat sound角色`
  - `高频运镜`
  - `低频运镜`
  - `开场建场镜头语法`
  - `地理重置镜头语法`
  - `情绪释放镜头语法`
  - `Recall 优先素材`
  - `Outline 建议骨架`
  - `素材禁区`
  - `镜头禁区`
- 这些结论默认表示“观测到的高频偏好”，不是自动变成所有未来脚本都必须机械复刻的硬模板；只有明确写成禁区或硬约束时才应强约束下游

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

## 一、风格定位与观察范围
...

## 二、节奏阶段拆解
阶段一：
...

阶段二：
...

## 三、剪辑节奏与素材编排
- `aerial`：
- `timelapse`：
- `drive`：
- `talking-head`：
- `broll`：
- `nat sound`：
...

## 四、摄影 / 画面 / 运镜语言
- 高频运镜：
- 低频运镜：
...

## 五、镜头语法与功能分配
- 开场建场：
- 地理重置：
- 情绪释放：
...

## 六、叙事与语言风格
...

## 七、下游消费提示（Script / Recall / Outline）
- Script：
- Recall：
- Outline：
...

## 八、风格禁区
### 素材禁区
1. **...** — ...

### 镜头禁区
1. **...** — ...

## 九、关键参数
| 参数 | 值 |
|------|-----|
| 节奏阶段一 | ... |
| 节奏阶段二 | ... |
| 节奏阶段三 | ... |
| 节奏阶段四 | ... |
| aerial角色 | ... |
| timelapse角色 | ... |
| drive角色 | ... |
| talking-head角色 | ... |
| broll角色 | ... |
| nat sound角色 | ... |
| 高频运镜 | ... |
| 低频运镜 | ... |
| 开场建场镜头语法 | ... |
| 地理重置镜头语法 | ... |
| 情绪释放镜头语法 | ... |
| Recall 优先素材 | ... |
| Outline 建议骨架 | ... |
| 素材禁区 | ... |
| 镜头禁区 | ... |
```

**分析维度清单**：

1. **叙事结构** — 三幕式？线性？段落组织？开头结尾惯例？
2. **语言风格** — 人称、句式、用词偏好、基调
3. **情绪层次** — 情绪光谱、表达克制度、高潮触发
4. **摄影 / 画面 / 运镜语言** — 拍摄母题、光线体系、运镜词汇与镜头组织偏好
5. **节奏阶段拆解** — 不同阶段如何进场、铺垫、观察、抬升与收束
6. **剪辑节奏与素材编排** — `aerial / timelapse / drive / talking-head / broll / nat sound` 的角色与插入时机
7. **镜头语法与功能分配** — 哪些镜头适合开场建场、地理重置、情绪释放
8. **主题与价值观** — 核心主题、文化引用、个人标签
9. **结构模板** — 抽象化的段落结构模板
10. **风格禁区** — 应避免的表达方式；优先拆成素材禁区与镜头禁区
11. **关键参数** — 可被 `kairos-script` 直接消费的稳定参数表格

### Step 7: 存储

**保存风格档案**：

```typescript
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

await mkdir(join(workspaceRoot, 'config/styles'), { recursive: true });
await writeFile(join(workspaceRoot, `config/styles/${category}.md`), markdownContent, 'utf-8');
```

**更新目录注册**：

```typescript
const catalogPath = join(workspaceRoot, 'config/styles/catalog.json');
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

await writeJson(join(workspaceRoot, 'config/styles/catalog.json'), catalog);
```

**保存 ASR 原文备查**：

```typescript
await mkdir(join(workspaceRoot, 'analysis/reference-transcripts'), { recursive: true });
for (const [videoPath, transcript] of transcripts) {
  const name = basename(videoPath, extname(videoPath));
  await writeFile(join(workspaceRoot, `analysis/reference-transcripts/${category}--${name}.txt`), transcript.fullText, 'utf-8');
}
```

**清理临时目录**：

```typescript
import { rm } from 'node:fs/promises';

await rm(join(workspaceRoot, '.tmp/style-analysis', category), {
  recursive: true,
  force: true,
});
```

如果用户正在排查分析问题，或明确要求保留中间结果，则可以跳过这一步。

## 产出

| 文件 | 格式 | 内容 |
|------|------|------|
| `<workspaceRoot>/config/styles/{category}.md` | Markdown (带 front-matter) | 该分类的完整风格档案 |
| `<workspaceRoot>/config/styles/catalog.json` | `IStyleCatalog` | 所有分类的注册表 |
| `<workspaceRoot>/analysis/reference-transcripts/{category}--{name}.txt` | TXT | ASR 原文备查 |
| `<workspaceRoot>/analysis/style-references/{category}/{video-stem}.json` | JSON | 单参考视频分析结果 |

## 与下游对接

`kairos-script` 阶段根据用户选择的分类加载：

```typescript
// 方式 1：按分类名加载
const style = await loadStyleByCategory(join(workspaceRoot, 'config/styles'), 'travel-doc');

// 方式 2：直接加载文件
const style = await loadStyleFromMarkdown(join(workspaceRoot, 'config/styles/travel-doc.md'));

// 查看所有可用分类
const categories = await listStyleCategories(join(workspaceRoot, 'config/styles'));
```

`style.guidancePrompt` 会传递到旁白创作阶段，提醒 agent 遵循用户的创作理念。

`kairos-script` 当前不应只把风格档案当作一篇长文来“感受语气”，而应优先直接读取其中的：

- 节奏阶段拆解
- `aerial / timelapse / drive / talking-head / broll / nat sound` 角色
- 运镜 / 镜头语言
- `开场建场 / 地理重置 / 情绪释放` 功能位偏好
- `参数` 表中的稳定 key
- `风格禁区` 中的素材禁区 / 镜头禁区

这些内容的目标是直接服务 `recall / outline / intro / montage`，而不是让下游再从整篇长文里重新猜一次。

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
- 用户手写风格档案 markdown → 直接放入 `<workspaceRoot>/config/styles/{category}.md` 并注册
- 用户想对比两个分类 → 分别执行分析后，agent 总结差异
