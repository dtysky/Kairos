# Kairos — 中间版本设计（Protocol First）

> 日期：2026-03-28
> 定位：介于“全链路 AI 后期平台”和“只做脚本助手”之间的中间版本
> 核心目标：先把可复用的中台能力做对，再通过适配层落地到剪映 MCP，并为后续达芬奇/其他 NLE 复用

## 1. 背景

当前总设计覆盖了素材导入、GPS、调色、脚本生成、达芬奇时间线、MCP 集成等完整链路，但对首个真实项目来说跨度过大。

与此同时，若只退化成“文案助手”，又会失去后续最有复用价值的能力沉淀：

- 视频 / 图片内容切片与识别
- 脚本生成与结构化编辑
- 时间线交换协议
- 时间线生成
- 字幕生成与添加
- 面向不同 NLE 的自动化落地

因此需要一个中间版本：

- 不强依赖 GPS、Pharos、调色和达芬奇
- 但保留未来可复用的核心中台
- 以剪映 MCP 作为第一个落地适配器
- 后续可平移到达芬奇 MCP 或导出协议

## 2. 设计目标

### 2.1 必须满足

1. **协议先行**：正式时间线交换格式必须严谨、版本化、可校验，而不是依赖临时文本标记语法。
2. **编辑器解耦**：剪映、达芬奇、未来其他 NLE 都只能依赖统一中间协议，不允许直接把业务逻辑写死在某个 MCP 上。
3. **切片优先**：视频/图片内容理解的基础单位不是“整条素材”，而是 `slice`。
4. **脚本与时间线分层**：脚本负责叙事，时间线负责编排；两者有关联，但不是同一个对象。
5. **字幕一等公民**：字幕不应是脚本的副产物，而应是协议中的正式对象。
6. **无 GPS 可工作**：地点、路线、场景信息允许缺失，用“证据系统”补位。

### 2.2 可接受的限制

- 不在中间版本内做调色自动化
- 不在中间版本内实现完整 GUI
- 不要求首版支持双向编辑器同步
- 不要求首版自动生成 100% 可直接交付的最终时间线

## 3. 产品定位

中间版本的 Kairos 不是“剪辑器”，而是一个 **叙事编排引擎**：

- 吃进去：素材、切片、识别结果、风格档案、人工备注、脚本意图
- 产出来：结构化脚本、结构化时间线、结构化字幕、面向 NLE 的执行计划

这个定位决定了它的核心不是某个 MCP，而是：

- `内容理解层`
- `脚本层`
- `时间线协议层`
- `NLE 适配层`

## 4. 中间版本范围

### 4.1 本版本纳入

- 媒体资产导入
- 视频镜头切片 / 图片资产切片
- 切片级内容识别
- 风格档案
- 脚本生成与编辑
- 统一时间线交换协议
- 时间线生成
- 字幕生成
- NLE 适配器抽象
- 剪映 MCP 适配器

### 4.2 延后

- GPS 自动匹配
- Pharos 数据集成
- 调色辅助
- 达芬奇专属高级能力
- 双向回读 NLE 时间线
- Tauri UI

## 5. 核心设计决策

### D1. 正式协议采用版本化 JSON，而不是临时文本语法

你当前使用的 `（）【】{}《》` 这类文本标记可以保留为 **临时导入器** 或 **人工草稿格式**，但**绝不能成为正式协议**。

正式协议需要满足：

- 明确的对象类型
- 稳定 ID
- 毫秒级时间基准
- 可附加证据与置信度
- 可由 Zod / JSON Schema 校验
- 可被不同编辑器适配器复用

### D2. “切片”是全系统共享中间层

`slice` 是连接内容理解、脚本生成、时间线生成的关键对象。

- 对视频：一个 `slice` 可以是镜头段、延时片段、口播段、航拍段、驾驶段、空镜段
- 对图片：一个 `slice` 可以是单张照片或照片集合中的单元

后续脚本引用 `slice`，时间线编排也引用 `slice`，而不是直接引用原始素材文件。

### D3. 时间线协议必须编辑器无关

协议中只描述：

- 有哪些轨道
- 放了哪些片段
- 每个片段用哪个 `slice`
- 在源素材中取哪一段
- 在时间线上摆到哪里
- 有哪些字幕、转场、基础运动参数

协议中不直接包含“剪映怎么点”“达芬奇哪个 API 名称”这类实现细节。

### D4. NLE 自动化全部收口到适配器层

中间版本只定义统一接口：

- 剪映 MCP 是 `JianyingAdapter`
- 达芬奇 MCP 是 `ResolveAdapter`
- 将来导出 FCPXML/OTIO 也只是另一种适配器或导出器

