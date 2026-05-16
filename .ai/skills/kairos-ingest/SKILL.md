---
name: kairos-ingest
description: >-
  Phase 1: Ingest project media roots into a synced Kairos project. Resolves
  logical roots through device-local path maps, scans media, probes metadata,
  resolves capture times, and writes project assets plus chronology. Use when
  importing raw footage, appending new media, or initializing a project's asset
  inventory.
---

# Kairos: Phase 1 — Ingest

把素材导入 **Kairos 工程内的项目目录**，生成可同步的资产主表和按拍摄时间排序的素材时序视图。

这条 skill 只负责：
- 逻辑素材源定义
- 设备本地路径映射
- 扫描和元信息提取
- `store/assets.json`
- `media/chronology.json`

它**不负责风格分析**，也不负责镜头级分析。

## 变更工作流规则

只要本轮任务涉及需求、行为、接口、工作流、正式入口或用户路径变更，必须遵守下面顺序：

1. 先进入 `Plan` 模式；如果宿主没有显式 `Plan mode`，先给出结构化计划并得到确认。
2. 计划确认后，先更新相关设计文档，再开始实现。
3. 实现完成后，必须回查并同步受影响的设计文档、rules 和 skills，再结束本轮。
4. 如果变更影响正式入口、监控页、工作流主路径或用户操作方式，还要同步更新 `README.md`、`designs/current-solution-summary.md` 和 `designs/architecture.md`。

## 项目模型

Kairos 现在的项目结构是：

```text
<workspaceRoot>/
└── projects/
    └── <projectId>/
        ├── config/
        ├── gps/
        │   ├── tracks/
        │   ├── same-source/
        │   │   ├── tracks/
        │   │   └── index.json
        │   └── merged.json
        ├── store/
        ├── analysis/
        ├── media/
        └── .tmp/
```

素材源统一来自 `config/project-brief.json`：

- 每个 root 保存 `id / label / description / notes / tags`
- 每个 root 保存主路径、原始路径和可选 `备选路径N / 原始路径N`
- 每个 root 可选保存 `captureTimePolicy`；当 `mode=manual-required` 时，命中的素材必须先通过单素材手动时间修正落成 `manual` capture time
- 运行时从路径候选中选择当前可读目录，不再维护 `device-media-maps.local.json`

## 可用入口

```typescript
initWorkspaceProject(workspaceRoot: string, projectId: string, name: string): Promise<string>
resolveWorkspaceProjectRoot(workspaceRoot: string, projectId: string): string

syncWorkspaceProjectBrief(
  workspaceRoot: string,
  projectId: string,
): Promise<ISyncProjectBriefResult>

ingestWorkspaceProjectMedia(input: {
  workspaceRoot: string;
  projectId: string;
  resolveTimezoneFromLocation?: (location: string) => Promise<string | null>;
  geocodeLocation?: (location: string) => Promise<{ lat: number; lng: number } | null>;
}): Promise<{
  projectRoot: string;
  scannedRoots: { rootId: string; label?: string; localPath: string; scannedFileCount: number }[];
  missingRoots: IMediaRoot[];
  merge: IMergeResult;
  chronologyCount: number;
  warnings: string[];
}>

importProjectGpxTracks(input: {
  projectRoot: string;
  sourcePaths: string[];
}): Promise<{
  trackPaths: string[];
  merged: IProjectGpsMerged;
}>
```

## 项目级 GPS 资源

如果用户提供外部 GPX，不要把它当成一次性的临时路径约定。当前项目内的正式落点是：

- 原始 GPX：`projects/<projectId>/gps/tracks/*.gpx`
- 标准化 merged cache：`projects/<projectId>/gps/merged.json`
- same-source 内部轨迹 cache：`projects/<projectId>/gps/same-source/tracks/*.gpx`
- same-source 内部索引：`projects/<projectId>/gps/same-source/index.json`
- 项目级 derived cache：`projects/<projectId>/gps/derived.json`

约定：

