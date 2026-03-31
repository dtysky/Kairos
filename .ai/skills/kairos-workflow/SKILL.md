---
name: kairos-workflow
description: >-
  Master workflow for Kairos video post-production. Orchestrates the full pipeline
  from raw media to NLE export in 5 phases. Use when the user wants to produce a
  video, start a new project, or run the full Kairos pipeline.
---

# Kairos: Master Workflow

## Overview

Kairos 将旅拍素材转化为可编辑时间线。流程分为 1 个准备阶段 + 5 个主阶段，每个阶段有独立的子 skill，本 skill 负责总控。

```
[Style Analysis] → Ingest → Analyze → Script → Timeline → Export
```

## 准备阶段：Style Analysis（分类风格分析）

**子 skill**: [kairos-style-analysis](../kairos-style-analysis/SKILL.md)

**可选但推荐**。从用户的历史成片中按分类提取风格档案。

输入：
- 分类名称（如 `travel-doc`、`city-walk`）
- 用户指导词（描述分析侧重和创作理念）
- 该分类的 1-5 个历史作品视频

产出：`config/styles/{category}.md` + `config/styles/catalog.json`

可以为不同类型的作品建立多个风格档案，在 Phase 3 选择使用。
如果用户已有手写风格档案（如 `test/style-profile.md`），可以跳过此步直接使用。

风格档案是 Phase 3（Script）的核心输入，决定了旁白的语言风格、叙事结构和情绪表达方式。

**重要规则**：
- 风格档案必须由用户人工指定；系统不能根据当前项目素材自动生成、自动挑选或自动推断风格档案。
- 如果用户没有明确指定风格档案（或明确说明这次不用风格档案），Workflow 必须停在 Script 之前，先向用户确认。
- `kairos-style-analysis` 只能在用户明确要求做风格分析时执行，不能被 Workflow 隐式触发。

## 项目初始化

在开始任何阶段前，先确保项目已初始化。当前的项目模型是：

```text
<kairos_workspace>/
└── projects/
    └── <projectId>/
```

初始化推荐直接走 workspace 入口：

```typescript
import { initWorkspaceProject } from 'kairos';
await initWorkspaceProject(
  'H:\\SpriaHeaven\\Kairos',
  'new-zealand-documentary',
  '新西兰纪录片',
  '新西兰纪录片正式项目',
);
```

初始化后会自动生成：
- `config/project-brief.md`

这个文件是给用户自然语言填写项目说明和素材路径映射的入口。后续应先提示用户按下面这种模板补充：

```text
路径：
F:\你的素材目录

说明：
主机位，风景、步行、口播都有
```

用户填完 `project-brief.md` 后，不要手工再抄一遍配置；应把它当成路径映射的输入源，同步到：
- `config/ingest-roots.json`
- `~/.kairos/device-media-maps.json`

如果当前平台是 Windows，并且后续流程涉及媒体分析或导出，在初始化阶段还应先检查 Windows 原生
`ffmpeg / ffprobe` 是否存在。优先使用当前平台的原生版本；如果没有自动探测到，先要求在项目的
`config/runtime.json` 中显式配置 `ffmpegPath` / `ffprobePath`，而不是直接假设用户需要重新下载安装。

`initWorkspaceProject` / `initProject` 会创建这些种子文件：

```
project/
├── config/
│   ├── ingest-roots.json    # ← initProject 创建（空 roots）
│   ├── runtime.json         # ← initProject 创建（ffmpeg / ffprobe / ml config）
│   ├── project-brief.md     # ← initProject 创建（项目说明 + 路径映射模板）
│   └── styles/              # ← initProject 创建（空目录）
├── store/
│   ├── project.json          # ← initProject 创建（IKtepProject）
│   └── manifest.json         # ← initProject 创建（IStoreManifest）
├── media/
├── script/
│   └── versions/
├── timeline/
│   └── versions/
├── subtitles/
├── adapters/
└── analysis/
    └── reference-transcripts/
```

后续各阶段产出的文件：

```
project/
├── config/styles/
│   ├── catalog.json          # Style Analysis 产出
│   └── {category}.md         # Style Analysis 产出
├── store/
│   ├── assets.json           # Phase 1 (Ingest) 产出
│   └── slices.json           # Phase 2 (Analyze) 产出
├── script/
│   └── current.json          # Phase 3 (Script) 产出
├── timeline/
│   └── current.json          # Phase 4 (Timeline) 产出 — IKtepDoc
├── subtitles/
│   └── *.srt / *.vtt         # Phase 5 (Export) 产出
└── analysis/
    └── reference-transcripts/ # Style Analysis 的 ASR 原文
```

## 5 个阶段

### Phase 1: Ingest (素材导入)

**子 skill**: [kairos-ingest](../kairos-ingest/SKILL.md)

输入：用户指定的素材目录
产出：`store/assets.json` — `IKtepAsset[]`

前置条件：项目已初始化

### Phase 2: Analyze (素材分析)

**子 skill**: [kairos-analyze](../kairos-analyze/SKILL.md)

输入：`store/assets.json`
产出：
- `analysis/asset-reports/*.json` — 单素材 coarse report
- `store/slices.json` — `IKtepSlice[]`
- `media/chronology.json` — 时间排序视图

前置条件：`store/assets.json` 存在且非空