业务模块不能直接调用任何一个具体 NLE 的 MCP 方法。

### D5. 空间上下文支持双主模式：GPS 增强模式 + 无 GPS 证据模式

中间版本不把 GPS 设为唯一前提，而是明确支持两种主模式：

- **GPS 增强模式**：有 GPS / Pharos / 无人机轨迹时，优先利用时间和空间信息增强地点识别、路线叙事和素材召回
- **无 GPS 证据模式**：没有 GPS 时，仍可依赖多模态证据构建地点线索和叙事骨架

也就是说：

- 有 GPS 更好，空间排序和地点置信度更强
- 没有 GPS 也不是降级到“不可用”，而是另一种正式支持的工作模式

无 GPS 模式下，地点和叙事线索可以来自：

- 文件夹名
- 文件名
- OCR 识别出的地名
- ASR 提取的口播内容
- 图像识别出的地标
- 用户手动标签
- 未来的 GPS / Pharos 数据

两种模式最终都统一进入 `evidence[]`，区别只在于证据强弱和可用能力不同，而不是协议分叉。

建议定义：

```typescript
type SpatialContextMode = 'gps-enhanced' | 'evidence-only';
```

模式差异：

- `gps-enhanced`：更适合路线叙事、地点确认、跨设备素材对齐
- `evidence-only`：更适合旧项目复盘、无轨迹历史素材、剪映中途接管项目

协议中不把 GPS 写死成唯一真相源，但当 GPS 存在时，应把它视为高置信度证据。

### D6. 本地多模态是主分析链路，云端 LLM 只做高价值生成

中间版本的内容理解默认走 **本地多模态**：

- `FFmpeg / shot detection` 做切片和关键帧抽取
- `Whisper` 做 ASR
- `OCR` 做文本证据提取
- `CLIP/BLIP` 做快速索引、聚类和粗标签
- 本地 `VLM` 做高质量画面理解

云端 LLM 的职责收缩为：

- 脚本生成
- 段落归纳
- 风格重写
- 镜头选择建议

这意味着系统不再把“把整段视频送进云端多模态模型”当成默认路径。

### D7. 采样策略采用“时长 + 信息密度”双规则

媒体分析不能只按固定 FPS 抽样，也不能只按时长一刀切。

建议使用双规则：

- **时长规则**：长视频默认稀采样，短视频默认密采样
- **信息密度规则**：镜头切换率、光流变化、OCR 命中、VAD/口播、亮度变化、图像语义突变，会触发局部提密

目标不是分析“整条视频的每一帧”，而是尽快找到：

- 值得进入脚本的片段
- 可能是转场 / 航拍 / 延时 / 口播 / 驾驶段的片段
- 值得进入高成本 VLM 细分析的 `interestingWindows[]`

### D8. 拍摄时间采用 metadata-first 归一化策略

素材的拍摄时间不能依赖文件名规则，因为相机、无人机、手机、剪映导出素材的命名都可能与真实拍摄时间无关。

中间版本必须采用：

- **优先读取元信息**
- **统一归一化时间格式**
- **记录时间来源与置信度**

建议的时间提取优先级：

1. 照片 EXIF：`DateTimeOriginal` / 相关原始拍摄时间字段
2. 视频容器元信息：QuickTime / MP4 / MOV 中的创建时间字段
3. `ffprobe` 可读标签中的 creation time / recording time
4. 文件名中的可解析时间
5. 文件系统时间
6. 用户手动修正

系统需要同时保存：

- `capturedAt`
- `captureTimeSource`
- `captureTimeConfidence`

并允许后续批量修正时区或偏移。

但中间版本不应只保存“时间”，还应把每个素材的**时间与描述信息整合**成统一的时序索引，用于：

- 按拍摄时间排序浏览素材
- 为脚本生成提供“按时间推进”的叙事底稿
- 让用户对时间和描述一起修正

建议引入 `MediaChronology` 作为中间层：

- 每个素材一条或多条时序条目
- 条目同时包含时间、摘要、标签、地点线索、证据来源
- 默认按 `capturedAt` 排序
- 若时间存在修正，则按修正后的排序键重排

### D9. 素材输入目录必须是显式配置，并支持目录级注解

中间版本不能假设只有一个素材目录，也不能假设目录名天然可被稳定理解。

因此需要一个显式的输入目录配置：

- 指定哪些目录会被扫描
- 指定目录类型和优先级
- 为每个目录附加人工注解

目录级注解的作用不是替代识别，而是作为 LLM / 规则系统的先验上下文，例如：

