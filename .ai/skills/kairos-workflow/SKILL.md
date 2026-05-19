---
name: kairos-workflow
description: >-
  Master workflow for Kairos video post-production. Orchestrates the full pipeline
  from raw media to NLE export in 5 phases. Use when the user wants to produce a
  video, start a new project, or run the full Kairos pipeline.
---

# Kairos: Master Workflow

## Overview

Kairos 将旅拍素材转化为可编辑时间线。流程分为准备阶段、素材事实阶段、编年史审查、剪辑规则驱动的 Edit Flow，以及导出。本 skill 负责总控。

```
[Edit Rules + optional Style Reference] → Ingest → Analyze → Chronology(Spans + Review) → Edit Flow(capability steps) → Export
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
3. 如果 hash 不一致，先把本轮任务切到 Pharos 协议同步：重读当前 `../Pharos/designs`、同步 Kairos 设计文档 / rules / skills / 代码影响、运行 `node scripts/pharos-protocol-hash.mjs --write-baseline`，再用 `--check` 确认 baseline 已匹配

不要只根据 Kairos 仓库里的旧设计印象实现 `Pharos` 集成；baseline 仍不匹配时，不要继续普通 Pharos 功能工作。

## 正式控制面

- 当前正式运行与监控入口是 `Supervisor + React console (apps/kairos-console/)`
- `Analyze` 与 `Style` 的正式监控路由分别是 `http://127.0.0.1:8940/analyze` 和 `http://127.0.0.1:8940/style`
- `DaVinci color` 当前已有独立 `/color` 主路由，正式承担 root 级最小 `renderPreset`、Resolve group 镜像、执行与 validation 控制
- 任何 DaVinci Resolve scripting、`/color`、Resolve export、DRX/DRT、LUT、render job、Group、node graph 或 vendored Resolve host 任务，必须先读 `.ai/knowledge/davinci-resolve-scripting.md`，再按安装版 Resolve `README.txt` 校验版本敏感 API
- `/color` 当前应自动发现已配置 `rawPath` 的素材根，并派生约定命名与阻塞信息；不要把“还没接通全部宿主健壮性”误渲染成“没有可显示 root”
- 当前 `Supervisor color` 的正式动作链是 `prepare_root -> sync_groups -> execute_root -> validate_batch -> prepare_all_roots -> export_all_roots`
- 当前 `prepare_root` 必须真实完成 `rawLocalPath -> Resolve root bins / single root grading timeline / explainable creative Groups + canonical clip repair layout` 的同步，而不是只持久化 Kairos 侧占位状态；大素材 root 默认按稳定 50-clip chunks 分批导入并追加到同一条 root grading timeline，避免一次性把整 root 塞进内存
- 当前 Group 真相以 Resolve 为准；用户可直接在 Resolve 中调整 Group，再通过 `/color` 的 `sync_groups` 回写最新现状；不存在额外 `Confirm Groups` 步骤
- `/color` 当前进入页面或切换项目时会自动执行 host preflight，并允许用户手动 `Recheck Host`
- `/color` 当前还提供 `保存 DRP 快照` 与外部 `.drp` 登记入口；自动 DRP 只在 root prepare 全部 chunks 完成后导出一次，人工入口也把 Resolve 工程快照落到 `color/resolve-projects/<safe-project-name>/`，并维护 `latest.drp` / `color/resolve-project-map.json`
- 当前 `prepare_root / sync_groups / execute_root / prepare_all_roots / export_all_roots` 都必须先通过 host preflight；若宿主 blocked 或当前 render preset 不受支持，应在 Resolve 变更前直接失败
- 当前 color 导出真相是 root grading timeline：render preset 是 root 级长期配置，batch 只是执行/重试粒度，可选携带 `clipKeys[]` 做 subset rerun；Resolve Groups 只承担组织与诊断语义，不再决定导出分批
- 当前 color `execute_root` 成功后会随调色视频同步同 basename sidecar：`.srt/.xml/.gyroflow/.wav/.flac/.m4a/.aac/.mp3`，sidecar 必须进入 manifest 与 validation 管理
- 当前 `/color` 还正式提供项目级 deterministic 批处理：
  - `Prepare All Roots`：按当前 read model 的 enabled root priority 顺序依次执行 `prepare_root`
  - `Export All Roots`：按同一顺序依次执行 `execute_root`；每个 root 内部完成 render all、最终 replace、metadata 修复与 validation
  - 两个项目级动作都继续其他 roots，但任一 root 失败都会让整个 color job 记为 failed
