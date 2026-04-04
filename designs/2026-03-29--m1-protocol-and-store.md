# M1 — 协议与核心存储

> 日期：2026-03-29
> 状态：已实施
> 依赖：`designs/2026-03-28--middle-version-protocol-first.md`

## 目标

将中间版本设计中定义的 KTEP 协议落地为 Zod schema，实现协议校验器和项目存储层。

## 技术选型

| 维度 | 选择 |
|------|------|
| 运行时 | Node.js >= 16 |
| 包管理器 | pnpm |
| 模块系统 | ESM (`"type": "module"`) |
| Schema 校验 | Zod |
| 语言 | TypeScript (strict) |

## 命名规范

| 类别 | 前缀 | 示例 |
|------|------|------|
| Enum | `E` | `EAssetKind` |
| Interface / Type | `I` | `IKtepAsset` |
| Constant | `C` | `CPROTOCOL` |

Zod schema 和 TypeScript 类型共用同名：

```typescript
export const IKtepAsset = z.object({ ... });
export type IKtepAsset = z.infer<typeof IKtepAsset>;
```

## 文件结构

```
src/
├── protocol/
│   ├── schema.ts       # Zod schema + 类型 + 枚举 + 常量
│   ├── validator.ts    # 协议不变量校验
│   └── index.ts
├── store/
│   ├── writer.ts       # 原子 JSON 读写
│   ├── project.ts      # 项目初始化 + 加载
│   └── index.ts
└── index.ts
```

## 项目初始化产物

`initProject()` 当前会创建的项目骨架已经不只包含 store，还包括后续风格分析和媒体分析会复用的配置目录：

```text
<project_root>/
├── config/
│   ├── ingest-roots.json
│   ├── runtime.json
│   └── styles/
├── store/
│   ├── project.json
│   └── manifest.json
├── media/
├── analysis/
│   └── reference-transcripts/
├── script/
│   └── versions/
├── timeline/
│   └── versions/
├── subtitles/
└── adapters/
```

其中：

- `config/runtime.json` 用于保存项目级运行时配置，不依赖环境变量
- `config/styles/` 保存风格档案与分类目录
- `analysis/reference-transcripts/` 保存后续风格分析和素材分析生成的正式转写文本

## Schema 清单

### 常量
- `CPROTOCOL` = `'kairos.timeline'`
- `CVERSION` = `'1.0'`

### 枚举
- `EAssetKind`, `ESliceType`, `EEvidenceSource`, `EScriptRole`
- `ETrackKind`, `ETrackRole`, `ETransitionType`
- `ECaptureTimeSource`, `EMediaRootCategory`

### 接口
- `IKtepDoc` — 顶层文档
- `IKtepProject` — 项目元信息
- `IKtepAsset` — 资产
- `IKtepSlice` — 切片
- `ITranscriptSegment` — 切片/素材的语音转写片段
- `IInferredGps` — 分析层推断出来的单条 GPS 结果
- `IKtepEvidence` — 证据
- `IKtepScriptAction` — 脚本行为
- `IKtepScriptSelection` — 从 `slice` 中真正选中的子区间
- `IKtepScriptBeat` — 脚本最小编排单元
- `IKtepScript` — 脚本段落
- `IKtepTimeline` — 时间线
- `IKtepTrack` — 轨道
- `IKtepClip` — 片段摆放
- `IKtepTransition` — 转场
- `IKtepTransform` — 变换
- `IKtepKenBurns` — Ken Burns 参数
- `IKtepSubtitle` — 字幕
- `IMediaRoot` — 输入目录配置
- `ICaptureTime` — 拍摄时间信息
- `IStoreManifest` — 存储清单
- `IRuntimeConfig` — 项目级运行时配置

当前补充口径：

- `IMediaRoot` 不再包含 `defaultTimezone`；视频等容器素材以 `create_time(UTC)` 为主时间来源，照片优先使用 EXIF 原始时间与时区
- `IAssetCoarseReport` 允许挂载 `inferredGps`，用于保存最终采用的结构化空间结果；当前来源优先级为 `embedded GPS > project GPX > project-derived-track`

## 校验器

实现设计文档 9.7 节定义的 8 条协议不变量：

