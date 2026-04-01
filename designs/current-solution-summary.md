# Kairos — 当前方案总结

> 本文档用于把当前已经稳定的 Kairos 方案收口成一份浓缩入口。
> 它不是新的 ADR，也不替代迭代设计文档；它的职责是先回答“Kairos 现在到底是什么、怎么工作、哪些结论已经稳定”。

## 1. 当前产品形态

Kairos 当前需要区分两层：

- **正式流程定义**：以 `Pharos` 为主输入来源，围绕项目素材、分析结果、脚本编排与时间线落地组织完整工作流
- **当前实现形态**：以 `Node.js core + Agent skill` 作为临时承载形态，已经覆盖正式流程中的多个阶段，但还不等于正式流程的全部实现

在这个前提下，Kairos 当前的正式方案可以概括为：

- 一个以 `KTEP` 为核心协议的后期编排系统
- 一个以 `projects/<projectId>/` 为中心的项目化存储体系
- 一条以 `Pharos -> ingest -> analyze -> script -> timeline -> export` 为骨架的正式主流程
- 一条与主链解耦的 `DaVinci color` 独立增强链路
- 一组运行在 Agent 环境中的工作流技能，以及面向不同 NLE / 导出目标的适配层

这意味着：

- Kairos 不把 NLE 当作主数据中心，而把它们视为执行器或导出目标
- 当前的 `Node.js core + Agent skill` 是对正式流程的临时承载形态，而不是正式流程本身的唯一边界
- 未来如果引入桌面 UI 或更多 provider / adapter，应建立在这套协议与项目模型上，而不是推翻它
- 某些项目会直接消费调色后的素材版本而非原始素材；因此主链面向的是“当前采用的素材版本”，而不是固定绑定“永远使用原始素材”

## 2. 正式主流程

```mermaid
flowchart TD
  pharos[PharosInput]
  sourceMedia[SourceMedia]
  colorChain["DaVinciColorChain (independent)"]
  adoptedMedia[AdoptedMediaVersion]
  ingest[Ingest]
  analyze[Analyze]
  script[Script]
  timeline[Timeline]
  exportFlow[Export]

  sourceMedia --> adoptedMedia
  sourceMedia --> colorChain
  colorChain --> adoptedMedia
  adoptedMedia --> ingest
  ingest --> analyze
  pharos --> script
  analyze --> script
  script --> timeline
  timeline --> exportFlow
```

这里的正式关系是：

- `Pharos` 是正式流程的主输入之一，主要驱动脚本规划、拍摄语义和素材对齐
- `AdoptedMediaVersion` 表示项目当前采用的素材版本，它可以是原始素材，也可以是独立调色链路产出的版本
- `DaVinciColorChain` 是独立链路，不属于主链中的固定顺序步骤
- 如果项目没有 `Pharos`，主链允许退化为基于素材、brief、行程和分析结果的兼容路径，但这属于 fallback，而不是正式主定义

### Ingest

- 通过逻辑素材源导入项目当前采用的素材版本
- 真实本机目录路径不写死进项目，而是通过设备本地映射维护
- 保留素材真值，例如 `capturedAt`、`rawTags`、基础 metadata
- 如果输入素材来自独立调色/转换链路，该链路必须先保证关键元信息被保留下来

### Analyze

- 当前正式策略是“粗扫优先 + 自动细扫”
- 视频内音轨的 ASR 已进入正式分析链路，而不再只是附属信息
- `transcript / transcriptSegments / speechCoverage / placeHints / inferredGps` 都属于分析层结果

### Script

- 正式脚本编排已经不是“整段 narration + 粗引用素材”的模型
- 当前正式模型是 `segment + beat + selection`
- 用户审查闸门存在于脚本生成之前，而不是召回和编排全部完成之后

### Timeline / Export

- 时间线与导出围绕 `KTEP` 展开
- 字幕默认来自 `beat.text`
- 当某拍保留原声时，字幕也可以来自 `slice.transcriptSegments`
- Resolve、剪映或其他导出目标都应建立在同一套正式时间线语义之上

## 3. 协议与数据骨架

### KTEP 是正式交换协议

- 协议名：`kairos.timeline`
- 当前版本：`1.0`
- Zod schema 与协议校验器共同定义正式数据边界

### 核心对象关系

```mermaid
flowchart TD
  asset[Asset]
  slice[Slice]
  selection[Selection]
  beat[Beat]
  segment[Segment]
  timeline[TimelineClip]
  subtitle[SubtitleCue]

  asset --> slice
  slice --> selection
  selection --> beat
  beat --> segment
  beat --> timeline
  beat --> subtitle
```

### 当前正式语义

- `asset`：素材真值层，保存原始资产事实
- `slice`：分析后得到的候选时间窗
- `selection`：脚本 / 时间线真正使用的子区间
- `beat`：当前正式的最小编排单元
- `segment`：叙事层面的段落容器

关键结论：

- `slice` 不承诺整段都会被用到
- `selection` 才决定到底使用 `slice` 里的哪几秒
- `beat` 统一承接文案、画面选择、字幕和时间线编排
- `segment.narration` 若存在，应理解为 beat 级文本的聚合预览，而不是时间线摆放的唯一真源

## 4. 项目布局与存储边界

### 项目目录

当前正式项目模型围绕 `projects/<projectId>/` 展开，主要包括：

- `config/`：逻辑素材源、运行时配置、风格档案、人工 itinerary 等
- `store/`：项目元数据与清单
- `analysis/`：资产分析报告、参考转写等正式分析产物
- `script/`、`timeline/`、`subtitles/`、`adapters/`：脚本、时间线与适配器状态
- `gps/`：项目级外部轨迹资源与归一化缓存
- `.tmp/`：流水线临时产物、进度、代理音频、关键帧等可清理内容