- 当前 color creative / repair 真相已经分层：
  - `Group Post-Clip` 是唯一正式 creative 真相
  - `Clip` 是固定 repair/local-exception 层，不承担主 creative
  - 自动 Group 当前以 `logProfile` 为前置分组轴，再在同一 log bucket 内按 first-match addon 分桶：`portrait-review -> lowlight -> 高置信 colorCastClass -> 明显 exposureSceneClass`；`gyro` 是 clip 级 repair 信号，不再参与分桶
- 当前 `lowlight` 是中点单帧视觉 creative 标签，不是 metadata fallback，也不等价于“必须降噪”
- 当前 `colorCastClass` 是便宜数值色偏标签：默认取 clip 中点单帧 proxy；若能解析到当前 root/profile 的技术 LUT，则先用同路径 `.cube` 转换 proxy，再做中性区域色偏判断。强冷蓝偏移归入 `cool-cyan`，绿青混合偏移归入 `green-cyan`，且 `prepare_root` 会对同一 root / 同一 log profile 内连续素材做轻量平滑，避免一个中点帧偏中性就切碎连续冷色路段；已诊断为 `white-reference-underexposed` 的 clip 不参与这种弱连续性提升。它只用于把 `cool-cyan / green-cyan / green / warm / mixed` 素材拆到独立 Group；不判断原因是否一定是前挡膜，`neutral / unknown` 不参与分桶
- 当前 `portrait-review` 是 `orientationStatus=portrait` 的 review addon，用于把竖屏素材在当前 log 下拆成单独 Group 给人工 review；它不改变竖屏 Gyro/DRT、repair template 或横屏 timeline transform 合同
- 当前 `exposureSceneClass` 是解 log / 技术 LUT 后 proxy 画面的便宜数值曝光标签；只有明显 `high-contrast / overexposed / underexposed` 在未命中更高优先级 addon 时才拆 Group，`normal / unknown` 仅作为诊断显示；`high-contrast` 也覆盖逆光/剪影或车内窗外这类高光面积可能较窄但亮暗尾部跨度很大的场景；`overexposed` 保持保守，只覆盖明确剪白或高亮面积/亮度明显偏高的画面，不再把泛洗白路面或高键灰雾画面批量纳入；`underexposed` 也覆盖单帧雪景等低饱和高键白参考区域被压灰且无真实高光尾部的 `white-reference-underexposed` 诊断，metrics 保留白参考覆盖率、目标 EV 提亮量、提亮后高光余量；该子类保持 `exposureSceneClass=underexposed` 但 Resolve Group addon 使用 `white-reference-underexposed`
- repair 当前正式走“同 clip 旧 repair 用 Resolve `CopyGrades` 保留；没有既存 repair 时建立 canonical clip graph”的路线
- clip repair 的正式布局固定为：
  - 所有可执行视频 clip：`Gyro -> Dehaze -> User1 -> User2 -> NR`
  - `Gyro` 固定为第 1 节点；每次 `prepare_root` 都按最终 `gyroEligible` 布尔判定重申 node1 开关，`gyroEligible=true` 请求开启并记为 `ready-to-load`，`gyroEligible=false` 请求关闭并记为 `seeded-disabled`
  - `ready-to-load` 只表示 Gyroflow OFX shell 存在且 Kairos 已请求正确 node 启停，不表示 Gyroflow 已执行 source-specific `Load for current file`
  - `gyroEligible` 必须来自显式声明：同名 `.gyroflow` 可开启 Gyro；带 Gyroscope 且型号受支持的 Sony XML sidecar 可开启 Gyro。默认 prepare 不深扫嵌入式私有 telemetry；DJI `dvtm_*` 私有 telemetry 不扫描、不能单独开启 Gyro，也不能据此猜测 log profile
  - `Dehaze` 固定为第 2 节点且默认禁用
  - `User1 / User2` 是最小用户区，默认开启；用户扩展节点必须放在 `Dehaze` 之后、`NR` 之前
  - `NR` 对所有视频 clip 固定预留在尾部且默认禁用，正式开关入口只有 Resolve
  - `lowlight` 继续只是 creative 标签与状态提示，不自动开启 `Dehaze / NR`