- `initWorkspaceProject()` 会初始化 `gps/` 与 `gps/tracks/`
- 导入 GPX 后，优先调用 `importProjectGpxTracks()` 复制进项目并刷新 merged cache
- 同 basename 的 sidecar `.SRT` 不需要单独导入；ingest 会在素材根目录中自动发现并尝试绑定
- 同目录同 basename 的 sidecar 保护音轨（如 `.wav/.flac/.m4a`）也应在 ingest 时自动发现，但当前正式语义是挂在对应视频资产的 `protectionAudio` 绑定上，而不是把它们重新作为通用独立音频资产导入
- DJI FlightRecord 日志不属于普通 `project GPX`。它的标准入口是每个 root 的 `飞行记录路径`，并在 ingest 时按文件头/可解析性识别，再切成素材级同源 GPS
- sidecar `.SRT` / FlightRecord 这类 dense same-source 轨迹会规范化写到 `gps/same-source/*`；这只是内部存储格式，不改变它们作为 `embedded GPS` 的正式语义
- 新 ingest 不再把 dense GPS `points[]` 内联进 `store/assets.json`；资产只保留 `embeddedGps.trackId / pointCount / representative / startTime / endTime`
- 如果 FlightRecord 是 DJI v13/v14 加密日志，可在 `config/runtime.json` 中提供 `djiOpenAPIKey`，避免依赖环境变量
- ingest 会刷新 `gps/derived.json`，把 embedded-derived sparse points 与可解析的 `manual-itinerary` 条目统一编译进 `project-derived-track`
- ingest 与 `gps-refresh` 都必须刷新 `analysis/pharos-context.json`；Pharos context 要按项目内 `pharos/` 的输入 fingerprint 自动失效并重建
- Pharos planned shot 的素材归属只使用 `record.json.actual_time` 精确匹配；continuous 行车记录在 `plan` 中没有 planned time 属于正常情况，只要 `record.json` 有完整 actual time 就不应产生 planned-time warning；planned time 不作为素材归属 fallback
- 如果 Pharos 协议 hash 与 `.ai/pharos-protocol-baseline.json` 不匹配，先完成协议同步并刷新 baseline，再改 ingest / GPS 的 Pharos 接入代码
- Analyze 的正式空间优先级是 `embedded GPS > Pharos GPX > 普通 project GPX > project-derived-track > none`
- Pharos GPX 只来自 planned shot 归属后的 trip `gpx/*.gpx` 按时取点；普通项目 GPX 来自 `gps/merged.json` / `gps/tracks/*.gpx`
- Analyze 在没有显式普通 `gpxPaths` 时，会默认读取这个项目级 GPX 资源
- `project-derived-track` 是第四优先级空间层，不能覆盖素材自身的 embedded GPS 真值，也不能覆盖 Pharos GPX 或项目级外部 GPX；Pharos GPX 也不能覆盖同名 `.SRT` / FlightRecord 绑定出的 embedded GPS
- Ingest / `gps-refresh` 只刷新空间输入缓存；如果已有 `analysis/asset-reports/*.json` 需要采用新 GPS / Pharos 结果，应去 `/analyze` 点击 `刷新空间结果`，由 `spatial-refresh` 修补 report / chronology / spans grounding
- 照片的拍摄时间优先级现在是：`EXIF DateTimeOriginal(+OffsetTimeOriginal) > EXIF CreateDate(+OffsetTimeDigitized/OffsetTime) > filename > filesystem`
- 照片如果自身 EXIF 已带 GPS，应直接写成资产的 `embeddedGps(metadata)` 真值；只有没有自身 GPS 时，才继续走 sidecar / FlightRecord / `manual-itinerary` 的时间匹配链路
- 对声明 `captureTimePolicy.mode=manual-required` 的 root，命中的素材时间必须人工确认；这类 blocker 要求显式 `正确日期 / 正确时间 / 时区`，不能从当前 capturedAt 自动补日期后视为 resolved
- 如果 ingest 发现弱时间源素材的拍摄时间和项目时间线、文件名完整时间戳或已纳入 `Pharos` trip 的整体时间边界明显冲突，必须把阻塞项同步到 `/ingest-gps` 的“素材时间校正”卡片与 `config/manual-itinerary.md`，并立刻阻塞后续流程
- “素材时间校正”是 capture-time 修正的唯一用户编辑面；不要让 `导入 / GPS Review` 或 `config/review-queue.json` 再镜像/反写同一批 `capture-time-correction`

## 用户输入方式

用户不需要手写 JSON。应先自然语言收集：

```text
项目名：新西兰纪录片

素材目录 1：
路径：F:\NZ\A7R5
说明：主机位，风景、步行、口播都有

素材目录 2：
路径：F:\NZ\Drone
说明：无人机，全景和地貌为主
飞行记录路径：.\FlightRecord
```

然后 agent 应先写/更新 `config/project-brief.md`，再由系统同步成：
- `projects/<projectId>/config/project-brief.json`
- 兼容 ingest root 读模型

## 工作流程

1. 确认或初始化项目
- 如果项目还不存在，先 `initWorkspaceProject()`

2. 写入或更新 `config/project-brief.md`
- 用自然语言维护路径和说明
- 如果某个 root 有配套的 DJI FlightRecord 日志，在同一个 block 里补 `飞行记录路径`

3. 从 `project-brief.md` 同步正式配置
- `syncWorkspaceProjectBrief()`
- 会更新：
  - `config/project-brief.json`
  - 兼容 ingest root 读模型
- 不要手工重复编辑 `ingest-roots.json`

4. 如有必要，再补充逻辑 root 元数据
- 每个 root 至少要有：
  - `id`
  - `enabled`
  - `label`
  - `description`
  - `notes[]`

