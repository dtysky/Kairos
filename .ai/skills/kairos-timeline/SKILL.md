---
name: kairos-timeline
description: >-
  Phase 4: Build KTEP timeline from script, slices and assets. Place clips,
  plan transitions and subtitles, validate the document. Use when building
  timeline, placing clips, or the user mentions timeline, edit, or assembly.
---

# Kairos: Phase 4 — Timeline

从脚本 + 切片 + 资产构建完整 KTEP 时间线文档。

## 变更工作流规则

只要本轮任务涉及需求、行为、接口、工作流、正式入口或用户路径变更，必须遵守下面顺序：

1. 先进入 `Plan` 模式；如果宿主没有显式 `Plan mode`，先给出结构化计划并得到确认。
2. 计划确认后，先更新相关设计文档，再开始实现。
3. 实现完成后，必须回查并同步受影响的设计文档、rules 和 skills，再结束本轮。
4. 如果变更影响正式入口、监控页、工作流主路径或用户操作方式，还要同步更新 `README.md`、`designs/current-solution-summary.md` 和 `designs/architecture.md`。

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
//   chronology?: IMediaChronology[],
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
// { maxSliceDurationMs: 15000, defaultTransitionMs: 500, photoDefaultMs: 1000, chronology?: IMediaChronology[] }

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
  photoDefaultMs: 1000,
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

Timeline 阶段的字幕已经按素材类型分流：

- photo-only beat 默认不生成字幕
- 只要主视频 selection 有可用 `transcriptSegments`，且没有显式 `muteSource=true`，系统默认按 source-speech 生成字幕
- 对最终走 source-speech 的 beat，时间线会优先把选区裁成 transcript-driven speech islands，并严格按 transcript 时间轴出字幕
- source-speech 的 clip 边界默认应直接贴过滤后的 spoken transcript / speech island；不要再为了“留空气”固定额外扩前后窗口
- 导航播报、录制口令、设备提示不应进入 source-speech context、speech islands 或 source-speech 字幕
- 如果 source-speech beat 的某个 ASR cue 清洗后仍不可读，时间线只跳过那个 cue；只有整段都不可读时，才保留原声但不生成字幕，不会回退到 `beat.text`
- 如果脚本显式要求 `muteSource=true`，即使素材里有 transcript，也会回到 narration 路径
- 只有非 source-speech、且不是 photo-only 的 beat，才会按 `beat.text` 或 `beat.utterances[]` 生成 narration 字幕
- 如果某条视频资产在 Analyze 的 `assetReports` 里被保守推荐切到 `protectionAudio`，且当前 beat 走 source-speech，时间线会把视频原音静音，并外挂一条对齐的 `nat` 音轨作为原声 fallback
- 当某拍不走 source speech 时，命中的带音轨视频 clip 会被标记为静音意图，供导出适配器把原音压到静音

## 画面时长与速度规则

- 对 Analyze 新产出的 slice，时间线默认优先使用 `editSourceInMs / editSourceOutMs`，而不是旧的 tight focus window
- 只有旧 slice / 旧 selection 缺少 edit bounds 时，`placeClips()` 才会回落到 legacy source range
- 对主轴明确偏时间 / 路程推进的 style，Timeline 还承担最后一层 chronology guardrail：
  - 相邻 beats 的主 selection `sortCapturedAt` 不应倒退
  - 同一 beat 内多 selections 默认也应按时间递增
  - 若检测到倒序，先尝试同段内安全重排；仍无法恢复时应直接报错，而不是静默输出错序时间线
- Timeline 不应再直接读取原始 `asset.capturedAt` 做排序；chronology guard、beat 排序与 selection 排序都必须统一消费 `media/chronology.json`
- `media/chronology.json` 当前以 `sortCapturedAt` 作为唯一正式时序真值：
  - 优先 `capturedAtOverride`
  - 其次 `asset.capturedAt + ingestRoot.clockOffsetMs`
  - 最后才回退原始 `asset.capturedAt`
- 如果确实需要速度变化，仍可显式使用 `beat.actions.speed`
- 显式 `speed` 现在会进入 timeline clip `speed`，并继续透传到导出层；但只有 `drive / aerial` clip 会实际消费，其他类型即使同拍也会强制保持 `1x`
- `placeClips()` 现在默认按自然 source 窗口或 edit-friendly bounds 摆放 clip，不再为了 `beat.targetDurationMs` 做压缩、拉伸或预算补齐
- 对 silent `drive / aerial` 粗剪 beat，如果 selection 自带 `speedCandidate` 且脚本没有显式写 `actions.speed`，时间线默认按 `2x` 自动加速
- 如果同一 asset 同时被选成 source-speech 和 silent `drive / aerial`，source-speech 优先占用重叠 source window；silent montage 只能消费非重叠 remainder
- 如果同一 `drive / aerial` asset 被多个 silent montage beat 重复引用，后面的 beat 也必须扣掉前面已经消费过的 source window，只保留新的 remainder
- 保护音轨 fallback 当前只在 `assetReports` 明确推荐 `protection` 时才会自动路由；默认仍优先保留视频内无线 mic
- `targetDurationMs` 在粗剪路径里只作为 advisory review hint，不再是默认 placement 驱动
- 照片不再是默认的预算填充器：
  - 没有显式长停要求时，单张照片默认 `1000ms`
  - 只有显式 `beat.actions.holdMs` 才应延长照片或静默停留
  - 需要补信息时，优先把有效素材列入时间线，而不是无上限拉长一张照片

## 产出

| 文件 | 格式 | 内容 |
|------|------|------|
| `timeline/current.json` | `IKtepDoc` | 完整 KTEP 文档（含 project, assets, slices, script, timeline, subtitles） |

## 决策点

- **默认输出规格**：若项目 `config/runtime.json` 未显式设置 `timelineWidth / timelineHeight / timelineFps`，默认生成 `3840x2160 @ 30fps`
- **项目覆盖**：如果项目有明确输出要求，应优先通过 `config/runtime.json` 覆盖默认规格，而不是只在某个 NLE 导出阶段临时改
- **速度决策**：`drive` 段落如果需要更快节奏，优先写显式 `actions.speed`，不要靠缩短 selection 或期待导出器自动推导
- **转场风格**：`cross-dissolve`（柔和）vs `fade`（正式）vs `cut`（干脆）
- **照片时长**：默认 1 秒；只有确实需要停留时才通过显式 `holdMs` 拉长
- **字幕字数**：`maxCharsPerCue` 控制每条字幕的最大字数，中文建议 15-20
