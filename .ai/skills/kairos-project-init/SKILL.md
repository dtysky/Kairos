---
name: kairos-project-init
description: >-
  Initialize or rehydrate a Kairos workspace project for migration-safe startup.
  Covers seed files, project-brief syncing, project-local device media maps,
  optional GPX/manual-itinerary inputs, and phase resume detection. Use when
  starting a formal project, moving a project to another device/workspace, or
  repairing missing project initialization files before ingest/analyze/script/timeline.
---

# Kairos: Project Init

在正式跑 Ingest / Analyze / Script / Timeline 之前，先把项目内容层初始化好，并且保证这一步对迁移友好。

这条 skill 负责：
- 初始化项目骨架和种子文件
- 迁移后补齐缺失但可安全重建的初始化内容
- 把 `config/project-brief.md` 同步成正式 ingest 配置
- 维护项目内的本机私有路径映射
- 挂接项目级 GPX 和可选 `manual-itinerary`
- 判断当前项目已经能从哪个阶段继续

这条 skill 不负责：
- 环境部署和 ML server 安装
  - 这部分用 [deploy-kairos](../deploy-kairos/SKILL.md)
- 风格分析
  - 这部分用 [kairos-style-analysis](../kairos-style-analysis/SKILL.md)
- 正式执行 Ingest / Analyze / Script / Timeline / Export
  - 这些分别交给对应 phase skill

## 三种模式

- 新项目启动：`projects/<projectId>/` 还不存在，创建骨架并写种子文件
- 已同步项目迁移：项目目录已经从别的机器拷过来，只补本机相关初始化内容
- 现有项目修复：目录存在，但少了某些初始化文件，需要安全补齐

## 强规则

- 只有当 `projects/<projectId>/` 还不存在时，才调用 `initWorkspaceProject()`
- 如果项目目录已经存在，不要盲目重跑 `initProject()`，也不要覆盖这些同步产物：
  - `store/project.json`
  - `store/manifest.json`
  - `store/assets.json`
  - `store/slices.json`
  - `analysis/asset-reports/*.json`
  - `script/current.json`
  - `timeline/current.json`
  - `subtitles/*`
  - `gps/merged.json`
  - `gps/derived.json`
- `config/project-brief.md` 是人类可编辑的路径和说明入口；不要优先手改 `ingest-roots.json`
- `config/device-media-maps.local.json` 是项目内的本机私有映射，方便迁移后重绑路径，但不应当作可同步事实源
- `store/assets.json[*].sourcePath` 必须保持 root-relative；迁移时不要改写成当前机器绝对路径

## 当前项目骨架

### `initWorkspaceProject()` 自动创建的目录

```text
project/
├── config/
│   └── styles/
├── store/
├── media/
├── .tmp/
├── script/
│   └── versions/
├── timeline/
│   └── versions/
├── subtitles/
├── adapters/
├── analysis/
│   ├── asset-reports/
│   └── reference-transcripts/
└── gps/
    └── tracks/
```

### `initWorkspaceProject()` 自动创建的文件

- `store/project.json`
- `store/manifest.json`
- `config/ingest-roots.json`
- `config/project-brief.md`
- `script/script-brief.md`

### 后续按需出现的文件

- `config/device-media-maps.local.json`
  - 首次执行 `syncWorkspaceProjectBrief()` 或 `saveProjectDeviceMap()` 后出现
- `gps/tracks/*.gpx`
  - 导入项目级 GPX 后出现
- `gps/merged.json`
  - 导入项目级 GPX 后刷新
- `gps/derived.json`
  - ingest refresh 后刷新
- `config/manual-itinerary.md`
  - 用户需要弱空间证据时再创建
- `config/runtime.json`
  - 可选本地运行时覆盖，不是 `initProject()` 自动产物

## 可用入口

```typescript
import {
  initWorkspaceProject,
  resolveWorkspaceProjectRoot,
  writeWorkspaceProjectBrief,
  syncWorkspaceProjectBrief,
  saveProjectDeviceMap,
  assignProjectDeviceMediaRoot,
  buildProjectBriefTemplate,
  writeScriptBriefTemplate,
  importProjectGpxTracks,
  ingestWorkspaceProjectMedia,
} from 'kairos';
```

常用起手：

```typescript
const projectRoot = await initWorkspaceProject(
  workspaceRoot,
  projectId,
  projectName,
  projectDescription,
);
```

## 推荐流程