当前分析链路除了视觉粗扫/细扫，还会在符合条件的视频上补充 ASR：
- 结构上更准确的理解是：`视觉粗扫 -> 音频分析 -> 细扫决策 -> 细扫执行`
- coarse report 会带 `transcript / transcriptSegments / speechCoverage`
- 语音时间窗会参与 fine-scan window 生成
- chronology 会写入部分 ASR evidence
- 当前正式项目的音频分析主路径指的是“视频素材里的音轨”，不是独立纯音频资产
- 如果后续项目真的引入独立音频素材，再补单独 analyze 分支；当前不要把这点和视频内语音 ASR 混为一谈

### Phase 3: Script (脚本创作)

**子 skill**: [kairos-script](../kairos-script/SKILL.md)

输入：素材分析结果（`store/slices.json`、`analysis/asset-reports/`、`media/chronology.json`）+ 风格档案（`config/styles/{category}.md` 或 `test/style-profile.md`）
产出：`script/current.json` — `IKtepScript[]`

前置条件：`store/slices.json` 存在且非空

**Agent 决策点**：旁白由 agent 自身直接创作，不需要外部 LLM API。

**重要规则**：
- 风格档案必须由用户人工指定；不能根据当前项目素材自动生成、自动挑选或自动推断。
- 如果用户还没有指定风格档案，或没有明确说这次不用风格档案，就不能开始 Script 阶段。
- 先由系统根据素材分析结果和风格档案自动起草 `script/script-brief.md`
- 这份 brief 里应包含：全片目标建议、叙事约束建议、段落方案建议、每段的简单备注
- 用户只需要在这份初稿基础上审查和修改，不应要求用户从空白开始填写
- 在用户审查 `script/script-brief.md` 之前，不应直接把段落方案推进到正式脚本
- 素材归纳（material digest）可以由规则和统计生成，但**段落规划（segment plan drafts）必须由 LLM 主驱动生成**
- 启发式规则只能作为 fallback，不能作为默认或主要的段落规划方案来源
- ASR transcript 已经是正式证据源之一，可参与 candidate recall、outline 和 beat 写作
- 但“素材里有声音”不等于“成片一定保留原声”；脚本应通过 `preserveNatSound / muteSource` 表达明确意图，未标注时交给 Timeline 自动推论

### Phase 4: Timeline (时间线构建)

**子 skill**: [kairos-timeline](../kairos-timeline/SKILL.md)

输入：`store/assets.json` + `store/slices.json` + `script/current.json`
产出：`timeline/current.json` — `IKtepDoc`（完整 KTEP 文档）

前置条件：前 3 阶段产出均存在

当前 Timeline 阶段的字幕有两条正式路径：
- 旁白路径：按 `beat.text` 切字幕
- 原声路径：当选中的 slice 带 transcript 且判断应保留原声时，按 `transcriptSegments` 直接落字幕

### Phase 5: Export (NLE 导出)

**子 skill**:
- [kairos-export](../kairos-export/SKILL.md) — 导出路由
- [kairos-export-jianying](../kairos-export-jianying/SKILL.md) — 导出到剪映
- [kairos-export-resolve](../kairos-export-resolve/SKILL.md) — 导出到达芬奇

输入：`timeline/current.json`
产出：按目标 NLE 生成草稿 / 时间线 + `subtitles/*.srt`

前置条件：`timeline/current.json` 存在且通过 KTEP 校验

执行方式：
- 若用户已明确目标 NLE，直接选择对应导出 skill
- 若用户只说“导出”，先用 `kairos-export` 决定目标，再路由到具体 skill

## 状态检查

在每个阶段开始前，检查前置文件是否存在：

```typescript
import { readJsonOrNull } from 'kairos';
import { join } from 'node:path';

const assets = await readJsonOrNull(join(projectRoot, 'store/assets.json'), z.array(IKtepAsset));
if (!assets || assets.length === 0) {
  // 需要先执行 Phase 1
}
```

## 跳阶段执行

不必每次从头开始。如果某阶段产出已存在，可以直接从下一阶段继续。例如素材分析很耗时，分析完一次后可以反复修改脚本和时间线。

## 素材追加

项目创建后可以随时追加新素材，不需要重头来过：

```
已有项目 → 追加 Ingest → 增量 Analyze → 重写 Script → 重建 Timeline → 重新 Export
```

### 追加流程

1. **追加导入**：`kairos-ingest` 的增量模式，按 `sourcePath` 自动去重

```typescript
const result = await appendAssets(projectRoot, newAssets);
// result.added — 实际新增资产
// result.duplicateCount — 跳过的重复
```

2. **增量分析**：`kairos-analyze` 自动识别未分析的资产，仅对新素材执行分析

```typescript
const toAnalyze = findUnanalyzedAssets(allAssets, existingSlices);
// 仅对 toAnalyze 中的资产做镜头检测、ML 分析
await appendSlices(projectRoot, newSlices);
```

3. **重新创作**：Phase 3-5 需要在新素材的基础上重新执行
   - 脚本需要重写（新素材可能改变叙事结构）
   - 时间线需要重建
   - 导出需要重做

### 注意事项

- 每个资产有 `ingestedAt` 时间戳，可以区分不同批次
- 可以用 `ingestRootId` 标记批次来源
- 已有的切片和证据不会丢失，新分析结果追加到后面
- 如果需要重新分析某个旧资产，`appendSlices` 会替换该资产的旧切片

## 迭代修改

Phase 3 和 Phase 4 支持迭代：
- 修改脚本后重新构建时间线
- 用 `script-editor` 微调旁白后重新导出
- 调整时间线参数（转场、字幕）后重新导出

## 跨设备

ML server 可以运行在另一台 GPU 机器上，通过 `KAIROS_ML_URL` 环境变量连接。
详见 [deploy-kairos](../deploy-kairos/SKILL.md)。