1. 所有时间统一使用毫秒 — 由 schema 类型保证
2. `timelineOutMs > timelineInMs` — 运行时校验
3. `sourceOutMs > sourceInMs`（若存在） — 运行时校验（clip + slice）
4. `clip.trackId` 引用存在的轨道 — 运行时校验
5. `clip.assetId` 引用存在的资产 — 运行时校验
6. `clip.sliceId` 若存在，引用存在的切片 — 运行时校验
7. 字幕时间范围不得为负 — 运行时校验
8. 编辑器私有字段不进入核心 — 由 schema 结构保证（`adapterHints`）

## 脚本与时间线的当前方向

这一版实现之后，正式设计口径应理解为：

- `slice` 是候选时间窗，不是最终必用区间
- `slice` 可以同时携带视觉摘要和语音证据：`summary / transcript / transcriptSegments / speechCoverage / evidence[]`
- `selection` 才是脚本和时间线真正使用的子区间
- `beat` 是脚本、时间线和字幕共享的最小编排单元
- `subtitle` 默认来自 `beat.text`，但当该 beat 保留原声时，也可以直接来自 `slice.transcriptSegments`
- `preserveNatSound` / `muteSource` 是脚本层的显式覆盖信号；未显式设置时，时间线层允许结合 transcript 匹配度、`speechCoverage` 和 segment role 自动推论
- `segment plan` 必须先经过用户审查，再进入候选召回和 beat 编排
- `script-brief` 不再只有一份，而是按阶段拆成 project / segment-plan / segment / beat-polish 四层

也就是说，正式的时间线编排顺序应是：

1. `project brief` 形成全片约束
2. `material digest` 形成全量素材印象
3. `segment-plan brief` 和系统一起产出 1-3 套 `segment plan drafts`
4. 用户确认 `approved segment plan`
5. `segment brief` 为每个段落约束召回与 beat 试写
6. `candidate recall` 为每个段落召回候选 `slice`
7. `beat` 确定每一小拍要说什么
8. `selection` 确定每一小拍到底用 `slice` 里的哪一段
9. `beat-polish brief` 做局部精修
10. `timeline clip` 和 `subtitle cue` 共同引用这些 beat 级决策

## Store 层

- `writeJson()`: 写入临时文件 → `fs.rename` 原子替换
- `readJson()`: 读取 + Zod 校验
- `initProject()`: 创建完整目录结构 + 初始 manifest
- `loadManifest()` / `loadIngestRoots()` / `loadRuntimeConfig()`: 读取项目状态

当前 `IRuntimeConfig` 已落地的字段：

```typescript
interface IRuntimeConfig {
  ffmpegPath?: string;
  ffprobePath?: string;
  ffmpegHwaccel?: string;
  analysisProxyWidth?: number;
  analysisProxyPixelFormat?: string;
  sceneDetectFps?: number;
  sceneDetectScaleWidth?: number;
  mlServerUrl?: string;
}
```

默认初始化值：

```json
{
  "analysisProxyWidth": 1024,
  "analysisProxyPixelFormat": "yuv420p",
  "sceneDetectFps": 4
}
```

说明：

- `ffmpegPath` / `ffprobePath` 记录项目实际使用的原生工具路径
- `ffmpegHwaccel` 记录默认视频硬件解码方式
- `analysisProxyWidth` / `analysisProxyPixelFormat` 约束统一分析代理规格
- `mlServerUrl` 指向本地 ML Server，供分析工作流调用

## 与临时工作区的关系

`M1` 落地的是可持久化的 store 和 config；长时分析任务的中间产物和进度报告不属于 `Canonical Project Store`。

当前实现约定：

- 临时关键帧、代理音频、阶段摘要写入项目内 `.tmp/`
- 正式输出写入 `config/styles/`、`analysis/reference-transcripts/`、`analysis/style-references/`
- 后续流程可以通过 `.tmp/<pipeline>/<scope>/progress.json` 驱动本地网页进度监视器

这样可以兼顾：

- 迁移时只带走正式产物和 `config/runtime.json`
- 调试时保留 `.tmp/`
- 日常完成后清理临时中间文件

## 延后项

- Revision 追踪（JSONL）
- 文档级快照
- 项目级备份
- Schema migration
