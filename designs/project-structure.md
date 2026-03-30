# Kairos — 项目数据结构

> 注：本文件是早期数据结构草案。自 `protocol-first` 中间版本起，当前实现与迁移规范应以
> [2026-03-28--middle-version-protocol-first.md](./2026-03-28--middle-version-protocol-first.md)
> 和
> [2026-03-29--m1-protocol-and-store.md](./2026-03-29--m1-protocol-and-store.md)
> 为准。

## 中间版本迁移注记（2026-03-29）

当前已实施的中间版本，与本文早期草案相比有几处关键差异：

- `projects/<project_id>/`
  - 下一阶段的正式设计建议把项目数据统一收口到 Kairos 工程内的 `projects/` 目录
  - 这样便于云同步、多设备共享和项目选择
- `~/.kairos/device-media-maps.json`
  - 素材真实目录不再直接写死在项目内，而是由每台设备单独维护本地路径映射
- `config/runtime.json`
  - 当前项目把 `ffmpegPath`、`ffprobePath`、`ffmpegHwaccel`、`analysisProxyWidth`、`analysisProxyPixelFormat`、`sceneDetectFps`、`mlServerUrl` 等运行时设置落在项目内配置中
  - 不再依赖环境变量或用户口头约定
- `config/styles/`
  - 风格档案不再只是一份 `style/profile.json`
  - 当前使用 `config/styles/{category}.md + config/styles/catalog.json`
- `analysis/reference-transcripts/` 与 `analysis/style-references/`
  - 风格分析和参考视频分析会先落地单视频报告，再综合出一个正式风格分类
- `.tmp/`
  - 当前流水线的关键帧、代理音频、阶段摘要、进度文件统一写入项目内 `.tmp/`
  - 例如 `.tmp/style-analysis/{category}/progress.json`
  - 这些内容默认视为可清理的中间产物，不属于 `Canonical Project Store`
- 素材分析策略
  - 下一阶段正式设计采用“粗扫优先 + 自动细扫”
  - 不是所有素材都默认做镜头级分析，也不是所有素材都会立刻生成 `slice`
- 脚本编排模型
  - 下一阶段正式设计采用 `segment + beat + selection`
  - `slice` 是候选时间窗，`selection` 才是最终进入时间线的子区间
  - 字幕默认来自 `beat.text`，而不是从整段 narration 事后切分
- 段落审查闸门
  - 正式流程会先生成 `material digest` 和 `segment plan drafts`
  - 由用户审查并冻结为 `approved segment plan`
  - 之后才进入候选素材召回、beat 试写和粗剪提案
- 分层 `script-brief`
  - `project brief`、`segment-plan brief`、`segment brief`、`beat polish brief`
  - 都使用自然语言输入，分别作用于全片、段落审查、章节细化和局部精修
- 本地网页进度页
  - 长时任务通过轮询 `.tmp/.../progress.json` 展示 `第 N / M 步`、`第 N / M 帧`、`剩余时间`

如果要做新设备部署或数据迁移，请优先参考较新的两份设计文档，而不是本文的旧 `cache/` 结构。

## 运行时项目目录

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
│   ├── tracks/                # 原始 GPX 文件（多源：Pharos 手机端/DJI 无人机 SRT）
│   ├── merged.json            # 合并去重后的统一轨迹
│   └── geocode-cache.json     # 逆地理编码缓存
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
