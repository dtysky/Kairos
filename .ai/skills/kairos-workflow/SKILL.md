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

## 项目初始化

在开始任何阶段前，先确保项目已初始化：

```typescript
import { initProject } from 'kairos';
await initProject('/path/to/project', '项目名称');
```

如果当前平台是 Windows，并且后续流程涉及媒体分析或导出，在初始化阶段还应先检查 Windows 原生
`ffmpeg / ffprobe` 是否存在。优先使用当前平台的原生版本；如果没有自动探测到，先要求在项目的
`config/runtime.json` 中显式配置 `ffmpegPath` / `ffprobePath`，而不是直接假设用户需要重新下载安装。

`initProject` 创建目录结构和 4 个种子文件：

```
project/
├── config/
│   ├── ingest-roots.json    # ← initProject 创建（空 roots）
│   ├── runtime.json         # ← initProject 创建（ffmpeg / ffprobe / ml config）
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
├── analysis/
│   ├── reference-transcripts/
│   └── style-references/
└── .tmp/                       # 临时工作区（gitignored，自动创建）
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
产出：`store/slices.json` — `IKtepSlice[]`

前置条件：`store/assets.json` 存在且非空

### Phase 3: Script (脚本创作)

**子 skill**: [kairos-script](../kairos-script/SKILL.md)

输入：`store/slices.json` + 风格档案（`config/styles/{category}.md` 或 `test/style-profile.md`）
产出：`script/current.json` — `IKtepScript[]`

前置条件：`store/slices.json` 存在且非空

**Agent 决策点**：旁白由 agent 自身直接创作，不需要外部 LLM API。

### Phase 4: Timeline (时间线构建)

**子 skill**: [kairos-timeline](../kairos-timeline/SKILL.md)

输入：`store/assets.json` + `store/slices.json` + `script/current.json`
产出：`timeline/current.json` — `IKtepDoc`（完整 KTEP 文档）

前置条件：前 3 阶段产出均存在

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
