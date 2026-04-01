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
- 设备本地：`~/.kairos/device-media-maps.json`
  - 保存 `projectId + rootId -> localPath`

也就是说：
- 项目可以同步
- 素材目录路径不跟着同步

## 可用入口

```typescript
initWorkspaceProject(workspaceRoot: string, projectId: string, name: string): Promise<string>
resolveWorkspaceProjectRoot(workspaceRoot: string, projectId: string): string

saveDeviceProjectMap(
  projectId: string,
  projectMap: { roots: { rootId: string; localPath: string }[] },
  filePath?: string,
): Promise<IDeviceMediaMapFile>

ingestWorkspaceProjectMedia(input: {
  workspaceRoot: string;
  projectId: string;
  deviceMapPath?: string;
}): Promise<{
  projectRoot: string;
  scannedRoots: { rootId: string; label?: string; localPath: string; scannedFileCount: number }[];
  missingRoots: IMediaRoot[];
  merge: IMergeResult;
  chronologyCount: number;
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

约定：

- `initWorkspaceProject()` 会初始化 `gps/` 与 `gps/tracks/`
- 导入 GPX 后，优先调用 `importProjectGpxTracks()` 复制进项目并刷新 merged cache
- Analyze 在没有显式 `gpxPaths` 时，会默认读取这个项目级 GPX 资源
- 这套资源只是第二优先级，不能覆盖素材自身的 embedded GPS 真值

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
```

然后 agent 再把它落成：
- `projects/<projectId>/config/ingest-roots.json`
- `~/.kairos/device-media-maps.json`

## 工作流程

1. 确认或初始化项目
- 如果项目还不存在，先 `initWorkspaceProject()`

2. 写入逻辑素材源
- `config/ingest-roots.json`
- 每个 root 至少要有：
  - `id`
  - `enabled`
  - `label`
  - `description`
  - `notes[]`

3. 写入本机路径映射
- 用 `saveDeviceProjectMap()` 或 `assignDeviceMediaRoot()`

4. 跑导入

```typescript
const result = await ingestWorkspaceProjectMedia({
  workspaceRoot,
  projectId,
  deviceMapPath,
});
```

5. 向用户报告
- 扫了几个 root
- 新增多少素材
- 跳过多少重复素材
- 当前总资产数
- chronology 是否更新

## 导入结果

| 文件 | 内容 |
|------|------|
| `store/assets.json` | 所有素材资产，`sourcePath` 为 root-relative 路径 |
| `media/chronology.json` | 按拍摄时间排序的素材视图 |

## 注意点

- `sourcePath` 现在应理解为 **相对 root 的可同步路径**，不是本机绝对路径
- 去重键是 `ingestRootId + sourcePath`
- 根目录说明是弱语义证据，不是强分类
- 如果某个逻辑 root 在当前设备没有映射，要向用户报告 `missingRoots`
- `manual-itinerary` 不属于 ingest 输入语义；它是 analyze 阶段在没有 embedded / GPX 命中时的空间 fallback
