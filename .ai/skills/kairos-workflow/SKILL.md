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

## 变更工作流规则

只要本轮任务涉及需求、行为、接口、工作流、正式入口或用户路径变更，必须遵守下面顺序：

1. 先进入 `Plan` 模式；如果宿主没有显式 `Plan mode`，先给出结构化计划并得到确认。
2. 计划确认后，先更新相关设计文档，再开始实现。
3. 实现完成后，必须回查并同步受影响的设计文档、rules 和 skills，再结束本轮。
4. 如果变更影响正式入口、监控页、工作流主路径或用户操作方式，还要同步更新 `README.md`、`designs/current-solution-summary.md` 和 `designs/architecture.md`。

## 强规则：Pharos 相关实现前先做协议 hash 校验

只要本轮任务涉及 `Pharos`，必须先执行：

1. 运行 `node scripts/pharos-protocol-hash.mjs`
2. 将结果与 `.ai/pharos-protocol-baseline.json` 对比
3. 如果 hash 不一致，先重读 `../Pharos/designs/` 下相关协议文档，再给计划或实现

不要只根据 Kairos 仓库里的旧设计印象实现 `Pharos` 集成。

## 正式控制面

- 当前正式运行与监控入口是 `Supervisor + React console (apps/kairos-console/)`
- `Analyze` 与 `Style` 的正式监控路由分别是 `http://127.0.0.1:8940/analyze` 和 `http://127.0.0.1:8940/style`
- 旧静态监控页和兼容脚本只保留调试 / 兼容用途，不能再被当成新的正式入口

## 进程收尾规则

- 只要 agent 在某个阶段里主动启动过辅助进程，就必须在该阶段结束后主动清理；除非用户明确要求保留
- 典型对象包括：本地监控面板、agent 本轮主动拉起的 ML server、临时 HTTP server、一次性调试进程、临时 watcher
- 如果 ML server 是 agent 本轮主动拉起的，也必须在阶段结束后停掉；不要因为它是“服务”就默认留着
- 不要清理由用户本来就在跑的长期服务，例如用户自己维护的 ML server、别的项目面板、用户手动启动的开发服务
- 如果阶段失败或被用户中断，也要做同样的收尾检查，避免留下孤儿进程

## 准备阶段：Style Analysis（分类风格分析）

**子 skill**: [kairos-style-analysis](../kairos-style-analysis/SKILL.md)

**可选但推荐**。从用户的历史成片中按分类提取风格档案。

输入：
- 分类名称（如 `travel-doc`、`city-walk`）
- 用户指导词（描述分析侧重和创作理念）
- 该分类的 1-5 个历史作品视频

产出：`<workspaceRoot>/config/styles/{category}.md` + `<workspaceRoot>/config/styles/catalog.json`

可以为不同类型的作品建立多个风格档案，在 Phase 3 选择使用。
如果用户已有手写风格档案（如 `test/style-profile.md`），可以跳过此步直接使用。

风格档案是 Phase 3（Script）的核心输入，决定了旁白的语言风格、叙事结构和情绪表达方式。

**重要规则**：
- 风格档案必须由用户人工指定；系统不能根据当前项目素材自动生成、自动挑选或自动推断风格档案。
- 如果用户没有明确指定风格档案（或明确说明这次不用风格档案），Workflow 必须停在 Script 之前，先向用户确认。
- `kairos-style-analysis` 只能在用户明确要求做风格分析时执行，不能被 Workflow 隐式触发。

## 项目初始化

在开始任何阶段前，先确保项目已初始化。当前的项目模型是：

**子 skill**: [kairos-project-init](../kairos-project-init/SKILL.md)

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
- `config/device-media-maps.local.json`

如果下一步就是跑 Ingest，优先直接调用 `ingestWorkspaceProjectMedia()`；当前实现会在检测到
`project-brief.md` 已配置路径映射时，先自动同步一次再继续扫描。

如果当前平台是 Windows，并且后续流程涉及媒体分析或导出，在初始化阶段还应先检查 Windows 原生
`ffmpeg / ffprobe` 是否存在。优先使用当前平台的原生版本；如果没有自动探测到，先要求在项目的
`config/runtime.json` 中显式配置 `ffmpegPath` / `ffprobePath`，而不是直接假设用户需要重新下载安装。

`initWorkspaceProject` / `initProject` 现在会创建这些目录和种子文件：

```
project/
├── config/
│   ├── ingest-roots.json    # ← initProject 创建（空 roots）
│   ├── project-brief.md     # ← initProject 创建（项目说明 + 路径映射模板）
├── gps/
│   ├── tracks/              # ← initProject 创建（项目级 GPX 目录）
│   └── same-source/
│       └── tracks/
├── store/
│   ├── project.json          # ← initProject 创建（IKtepProject）
│   └── manifest.json         # ← initProject 创建（IStoreManifest）
├── media/
├── .tmp/
├── script/
│   ├── script-brief.md       # ← initProject 创建（脚本 brief 初始模板）
│   └── versions/
├── timeline/
│   └── versions/
├── subtitles/
├── adapters/
└── analysis/
    └── asset-reports/
```

