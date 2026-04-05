# Kairos — 项目数据结构

> 当前方案的浓缩入口：[`current-solution-summary.md`](./current-solution-summary.md)。
> 本文当前同时承担两种职责：顶部给出当前正式结构要点，后文保留较多早期结构与迁移背景，适合作为历史与细节补充阅读。
>
> 注：本文后半部分仍保留早期数据结构草案内容；当前正式口径应以本文顶部要点、[`current-solution-summary.md`](./current-solution-summary.md) 与较新的协议 / 存储设计为准。
> 若需要查看历史推导，可继续参考
> [2026-03-28--middle-version-protocol-first.md](./2026-03-28--middle-version-protocol-first.md)
> 和
> [2026-03-29--m1-protocol-and-store.md](./2026-03-29--m1-protocol-and-store.md)
> 。

## 当前正式结构要点

- 正式主链以 `Pharos` 为主输入，兼容没有 `Pharos` 的 fallback 路径
- 当前实现仍是临时版本，但已经覆盖正式主链中的多个阶段
- 主链消费的是项目当前采用的素材版本；它可以是原始素材，也可以是独立调色链路产出的版本
- `DaVinci color` 是与主链解耦的独立增强链路，而不是主链中的固定顺序步骤
- 只要主链消费的是派生素材版本，该版本就必须保留关键元信息，至少包括：
  - 媒体创建时间
  - 照片 EXIF 原始拍摄时间与时区
  - 文件 `create_time`
  - GPS / 空间相关元信息
  - 后续与 `Pharos`、chronology、空间推断对齐所需的其他核心字段
- 当前正式项目结构围绕 `projects/<projectId>/`、`config/runtime.json`、logical ingest roots、`config/device-media-maps.local.json`、Workspace 结构化配置 JSON、`gps/tracks/*.gpx`、`gps/merged.json`、`gps/same-source/`、`gps/derived.json` 与项目内 `.tmp/` 展开
- 本地运行与项目配置当前由 `Supervisor + Hana UI console` 承载；`Analyze` 与 `Style` 监控直接挂在 `/analyze` 与 `/style` 主路由上

## 当前实现与早期草案的差异注记（2026-03-29 之后）

当前实现虽然仍是临时版本，但已经在结构上对齐了多项正式口径；与本文早期草案相比有几处关键差异：

- `projects/<project_id>/`
  - 下一阶段的正式设计建议把项目数据统一收口到 Kairos 工程内的 `projects/` 目录
  - 这样便于云同步、多设备共享和项目选择
- `config/device-media-maps.local.json`
  - 素材真实目录不再直接写死在正式产物中，而是由当前设备在项目内维护本地路径映射
  - 该文件属于本机私有配置，应默认忽略，不作为项目同步内容
  - 每个 root 本地映射现在还可以带 `flightRecordPath`，用于声明该素材源对应的 DJI FlightRecord 目录或文件；实际识别按文件头/可解析性完成
- `config/runtime.json`
  - 当前项目把 `ffmpegPath`、`ffprobePath`、`ffmpegHwaccel`、`analysisProxyWidth`、`analysisProxyPixelFormat`、`sceneDetectFps`、`mlServerUrl`、`djiOpenAPIKey` 等运行时设置落在项目内配置中
  - 时间线 / 草稿输出规格也从这里读取：`timelineWidth`、`timelineHeight`、`timelineFps`
  - 剪映本地导出相关配置也在这里维护，例如 `jianyingDraftRoot`、`jianyingPythonPath`、`jianyingPyProjectRoot`
  - 不再依赖环境变量或用户口头约定
- `config/styles/`
  - 风格档案不再只是一份 `style/profile.json`
  - 当前使用 `config/styles/{category}.md + config/styles/catalog.json`
- Workspace 结构化配置
  - `config/project-brief.json`
  - `config/manual-itinerary.json`
  - `script/script-brief.json`
  - `config/style-sources.json`
  - `config/review-queue.json`
  - 这些 JSON 当前是 Console 的正式事实源，Markdown 继续保留为项目内可读派生产物
