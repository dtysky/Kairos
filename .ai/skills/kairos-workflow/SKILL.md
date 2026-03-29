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

这会创建以下目录结构：

```
project/
├── config/
│   ├── ingest-roots.json    # 素材根目录配置
│   └── styles/              # 分类风格档案
│       ├── catalog.json     # 风格目录
│       └── {category}.md    # 各分类的风格 markdown
├── store/
│   ├── project.json          # 项目信息 (IKtepProject)
│   ├── manifest.json         # 版本跟踪
│   ├── assets.json           # Phase 1 产出
│   └── slices.json           # Phase 2 产出
├── media/                    # 关键帧等中间数据
├── script/
│   └── current.json          # Phase 3 产出
├── timeline/
│   └── current.json          # Phase 4 产出 (IKtepDoc)
├── subtitles/                # SRT/VTT 导出
├── adapters/                 # NLE 适配器数据
└── analysis/
    └── reference-transcripts/ # 风格分析的 ASR 原文
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

**子 skill**: [kairos-export](../kairos-export/SKILL.md)

输入：`timeline/current.json`
产出：剪映草稿 + `subtitles/*.srt`

前置条件：`timeline/current.json` 存在且通过 KTEP 校验

## 状态检查

在每个阶段开始前，检查前置文件是否存在：

```typescript
import { readJsonOrNull } from 'kairos';
const assets = await readJsonOrNull('store/assets.json', z.array(IKtepAsset));
if (!assets || assets.length === 0) {
  // 需要先执行 Phase 1
}
```

## 跳阶段执行

不必每次从头开始。如果某阶段产出已存在，可以直接从下一阶段继续。例如素材分析很耗时，分析完一次后可以反复修改脚本和时间线。

## 迭代修改

Phase 3 和 Phase 4 支持迭代：
- 修改脚本后重新构建时间线
- 用 `script-editor` 微调旁白后重新导出
- 调整时间线参数（转场、字幕）后重新导出

## 跨设备

ML server 可以运行在另一台 GPU 机器上，通过 `KAIROS_ML_URL` 环境变量连接。
详见 [deploy-kairos](../deploy-kairos/SKILL.md)。