- `“北岛 D1-D3，奥克兰城市段与鸟岛”`
- `“无人机素材，主要是海岸和地热公园”`
- `“相机 B 机位，车内口播和第一视角驾驶段为主”`

这些注解应进入证据系统，但来源应标记为 `manual-root-note`，不能与画面识别结果混淆。

## 6. 系统架构

```text
素材文件 / 图片 / 音频 / 人工备注 / 风格档案
                 │
                 ▼
        Media Understanding
  (切片、识别、转写、标签、证据汇总)
                 │
                 ▼
         Canonical Project Store
   (assets / slices / script / timeline / subtitles)
                 │
        ┌────────┴────────┐
        ▼                 ▼
  Script Engine      Timeline Engine
 (叙事结构生成)       (轨道与片段编排)
        │                 │
        └────────┬────────┘
                 ▼
      Kairos Timeline Exchange Protocol
                 │
      ┌──────────┼──────────┐
      ▼          ▼          ▼
 Jianying    Resolve     Exporters
 Adapter     Adapter     (SRT/FCPXML/OTIO...)
```

## 7. 模块划分

### 7.1 `src/modules/media/`

负责媒体切片与识别。

建议子模块：

- `asset-ingest.ts`
- `shot-slicer.ts`
- `image-slicer.ts`
- `speech-transcriber.ts`
- `ocr-runner.ts`
- `capture-time-resolver.ts`
- `chronology-builder.ts`
- `frame-sampler.ts`
- `density-analyzer.ts`
- `sampling-planner.ts`
- `content-recognizer.ts`
- `vlm-runner.ts`
- `evidence-merger.ts`

职责：

- 识别媒体文件
- 读取输入目录配置与目录级注解
- 视频按镜头/规则切片
- 图片生成单图切片
- 提取并归一化拍摄时间
- 提取关键帧
- ASR 转写
- OCR 文本提取
- 估算信息密度并生成采样计划
- OCR / 图像标签 / 场景说明
- 路由到本地 VLM 做重点分析
- 生成可复用的 `slice`

### 7.1.1 输入目录配置

建议定义：

```typescript
interface MediaRootConfig {
  id: string;
  path: string;
  enabled: boolean;
  category?: 'camera' | 'drone' | 'phone' | 'audio' | 'exports' | 'mixed';
  priority?: number;
  notes?: string[];
  tags?: string[];
  defaultTimezone?: string;
}
```

规则：

- 一个项目可配置多个 `media root`
- `notes` 作为目录级语义注解进入分析上下文
- `tags` 用于规则筛选和脚本召回
- `defaultTimezone` 用于元信息缺失时的时间归一化

### 7.1.2 拍摄时间归一化

建议定义：

```typescript
interface CaptureTimeInfo {
  capturedAt?: string; // UTC ISO 8601
  originalValue?: string;
  originalTimezone?: string;
  source:
    | 'exif'
    | 'quicktime'
    | 'container'
    | 'ffprobe-tag'
    | 'filename'
    | 'filesystem'
    | 'manual';
  confidence: number; // 0-1
}
```

要求：

- 内部统一使用 UTC ISO 时间
- 保留原始字段和原始时区信息
- 文件名时间只能作为 fallback
- 允许后续做项目级时间偏移修正

### 7.1.3 素材时序视图

建议定义：

```typescript
interface MediaChronologyEntry {
  id: string;
  assetId: string;
  ingestRootId?: string;
  capturedAt?: string; // UTC ISO 8601
  sortCapturedAt?: string; // 修正后用于排序的时间
  captureTimeSource?: CaptureTimeInfo['source'];
  captureTimeConfidence?: number;
  summary?: string;
  labels: string[];
  placeHints: string[];
  evidence: KtepEvidence[];
  correction?: {
    capturedAtOverride?: string;
    summaryOverride?: string;
    labelsAdd?: string[];
    labelsRemove?: string[];
    reason?: string;
    updatedAt: string;
  };
}
```

规则：

- `capturedAt` 保存系统解析出的原始归一化时间
- `sortCapturedAt` 保存修正后的排序时间；若无修正，则等于 `capturedAt`
- `summary` 默认来自媒体分析层
- `summaryOverride` 允许用户对素材描述进行纠正
- 时间修正和描述修正都应保留原值，不直接覆盖底层分析结果
- `MediaChronologyEntry[]` 是脚本生成按时间组织素材的首要输入之一

### 7.2 `src/modules/script/`

负责风格、叙事、脚本。

建议子模块：

- `style-analyzer.ts`
- `outline-builder.ts`
- `script-generator.ts`
- `script-editor.ts`
- `script-store.ts`

职责：