5. 跑导入
- Console 正式入口是 `/ingest-gps` 的 `运行 Ingest` 按钮，它触发 Supervisor `ingest` job；保存素材 Root、FlightRecord、manual-itinerary、root 时钟偏移或 capture-time overrides 只保存配置，不会自动扫描大目录
- 默认从 `project-brief` 主路径和备选路径中选择当前可读目录
- 如果 `project-brief.md` 已有映射，`ingestWorkspaceProjectMedia()` 会先尝试自动同步一次
- 对本次成功扫描到的 root，资产索引按扫描结果同步；磁盘上已删除的旧素材要从 `store/assets.json` 移除，missing root 的旧素材必须保留
- `.SRT` sidecar 会在素材旁自动发现，不需要单独配置
- 保护音轨 sidecar 也会按“同目录同 basename”自动发现；第一阶段只做视频资产绑定，不把这些音频重新放回普通素材池
- `飞行记录路径` 如果存在，会被当作该 root 的同源遥测输入，而不是普通项目 GPX
- 如果项目希望让 `manual-itinerary` 参与后续空间推断，修改完 `config/manual-itinerary.md` 后也应重新跑一次 ingest，刷新 `gps/derived.json`
- 如果 `config/manual-itinerary.md` 末尾已经有“素材时间校正”区，ingest 必须读取用户在 Console 或 Markdown 中维护的修正值，并把它作为 `manual` capture time 真值覆盖弱时间源
- rerun ingest 只能从“素材时间校正”读取时间修正；review queue 中旧的 capture-time 镜像应被清除，而不是作为第二份输入
- 当前正式语义是：优先填写 `正确时间 / 时区`；`正确日期` 会先用 `suggestedDate` 自动补齐，再退到“当前时间在所填时区对应的本地日期”；只有仍无法推导时才需要用户手填日期
- `captureTimePolicy.mode=manual-required` 生成的 blocker 是例外：必须显式填写 `正确日期 / 正确时间 / 时区`，不能依赖建议日期或当前文件时间自动补齐
- 如果本轮 ingest 又发现新的明显时间冲突，必须更新这些卡片 / 行；未解决的项会阻塞 Analyze

5b. 轻量刷新 GPS 缓存
- Console 的 `/ingest-gps` 也提供 `刷新 GPS 缓存`，触发 Supervisor `gps-refresh` job
- 这个入口不重新扫描素材，不更新 `store/assets.json`
- 它刷新项目级 `gps/merged.json`、`gps/derived.json` 与 `analysis/pharos-context.json`，适合 GPX、Pharos 或 `manual-itinerary` 空间信息变化后使用

```typescript
const result = await ingestWorkspaceProjectMedia({
  workspaceRoot,
  projectId,
  resolveTimezoneFromLocation,
  geocodeLocation,
});
```

6. 向用户报告
- 扫了几个 root
- 新增多少素材
- 跳过多少重复素材
- 当前总资产数
- chronology 是否更新
- 是否有同源 GPS 绑定 warnings（例如 `FlightRecord` 缺失、未解密、未解析出坐标）
- 如果本轮 ingest 为了观测进度或排查问题启动过临时辅助进程，结束后要主动清理；除非用户明确要求保留
- 清理范围只包含 agent 本轮主动拉起的辅助进程，不包括用户本来就在跑的后台服务

## 导入结果

| 文件 | 内容 |
|------|------|
| `store/assets.json` | 所有素材资产，`sourcePath` 为 root-relative 路径；成功绑定的 `.SRT` / `FlightRecord` 同源 GPS 会写成轻量 `embeddedGps` 引用；同 basename 的保护音轨会写成视频资产上的 `protectionAudio` 绑定，而不是单独 reopen 通用 audio ingest |
| `media/chronology.json` | 按拍摄时间排序的素材视图 |
| `gps/same-source/index.json` + `gps/same-source/tracks/*.gpx` | dense same-source GPS 的项目内内部 cache，仅用于索引 / 惰性查找 |
| `gps/derived.json` | 统一后的 `project-derived-track` 缓存 |
| `analysis/pharos-context.json` | Ingest/GPS 阶段刷新的 Pharos context cache，带输入 fingerprint |

## 注意点

- `sourcePath` 现在应理解为 **相对 root 的可同步路径**，不是本机绝对路径
- 去重键是 `ingestRootId + sourcePath`
- 即使素材文件本身没有容器 GPS，只要 sidecar `.SRT` 或 root 级 `FlightRecord` 成功绑定，该素材仍然属于 `embedded GPS`
- 根目录说明是弱语义证据，不是强分类
- 如果某个逻辑 root 在当前设备没有映射，要向用户报告 `missingRoots`
- `manual-itinerary` 不是素材路径映射输入，但它现在属于 ingest refresh 的空间编译输入：会被编译进 `gps/derived.json`
- `manual-itinerary` 现在有两层正式语义：
  - 正文自然语言段落：用于空间/路线推断
  - 末尾“素材时间校正”区：用于手工修正具体素材的拍摄时间；Console 正式入口是卡片式修正器，不要求用户先回到 Markdown 填表
- 如果 `FlightRecord` 日志是加密版本且环境里没有 `KAIROS_DJI_OPEN_API_KEY` / `DJI_OPEN_API_KEY`，要向用户报告对应 warning
- 如果宿主没有提供 `resolveTimezoneFromLocation / geocodeLocation`，ingest 仍会刷新 embedded-derived 部分，但无法把 `manual-itinerary` 编译成可用坐标