### 三类边界

- 项目内正式产物：可同步、可复用、可作为正式输入继续流转
- 设备本地映射：`~/.kairos/device-media-maps.json`，只描述当前设备能访问到的素材真实目录
- 临时产物：`.tmp/`，默认不属于 `Canonical Project Store`

### 当前稳定约定

- `config/ingest-roots.json` 保存逻辑素材源，而不是设备绝对路径
- `config/runtime.json` 是项目级运行时配置入口
- `config/styles/` 保存正式风格档案
- `gps/tracks/*.gpx` 与 `gps/merged.json` 是当前项目级外部轨迹资源入口
- 主链消费的是项目当前采用的素材版本，而不是强制要求原始素材始终在线

### 元信息保真原则

只要主链消费的是转换、调色、导出或其他链路生成的派生素材版本，就必须保证这些版本保留正式流程依赖的关键元信息。

至少包括：

- 媒体创建时间（容器 / EXIF / 媒体侧 creation metadata）
- 文件 `create_time`
- GPS / 空间相关元信息
- 后续与 `Pharos`、chronology、空间推断对齐所需的其他核心字段

也就是说，派生素材版本可以替代原始素材进入主链，但不能因为转换而破坏时间语义、空间语义和后续匹配能力。

## 5. 脚本编排与审查闸门

当前正式的脚本工作流应理解为：

1. `project brief` 提供全片约束
2. `material digest` 提供全量素材印象
3. 系统生成 `segment plan drafts`
4. 用户冻结 `approved segment plan`
5. 进入段落级召回、beat 试写与选择
6. 由 `selection` 与 `beat` 共同落成时间线和字幕

因此，当前稳定结论包括：

- `Pharos` 是正式脚本流程的主输入；没有 `Pharos` 时才回落到兼容路径
- `approved segment plan` 是正式闸门，不是可有可无的附加步骤
- `script-brief` 已经分层，而不是只有一份统管全文的脚本说明
- `beat` 和 `selection` 比旧的“段落 narration + slice 粗引用”模型更接近当前真实编排方式

## 6. 时空语义的当前正式口径

### 时间

- 素材拍摄时间以 `create_time(UTC)` 为主来源
- 不再依赖 `path-timezones`
- `manual-itinerary` 不再承担拍摄时间修正职责

### 空间

当前正式空间优先级是：

1. `embedded GPS`
2. `project GPX`
3. `manual-itinerary`
4. `none`

补充约定：

- DJI / QuickTime / EXIF 的 embedded GPS 属于素材同源真值
- 项目级 GPX 是第二优先级资源，统一收口到 `gps/tracks/*.gpx` 与 `gps/merged.json`
- `manual-itinerary` 只负责无内嵌 GPS 且无可用 GPX 命中时的低置信度 fallback
- 最终采用的空间结果挂在 `IAssetCoarseReport.inferredGps`，而不是回写到素材真值层

## 7. 正式流程与当前实现的边界

### 正式流程中已经有稳定定义的部分

- `KTEP + Zod + validator` 协议边界
- 项目化 store 与 `projects/` 布局
- `Pharos-first` 的正式主流程定义
- logical roots + device-local maps
- coarse-first analyze 与 ASR 进入正式分析链路
- `segment + beat + selection` 的编排方向
- 双路径字幕
- `create_time(UTC)` 与 `embedded GPS > project GPX > manual-itinerary`
- `DaVinci color` 作为独立增强链路，而非主链固定步骤
- 派生素材版本必须保留关键元信息

### 当前实现已经覆盖的部分

- 项目化 ingest / analyze / script / timeline 准备链路
- 无 `Pharos` 场景下的兼容使用方式
- 以项目素材和分析结果驱动的临时版本工作流
- 项目级 GPX / embedded GPS / manual-itinerary 的时空语义收口

### 仍然属于后续补齐或持续演进的部分

- 更完整的 `Pharos-first` 全链路落地
- 更完整的桌面 UI / Tauri 壳
- 更丰富的 provider / adapter 扩展
- 更完整的 revision / backup / migration 体系
- 更强的地图可视化、项目级 geocode cache、轨迹审阅能力

这些后续工作应建立在正式流程定义之上，而不是把当前临时实现直接等同为正式方案本体。

## 8. 历史文档怎么使用

如果你需要查看设计脉络，而不是只看当前浓缩结论，可继续阅读这些文档：

- [2026-03-28--middle-version-protocol-first.md](./2026-03-28--middle-version-protocol-first.md)
  - 适合查看 `KTEP`、`slice / selection / beat`、双路径字幕、项目结构调整等设计推导
- [2026-03-29--m1-protocol-and-store.md](./2026-03-29--m1-protocol-and-store.md)
  - 适合查看协议与核心存储的落地口径
- [2026-04-01--remove-path-timezones-use-utc-create-time.md](./2026-04-01--remove-path-timezones-use-utc-create-time.md)
  - 适合查看时间链路与空间优先级收口的决策背景
- [phase1-plan.md](./phase1-plan.md)
  - 适合作为早期里程碑计划的历史参考，而不是当前方案的直接入口

## 9. 阅读顺序建议

如果你想快速理解当前 Kairos：

1. 先读本文
2. 再读 [requirements.md](./requirements.md)
3. 再读 [architecture.md](./architecture.md)
4. 若需要项目目录与数据落点，再读 [project-structure.md](./project-structure.md)
5. 若需要历史推导，再回到各迭代设计文档