注意：
- `config/device-media-maps.local.json` 不是 `initProject` 自动产物，而是在首次同步 `project-brief` 或显式保存项目本机路径映射后生成
- `config/runtime.json` 现在是可选本地运行时覆盖，不是自动种子文件

后续各阶段产出的文件：

```
project/
├── gps/
│   ├── tracks/*.gpx          # 项目级外部 GPX
│   ├── merged.json           # 项目级外部 GPX merged cache
│   ├── same-source/index.json
│   ├── same-source/tracks/*.gpx
│   └── derived.json          # project-derived-track cache
├── store/
│   ├── assets.json           # Phase 1 (Ingest) 产出；same-source GPS 只保留 lightweight embeddedGps refs
│   └── slices.json           # Phase 2 (Analyze) 产出
├── script/
│   ├── script-brief.md       # Console / Agent 审查入口
│   └── current.json          # Agent 在 Phase 3 (Script) 产出
├── timeline/
│   └── current.json          # Phase 4 (Timeline) 产出 — IKtepDoc
├── subtitles/
│   └── *.srt / *.vtt         # Phase 5 (Export) 产出
└── analysis/
    └── asset-reports/*.json   # Phase 2 (Analyze) 产出
```

另外还有 workspace 级共享风格资产：

```
<workspaceRoot>/
├── config/
│   ├── style-sources.json     # Style Analysis / Console 的风格来源配置
│   └── styles/
│       ├── catalog.json       # Style Analysis 产出
│       └── {category}.md      # Style Analysis 产出
└── analysis/
    ├── reference-transcripts/ # Style Analysis 的 ASR 原文
    └── style-references/      # 单参考视频分析结果
```

## 5 个阶段

### Phase 1: Ingest (素材导入)

**子 skill**: [kairos-ingest](../kairos-ingest/SKILL.md)

输入：用户指定的素材目录
产出：`store/assets.json` — `IKtepAsset[]`

前置条件：项目已初始化

补充口径：
- dense sidecar `.SRT` / DJI FlightRecord 轨迹会规范化写到 `gps/same-source/tracks/*.gpx` + `gps/same-source/index.json`
- 这套内部 GPX 只用于 same-source 索引 / 惰性查找，不改变 `embedded GPS > project GPX > project-derived-track` 的正式优先级
- 照片拍摄时间默认优先吃 EXIF 原始时间和时区；如果照片自身带 GPS，也应直接作为 `embedded GPS` 真值
- 如果 ingest 发现素材时间和项目时间线明显冲突，必须把待校正项追加到 `config/manual-itinerary.md` 末尾的“素材时间校正”表格，并阻塞后续阶段

### Phase 2: Analyze (素材分析)

**子 skill**: [kairos-analyze](../kairos-analyze/SKILL.md)

输入：`store/assets.json`
产出：
- `analysis/asset-reports/*.json` — 单素材 coarse report
- `store/slices.json` — `IKtepSlice[]`
- `media/chronology.json` — 时间排序视图

前置条件：`store/assets.json` 存在且非空

**强规则**：
- Workflow 在进入 Analyze 前，必须先执行一次 GPS 规则提示，不能直接开跑
- Workflow 在真正启动 Analyze 前，还必须确认 ML server 可用；如果 health check 不通，应该直接停在这里并提示用户修复，而不是静默退化成无 ML 分析
- 至少要向用户说明：`embedded GPS > project GPX > project-derived-track > none`
- 必须结合当前项目状态指出：是否已有项目级 GPX、是否已有 `gps/derived.json`、是否已有 `config/manual-itinerary.md`
- 如果缺少 GPX 且缺少 `gps/derived.json`，必须明确提示：没有 embedded GPS 的素材将没有空间 fallback
- 如果用户刚修改了 `manual-itinerary` 但还没重新跑 ingest，必须明确提示：需要先刷新 `gps/derived.json`
- 如果 `manual-itinerary` 末尾“素材时间校正”表格还有未填写或未重新 ingest 应用的条目，Workflow 必须停在 Analyze 之前
- 如果用户手里拿的是 sidecar `.SRT` 或 DJI FlightRecord 日志，必须明确提示：这类输入属于 `embedded GPS` 标准链路，不是普通 GPX
- 必须指导用户选择：补 GPX、给对应 root 配置 `飞行记录路径`、填写/更新 `manual-itinerary` 后 rerun ingest，或明确接受“部分素材没有空间结果”后继续
  - 当用户选择填写 `manual-itinerary` 时，默认应推荐一句自然语言一段，而不是要求先写成 key-value 表单
  - 推荐示例：`2026.02.17，早上九点左右，开车从新西兰皇后镇出发`
- 如果是时间线冲突导致的阻塞，必须明确指导用户去填 `manual-itinerary` 末尾表格里的 `正确日期 / 正确时间 / 时区`，然后 rerun ingest
- 只有在用户明确确认继续后，才可以调用 Analyze