- ZV-E1 / Sony 竖屏素材可以进入 Gyro 路径，但必须方向感知：Kairos 从 ffprobe `rotate/display matrix` 解析方向，横屏用 `config/default.drt`；ffprobe 源 `rotation=90` 会写 `RotationAngle=-90`，但按 Gyroflow `270` 使用 `config/gyroflow-portrait--90.drt`；ffprobe 源 `rotation=-90/270` 会写 `RotationAngle=90`，但按 Gyroflow `90` 使用 `config/gyroflow-portrait-90.drt`；缺少方向 DRT 时只禁用该 clip 的自动 Gyro seed 并标记 `pending-orientation-template`
- `/color` 默认把竖屏素材导出成横屏单 clip：`prepare_root` 对竖屏 timeline item 写入 `RotationAngle / ZoomX / ZoomY / ZoomGang / Pan / Tilt`，旋转并放大填满横屏 root timeline；横向编码但 display-matrix 竖屏的素材需要额外 fill zoom，避免 Gyroflow/DRT 输出层留下居中小画面；Gyroflow OFX 内部 orientation 仍由方向专用 DRT 提供，不通过 Resolve scripting 猜参数
- portrait DRT hash 缺失或过期时，`prepare_root` 只重跑命中的 chunk，并对 stale portrait clip 先执行 `ResetAllGrades()` 清掉旧 repair/OFX state，再重新应用方向 DRT；最终 `sync_groups` 要把当前 DRT hash 写回 clip snapshot，后续 hash 未变时才走 canonical preserve
- 旧非规范 clip graph 记为 `legacy-layout`；本轮允许在 workspace `config/default.drt` 存在时破坏性重建到 canonical layout，不存在时 bulk prepare 跳过自动 repair seed 并标记 `pending-template`；规范图重跑保留用户区状态与用户手动切换的 Dehaze/NR 状态，但仍按最终 `gyroEligible` 重申 Gyro node1 开关；`NR` 后新增节点也视为 legacy
- 只使用 clean DRT donor 做正式自动 clip repair seeding：旧 `gyro-only.drt + CopyGrades + render` 已实测可触发 Gyroflow source-specific load；DRX 仅保留为人工诊断材料，不再作为 bulk prepare fallback
- `/color` 当前继续保持单页，但页面信息架构正式收口为 `Root 摘要 -> 当前 Root Hero -> 所有 Root 常驻可编辑配置 -> Groups -> 次级诊断/归档`
- `/color` 上所有 root 的用户可编辑项都必须保持在主信息流中直接可见且同页可维护；折叠区只保留只读的 `Host Diagnostics / Recent Batches / Validation Failures` 与技术调试信息
- 当前 color 的长期配置只保留项目级 root 上的 `color.renderPreset`；不要再把 `resolveProjectName / rootNamespace / gradingTimelineName / bootstrap Group` 当成用户配置项
- `color.renderPreset` 当前正式 bitrate 字段只有 `bitrateKbps`（`kb/s`）；不要再读取或写回旧 bitrate 别名字段
- `scripts/kairos-supervisor.* start` 只会启动 `Supervisor + React console`；不会自动启动 ML，也不会恢复旧 job
- `progress.json` 是 durable progress cache，不是 live job 证据
- Console 刷新时，默认项目上下文应优先跟随最新的 active project-scoped job；没有活跃项目 job 时，才回退到上次本地选择
- 如果多个项目共用同一个显示名，项目选择器必须同时暴露 `projectId`
- 旧静态监控页和兼容脚本已经退出正式链路，不能再被当成新的入口或 fallback

## 进程收尾规则

- 只要某个 Kairos 顶层阶段结束，就必须主动做一次进程收尾对账；默认目标状态是 Kairos 官方管理的 `ML server = stopped`
- 典型对象包括：本地监控面板、agent 本轮主动拉起的 ML server、临时 HTTP server、一次性调试进程、临时 watcher
- 即使该阶段最终没有真正使用到 ML，也要把 Kairos 官方 ML service 对账回 `stopped`
- 不要清理由用户本来就在跑的无关外部服务；这里指的是 Kairos 官方管理的 ML service 状态必须回收
- 如果阶段失败或被用户中断，也要做同样的收尾检查，避免留下孤儿进程

## 准备阶段：Edit Rules + optional Style Reference

**相关 skill**: [kairos-style-analysis](../kairos-style-analysis/SKILL.md)

