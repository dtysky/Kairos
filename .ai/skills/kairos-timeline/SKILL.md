---
name: kairos-timeline
description: >-
  Phase 4: Build KTEP timeline from script, slices and assets. Place clips,
  plan transitions and subtitles, validate the document. Use when building
  timeline, placing clips, or the user mentions timeline, edit, or assembly.
---

# Kairos: Phase 4 — Timeline

从脚本 + 切片 + 资产构建完整 KTEP 时间线文档。

## 前置条件

- `store/assets.json` — 资产列表
- `store/slices.json` — 切片列表
- `script/current.json` — 脚本

三个文件均存在且非空。

## 可用工具

```typescript
// 一键构建：脚本 → 摆放 → 转场 → 字幕 → 校验 → IKtepDoc
buildTimeline(
  project: IKtepProject,
  assets: IKtepAsset[],
  slices: IKtepSlice[],
  script: IKtepScript[],
  config?: Partial<IBuildConfig>,
): IKtepDoc

// IBuildConfig:
// {
//   fps: number (default 25),
//   width: number (default 3840),
//   height: number (default 2160),
//   name: string (default 'Untitled'),
//   placement?: Partial<IPlacementConfig>,
//   transition?: Partial<ITransitionConfig>,
//   subtitle?: Partial<ISubtitleConfig>,
// }

// 或分步执行：

// 1. 摆放 clip
placeClips(
  script: IKtepScript[], slices: IKtepSlice[], assets: IKtepAsset[],
  config?: Partial<IPlacementConfig>,
): { tracks: IKtepTrack[]; clips: IKtepClip[] }

// IPlacementConfig:
// { maxSliceDurationMs: 15000, defaultTransitionMs: 500, photoDefaultMs: 5000 }

// 2. 规划转场
planTransitions(clips: IKtepClip[], config?: Partial<ITransitionConfig>): IKtepClip[]

// ITransitionConfig:
// { defaultType: 'cut', sceneChangeType: 'cross-dissolve', sceneChangeDurationMs: 800 }

// 3. 生成字幕
planSubtitles(script: IKtepScript[], clips: IKtepClip[], config?: Partial<ISubtitleConfig>): IKtepSubtitle[]

// ISubtitleConfig:
// { maxCharsPerCue: 20, language: 'zh' }

// 4. 校验 KTEP 文档
validateKtepDoc(doc: IKtepDoc): IValidationResult
// IValidationResult = { ok: boolean; errors: IValidationError[] }
// IValidationError = { rule: string; message: string; path?: string }
```

## 工作流程

### 快速路径（推荐）

```typescript
import { buildTimeline, readJson, writeJson } from 'kairos';

const assets = await readJson('store/assets.json', z.array(IKtepAsset));
const slices = await readJson('store/slices.json', z.array(IKtepSlice));
const script = await readJson('script/current.json', z.array(IKtepScript));

const project: IKtepProject = {
  id: randomUUID(),
  name: '新西兰纪录片',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const doc = buildTimeline(project, assets, slices, script, {
  name: '新西兰纪录片',
  fps: 25,
  width: 3840,
  height: 2160,
});

await writeJson('timeline/current.json', doc);
```

### 分步路径（需要精细控制时）

```typescript
const { tracks, clips: rawClips } = placeClips(script, slices, assets, {
  maxSliceDurationMs: 12000,
  photoDefaultMs: 4000,
});

const clips = planTransitions(rawClips, {
  sceneChangeType: 'fade',
  sceneChangeDurationMs: 1000,
});

const subtitles = planSubtitles(script, clips, {
  maxCharsPerCue: 15,
  language: 'zh',
});
```

## 产出

| 文件 | 格式 | 内容 |
|------|------|------|
| `timeline/current.json` | `IKtepDoc` | 完整 KTEP 文档（含 project, assets, slices, script, timeline, subtitles） |

## 决策点

- **分辨率**：4K (3840x2160) 或 1080p (1920x1080)？取决于素材和目标平台
- **帧率**：25fps（欧洲/旅拍常见）或 30fps（北美/网络）或 24fps（电影感）
- **转场风格**：`cross-dissolve`（柔和）vs `fade`（正式）vs `cut`（干脆）
- **照片时长**：默认 5 秒，快节奏可以 3 秒，慢节奏可以 7 秒
- **字幕字数**：`maxCharsPerCue` 控制每条字幕的最大字数，中文建议 15-20