- 分析历史成片，生成风格档案
- 基于 `slice` 和证据生成叙事骨架
- 生成结构化脚本段落
- 支持段落级编辑和重排

### 7.3 `src/modules/timeline-core/`

负责与 NLE 无关的时间线能力。

建议子模块：

- `protocol.ts`
- `timeline-builder.ts`
- `placement-engine.ts`
- `transition-planner.ts`
- `subtitle-planner.ts`
- `timeline-validator.ts`

职责：

- 定义正式协议
- 从脚本和切片生成时间线
- 计算轨道分配和时间摆放
- 生成字幕 cue
- 校验时间线合法性

### 7.4 `src/modules/nle/`

负责具体编辑器适配。

建议子模块：

- `adapter.ts`
- `jianying-mcp-adapter.ts`
- `resolve-mcp-adapter.ts`
- `export-srt.ts`
- `export-fcpxml.ts`（后续）

职责：

- 将正式协议翻译为具体编辑器操作
- 维护外部素材 ID / 轨道 ID / 项目 ID 映射
- 对不同编辑器能力差异做降级

## 8. 本地多模态与自适应采样

### 8.1 分层执行策略

媒体分析建议分三层执行：

#### Layer A — 低成本粗扫

- 镜头切分
- 关键帧抽取
- ASR
- OCR
- CLIP/BLIP 粗标签

特点：

- 默认本地执行
- 不依赖云端 token
- 目的是生成 `MediaAnalysisPlan`

#### Layer B — 本地 VLM 精扫

只对高价值窗口执行：

- `interestingWindows[]`
- 口播与画面冲突片段
- 航拍 / 延时 / 复杂事件片段
- 可能进入 `intro / climax / transition` 的候选片段

特点：

- 由本地 `VLM` 执行
- 以 `slice` 或小窗口为单位
- 输出高质量结构化描述，而不是自由文本堆砌

#### Layer C — 生成层

这一层才进入脚本和叙事：

- 脚本生成
- 旁白润色
- 段落重写
- 镜头选择建议

原则：

- 优先喂结构化 `evidence`
- 不把原始长视频直接送进大模型

### 8.2 本地 VLM 角色

对于使用 `RTX 4090` 的本地环境，中间版本应把本地 VLM 视为**主分析器**而不是“实验性增强”。

推荐角色分工：

- `CLIP/BLIP`：快速索引、去重、粗聚类、初筛
- `本地 VLM`：场景理解、镜头作用判断、地标/事件/氛围识别
- `Whisper + OCR`：文本证据补全

这样做的好处是：

- 不烧云端 API token
- 结构化证据可持久化复用
- 后续脚本生成不必重复看画面

### 8.3 自适应采样规则

先计算：

- `clipType`
- `densityScore`
- `interestingWindows[]`

建议定义：

```typescript
interface MediaAnalysisPlan {
  assetId: string;
  clipType: 'drive' | 'talking-head' | 'aerial' | 'timelapse' | 'broll' | 'unknown';
  densityScore: number; // 0-1
  samplingProfile: 'dense' | 'balanced' | 'sparse';
  baseSampleIntervalMs: number;
  interestingWindows: Array<{
    startMs: number;
    endMs: number;
    reason: string;
  }>;
  vlmMode: 'none' | 'multi-image' | 'video';
  targetBudget: 'coarse' | 'standard' | 'deep';
}
```

信息密度信号可来自：

- 视频时长
- 镜头切换率
- 光流变化
- OCR 命中频率
- VAD / 口播检测
- 亮度和色彩变化
- 图像语义突变

### 8.4 首版采样预算

#### 按时长

- `0-15s`：高密度采样，近似全看
- `15-60s`：每 `1-2s` 抽样
- `1-5min`：每 `3-5s` 抽样
- `5-20min`：每 `8-12s` 抽样
- `20min+`：每 `15-30s` 抽样

#### 按类型

- `talking-head`：画面稀采样，ASR 全量
- `drive`：默认稀采样，但对突变窗口局部提密
- `aerial`：中等密度，优先抓地貌和视角变化
- `timelapse`：提高采样密度，防止错过节奏变化
- `broll`：优先镜头边界抽样

#### 驾驶视频的提密触发器

- 识别到路牌、地名、限速牌
- 天光突变，例如日落、进出隧道、暴雨、耶稣光
- 出现桥梁、海岸线、城市天际线、山谷等结构性地貌
- 停车、下车、明显减速或场景切换
- 口播开始或结束

### 8.5 目标性能预算（RTX 4090）

中间版本建议以 `RTX 4090` 为主参考机型，先设定工程预算，而不是追求不切实际的“全量逐帧理解”。

建议目标：

