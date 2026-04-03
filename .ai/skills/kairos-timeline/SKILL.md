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
//   fps: number (default 30),
//   width: number (default 3840),
//   height: number (default 2160),
//   name: string (default 'Untitled'),
//   assetReports?: IAssetCoarseReport[],
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
planSubtitles(
  script: IKtepScript[],
  clips: IKtepClip[],
  slices: IKtepSlice[],
  config?: Partial<ISubtitleConfig>,
): IKtepSubtitle[]

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
  fps: 30,
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

const subtitles = planSubtitles(script, clips, slices, {
  maxCharsPerCue: 15,
  language: 'zh',
});
```

## 字幕来源规则

Timeline 阶段的字幕已经不是“永远只切 `beat.text`”：

- 默认仍以 `beat.text` 作为旁白/成片字幕来源
- 如果选中的 `slice` 带有明确 `transcriptSegments`，且脚本显式要求 `preserveNatSound=true`，会优先按原声时间轴生成字幕
- 如果脚本显式要求 `muteSource=true`，即使素材里有 transcript，也会回到 `beat.text`
- 如果脚本没有显式标注，系统会根据 `speechCoverage`、`beat.text` 与 transcript 的匹配程度、以及段落角色自动推论是否保留原声
- 当前推论默认对 `intro / transition / outro` 更保守，避免“因为素材里有人说话就把过门镜头错误保留原声”
- 如果某条视频资产在 Analyze 的 `assetReports` 里被保守推荐切到 `protectionAudio`，且当前 beat 走 `preserveNatSound`，时间线会把视频原音静音，并外挂一条对齐的 `nat` 音轨作为原声 fallback
- 如果 `beat.utterances[]` 存在，字幕会按多段 utterance + `pauseBeforeMs / pauseAfterMs` 生成多个有声岛，而不是把整个 beat 当成连续配音
- 当某拍不走 source speech 时，命中的带音轨视频 clip 会被标记为静音意图，供导出适配器把原音压到静音

## 画面时长与速度规则

- 对 Analyze 新产出的 slice，时间线默认优先使用 `editSourceInMs / editSourceOutMs`，而不是旧的 tight focus window
- 只有旧 slice / 旧 selection 缺少 edit bounds 时，`placeClips()` 才会回落到 legacy stretch 行为
- 如果确实需要速度变化，应显式使用 `beat.actions.speed`
- 显式 `speed` 现在会进入 timeline clip `speed`，并继续透传到导出层；不要再依赖“短 source + 长 target”去隐式制造慢放
- `drive` slice 上的 `speedCandidate` 只是建议档位，不是自动应用的最终速度
- 保护音轨 fallback 当前只在 `assetReports` 明确推荐 `protection` 时才会自动路由；默认仍优先保留视频内无线 mic

## 产出

| 文件 | 格式 | 内容 |
|------|------|------|
| `timeline/current.json` | `IKtepDoc` | 完整 KTEP 文档（含 project, assets, slices, script, timeline, subtitles） |

## 决策点

- **默认输出规格**：若项目 `config/runtime.json` 未显式设置 `timelineWidth / timelineHeight / timelineFps`，默认生成 `3840x2160 @ 30fps`
- **项目覆盖**：如果项目有明确输出要求，应优先通过 `config/runtime.json` 覆盖默认规格，而不是只在某个 NLE 导出阶段临时改
- **速度决策**：`drive` 段落如果需要更快节奏，优先写显式 `actions.speed`，不要靠缩短 selection 或期待导出器自动推导
- **转场风格**：`cross-dissolve`（柔和）vs `fade`（正式）vs `cut`（干脆）
- **照片时长**：默认 5 秒，快节奏可以 3 秒，慢节奏可以 7 秒
- **字幕字数**：`maxCharsPerCue` 控制每条字幕的最大字数，中文建议 15-20