`剪辑规则` 是 Edit Flow 的正式流程定义输入，存放在 `<workspaceRoot>/config/edit-rules/*.md`。规则正文只来自这些人工维护的 markdown；分类通过 frontmatter / 文件名扫描得到，不能由风格分析自动生成。

每个 edit unit 必须先生成并人工确认 `edits/<editId>/planning/flow-plan.json`。Flow Plan 由 LLM 读取 raw edit-rule markdown、项目上下文和 capability registry 后生成；代码只执行确认后的 `capabilityId / inputRefs / outputRefs / gate / runner`，不关键词解析 markdown 正文。

Style Analysis 当前是 **可选 layered-v1 分层风格档案**。它从用户历史成片中按分类提取 `literary / artistic / editingTechnical` 三层：文学表达、影像审美、剪辑技法观察。它不生成正式剪辑规则；只有剪辑规则自由正文经 Flow Planner 写入 confirmed `flow-plan.json.styleUsage` 后，脚本阶段才可读取被授权的层。

风格档案正文必须是抽象“生成法则”，不是参考视频内容复述：`literary` 分析旁白写法机制，`artistic` 分析审美母题 / 情绪光谱 / 空间时间观，`editingTechnical` 分析可迁移剪辑技法。样本地名、事件和人物只能作为简短证据，不能成为层 summary 或章节主体。

输入：
- 分类名称（如 `travel-doc`、`city-walk`）
- 用户指导词（描述分析侧重和创作理念）
- 该分类的 1-5 个历史作品视频

Style Analysis 产出：deterministic prep 先写 `<workspaceRoot>/.tmp/style-analysis/{category}/`、`analysis/reference-transcripts/`、`analysis/style-references/`，随后由 Agent 写 `<workspaceRoot>/config/styles/{category}.md`；分类索引只保留在 `<workspaceRoot>/config/style-sources.json`

当前 Agent 最终风格归纳不再是单 prompt 汇总，而是 clean-context subagent 链：
- `analysis/style-references/{category}/agent-summary.json`
- `analysis/style-references/{category}/style-draft.json`
- `analysis/style-references/{category}/style-review.json`
- reviewer blockers 通过前，不能落成正式 `config/styles/{category}.md`

可以为不同类型的作品建立多个风格参考，在 Edit Flow 中由 `styleUsage` 授权后作为可选表达参考使用。
如果用户已有手写风格参考（如 `test/style-profile.md`），可以跳过 Style Analysis 直接使用。

剪辑规则是 Edit Flow 的核心输入；风格参考只在 Flow Plan 授权的能力 step 中影响表达、审美或剪辑技法偏好。

**重要规则**：
- 剪辑规则必须由用户人工指定；系统不能根据当前项目素材自动生成、自动挑选或自动推断剪辑规则。
- 如果用户没有明确指定 `editRuleCategory`，Workflow 必须停在 Edit Flow 之前，先向用户确认。
- 如果当前 edit unit 没有 confirmed 且 hash 未过期的 Flow Plan，Workflow 必须停在 Edit Flow 之前，先运行 Flow Planner 并等待用户确认。
- 缺少 `styleCategory` 默认不阻塞粗剪；但如果剪辑规则要求使用风格层，Flow Plan 不能确认，Edit Flow 必须阻塞到用户选择 / 重跑可用的 `layered-v1` 档案。
- `kairos-style-analysis` 只能在用户明确要求做风格分析时执行，不能被 Workflow 隐式触发。
- `kairos-style-analysis` 当前正式是 `Supervisor deterministic prep -> awaiting_agent -> Agent final profile`，不能再被描述成“UI 上能点但 runner 还没接上”的占位状态

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

正常情况下，用户应优先在 `/ingest-gps` 用结构化 `素材 Root` 编辑器维护这些字段；保存时会把 `config/project-brief.json` 作为单真值落盘，并自动回写 `config/project-brief.md` 镜像。如果没有 Console 可用，再按下面这种模板直接补：

```text
路径：
F:\你的素材目录

原始路径：
F:\你的原始素材目录（可选，仅 `/color` 使用）

说明：
主机位，风景、步行、口播都有
```

用户填完 `project-brief.md` 后，不要手工再抄一遍配置；应把它当成路径映射的人类镜像，并同步成：
- `config/project-brief.json`
- 兼容 ingest root 读模型

