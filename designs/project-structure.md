# Kairos — 项目数据结构

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