- `coarse`：`<= 10s / 分钟素材`
- `standard`：`<= 30s / 分钟素材`
- `deep`：`<= 90s / 分钟素材`

性能预期：

- `ASR` 通常不是瓶颈
- `scene cut / keyframe` 也不是瓶颈
- 真正的瓶颈是本地 `VLM` 对采样帧的理解

因此首版优化重点应是：

- 少看无价值帧
- 多看 `interestingWindows[]`
- 尽量让 VLM 看多图小窗口，而不是整段长视频

### 8.6 输出要求

媒体分析层输出的不应只是自由文本，而应是结构化结果，例如：

- 片段类型
- 画面主体
- 叙事作用
- 情绪 / 氛围
- 地点线索
- 是否适合 `intro / transition / climax / broll`
- 证据来源和置信度

这样后续脚本和时间线模块可以复用结果，而不是重复推理。

## 9. 正式协议：Kairos Timeline Exchange Protocol

协议名称建议：

- `Kairos Timeline Exchange Protocol`
- 缩写：`KTEP`

这是中间版本最关键的设计产物。

### 9.1 顶层结构

```typescript
interface KtepDocument {
  protocol: 'kairos.timeline';
  version: '1.0';
  project: KtepProject;
  assets: KtepAsset[];
  slices: KtepSlice[];
  script?: KtepScriptSegment[];
  timeline: KtepTimeline;
  subtitles?: KtepSubtitleCue[];
  adapterHints?: Record<string, unknown>;
}
```

### 9.2 资产对象

```typescript
interface KtepAsset {
  id: string;
  kind: 'video' | 'photo' | 'audio';
  sourcePath: string;
  displayName: string;
  ingestRootId?: string;
  durationMs?: number;
  fps?: number;
  width?: number;
  height?: number;
  capturedAt?: string;
  captureTimeSource?:
    | 'exif'
    | 'quicktime'
    | 'container'
    | 'ffprobe-tag'
    | 'filename'
    | 'filesystem'
    | 'manual';
  captureTimeConfidence?: number;
  createdAt?: string;
  metadata?: Record<string, unknown>;
}
```

规则：

- `sourcePath` 必须指向原始资产
- `id` 稳定，不因脚本修改而变化
- `durationMs` 对图片可为空
- `capturedAt` 优先来自元信息，不依赖文件名
- `ingestRootId` 用于追踪该素材来自哪个输入目录配置

建议在素材分析层另存一份面向叙事和浏览的时序索引，而不是只依赖 `KtepAsset` 的扁平字段。

### 9.3 切片对象

```typescript
interface KtepSlice {
  id: string;
  assetId: string;
  type:
    | 'shot'
    | 'timelapse'
    | 'photo'
    | 'aerial'
    | 'talking-head'
    | 'drive'
    | 'broll'
    | 'unknown';
  sourceInMs?: number;
  sourceOutMs?: number;
  summary?: string;
  labels: string[];
  confidence?: number;
  evidence: KtepEvidence[];
}

interface KtepEvidence {
  source:
    | 'vision'
    | 'asr'
    | 'ocr'
    | 'filename'
    | 'folder'
    | 'manual-root-note'
    | 'manual'
    | 'gps'
    | 'pharos';
  value: string;
  confidence?: number;
}
```

说明：

- `evidence` 用来支撑地点、主题、事件、对象识别
- 没有 GPS 时，不影响协议成立
- 将来接入 GPS / Pharos，只是多加证据来源

### 9.4 脚本对象

```typescript
interface KtepScriptSegment {
  id: string;
  role: 'intro' | 'scene' | 'transition' | 'highlight' | 'outro';
  title?: string;
  narration: string;
  targetDurationMs?: number;
  linkedSliceIds: string[];
  notes?: string;
}
```

说明：

- 脚本只描述“讲什么”
- `linkedSliceIds` 只提供素材候选，不直接决定轨道摆放

### 9.5 时间线对象

```typescript
interface KtepTimeline {
  id: string;
  name: string;
  fps: number;
  resolution: { width: number; height: number };
  tracks: KtepTrack[];
  clips: KtepClipPlacement[];
}

interface KtepTrack {
  id: string;
  kind: 'video' | 'audio' | 'subtitle';
  role: 'primary' | 'broll' | 'voiceover' | 'nat' | 'music' | 'caption';
  index: number;
}

interface KtepClipPlacement {
  id: string;
  trackId: string;
  assetId: string;
  sliceId?: string;
  sourceInMs?: number;
  sourceOutMs?: number;
  timelineInMs: number;
  timelineOutMs: number;
  transitionIn?: KtepTransition;
  transitionOut?: KtepTransition;
  transform?: KtepTransform;
  linkedScriptSegmentId?: string;
}

interface KtepTransition {
  type: 'cut' | 'cross-dissolve' | 'fade' | 'wipe';
  durationMs?: number;
}

interface KtepTransform {
  scale?: number;
  positionX?: number;
  positionY?: number;
  rotation?: number;
  kenBurns?: {
    startScale: number;
    endScale: number;
    startX: number;
    startY: number;
    endX: number;
    endY: number;
  };
}
```

