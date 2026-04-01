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

素材源分成两层：

- 项目内：`config/ingest-roots.json`
  - 保存逻辑 root
  - 包括 `id / label / description / notes / tags`
- 设备本地：`config/device-media-maps.local.json`
  - 保存 `projectId + rootId -> localPath`
  - 默认落在当前项目内，但属于本机私有映射，不应纳入项目同步

也就是说：
- 项目可以同步
- 素材目录路径不跟着同步

## 可用入口

```typescript
initWorkspaceProject(workspaceRoot: string, projectId: string, name: string): Promise<string>
resolveWorkspaceProjectRoot(workspaceRoot: string, projectId: string): string

syncWorkspaceProjectBrief(
  workspaceRoot: string,
  projectId: string,
  deviceMapPath?: string,
): Promise<ISyncProjectBriefResult>

saveProjectDeviceMap(
  projectRoot: string,
  projectId: string,
  projectMap: { roots: { rootId: string; localPath: string }[] },
  filePath?: string,
): Promise<IDeviceMediaMapFile>

ingestWorkspaceProjectMedia(input: {
  workspaceRoot: string;
  projectId: string;
  deviceMapPath?: string;
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
- DJI FlightRecord 日志不属于普通 `project GPX`。它的标准入口是每个 root 的 `飞行记录路径`，并在 ingest 时按文件头/可解析性识别，再切成素材级同源 GPS
- sidecar `.SRT` / FlightRecord 这类 dense same-source 轨迹会规范化写到 `gps/same-source/*`；这只是内部存储格式，不改变它们作为 `embedded GPS` 的正式语义
- 新 ingest 不再把 dense GPS `points[]` 内联进 `store/assets.json`；资产只保留 `embeddedGps.trackId / pointCount / representative / startTime / endTime`
- 如果 FlightRecord 是 DJI v13/v14 加密日志，可在 `config/runtime.json` 中提供 `djiOpenAPIKey`，避免依赖环境变量
- ingest 会刷新 `gps/derived.json`，把 embedded-derived sparse points 与可解析的 `manual-itinerary` 条目统一编译进 `project-derived-track`
- Analyze 在没有显式 `gpxPaths` 时，会默认读取这个项目级 GPX 资源
- `project-derived-track` 是第三优先级空间层，不能覆盖素材自身的 embedded GPS 真值，也不能覆盖项目级外部 GPX

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
- `projects/<projectId>/config/ingest-roots.json`
- `projects/<projectId>/config/device-media-maps.local.json`

## 工作流程

1. 确认或初始化项目
- 如果项目还不存在，先 `initWorkspaceProject()`

2. 写入或更新 `config/project-brief.md`
- 用自然语言维护路径和说明
- 如果某个 root 有配套的 DJI FlightRecord 日志，在同一个 block 里补 `飞行记录路径`

3. 从 `project-brief.md` 同步正式配置
- `syncWorkspaceProjectBrief()`
- 会更新：
  - `config/ingest-roots.json`
  - `config/device-media-maps.local.json`
- 不要手工重复编辑 `ingest-roots.json`

4. 如有必要，再补充逻辑 root 元数据
- 每个 root 至少要有：
  - `id`
  - `enabled`
  - `label`
  - `description`
  - `notes[]`

5. 跑导入
- 默认会优先读取项目内 `config/device-media-maps.local.json`
- 如果 `project-brief.md` 已有映射，`ingestWorkspaceProjectMedia()` 会先尝试自动同步一次
- `.SRT` sidecar 会在素材旁自动发现，不需要单独配置
- `飞行记录路径` 如果存在，会被当作该 root 的同源遥测输入，而不是普通项目 GPX
- 如果项目希望让 `manual-itinerary` 参与后续空间推断，修改完 `config/manual-itinerary.md` 后也应重新跑一次 ingest，刷新 `gps/derived.json`

```typescript
const result = await ingestWorkspaceProjectMedia({
  workspaceRoot,
  projectId,
  deviceMapPath,
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

## 导入结果

| 文件 | 内容 |
|------|------|
| `store/assets.json` | 所有素材资产，`sourcePath` 为 root-relative 路径；成功绑定的 `.SRT` / `FlightRecord` 同源 GPS 会写成轻量 `embeddedGps` 引用，而不是内联 dense `points[]` |
| `media/chronology.json` | 按拍摄时间排序的素材视图 |
| `gps/same-source/index.json` + `gps/same-source/tracks/*.gpx` | dense same-source GPS 的项目内内部 cache，仅用于索引 / 惰性查找 |
| `gps/derived.json` | 统一后的 `project-derived-track` 缓存 |

## 注意点

- `sourcePath` 现在应理解为 **相对 root 的可同步路径**，不是本机绝对路径
- 去重键是 `ingestRootId + sourcePath`
- 即使素材文件本身没有容器 GPS，只要 sidecar `.SRT` 或 root 级 `FlightRecord` 成功绑定，该素材仍然属于 `embedded GPS`
- 根目录说明是弱语义证据，不是强分类
- 如果某个逻辑 root 在当前设备没有映射，要向用户报告 `missingRoots`
- `manual-itinerary` 不是素材路径映射输入，但它现在属于 ingest refresh 的空间编译输入：会被编译进 `gps/derived.json`
- 如果 `FlightRecord` 日志是加密版本且环境里没有 `KAIROS_DJI_OPEN_API_KEY` / `DJI_OPEN_API_KEY`，要向用户报告对应 warning
- 如果宿主没有提供 `resolveTimezoneFromLocation / geocodeLocation`，ingest 仍会刷新 embedded-derived 部分，但无法把 `manual-itinerary` 编译成可用坐标