- `config/manual-itinerary.md` 与 `analysis/asset-reports/`
  - `manual-itinerary` 现在有两层正式语义：
    - 正文行程：项目级弱空间线索，不承担 timezone 输入语义，也不再作为 analyze 阶段的独立顶层来源
    - 末尾“素材时间校正”表格：人工 capture time override，用户填写 `正确日期 / 正确时间 / 时区` 后，下一次 ingest 会把它作为 `manual` 真值应用到资产时间
  - ingest 会在 refresh `project-derived-track` 时把正文编译进 `gps/derived.json`
  - 最终空间来源优先级为 `embedded GPS > project GPX > project-derived-track > none`
  - 如果 ingest 发现弱时间源和项目时间线明显冲突，会把阻塞项写进这张表；未填写或填写后未 rerun ingest 都会阻塞 Analyze
  - 结构化空间结果落在 `IAssetCoarseReport.inferredGps`，而不是写回素材主数据
- `config/project-brief.md`
  - 每个素材源 block 除了 `路径` / `说明`，还可以额外声明 `飞行记录路径`
  - 该字段用于把 root 伴随的 DJI FlightRecord 日志纳入 ingest 标准流程，而不是依赖硬编码文件名
- ingest root 旁路 sidecar
  - 与素材同 basename 的 `.SRT` 会在 ingest 时自动发现并绑定
  - 绑定成功后按同源 `embedded GPS` 进入主优先级链路
- `gps/tracks/` 与 `gps/merged.json`
  - 项目级外部轨迹资源现统一收口到 `gps/tracks/*.gpx`
  - 标准化后的缓存写到 `gps/merged.json`
  - Analyze 在没有显式 `gpxPaths` 时默认读取这里，而不是要求每次调用临时传路径
- `gps/same-source/`
  - sidecar `.SRT` / root 级 FlightRecord 这类 dense same-source 轨迹会规范化写到 `gps/same-source/tracks/*.gpx`
  - `gps/same-source/index.json` 维护 `trackId -> source/origin/file` 的项目内索引
  - 这套内部 GPX 只用于索引 / 惰性查找，不改变 `embedded GPS > project GPX > project-derived-track` 的正式优先级
- `store/assets.json`
  - 绑定成功的 same-source GPS 不再内联 dense `points[]`
  - 资产上的 `embeddedGps` 只保留轻量引用，如 `trackId / pointCount / representative / startTime / endTime / sourcePath`
- `gps/derived.json`
  - 项目级 `project-derived-track` 缓存
  - 当前 v1 统一收口 embedded-derived sparse points 与 manual-itinerary-derived sparse windows
  - Analyze 默认把它作为第三优先级空间层消费，不做跨 gap 插值
  - 照片若没有自身 GPS，也会使用修正后的 `capturedAt` 参与 project GPX / `project-derived-track` 的时间匹配
- `analysis/reference-transcripts/` 与 `analysis/style-references/`
  - 风格分析和参考视频分析会先落地单视频报告，再综合出一个正式风格分类
- `.tmp/`
  - 当前流水线的关键帧、代理音频、阶段摘要、进度文件统一写入项目内 `.tmp/`
  - 例如 `.tmp/style-analysis/{category}/progress.json`
  - 这些内容默认视为可清理的中间产物，不属于 `Canonical Project Store`
- 素材分析策略
  - 当前正式流程采用“粗扫优先 + 自动细扫”
  - 不是所有素材都默认做镜头级分析，也不是所有素材都会立刻生成 `slice`
- 脚本编排模型
  - 当前正式流程采用 `segment + beat + selection`
  - `slice` 是候选时间窗，`selection` 才是最终进入时间线的子区间
  - 字幕默认来自 `beat.text`，而不是从整段 narration 事后切分
  - `beat` 可选带 `utterances[]`，显式表达多段配音与停顿
  - 当某拍不走原声时，时间线会为命中的视频片段标记静音意图，交给导出适配器落地