### 9.6 字幕对象

```typescript
interface KtepSubtitleCue {
  id: string;
  startMs: number;
  endMs: number;
  text: string;
  language?: string;
  speaker?: string;
  linkedScriptSegmentId?: string;
}
```

说明：

- 字幕与脚本相关，但不要求 1:1
- 可以来自旁白脚本，也可以来自口播转写修订
- 可以直接导出 SRT，也可以通过适配器写入 NLE

### 9.7 协议不变量

`KTEP` 至少应保证以下约束：

1. 所有时间统一使用毫秒。
2. `timelineOutMs > timelineInMs`。
3. 视频/音频切片若存在 `sourceInMs/sourceOutMs`，则必须满足 `sourceOutMs > sourceInMs`。
4. `clip.trackId` 必须引用存在的轨道。
5. `clip.assetId` 必须引用存在的资产。
6. `clip.sliceId` 若存在，必须引用存在的切片。
7. 字幕时间范围不得为负。
8. 编辑器私有字段不得进入协议核心字段，只能放在 `adapterHints` 或适配器侧状态中。

## 10. 时间线生成流程

### 10.1 输入

- `assets`
- `slices`
- `script`
- 可选的人工偏好
  - 哪些片段必须出现
  - 哪些口播保留原声
  - 哪些段落优先航拍
  - 哪些图片需要 Ken Burns

### 10.2 生成步骤

1. 根据 `script segment` 确定段落顺序和目标时长。
2. 在每个段落中从 `linkedSliceIds` 或标签候选中选片。
3. 生成主轨 `primary` 和辅轨 `broll` 的初始摆放。
4. 为照片和延时生成默认 transform。
5. 根据脚本生成字幕 cue。
6. 生成 `KTEP.timeline`。
7. 用 `timeline-validator` 做一致性校验。

### 10.3 首版生成策略

首版不追求“完美剪辑决策”，而采用可解释规则：

- 优先使用被脚本直接引用的切片
- 单个切片默认最大使用时长可配置
- 航拍 / 延时优先放在段落开头或转场
- 图片默认走 `Ken Burns`
- 字幕先用规则切分，后续再引入语义断句优化

## 11. 字幕添加策略

字幕能力拆成两层：

### 11.1 协议层

统一生成 `KtepSubtitleCue[]`。

### 11.2 落地层

适配器按目标环境选择：

- 导出 `SRT`
- 导出 `WebVTT`
- 通过剪映 MCP 创建字幕轨
- 通过达芬奇 MCP 创建字幕轨

这样字幕算法本身不依赖任何具体 NLE。

## 12. NLE 适配层设计

### 12.1 统一接口

```typescript
interface NleAdapter {
  name: string;
  capabilities: NleCapabilities;

  validate(doc: KtepDocument): Promise<void>;
  ensureProject(projectName: string): Promise<void>;
  importAssets(assets: KtepAsset[]): Promise<void>;
  createTimeline(timeline: KtepTimeline): Promise<void>;
  placeClips(clips: KtepClipPlacement[]): Promise<void>;
  addSubtitles(cues: KtepSubtitleCue[]): Promise<void>;
}

interface NleCapabilities {
  subtitleTrack: boolean;
  transform: boolean;
  kenBurns: boolean;
  transition: boolean;
  nestedTimeline: boolean;
}
```

### 12.2 剪映适配器

`JianyingAdapter` 是中间版本的首个正式适配器。

职责：

- 对接剪映 MCP
- 处理剪映项目创建、素材导入、时间线创建、片段摆放、字幕插入
- 管理剪映内部对象 ID 与 `KTEP` ID 的映射

### 12.3 达芬奇适配器

`ResolveAdapter` 不再是系统中心，而是未来的第二个适配器。

这样达芬奇从“主目标架构”变为“可插拔落地端”，不会再绑死整体设计。

## 13. 人工草稿与正式协议的关系

正式协议是 `KTEP`。

人工草稿、临时文本、已有的时间线笔记，都只能作为：

- 导入器输入
- 提示词上下文
- 人工编辑界面内容

而不能直接充当正式时间线对象。

这意味着：