如果某个 root 配了 `原始路径` 或 `原始路径N`，运行时会解析为当前可读 `rawLocalPath`。
当解析后的 `rawLocalPath` 位于当前素材目录内部时，Ingest 必须显式排除该 raw 子树，避免把 raw 与当前输出一起纳入主链扫描。

如果下一步就是跑 Ingest，优先直接调用 `ingestWorkspaceProjectMedia()`；当前实现会在检测到
`project-brief` 已配置路径映射时，先自动同步一次再继续扫描。

如果当前平台是 Windows，并且后续流程涉及媒体分析或导出，在初始化阶段还应先检查 Windows 原生
`ffmpeg / ffprobe` 是否存在。优先使用当前平台的原生版本；如果没有自动探测到，先要求在项目的
`config/runtime.json` 中显式配置 `ffmpegPath` / `ffprobePath`，而不是直接假设用户需要重新下载安装。

`initWorkspaceProject` / `initProject` 现在会创建这些目录和种子文件：

```
project/
├── config/
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
├── edits/
│   └── main/
│       ├── planning/
│       ├── runs/
│       ├── timeline/
│       └── subtitles/
├── adapters/
└── analysis/
    └── asset-reports/
```

注意：
- `device-media-maps.local.json` 已退出正式路径模型；不要再生成或依赖它
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
│   ├── spans.json            # /chronology span-rebuild 产出
│   └── spans.meta.json       # /chronology span-rebuild freshness/hash
├── edits/<editId>/
│   ├── planning/
│   │   └── flow-plan.json    # Edit Flow 可执行计划
│   ├── runs/
│   │   └── current.json      # capability step run truth
│   ├── timeline/
│   │   ├── current.json      # timeline.generate KTEP/manifest 审计；Resolve timeline 才是成功标准
│   │   └── locked-rough-cut.json
│   └── subtitles/
│       └── *.srt / *.vtt     # Phase 5 (Export) 产出
└── analysis/
    └── asset-reports/*.json   # Phase 2 (Analyze) 产出
```

另外还有 workspace 级共享风格资产：

```
<workspaceRoot>/
├── config/
│   ├── style-sources.json     # Style Analysis / Console 的风格来源配置
│   └── styles/
│       └── {category}.md      # Style Analysis 产出
└── analysis/
    ├── reference-transcripts/ # Style Analysis 的 ASR 原文
    └── style-references/      # 单参考视频分析结果
```

## 主链阶段

### Phase 1: Ingest (素材导入)

**子 skill**: [kairos-ingest](../kairos-ingest/SKILL.md)

输入：用户指定的素材目录
产出：`store/assets.json` — `IKtepAsset[]`

前置条件：项目已初始化

补充口径：
- dense sidecar `.SRT` / DJI FlightRecord 轨迹会规范化写到 `gps/same-source/tracks/*.gpx` + `gps/same-source/index.json`
- 这套内部 GPX 只用于 same-source 索引 / 惰性查找，不改变 `embedded GPS > Pharos GPX > 普通 project GPX > project-derived-track` 的正式优先级；Pharos GPX 不能覆盖同名 `.SRT` / FlightRecord 绑定出的 embedded GPS
- 照片拍摄时间默认优先吃 EXIF 原始时间和时区；如果照片自身带 GPS，也应直接作为 `embedded GPS` 真值
- Ingest / GPS 刷新负责解析项目内固定 `pharos/` 并刷新 `analysis/pharos-context.json`；该 cache 必须按输入 fingerprint 和 parser version 自动失效；Analyze 只消费该 cache，不临时补跑 Pharos parse
- Pharos planned shot 归属只使用 `record.json.actual_time` 精确匹配；`expected / unexpected` 且有完整 actual time 的记录才可绑定存在有意义时间重叠的素材，多个单点事件时间窗重叠时只按 `record.json.actual_captures[]` 等显式拍摄类型/设备字段调整优先级，仍同分时优先更窄的 actual window，不从描述、地点或 note 推断语义；`pending / abandoned` 和 planned time segment 不参与素材归属，空间仍只从 trip GPX 按时间反算
- Pharos/Pyxis 的普通事件过长二次确认只防止上游误写超长 `actual_time`，不改变 Kairos workflow 的归属、刷新或重建步骤
- 对本次成功扫描到的 root，Ingest 会剪掉该 root 下磁盘已不存在的旧资产；missing root 的旧资产保持不动
- root 可声明 `captureTimePolicy.mode=manual-required`；命中素材必须由用户显式补 `正确日期 / 正确时间 / 时区` 后 rerun ingest
- 如果 ingest 发现素材时间和项目时间线明显冲突，必须把待校正项追加到 `config/manual-itinerary.md` 末尾的“素材时间校正”表格，并阻塞后续阶段

### Phase 2: Analyze (素材分析)

**子 skill**: [kairos-analyze](../kairos-analyze/SKILL.md)

输入：`store/assets.json`
产出：
- `analysis/asset-reports/*.json` — 单素材 coarse report

前置条件：`store/assets.json` 存在且非空

**强规则**：
- Workflow 在进入 Analyze 前，必须先执行一次 GPS 规则提示，不能直接开跑
- Workflow 在真正启动 Analyze 前，还必须确认 ML server 可用；如果 health check 不通，应该直接停在这里并提示用户修复，而不是静默退化成无 ML 分析
- 至少要向用户说明：`embedded GPS > Pharos GPX > 普通 project GPX > project-derived-track > none`
- 必须结合当前项目状态指出：是否已有项目级 GPX、是否已有 `gps/derived.json`、是否已有 `config/manual-itinerary.md`
- 必须结合当前项目状态指出：是否已有已刷新 `analysis/pharos-context.json`，以及其中 Pharos 状态是否为 `success / empty / failure`
- 如果缺少 GPX 且缺少 `gps/derived.json`，必须明确提示：没有 embedded GPS 的素材将没有空间 fallback
- 如果用户刚修改了 `manual-itinerary` 但还没重新跑 ingest，必须明确提示：需要先刷新 `gps/derived.json`
- 如果 `manual-itinerary` 末尾“素材时间校正”表格还有未填写或未重新 ingest 应用的条目，Workflow 必须停在 Analyze 之前
- 对拍摄时间修正，Workflow 只能引导用户维护 `/ingest-gps` 的“素材时间校正”；`导入 / GPS Review` 不应再要求用户重复填写同一素材
- 如果用户手里拿的是 sidecar `.SRT` 或 DJI FlightRecord 日志，必须明确提示：这类输入属于 `embedded GPS` 标准链路，不是普通 GPX
- 必须指导用户选择：补 GPX、给对应 root 配置 `飞行记录路径`、填写/更新 `manual-itinerary` 后 rerun ingest，或明确接受“部分素材没有空间结果”后继续
  - 当用户选择填写 `manual-itinerary` 时，默认应推荐一句自然语言一段，而不是要求先写成 key-value 表单
  - 推荐示例：`2026.02.17，早上九点左右，开车从新西兰皇后镇出发`
- 如果是时间线冲突导致的阻塞，必须明确指导用户去填 `manual-itinerary` 末尾表格里的 `正确日期 / 正确时间 / 时区`，然后 rerun ingest
- 如果是 root 级 `manual-required` 时间策略导致的阻塞，必须明确说明这不是弱时间猜测，而是该 root 被标记为必须人工确认；用户必须显式填写完整日期、时间和时区
- 只有在用户明确确认继续后，才可以调用 Analyze

Chronology 审查：
- `/chronology` 是 Analyze 和 Edit Flow 之间的正式审查页，提供 `生成素材片段与模式` 与 `生成/刷新编年史` 两步，并展示 active job 的 text-LM chunk / retry / warning 进度
- `span-rebuild` 只读取 `store/assets.json + analysis/asset-reports/*.json`，再用本地 qwen 文本 LM 从每个 span 的最小文本事实按 3 个 span 一批生成中文 `materialPatterns[]`；LM 只返回 ordered rows，代码按 chunk 顺序写回 spans；已完成 checkpoint 写 `.tmp/chronology/span-rebuild.partial.json`，全量成功后才写正式 `store/spans.json + store/spans.meta.json`
- `chronology-build` 要求 spans fresh，再从 assets + fresh spans + root time + Pharos context 写 Chronology V2，默认 `draft`
- `chronology-build` 写 `media/chronology.json` 时必须有可用 GPS reverse-geocode service；无 service、cache/provider 反查不到 route/event GPS anchor 时直接失败，不允许用素材标签、`materialPatterns`、manual itinerary 或 Pharos continuous route prose 生成地点
- 用户必须在 `/chronology` 确认 Chronology V2 后，Edit Flow 才能继续
- 旧数组 v1、`draft` 或 `stale` chronology 都应阻塞 Edit Flow，并提示重建或确认
- Pharos 只作为生成 chronology 的输入；正式 chronology event 不暴露 Pharos/source/origin 等生成痕迹

轻量空间刷新：
- 如果已有 `analysis/asset-reports/*.json`，且用户只是改变了 GPS / Pharos context / 空间优先级 / reverse-geocode 逻辑，应优先在 `/chronology` 触发 `spatial-refresh`
- `spatial-refresh` 只修补已有 Analyze report 的空间层，不启动 ML，不生成缺失 report，不重建 spans/chronology，只标记它们 stale，不替代 Ingest 扫描新 `.SRT`、FlightRecord、root 或 capture-time 修正

当前分析链路除了视觉粗扫/细扫，还会在符合条件的视频上补充 ASR：
- 结构上更准确的理解是：
  - 有音轨视频：`coarse-scan -> audio-analysis -> finalize -> 细扫决策 -> 细扫执行`
  - 无音轨视频：`coarse-scan -> finalize -> 细扫决策 -> 细扫执行`
- `coarse-scan` 当前是素材级动态并发：同一素材在 coarse 阶段最多一个抽帧 `ffmpeg`，但多个素材会按 free memory 目标并发推进
- `audio-analysis` 当前是两级素材队列：先做本地健康检查/保护音轨选边，再把最终选中的一路送入 ASR 队列
- coarse report 会带 `transcript / transcriptSegments / speechCoverage`
- 语音时间窗会参与 fine-scan window 生成
- chronology 会把 ASR/空间/Pharos 等输入折叠成普通 `event / route / gap`，但正式事件不写入 ASR anchors、source、origin 或 Pharos refs
- 对带 `protectionAudio` 的素材，当前正式策略是双健康检查后只跑一侧 ASR；如果 protection 被选中，它就直接成为正式 transcript 来源
- 当前正式项目的音频分析主路径指的是“视频素材里的音轨”，不是独立纯音频资产
- 如果后续项目真的引入独立音频素材，再补单独 analyze 分支；当前不要把这点和视频内语音 ASR 混为一谈

### Phase 3: Edit Flow (剪辑规则驱动能力流)

**子 skill**: [kairos-edit-flow](../kairos-edit-flow/SKILL.md)

输入：已确认 Chronology V2 `media/chronology.json`、剪辑规则、confirmed Flow Plan、可选风格档案；fresh `store/spans.json` 与 `analysis/asset-reports/` 只在具体 step 的 `inputRefs` 声明时才成为必需输入。

产出：由 confirmed Flow Plan 的 `outputRefs` 决定，可能包括 planning markdown、素材召回 JSON、Resolve timeline、`locked-rough-cut.json` 或字幕/旁白草稿；`.tmp/edit-flow/<editId>/timeline/current.json` 只作为本机临时审计。

前置条件：Chronology V2 confirmed。每个 capability 再按自己的 `inputRefs` 精确阻塞，例如 `trip.event_table` 只依赖 `media/chronology.json`，素材归档 / 召回类 step 才进入 spans 与 asset reports。

**重要规则**：
- 不存在固定 `Script -> Timeline` 用户流程。
- 不引入必选 `script/current.json`、beat 或其它全局中间稿。
- `script.generate` 只有当剪辑规则明确要求前置文本稿 / beat 稿时才出现。
- `material.recall` 只输出 `material-slots.json`；`segment-plan.json` 不再是正式输出或下游输入。
- `material-slots.json` 是素材召回和粗剪建议唯一结构化产物，每个 `chosenSpanId` 必须有 numeric `audio` dB / `speed` 倍速 treatment；非照片 span 如果有 transcript、transcriptSegments 或 `semanticKind=speech/mixed`，不得静音。
- `resolve.media_sync` 是 deterministic Resolve Media Pool 同步步骤；Media Pool 是素材归档真相，不新增 `media-archive.json`，重复运行只能复用 / 移动 / 补导入。
- `timeline.generate` 是 deterministic Resolve rough-cut 创建步骤，只读取 `edit-framework.md + material-slots.json + spans + assets + chronology` 并从已同步 Media Pool 选择素材；不能要求 `script/current.json` 或 `segment-plan.json`，也不能重新导入素材或清空 `Kairos Project Media` namespace。
- `.tmp/edit-flow/<editId>/timeline/current.json` 只是本机临时 KTEP/manifest 审计；Resolve 不可用时不能作为成功兜底。
- `trip.event_table` 是事件级组织能力，只使用 confirmed chronology；不要因为 spans stale 或缺 asset reports 阻塞它。
- `sharded-agent` step 的连续天打包、阈值与 SubAgent 口径只来自 confirmed `step.execution.shardPacking / codexSubagentProfile`；默认不得按 route 拆。
- Edit Flow SubAgent step 必须写明 Codex 使用 `reasoning_effort=high`、`fork_context=false`、标准速度；执行时只传有界 step/shard 上下文，不 fork 当前长上下文。
- `edits/<editId>/runs/` 只保存轻量 record；capability 只写 `outputRefs` 声明的正式输出。
- 每个 step 由 capability runner 选择 deterministic / agent / script / manual 执行，并写 run record。
- human gate 未确认时，后续依赖 step 不可继续。

### Phase 4: Export (NLE 导出)

**子 skill**:
- [kairos-export](../kairos-export/SKILL.md) — 导出路由
- [kairos-export-jianying](../kairos-export-jianying/SKILL.md) — 导出到剪映
- [kairos-export-resolve](../kairos-export-resolve/SKILL.md) — 导出到达芬奇

输入：Edit Flow 已确认产出的正式时间线 / 字幕 / NLE 目标。
产出：按目标 NLE 生成草稿 / 时间线 + `subtitles/*.srt`

前置条件：目标 NLE 和最终输出目录明确；如果导出消费 KTEP，则对应临时审计 `.tmp/edit-flow/<editId>/timeline/current.json` 必须存在且通过校验，或先重新生成。

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
已有项目 → 追加 Ingest → 增量 Analyze → 刷新 /chronology → 重跑受影响 Edit Flow steps → 重新 Export
```

如果只是空间规则、GPX、Pharos context 或 reverse-geocode 逻辑变化，且已有 Analyze 产物完整，则可走更轻的：

```
已有项目 → /chronology spatial-refresh → 生成素材片段与模式 → 生成/刷新编年史 → 确认 chronology → 视需要重跑 Edit Flow steps
```

### 追加流程

1. **追加导入**：`kairos-ingest` 的增量模式，按 `ingestRootId + sourcePath` 自动去重；对本次成功扫描到的 root，也会剪掉该 root 下已经不在磁盘扫描结果中的旧资产

```typescript
const result = await appendAssets(projectRoot, newAssets);
// result.added — 实际新增资产
// result.duplicateCount — 跳过的重复
```

2. **增量分析**：`kairos-analyze` 自动识别缺少 report 的资产，仅对新素材执行分析；Analyze 完成后到 `/chronology` 重建 spans / chronology

```typescript
const toAnalyze = findUnanalyzedAssets(allAssets, existingReports);
// 仅对 toAnalyze 中的资产做镜头检测、ML 分析
await analyzeWorkspaceProjectMedia({ workspaceRoot, projectId, assetIds: toAnalyze.map((asset) => asset.id) });
// 然后从 /chronology 显式运行 span-rebuild（需要本地 qwen 文本 LM / ML 服务）与 chronology-build
```

3. **重新创作**：受影响的 Edit Flow steps 和 Export 需要在新素材基础上重新执行
   - Flow Plan 可能需要重新生成或标记 stale
   - 能力 step 需要根据 declared inputs 重新运行
   - 导出需要重做

### 注意事项

- 每个资产有 `ingestedAt` 时间戳，可以区分不同批次
- 可以用 `ingestRootId` 标记批次来源
- 已有的 reports 和证据不会丢失，新分析结果追加到后面
- 如果需要重新分析某个旧资产，重新写入该资产 report 后必须显式运行 `span-rebuild`

## 迭代修改

Edit Flow 支持迭代：
- 修改剪辑规则或 Flow Plan 后重跑受影响 steps
- 人工确认 human gate 后继续后续 steps
- 调整时间线、字幕或 post-lock 输出后重新导出

## 跨设备

ML server 可以运行在另一台 GPU 机器上，通过 `KAIROS_ML_URL` 环境变量连接。
详见 [deploy-kairos](../deploy-kairos/SKILL.md)。