当前分析链路除了视觉粗扫/细扫，还会在符合条件的视频上补充 ASR：
- 结构上更准确的理解是：
  - 有音轨视频：`coarse-scan -> audio-analysis -> finalize -> 细扫决策 -> 细扫执行`
  - 无音轨视频：`coarse-scan -> finalize -> 细扫决策 -> 细扫执行`
- `coarse-scan` 当前是素材级动态并发：同一素材在 coarse 阶段最多一个抽帧 `ffmpeg`，但多个素材会按 free memory 目标并发推进
- `audio-analysis` 当前是两级素材队列：先做本地健康检查/保护音轨选边，再把最终选中的一路送入 ASR 队列
- coarse report 会带 `transcript / transcriptSegments / speechCoverage`
- 语音时间窗会参与 fine-scan window 生成
- chronology 会写入部分 ASR evidence
- 对带 `protectionAudio` 的素材，当前正式策略是双健康检查后只跑一侧 ASR；如果 protection 被选中，它就直接成为正式 transcript 来源
- 当前正式项目的音频分析主路径指的是“视频素材里的音轨”，不是独立纯音频资产
- 如果后续项目真的引入独立音频素材，再补单独 analyze 分支；当前不要把这点和视频内语音 ASR 混为一谈

### Phase 3: Script (脚本创作)

**子 skill**: [kairos-script](../kairos-script/SKILL.md)

输入：素材分析结果（`store/slices.json`、`analysis/asset-reports/`、`media/chronology.json`）+ 风格档案（`<workspaceRoot>/config/styles/{category}.md` 或 `test/style-profile.md`）
产出：`script/current.json` — `IKtepScript[]`

前置条件：`store/slices.json` 存在且非空

**Agent 决策点**：旁白由 agent 自身直接创作，不需要外部 LLM API。

**重要规则**：
- 风格档案必须由用户人工指定；不能根据当前项目素材自动生成、自动挑选或自动推断。
- 如果用户还没有指定风格档案，或没有明确说这次不用风格档案，就不能开始 Script 阶段。
- 项目只保存 `styleCategory` 选择，不再持有自己的 `config/styles/` 风格库。
- `Supervisor + React console` 里的 `script` job 现在只负责 deterministic prep：
  - 校验 `store/slices.json`
  - 校验 `styleCategory`
  - 校验 workspace style profile
  - 刷新 `analysis/material-digest.json`
  - 在缺失时写最小 `script/script-brief.md`
- 正式脚本作者是 Agent；`script/current.json` 不应由 Console / Supervisor 自动写入
- 用户应先审查 `script/script-brief.md`，再让 Agent 继续推进段落规划、outline 和正式脚本
- ASR transcript 已经是正式证据源之一，可参与 candidate recall、outline 和 beat 写作
- 但“素材里有声音”不等于“成片一定保留原声”；脚本应通过 `preserveNatSound / muteSource` 表达明确意图，未标注时交给 Timeline 自动推论
- 如果一个 beat 内存在明确的头部 / 中间 / 尾部停顿，Script 阶段应优先写 `beat.utterances[]`，而不是假设字幕会自动在整拍里留白

### Phase 4: Timeline (时间线构建)

**子 skill**: [kairos-timeline](../kairos-timeline/SKILL.md)

输入：`store/assets.json` + `store/slices.json` + `script/current.json`
产出：`timeline/current.json` — `IKtepDoc`（完整 KTEP 文档）

前置条件：前 3 阶段产出均存在

当前 Timeline 阶段的字幕有两条正式路径：
- 旁白路径：按 `beat.text` 切字幕
- 原声路径：当选中的 slice 带 transcript 且判断应保留原声时，按 `transcriptSegments` 直接落字幕
- 若 `beat.utterances[]` 存在，Timeline 会按 utterance + pause 生成多个有声岛
- 默认输出规格走项目 `config/runtime.json` 中的 `timelineWidth / timelineHeight / timelineFps`；未配置时 fallback 为 `3840x2160 @ 30fps`

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

**强规则**：
- 在真正进入 Export 前，必须先解析最终输出路径；不要只拿一个导出根目录或 NLE 草稿库根目录就开始写。
- 只要最终导出目录已存在，就必须阻塞并等待用户改用新的目录名；禁止覆盖、删除、清空或重建旧导出目录。
- Workflow 不得把用户真实的 NLE 草稿库根目录当成单个导出目录。
- 如果底层导出器默认会 replace / delete existing output，必须先显式关闭；无法关闭时不能继续。
- 默认导出到新的版本化或时间戳目录，而不是复用旧目录。
- 如果任务是修改已有草稿 / 工程，而不是新建导出，必须先核对目标对象的准确路径、名称和可读元数据；目标未确认前不能进入写入步骤。
- 如果用户只说“改刚才那个草稿”“修一下当前稿子”，必须先把候选对象列出来并得到明确确认，不能自己猜。

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