- 你现在已有的文本粗剪笔记仍然有用
- 但系统内部保存和交换时，必须转成 `KTEP`
- 将来无论接剪映、达芬奇还是导出文件，都只吃 `KTEP`

## 14. 项目数据结构调整

建议在现有 `project-structure` 基础上新增：

```text
<project_root>/
├── config/
│   └── ingest-roots.json
├── store/
│   ├── manifest.json
│   ├── revisions.jsonl
│   ├── snapshots/
│   │   ├── script/
│   │   ├── timeline/
│   │   ├── chronology/
│   │   └── subtitles/
│   └── backups/
│       ├── manifest.json
│       └── full/
├── analysis/
│   ├── plans.json
│   └── windows.json
├── media/
│   ├── index.json
│   ├── slices.json
│   └── chronology.json
├── script/
│   ├── current.json
│   └── versions/
├── timeline/
│   ├── current.ktep.json
│   └── versions/
├── subtitles/
│   ├── current.srt
│   ├── current.vtt
│   └── current.json
└── adapters/
    ├── jianying/
    │   └── state.json
    └── resolve/
        └── state.json
```

说明：

- `config/ingest-roots.json` 保存素材输入目录、目录注解、默认时区等配置
- `store/manifest.json` 保存项目级 schema 版本、当前 revision、最近备份信息
- `store/revisions.jsonl` 记录每次持久化变更的 revision 日志
- `store/snapshots/` 保存可回退的文档级快照
- `store/backups/` 保存跨文档的项目级备份包
- `analysis/plans.json` 保存每条素材的分析计划、密度分数和采样策略
- `analysis/windows.json` 保存 `interestingWindows[]` 和命中原因
- `slices.json` 是未来最有复用价值的中间资产
- `media/chronology.json` 保存按拍摄时间排序的素材时序视图，并记录时间/描述修正
- `current.ktep.json` 是编辑器无关的正式时间线
- `adapters/*/state.json` 只保存适配器私有映射状态

建议的 `ingest-roots.json` 结构：

```json
{
  "roots": [
    {
      "id": "nz-a7r5-main",
      "path": "H:/NZ/A7R5",
      "enabled": true,
      "category": "camera",
      "priority": 10,
      "defaultTimezone": "Pacific/Auckland",
      "notes": [
        "北岛前半段主机位",
        "城市、步行、风光和部分机内口播"
      ],
      "tags": ["north-island", "main-camera"]
    },
    {
      "id": "nz-drone",
      "path": "H:/NZ/Mavic",
      "enabled": true,
      "category": "drone",
      "priority": 20,
      "defaultTimezone": "Pacific/Auckland",
      "notes": [
        "无人机素材，优先关注海岸线、瀑布、地热、公路全景"
      ],
      "tags": ["north-island", "drone"]
    }
  ]
}
```

### 14.1 Canonical Project Store 存储原则

`Canonical Project Store` 不应理解成单个文件，而是一组**规范化、可校验、可回退**的项目文档集合。

建议分为三层：

- `current`：当前生效的项目状态，例如 `media/index.json`、`script/current.json`
- `versions`：面向日常工作回退的版本快照
- `backups`：面向损坏恢复、迁移失败、误操作的项目级备份

这三层职责不同：

- `current` 解决“系统现在用什么”
- `versions` 解决“我想回到上一个可编辑状态”
- `backups` 解决“项目坏了还能不能救回来”

### 14.2 当前状态层（Current State）

当前状态层保存**唯一生效版本**，供系统读取和编辑。

建议纳入的 canonical 文档：

- `config/ingest-roots.json`
- `media/index.json`
- `media/slices.json`
- `media/chronology.json`
- `analysis/plans.json`
- `analysis/windows.json`
- `script/current.json`
- `timeline/current.ktep.json`
- `subtitles/current.json`
- `adapters/*/state.json`

原则：

- 每份文档职责单一
- 通过稳定 ID 互相引用
- 写入必须走原子替换，不允许半写入状态

### 14.3 版本层（Versions / Revisions）

版本层用于支持“回退到前一个脚本版本”“恢复昨天的时间线”“比较两次 chronology 修正差异”。

建议设计两部分：

- `store/revisions.jsonl`：轻量 revision 日志
- `store/snapshots/`：必要时存放文档级快照

建议的 revision 记录：

```typescript
interface StoreRevision {
  revisionId: string;
  createdAt: string;
  reason:
    | 'ingest'
    | 'analysis'
    | 'chronology-correction'
    | 'script-edit'
    | 'timeline-build'
    | 'subtitle-update'
    | 'adapter-sync'
    | 'migration'
    | 'manual';
  changedDocs: string[];
  note?: string;
}
```

建议的快照策略：