- 段落审查闸门
  - 正式流程会先生成 `material digest` 和 `segment plan drafts`
  - 由用户审查并冻结为 `approved segment plan`
  - 之后才进入候选素材召回、beat 试写和粗剪提案
- 分层 `script-brief`
  - `project brief`、`segment-plan brief`、`segment brief`、`beat polish brief`
  - 都使用自然语言输入，分别作用于全片、段落审查、章节细化和局部精修
- 本地网页进度页
  - 当前由 `Supervisor` 聚合为控制台监控接口，再由 Hana UI 控制台展示
  - `Analyze` 与 `Style` 监控主入口分别是 `/analyze` 与 `/style`
  - 旧监控子路由只保留兼容跳转

如果要做新设备部署或数据迁移，请优先参考本文顶部要点、`current-solution-summary.md` 与较新的两份设计文档，而不是本文后文保留的旧 `cache/` 结构。

## 历史草案：运行时项目目录

每个 Kairos 项目（一次旅行 = 一个项目）在用户指定位置生成如下目录结构：

```
<project_root>/
├── kairos.project.json        # 项目配置（名称、创建时间、阶段状态、版本）
│
├── media/
│   ├── index.json             # 素材索引：clipId → MediaClip 映射
│   └── scenes.json            # 场景分组：sceneId → Scene 映射
│
├── gps/
│   ├── tracks/                # 原始 GPX 文件（项目级外部轨迹资源）
│   └── merged.json            # 归一化后的统一轨迹点缓存
│
├── style/
│   └── profile.json           # 风格档案（叙事结构 + 旁白风格）
│
├── script/
│   ├── current.json           # 当前脚本
│   └── versions/              # 脚本历史版本快照
│       └── v1_<timestamp>.json
│
├── color/
│   └── grades.json            # 调色方案（每条素材的节点树 + 参数）
│
├── cut/
│   ├── timeline.json          # 粗剪时间线
│   └── versions/              # 时间线历史版本
│       └── v1_<timestamp>.json
│
└── cache/                     # 可安全删除的临时数据
    ├── proxy/                 # 代理文件（720p H.264）
    │   └── <clipId>.mp4
    ├── thumbnails/            # 缩略图
    │   └── <clipId>.jpg
    ├── keyframes/             # 关键帧抽取
    │   └── <clipId>/
    │       └── <timestamp>.jpg
    ├── embeddings/            # CLIP 特征向量缓存
    │   └── <clipId>.json
    ├── whisper/               # 语音识别缓存
    │   └── <clipId>.json
    └── preprocess/            # 预处理状态（断点恢复）
        └── jobs.json
```

## 关键文件 Schema

### `kairos.project.json`

```json
{
  "version": "1.0.0",
  "name": "冰岛环岛 2026",
  "createdAt": "2026-03-20T10:00:00Z",
  "updatedAt": "2026-03-23T15:30:00Z",
  "stage": "script",
  "stages": {
    "ingest": { "status": "completed", "completedAt": "..." },
    "color": { "status": "completed", "completedAt": "..." },
    "script": { "status": "in_progress" },
    "cut": { "status": "pending" }
  },
  "mediaDirs": [
    "/Volumes/SSD/Iceland/A7R5/",
    "/Volumes/SSD/Iceland/ZVE1/",
    "/Volumes/SSD/Iceland/Mavic4Pro/"
  ],
  "config": {
    "styleProfileId": "default"
  }
}
```

### `media/index.json`