1. 判定模式
- `projects/<projectId>/` 不存在：新项目启动
- 项目目录已存在且已有 `store/project.json`：迁移 / 修复模式
- 如果项目目录存在但核心文件不全，先补初始化，再决定是否继续后续 phase

2. 新项目启动
- 调 `initWorkspaceProject(workspaceRoot, projectId, name, description?)`
- 这一步只创建骨架和基础种子文件，不会自动扫描素材

3. 迁移或修复已有项目
- 先保留所有已同步产物
- 仅补齐缺失的种子目录和初始化文件
- 如果 `config/project-brief.md` 缺失，可以用 `writeWorkspaceProjectBrief()` 或 `buildProjectBriefTemplate()` 重建
- 如果 `script/script-brief.md` 缺失，可以用 `writeScriptBriefTemplate()` 回填
- 不要为了补一个文件去重跑整套 `initProject()`

4. 维护 `project-brief`
- 路径映射统一先写到 `config/project-brief.md`
- 推荐让用户用自然语言维护：

```text
路径：F:\NZ\Pocket3
说明：口袋机位，步行和口播为主

路径：F:\NZ\Drone
说明：无人机，全景与地貌空镜
```

5. 从 `project-brief` 同步正式配置
- 调 `syncWorkspaceProjectBrief(workspaceRoot, projectId)`
- 会更新：
  - `config/ingest-roots.json`
  - `config/device-media-maps.local.json`
- 当前实现里，如果 `project-brief.md` 没有任何映射条目，会保留现有 roots 和 device map，不会强行清空

6. 只有在确实不想走 `project-brief` 时，才直写本机映射
- 可用：
  - `saveProjectDeviceMap()`
  - `assignProjectDeviceMediaRoot()`
- 这只是本机便利入口，不应替代 `project-brief` 作为长期事实源

7. 如有项目级 GPS，再挂到项目里
- 外部 GPX 不要只记在临时路径里，应复制到：
  - `gps/tracks/*.gpx`
- 用 `importProjectGpxTracks()` 导入并刷新 `gps/merged.json`
- 当前 Analyze 的空间优先级是：
  - `embedded GPS > project GPX > project-derived-track > none`

8. 如需弱空间证据，再补 `manual-itinerary`
- 文件位置：`config/manual-itinerary.md`
- 这是项目内容的一部分，但不是路径映射输入
- 修改完后，若希望它参与空间推断，需要重新跑一次 ingest，刷新 `gps/derived.json`

9. 本地运行时覆盖按需补
- `config/runtime.json` 不是初始化必需项
- 如果当前机器需要显式指定 `ffmpegPath` / `ffprobePath` / `mlServerUrl`，再创建它
- 当前加载顺序是：
  - `projects/<projectId>/config/runtime.json`
  - `<workspaceRoot>/config/runtime.json`

## 迁移后的恢复检查

优先检查这些文件，判断项目能从哪一步继续：

| 检查项 | 结论 |
|---|---|
| `store/project.json` + `store/manifest.json` | 项目骨架已经存在 |
| `config/project-brief.md` | 可以继续维护素材路径与说明 |
| `config/ingest-roots.json` + `config/device-media-maps.local.json` | 可以直接进入 Ingest |
| `store/assets.json` | 可以跳过首轮 Ingest |
| `analysis/asset-reports/*.json` + `store/slices.json` | 可以跳过 Analyze |
| `script/current.json` | 可以跳过 Script 起稿 |
| `timeline/current.json` | 可以直接做导出或继续改时间线 |

## 迁移注意点

- 迁移项目时，优先复制整个 `projects/<projectId>/`
- 到新机器后，第一件事不是改 `assets.json`，而是重绑 `project-brief` / `device-media-maps.local.json`
- 如果素材根目录换了，只改路径映射，不改 `sourcePath`
- 如果迁移时没带 `gps/tracks/` 或 `gps/merged.json`，后续没有 embedded GPS 的素材会丢掉一层空间证据
- 如果用户更新过 `manual-itinerary` 但没重新跑 ingest，`gps/derived.json` 会是旧的
- 如果只做“项目内容初始化”，不要顺手启动 Analyze 或 ML server

## 交接给后续 phase

- 素材导入：用 [kairos-ingest](../kairos-ingest/SKILL.md)
- 素材分析：用 [kairos-analyze](../kairos-analyze/SKILL.md)
- 脚本创作：用 [kairos-script](../kairos-script/SKILL.md)
- 时间线构建：用 [kairos-timeline](../kairos-timeline/SKILL.md)
- 导出：用 [kairos-export](../kairos-export/SKILL.md)