- `script/current.json` 每次保存都生成快照
- `timeline/current.ktep.json` 每次生成或手动确认都生成快照
- `media/chronology.json` 每次人工修正后生成快照
- `subtitles/current.json` 在字幕确认或批量调整后生成快照
- `analysis/*` 默认不高频快照，必要时由 revision 日志追踪

这样可以避免把所有分析中间产物都无限制版本化，导致体积膨胀。

### 14.4 备份层（Backups）

备份不是版本快照的别名，而是**项目级恢复机制**。

建议分两类：

- `自动备份`
  - schema migration 前
  - 批量写入 chronology 修正前
  - 大规模重跑 ingest / analysis 前
  - 首次执行 NLE 同步前
- `手动备份`
  - 用户准备做大改动前
  - 用户准备切换机器前
  - 用户准备清理缓存前

建议的备份形态：

- `full project backup`
  - 备份 canonical 文档和必要配置
  - 不默认打包原始媒体文件
- `metadata backup`
  - 只备份 JSON store、脚本、时间线、字幕、适配器状态

建议的备份元信息：

```typescript
interface ProjectBackup {
  backupId: string;
  createdAt: string;
  type: 'auto' | 'manual';
  scope: 'metadata-only' | 'full-store';
  reason?: string;
  includedPaths: string[];
}
```

建议默认不备份：

- 原始视频/照片文件
- 可重建的缓存代理
- 可重算的关键帧和 embedding

因为这些体积大，且不属于 `Canonical Project Store` 本身。

### 14.5 写入流程与恢复原则

建议所有写入走统一事务化流程：

1. 读取当前 manifest 和目标文档
2. 生成新文档内容
3. 写入临时文件
4. 原子替换目标文件
5. 追加一条 `revision`
6. 若命中备份策略，生成一份 backup
7. 更新 `store/manifest.json`

`store/manifest.json` 建议至少包含：

```typescript
interface StoreManifest {
  storeSchemaVersion: string;
  currentRevisionId: string;
  lastBackupId?: string;
  updatedAt: string;
}
```

恢复优先级建议：

1. 先尝试读取 current 文档
2. 若 current 文档损坏，回退到最近 revision 对应快照
3. 若快照也不可用，回退到最近 backup

这套机制保证：

- 日常编辑可回退
- 批量修正可追踪
- migration / 同步失败时有兜底
- 项目状态不会因为一次写坏而整体报废

## 15. 推荐实施顺序

### M1. 协议与核心存储

- 定义 `KTEP` Zod Schema
- 建立 `assets / slices / script / timeline / subtitles` 存储
- 完成协议校验器

### M2. 切片与识别

- 输入目录配置加载
- 拍摄时间提取与归一化
- 视频镜头切片
- 图片切片
- 关键帧抽取
- 信息密度估算
- 自适应采样计划
- 基础标签与摘要
- 本地 VLM 精分析
- 证据系统

### M3. 脚本到时间线

- 风格档案导入
- 脚本生成
- 时间线生成
- 字幕规划

### M4. 剪映适配器

- 剪映 MCP 封装
- `KTEP -> 剪映操作` 执行器
- SRT 导出作为兜底

### M5. 达芬奇适配器

- 复用相同 `KTEP`
- 新增 `ResolveAdapter`
- 验证跨 NLE 可迁移性

## 16. 复用价值评估

这个中间版本沉淀下来的能力，后续都能复用：

| 能力 | 中间版本可用 | 完整版可复用 |
|------|--------------|--------------|
| 视频/图片切片 | 是 | 是 |
| 自适应采样与分析计划 | 是 | 是 |
| 证据系统 | 是 | 是 |
| 风格档案 | 是 | 是 |
| 脚本生成 | 是 | 是 |
| 正式时间线协议 | 是 | 是 |
| 字幕规划 | 是 | 是 |
| 剪映适配器 | 是 | 可并存 |
| 达芬奇适配器 | 后续 | 是 |
| GPS / Pharos | 双模式支持 | 可增强接入 |
| 调色辅助 | 否 | 后续独立接回 |

## 17. 结论

中间版本不应理解为“缩小版 Kairos”，而应理解为：

- **把真正可复用的核心抽出来**
- **把编辑器集成降到适配层**
- **把时间线先变成正式协议**
- **先让剪映跑起来，再让达芬奇复用**

这样做的收益是：

- 当前新西兰纪录片可以直接受益
- 不会把项目锁死在剪映或达芬奇
- 后续 GPS、Pharos、调色、Tauri 都能往这个核心上增量叠加

这会比“先做一个完整平台”更稳，也比“只做一次性脚本助手”更值。