```json
{
  "clips": {
    "abc123def456": {
      "id": "abc123def456",
      "filePath": "/Volumes/SSD/Iceland/A7R5/C0001.MP4",
      "proxyPath": "cache/proxy/abc123def456.mp4",
      "type": "video",
      "metadata": {
        "duration": 45.2,
        "resolution": { "width": 3840, "height": 2160 },
        "fps": 25,
        "codec": "XAVC-S",
        "colorSpace": "S-Log3",
        "capturedAt": "2026-03-15T08:30:00Z"
      },
      "gps": { "lat": 64.1466, "lng": -21.9426 },
      "placeName": "雷克雅维克 · 哈尔格林姆斯大教堂",
      "sceneId": "scene_001",
      "tags": ["教堂", "城市", "日出"],
      "clipEmbedding": null
    }
  },
  "stats": {
    "totalClips": 342,
    "totalDuration": 12840,
    "lastScanAt": "2026-03-20T22:00:00Z"
  }
}
```

### `media/scenes.json`

```json
{
  "scenes": {
    "scene_001": {
      "id": "scene_001",
      "clipIds": ["abc123def456", "xyz789..."],
      "timeRange": {
        "start": "2026-03-15T08:30:00Z",
        "end": "2026-03-15T09:15:00Z"
      },
      "location": "雷克雅维克",
      "description": "日出时分的哈尔格林姆斯大教堂，从低角度拍摄教堂正面，阳光从侧面照射",
      "mood": "宁静",
      "pharosShotId": "shot_reykjavik_church"
    }
  }
}
```

### `style/profile.json`

```json
{
  "id": "default",
  "name": "默认风格",
  "sourceFiles": ["/Users/dtysky/Films/Iceland2024_final.mp4"],
  "narrative": {
    "introRatio": 0.08,
    "outroRatio": 0.05,
    "avgSegmentDuration": 25,
    "brollFrequency": 0.3,
    "pacePattern": "缓起→中段密集→结尾回归平静"
  },
  "voiceStyle": {
    "person": "1st",
    "tone": "沉浸、内省、偶有幽默",
    "density": "moderate",
    "sampleTexts": [
      "凌晨四点，冰岛的天还没完全亮起来。空气冷得让人清醒。",
      "这大概就是旅行的意义——你永远不知道下一个转弯会遇到什么。"
    ]
  },
  "createdAt": "2026-03-20T10:00:00Z",
  "updatedAt": "2026-03-20T10:00:00Z"
}
```

### `script/current.json`

```json
{
  "version": 3,
  "createdAt": "2026-03-21T14:00:00Z",
  "updatedAt": "2026-03-22T09:30:00Z",
  "totalDuration": 480,
  "segments": [
    {
      "id": "seg_001",
      "type": "intro",
      "narration": "三月的冰岛，极光季的尾巴。我带着两台相机和一架无人机，沿一号公路环岛。",
      "clipRefs": [
        { "clipId": "abc123def456", "inPoint": 5.0, "outPoint": 12.0 },
        { "clipId": "def456ghi789", "inPoint": 0, "outPoint": 8.0 }
      ],
      "estimatedDuration": 15,
      "mood": "期待",
      "notes": null
    }
  ]
}
```

### `color/grades.json`

```json
{
  "plans": {
    "abc123def456": {
      "clipId": "abc123def456",
      "colorSpace": "S-Log3",
      "nodes": [
        { "index": 1, "type": "cst", "params": { "from": "S-Gamut3.Cine/S-Log3", "to": "Rec.709" } },
        { "index": 2, "type": "correction", "params": { "lift": 0.02, "gamma": 1.05, "gain": -0.03 } }
      ]
    }
  }
}
```

## 缓存目录说明

`cache/` 下所有内容可安全删除并重新生成：

| 目录 | 内容 | 生成阶段 |
|------|------|----------|
| `proxy/` | 720p H.264 代理文件 | Ingest |
| `thumbnails/` | 缩略图（1 张/素材） | Ingest |
| `keyframes/` | 关键帧截图（每 5 秒 1 帧） | Ingest |
| `embeddings/` | CLIP 特征向量 | Ingest（场景检测） |
| `whisper/` | 语音识别结果 | Script（风格档案分析） |
| `preprocess/` | 预处理任务状态 | Ingest（断点恢复） |
