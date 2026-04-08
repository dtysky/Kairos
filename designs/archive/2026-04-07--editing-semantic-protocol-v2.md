# Kairos v2 剪辑语义协议：真值层、综合层与推理包层

## Status

当前状态：评审稿。

本稿的职责是为即将开始的 Analyze / Style / Script / Timeline 重构先定协议，不承担实现说明，也不承担兼容迁移设计。当前仓库尚未切分支，尚未改代码，尚未把结论同步到 `README.md`、`AGENTS.md`、`designs/current-solution-summary.md` 与 `designs/architecture.md`。本稿通过评审后，再进入第二轮主文档同步与实现拆分。

本稿明确采用 **Clean Break** 立场。这里的 Clean Break 不是“先兼容一阵子，慢慢挪过去”，而是先把新的正式合同写清楚，然后再按这份合同替换当前主链。旧的弱结构语义字段、旧的 prompt 组织方式、旧的“把很多中间产物一起塞给主模型”的用法，都不再被视为这轮设计的约束条件。

当前上游 `Pharos` 协议校验基线为：

- `combinedSha256 = bc6a47dd9a929ef7346578326fa66840a4c105c30a55566f00b81eea576f0c0f`

后续凡是涉及 `Pharos` 证据进入 Kairos 主链的设计，都以该基线对应的 `../Pharos/designs` 为准。

## Background

这轮重构不是因为“模型还不够强”，而是因为现有系统把太多本应在结构层解决的问题，推给了最终负责脚本决策的 LLM。过去几轮试跑已经暴露出几个共同问题。

第一，Analyze 的结果虽然已经比最初阶段丰富很多，但正式下游真正稳定消费的仍然主要是 `labels`、`placeHints`、`summary`、`transcript` 这类弱结构信号。它们能帮助人类快速扫一眼，却不适合作为 LLM 长链决策的主输入，因为这些字段天然缺主次、缺层级、缺证据口径，也缺少“这段素材在剪辑里到底能干什么”的正式表达。

第二，Style Analysis 已经不再只是“写一篇风格长文”，但当前正式形态依然过于依赖 prose。风格档案里虽然能写节奏、素材角色、运镜偏好和 anti-patterns，可这些内容在进入脚本阶段时，仍然容易退化成“让 LLM 再从长文里猜一遍镜头组织逻辑”。这会让风格分析变成内容丰富但消费不稳定的中间层。

第三，主 LLM 的上下文太胖。当前链路里，最容易失控的不是单个模型能力，而是“把全量 slices、风格长文、历史讨论、brief 说明和其它半结构化中间产物一起喂进去”的方式。只要上下文太长、太混、太平级，LLM 就容易出现幻觉、优先级错位、过度联想和局部事实污染。

第四，当前协议只有“真值”和“packet”两个层次，但中间缺了一层真正负责“编排综合”的正式对象。系统知道很多 slice，也有一些 style bias，却没有一份正式的中间表示来回答“这些素材为什么会被综合成一段开场、一段路途推进、一段 drama 桥段、一段时间拔升”。结果就是项目级编排仍然过多依赖一次性 prompt 猜测。

第五，空间语义仍然不够干净。Kairos 这几轮已经有了 `embedded GPS > project GPX > derived-track` 的优先级口径，也已经引入了 `confidence`，但空间上下文在下游的消费口径仍然没有彻底收口。尤其在 `Pharos` 接入后，如果不把计划意图、执行记录、轨迹证据和视觉/文本推断明确区分，下游很容易把“推测到的地点”误当成“可以直接拿来写片中地理重置”的真值。

第六，脚本工作流里的“文案”还没有被正式分成两个阶段。人的真实工作方式并不是“先想完全片结构，再在最后一次性把终稿文案写完”。更真实的方式是：先形成全片和段落级的叙事构思，拿这个构思指导素材聚合与时间线初版；再在时间线有了更接近真实片长、节奏和原声占位之后，落地精确文案，并允许文案和时间线之间做一次小范围双向微调。当前协议没有把这种工作方式写死，所以文案和时间线之间还缺正式的往返合同。

## Problem Statement

Kairos 当前失败的核心，不是模型规模不足，而是 **中间表示和上下文组织错误**。

现有系统最大的问题不是“缺字段”，而是“缺层”。Analyze、Style、Script、Timeline 之间没有形成一套清晰的“真值层、综合层、推理包层”分工，导致系统把本该由结构和阶段边界解决的问题，交给了最终的主 LLM。

如果继续沿着旧思路补字段，结果只会是：

- Analyze 越做越重，但下游仍然不知道先看什么。
- Style 越写越长，但主模型仍然只能从 prose 中再次猜测。
- Script 越来越依赖 prompt 工程来补救上游结构问题。
- Timeline 与文案互相耦合，却没有正式反馈面。
- `Pharos`、GPS、轨迹和地点线索继续以 loose hints 的形式污染最终决策。

因此，这轮重构的第一目标不是让协议“更完整”，而是让协议 **更会做减法**。系统内部可以复杂，但主 LLM 每次只能看到当前层真正需要回答的那个问题，而且这个问题之前必须先经过正式的综合层消化。

## Design Goals

本稿定义的 v2 协议必须同时满足以下目标。

第一，真值层必须准确。Analyze 输出可以丰富，但不能冗余，也不能把“为方便 prompt 凑出来的文本摘要”和“值得长期保留的正式结论”混为一谈。

第二，综合层必须正式存在。系统不能再直接从 `SemanticSlice[]` 跳到全片编排 prompt。必须先有一套可审查、可复用的综合对象，把若干素材团块和段落骨架正式表达出来。

第三，推理必须分层。主 LLM 不再直接面向全量素材池做一次性全局决策，而是按层次推进：先决定全片骨架，再决定段落，再决定 beat，再在初版时间线后生成精确文案。

第四，主 LLM 必须低幻觉。它不允许直接看到全量 truth objects，也不允许直接吞下整份 style markdown、长历史讨论或弱结构 summary 堆料。它只能消费阶段性的、一次性的 reasoning packet。

第五，协议必须可审查。无论是人类审稿还是后续做调试，都必须能指出：某次编排决策到底是依据了哪些 slice、哪些 bundle、哪些 style archetypes、哪些空间证据和哪些硬约束，而不是只能回头翻 prompt。

第六，Style / Analyze / Script / Timeline 必须共享同一套正式核心语义，而不是各阶段各说各话，再靠字符串相似度做翻译。

## Non-Goals

本稿不承担以下目标。

- 不做旧协议兼容设计。
- 不在本稿里展开剪映草稿 readback 的协议。
- 不把 Console 或 UI 交互细节作为设计重点。
- 不讨论具体 prompt 模板实现。
- 不讨论本轮重构的代码拆分和工期安排。

需要额外说明的是：`StyleFunctionProfile` 在本稿中被定义成可编辑的正式风格资产，这意味着它应当允许手写、复制和后续 UI 编辑；但“编辑器长什么样”不在本稿范围内。

## Core Principles

### 1. Analyze 产出真值，不直接喂主模型

Analyze 的职责是生成准确、稳定、可复用的事实和结论，而不是直接替主模型拼装最终 prompt。Analyze 可以产生丰富的语义，但这些语义首先属于 truth layer，不属于主 LLM 的直接输入。

### 2. 综合层先消化，再交给主模型

`SemanticSlice` 不应直接成为全片编排的输入海洋。系统必须先在内部完成聚合、归并、原型命中和骨架综合，得到正式的 `MotifBundle`、`ArrangementSkeleton` 与 `SegmentCard`，再把结果压成 packet。

### 3. 主模型只消费 packet

主 LLM 的正式输入不是全量 truth objects，也不是全量 synthesis objects，而是按阶段压缩过的 reasoning packet。每个 packet 只能服务一个问题，且必须显式限制可见表示与 token 预算。

### 4. 一层只回答一个问题

综合层回答“这些素材团块怎样长成全片骨架”。全片编排层回答“骨架候选里哪一种最适合当前项目”。段落层回答“某一段应该如何聚合 bundle 并承担什么功能”。beat 层回答“当前这个 beat 用哪几段代表素材来实现”。时间线后精修层回答“在真实时长和排布约束下，这一句具体怎么说”。任何一层都不允许越权把下一层的复杂度一并吞下。

### 5. 文案固定为两阶段写作

前期必须允许存在“文案构思”，但这不是终稿。后期必须在初版时间线之后，再生成精确文案。精确文案允许对时间线提出一次小范围回调，但不允许重新回到全片结构级别推翻前面所有决策。

### 6. 复杂性允许存在于系统中，但不允许暴露给主 LLM

内部可以有 richer truth graph、证据链、聚类、排序、subagent 压缩和 deterministic packing；但这些复杂性必须在进入主模型之前被吸收掉。系统复杂不等于 prompt 可以复杂。

## Formal Model

v2 协议分为三层：`Analyze Truth Layer`、`Arrangement Synthesis Layer` 与 `Reasoning Packet Layer`。

Truth Layer 是项目级正式真源，负责保存较完整但不冗余的分析与风格结论。Synthesis Layer 是正式综合层，负责把 slice 组织成素材团块、段落候选和全片骨架。Packet Layer 是阶段性推理包，负责把前两层压缩成当前阶段真正需要的最小输入。主 LLM 只允许消费 packet，不允许直接读取 truth layer 或 synthesis layer。

### Analyze Truth Layer

Truth Layer 只包含三个正式对象：`SemanticAsset`、`SemanticSlice`、`StyleFunctionProfile`。

#### SemanticAsset

`SemanticAsset` 的职责是保存素材事实和聚合索引。它存在，是为了让系统保留素材真值、跨 slice 的引用关系和技术事实，但它 **不承担主编排决策**。下游不应该再从 asset summary 猜这条素材适合放在片子的什么位置。

```ts
type SemanticAsset = {
  id: string;
  kind: 'video' | 'photo';
  sourcePath: string;
  displayName: string;
  durationMs?: number;
  fps?: number;
  width?: number;
  height?: number;
  capturedAt?: string;
  captureTimeSource?: string;
  captureTimeConfidence?: number;
  embeddedGps?: unknown;
  protectionAudio?: unknown;
  sliceIds: string[];
  metadata?: Record<string, unknown>;
};
```

为什么存在：

- 保存素材事实，不让 slice 反向承担技术真值。
- 作为 slice 的归属容器和可追溯入口。
- 为后续 Timeline 导出提供必要的媒体事实。

谁消费它：

- Analyze 自己
- Timeline 适配层
- 调试/审查工具

谁不允许直接消费它：

- Project arrangement 主 LLM
- Segment planning 主 LLM
- Beat planning 主 LLM

#### SemanticSlice

`SemanticSlice` 是 v2 中唯一正式的剪辑语义单元。它不是“素材概览”，而是“已经对下游剪辑有意义的一段可用内容”。后续综合层与下游 Script / Timeline 都以它为正式基础。

```ts
type SemanticSlice = {
  id: string;
  assetId: string;
  timing: {
    focusStartMs: number;
    focusEndMs: number;
    editStartMs: number;
    editEndMs: number;
    speechAlignedStartMs?: number;
    speechAlignedEndMs?: number;
  };
  narrativeFunctions: SemanticTagSet;
  shotGrammar: SemanticTagSet;
  viewpointRoles: SemanticTagSet;
  subjectStates: SemanticTagSet;
  grounding: {
    speechMode: 'none' | 'available' | 'preferred';
    speechValue: 'none' | 'informative' | 'emotional' | 'mixed';
    spatialEvidence: SpatialEvidence[];
    pharosRefs: Array<{ tripId: string; shotId: string }>;
  };
  transcript?: string;
  transcriptSegments?: Array<{ startMs: number; endMs: number; text: string }>;
};

type SemanticTagSet = {
  core: string[];
  extra: string[];
  evidence: Array<{
    tier: 'truth' | 'strong-inference' | 'weak-inference';
    confidence: number;
    sourceKinds: string[];
    reasons: string[];
  }>;
};
```

为什么存在：

- 它直接表达“这段素材在剪辑里能干什么”。
- 它把“叙事功能”和“镜头语法”正式化，避免下游继续靠 summary 猜。
- 它既足够小，能成为 beat 级代表候选；又足够完整，能支撑综合层做 bundle 和 skeleton 判断。

谁消费它：

- Motif bundle builder
- Beat packet builder
- Timeline refinement packet builder

谁不允许直接消费它：

- 直接把全量 `SemanticSlice[]` 塞给主 LLM 的任何链路

#### StyleFunctionProfile

`StyleFunctionProfile` 是正式风格输入。它不是“长文风格报告”，而是“可直接被综合层和脚本阶段消费的结构化风格骨架”。长文 prose 可以继续存在，但只作为解释副产物，不再是正式下游输入。

```ts
type StyleFunctionProfile = {
  id: string;
  category: string;
  arrangementBias: {
    preferredStrategies: Array<'space-first' | 'time-first' | 'event-first' | 'mixed'>;
    notes?: string;
  };
  segmentArchetypes: Array<{
    id: string;
    name: string;
    functions: string[];
    preferredShotGrammar: string[];
    preferredViewpoints?: string[];
    preferredMaterials: string[];
    typicalTiming?: 'opening' | 'middle' | 'ending' | 'bridge';
    notes?: string;
  }>;
  transitionRules: Array<{
    from: string;
    to: string;
    purpose: string;
    preferredTransitions?: string[];
    notes?: string;
  }>;
  functionBlocks: Array<{
    id: string;
    functions: string[];
    preferredShotGrammar: string[];
    preferredMaterials: string[];
    preferredTransitions: string[];
    disallowedPatterns: string[];
    timingBias?: 'opening' | 'middle' | 'ending' | 'bridge';
    notes?: string;
  }>;
  globalConstraints: string[];
  antiPatterns: string[];
  proseReference?: string;
};
```

为什么存在：

- 它把“风格到底怎么影响编排”从长文中抽离成结构化骨架。
- 它不仅约束语气和镜头偏好，也正式约束段落原型和原型连接规则。
- 它让 Script 和 Timeline 不再重新解释 prose，而是直接命中相关 archetypes 和 function blocks。

谁消费它：

- Arrangement synthesizer
- Project arrangement packet builder
- Segment packet builder
- Timeline refinement packet builder

谁不允许直接消费它：

- 直接拿整篇 style markdown 做主输入的任何主模型链路

### Arrangement Synthesis Layer

Synthesis Layer 是 v2 新增的正式综合层。它不直接生成终稿文案，也不直接替主模型做最终裁决。它的职责是把大量 `SemanticSlice` 消化成“主模型真正能用来做编排决策的结构化中间表示”。

这一层包含三个正式对象：`MotifBundle`、`ArrangementSkeleton`、`SegmentCard`。

#### MotifBundle

`MotifBundle` 是素材团块。它表达的是：若干 slices 在时间、空间、功能、人物或视角上足够相容，因此可以作为同一段落或同一桥段的候选材料整体来思考。

```ts
type MotifBundle = {
  id: string;
  sliceIds: string[];
  dominantFunctions: string[];
  dominantPlaces: string[];
  dominantViewpoints: string[];
  timeContinuity: 'tight' | 'loose' | 'mixed';
  spatialContinuity: 'tight' | 'loose' | 'mixed';
  archetypeHits: Array<{
    archetypeId: string;
    confidence: number;
    reasons: string[];
  }>;
  representativeSliceIds: string[];
  notes?: string;
};
```

为什么存在：

- 它把“很多小 slice”收敛成“可被段落层理解的素材团块”。
- 它让复杂项目先扩展内部综合表示，而不是直接扩展 LLM 可见的 raw slices。
- 它能解释一段为什么是“开车聚合”“景点介绍聚合”“drama 聚合”，而不只是把一串 slice id 堆在一起。

谁消费它：

- Arrangement skeleton builder
- Segment packet builder
- Beat packet builder

谁不允许直接消费它：

- 任何试图绕过骨架层、直接让 bundle 自己定义整片结构的链路

#### ArrangementSkeleton

`ArrangementSkeleton` 是全片级骨架图。它不是线性大纲字符串，而是一张有顺序、有节点功能、有连接意图的结构图。

```ts
type ArrangementSkeleton = {
  id: string;
  strategy: 'space-first' | 'time-first' | 'event-first' | 'mixed';
  nodes: Array<{
    id: string;
    archetypeId?: string;
    functions: string[];
    bundleIds: string[];
    narrativePurpose: string;
  }>;
  edges: Array<{
    from: string;
    to: string;
    transitionPurpose: string;
  }>;
  narrativeSketch: string;
};
```

为什么存在：

- 它是全片编排真正要比较和选择的对象，而不是一堆临时 prompt 描述。
- 它把顺序、段落功能和连接规则正式化。
- 它允许系统保留多个候选骨架，再交给主模型做项目级裁决。

谁消费它：

- Project arrangement packet builder
- 审查 / 调试工具

谁不允许直接消费它：

- Beat planning 主 LLM

#### SegmentCard

`SegmentCard` 是段落级消费单元。它是骨架节点的具体化，承接该段的目标、候选 bundle、禁区和粗文案意图。

```ts
type SegmentCard = {
  id: string;
  skeletonId: string;
  nodeId: string;
  archetypeId?: string;
  segmentGoal: string;
  bundleIds: string[];
  styleArchetypeHits: string[];
  hardConstraints: string[];
  narrativeSketch: string;
};
```

为什么存在：

- 它把全片骨架节点变成段落层可以正式消费的卡片。
- 它让 `SegmentPacket` 看到的是“这一段是什么”，不是“这一段附近有哪些素材”。
- 它天然适合作为复杂项目的审查界面和调试边界。

谁消费它：

- Project arrangement packet builder
- Segment packet builder

谁不允许直接消费它：

- 任何直接把全片骨架细节泄露给 beat 层的链路

### Reasoning Packet Layer

Packet Layer 是 Truth Layer 和 Synthesis Layer 之上的压缩层。它是正式协议的一部分，但不属于长期项目真值。packet 的存在，是为了让 LLM 只面对当前层的问题，而不是面对整个项目世界。

#### Packet Budget Policy

v2 不再把 `<= 8` 之类的数量写成正式协议常量。正式规则改为预算约束：

```ts
type PacketBudgetPolicy = {
  targetTokenBudget: number;
  representationPolicy: 'cards-only' | 'cards-plus-representatives' | 'local-representatives-only';
  mustHideRawSlices: boolean;
};
```

这条规则的真正含义是：

- 复杂项目可以拥有更多段落卡、更多 bundle 和更多骨架候选。
- 复杂项目首先扩展的是综合层表示，不是直接扩展主 LLM 可见的 raw inputs。
- 实现可以有默认数量目标，但这些目标只能是 builder 默认值，不能写成协议真理。

#### ProjectArrangementPacket

它服务“全片怎么编排”的问题，而不是“这一拍怎么写字幕”。它只提供全局级别必要信息，不允许携带原始 slice 海洋。

```ts
type ProjectArrangementPacket = {
  projectGoal: string;
  budget: PacketBudgetPolicy;
  skeletonCandidates: ArrangementSkeleton[];
  segmentCards: SegmentCard[];
  styleArchetypeHits: Array<{
    archetypeId: string;
    matchedBundleIds: string[];
    notes?: string;
  }>;
  hardConstraints: string[];
  outputContract: {
    chosenSkeletonId: string;
    arrangementStrategy: 'space-first' | 'time-first' | 'event-first' | 'mixed';
    segmentOutline: Array<{ segmentCardId: string; order: number }>;
    narrativeSketch: string;
  };
};
```

#### SegmentPacket

它服务“这一段如何聚合素材、承担什么叙事任务”的问题。它不允许重做全片编排，也不允许直接生成精确文案。

```ts
type SegmentPacket = {
  budget: PacketBudgetPolicy;
  segmentCard: SegmentCard;
  motifBundles: MotifBundle[];
  representativeSlices: SemanticSlice[];
  styleArchetypeHits: string[];
  hardConstraints: string[];
  outputContract: {
    beatPlan: unknown[];
    narrativeSketch: string;
  };
};
```

#### BeatPacket

它服务“当前 beat 选哪几条素材、保不保原声、画面关系怎么定”的问题。它不允许再回头做段落层重构。

```ts
type BeatPacket = {
  budget: PacketBudgetPolicy;
  beatGoal: string;
  motifBundleIds: string[];
  representativeSlices: SemanticSlice[];
  styleBlocks: string[];
  localTimelineConstraints: string[];
  outputContract: {
    chosenSliceIds: string[];
    sourceSpeechDecision: 'use' | 'avoid' | 'optional';
    roughTextIntent: string;
  };
};
```

#### TimelineRefinementPacket

它服务“在初版时间线已经落位之后，生成精确文案并允许小范围微调”的问题。它不允许重做全片结构，也不允许重新回到海量素材召回。

```ts
type TimelineRefinementPacket = {
  budget: PacketBudgetPolicy;
  actualTimelineFacts: {
    segmentId: string;
    beatId: string;
    durationMs: number;
    clips: unknown[];
    subtitleWindows: unknown[];
  };
  currentBeatIntent: string;
  sourceSpeechDecision: 'use' | 'avoid' | 'optional';
  styleBlocks: string[];
  outputContract: {
    finalText: string;
    timelineAdjustmentRequest?: unknown;
  };
};
```

### 三层之间的边界

Truth Layer 保存长期可复用的分析与风格真值。Synthesis Layer 负责把 truth objects 综合成素材团块、段落候选和全片骨架。Packet Layer 负责分层提问。Truth Layer 可以复杂，Synthesis Layer 也可以复杂，但 Packet Layer 必须短。前两层的复杂性被系统吸收，Packet Layer 的复杂性必须被严格限制。

## Vocabulary

v2 采用“核心闭集 + 扩展标签”的策略。核心闭集负责稳定下游消费，扩展标签负责容纳目前尚不适合正式收口的细粒度语义。

正式核心维度固定为五轴：

- `narrativeFunctions`
- `shotGrammar`
- `viewpointRoles`
- `subjectStates`
- `grounding`

`grounding` 不作为普通标签轴，而是一个单独的证据与落地层，固定包含：

- `speechMode`
- `speechValue`
- `spatialEvidence[]`
- `pharosRefs[]`

`spatialEvidence.tier` 固定闭集为：

- `truth`
- `strong-inference`
- `weak-inference`

`arrangementStrategy` 固定闭集为：

- `space-first`
- `time-first`
- `event-first`
- `mixed`

`segmentArchetypes[]` 不等于整片模板。它们是风格定义的段落原型，例如：

- `opening-intro`
- `poi-intro`
- `route-advance`
- `bridge-follow`
- `drama-turn`
- `time-lift`
- `closure`

本稿不试图在这里一次性穷尽所有词表，但要求后续实现遵守一个原则：只有经常被下游稳定消费、且不会在项目间频繁漂移的语义，才允许进入核心闭集；其它内容进入 `extra`。

## Workflow

### Analyze

Analyze 的输入是资产事实、音频 / 视觉证据、空间证据与 `Pharos` 上游信息。Analyze 的输出是 `SemanticAsset[]` 与 `SemanticSlice[]`。

这一层回答的问题是：这段素材在剪辑里到底是什么、能承担什么叙事功能、具有什么镜头语法、它的空间与原声证据等级是多少。

这一层不允许回答的问题是：整片如何编排、某个段落要不要押某种情绪、某一句具体文案怎么写。

### Style

Style 的输入是参考作品和指导词。Style 的输出是 `StyleFunctionProfile`。

这一层回答的问题是：某类片子通常有哪些段落原型、哪些原型如何衔接、哪些镜头语法在什么功能块里高频出现、哪些表达是禁区。

这一层不允许回答的问题是：当前项目就一定要按哪一个具体段落方案来剪。

### Arrangement Synthesis

这一层的输入是 `SemanticSlice[]` 与 `StyleFunctionProfile`。输出是 `MotifBundle[]`、`ArrangementSkeleton[]` 与 `SegmentCard[]`。

这一层回答的问题是：这些素材如何先被综合成若干素材团块，这些团块又如何结合风格原型长成一套或多套全片骨架。

正式综合顺序固定如下：

1. `SemanticSlice` 先落成五轴语义。
2. `MotifBundle Builder` 按四类主信号做聚合：
   - 时间连续性
   - 空间连续性
   - 叙事功能相容性
   - 人物 / 视角相容性
3. bundle 构建时允许参考辅助信号：
   - 原声可用性
   - 运动方向 / 运镜尺度
   - 画面能量与节奏
   - `Pharos/GPS` 空间证据强度
4. `StyleFunctionProfile.segmentArchetypes[]` 为每个 bundle 提供段落原型命中。
5. `Arrangement Synthesizer` 根据 `transitionRules[]` 把 bundle 连接成一个或多个 `ArrangementSkeleton`。
6. 每个骨架节点再具体化为 `SegmentCard`。

这意味着项目级编排不再是“看一堆 slices 直接猜”。例如一条复杂旅程，正式综合过程可以长成：

- 航拍 slices 在空间重置、尺度建立、情绪打开上聚成 `opening-intro` 候选 bundle。
- 第三视角景点介绍类 slices 聚成 `poi-intro` 候选 bundle。
- 开车与路线推进类 slices 聚成 `route-advance` 候选 bundle。
- 航拍跟车 / 跟人素材聚成“连接人物与空间”的 `bridge-follow` bundle。
- 冲突 / 故障 / 停滞类 slices 聚成 `drama-turn` bundle。
- 延时摄影和高尺度镜头聚成 `time-lift` bundle。
- 收尾拉入整片的镜头再聚成 `closure` bundle。

这一层不允许回答的问题是：终稿逐字文案和最终 clip 级裁决。

### Project Arrangement

这一层的输入是 `ProjectArrangementPacket`。输出是全片主编排轴、选中的骨架、段落级 outline 和全片级文案构思。

这一层回答的问题是：现有骨架候选里，哪一套最适合当前项目；整片按空间推进、时间推进、事件推进还是混合方式组织；每一大块的大致叙事意图是什么。

这一层不允许回答的问题是：某一个 beat 用哪一个具体 cut、哪一句终稿文案怎么写。

### Segment Planning

这一层的输入是 `SegmentPacket`。输出是当前段落的 beat plan 和段落级 narrative sketch。

这一层回答的问题是：这一段需要哪些小块、这些小块如何承担具体功能、为什么是这些 bundle 组成当前段。

这一层不允许回答的问题是：最终逐字文案和最终时间线微调。

### Beat Planning

这一层的输入是 `BeatPacket`。输出是当前 beat 的 slice 选择、原声取舍和粗文案意图。

这一层回答的问题是：当前 beat 到底用哪几条代表候选、是否保留原声、这个 beat 的文本意图是什么。

这一层不允许回答的问题是：全段乃至全片的结构回退。

### Timeline Refinement

这一层的输入是 `TimelineRefinementPacket`。输出是精确文案以及可能的小范围时间线调整请求。

这一层回答的问题是：在真实时间线排布和片长约束下，这一句最终怎么说，字幕如何落，是否需要对 beat 时长或 clip 排布做小幅回调。

这一层不允许回答的问题是：重新做全片编排，或重新回到全量素材召回。

## Evidence And Grounding

空间与 `Pharos` 语义必须单独成章，因为这是这轮重构最容易继续混淆的地方。

首先，`Pharos` 数据进入 Kairos v2 的唯一方式，是进入 `grounding.spatialEvidence[]` 与 `grounding.pharosRefs[]`，再通过综合层影响 bundle 和 skeleton。它不允许再作为一堆 loose hints 被拼到 prompt 文本里。

其次，必须明确区分：

- `plan.json` 是计划意图
- `record.json` 是执行记录
- `gpx/*.gpx` 是轨迹证据

这三者进入 Kairos 后的语义不同。`plan.json` 可以帮助判断某个地点原本计划承担什么功能，但它不能自动等于素材真值。`record.json` 提供执行时的实际时间与位置，是比计划更强的现场证据。`gpx/*.gpx` 提供轨迹连续性和路线推进的证据，但它本身也不是画面内容真值。

因此，空间语义必须通过 `SpatialEvidence` 正式表达，而不是只剩一个地点字符串。一个 slice 可以同时持有多条 `SpatialEvidence`，但每一条都必须明确 tier、confidence、sourceKinds 和 reasons。下游如果要做地理重置、路线推进、地点介绍，必须明确读取的是哪一类证据，而不是“看起来像在这里”。

## Hallucination Control

本章是 v2 的核心。v2 的第一目标不是让系统更会描述，而是让主模型更不容易胡说。

第一条强规则：主模型永远不直接看 Truth Layer 全量对象，也不直接看 Synthesis Layer 全量对象。前两层可以保存复杂性，但它们不能直接成为主模型上下文。

第二条强规则：packet 必须是阶段性的、一次性的提问包。Project arrangement、segment planning、beat planning、timeline refinement 这四层必须各自使用不同 packet。

第三条强规则：packet 必须预算控制，而不是固定数量帽。v2 的正式规则是：

- `ProjectArrangementPacket` 只允许看到骨架候选和段落卡，不允许看到 raw slice 海洋。
- `SegmentPacket` 只允许看到当前段相关 bundle，raw slices 只能以代表卡形式出现。
- `BeatPacket` 只允许看到当前 beat 的局部 bundle 和代表 slices，不允许跨段回看全局素材。
- `TimelineRefinementPacket` 只允许看到当前 beat 的实际时间线事实和当前文案任务。

第四条强规则：实现可以有默认数量目标，但这些目标只能写成 builder 默认值，不能写成协议真理。例如：

- `ProjectArrangementPacket` 常见是 5 到 15 个 `SegmentCard`
- `SegmentPacket` 常见是 3 到 10 个 `MotifBundle`
- `BeatPacket` 常见是 2 到 6 个代表 slice 候选

第五条强规则：禁止输入清单必须是正式规则，而不是实现习惯。以下内容不得直接进入主模型：

- 全量 `SemanticSlice[]`
- 全量 `MotifBundle[]`
- 全量 style markdown
- 长历史讨论
- 弱结构 summary 堆料
- loose GPS / Pharos hints 文本

第六条强规则：系统内部允许使用 deterministic packing 和 subagent compaction。subagent 的主要职责不是提速，而是 **在进入主模型前先完成压缩、排序、去污染和阶段隔离**。主 agent 不再默认直接消费全部原始中间产物。

## Rejected Alternatives

### 兼容旧协议

不采用。因为这轮问题不是“旧协议不够长”，而是“旧协议的结构方向就错了”。如果继续兼容旧字段和旧输入组织方式，新的 truth layer、synthesis layer 和 packet layer 会被迫为旧 prompt 让路，最终变成名义上重构、实际上继续堆料。

### 两层协议

不采用。只有 truth 和 packet 两层，会让“编排综合”继续躲在 builder 黑盒或 prompt 魔法里。`MotifBundle`、`ArrangementSkeleton`、`SegmentCard` 必须拥有正式地位，才能让“全片怎么长出来”变成可审查协议，而不是经验实现。

### 固定数量帽

不采用。`<= 8` 之类的常量没有足够理论依据，也会在复杂片子里直接把真实结构压坏。v2 只承认预算规则和表示隔离，不承认把复杂项目硬截成统一数量的协议常量。

### 主模型直接读取全量 slices

不采用。即便 Analyze 结果更准确了，只要主模型继续直接面对全量 slices，问题仍然会回到上下文污染、候选泛滥和优先级丢失。

### 一次性写完整终稿文案

不采用。因为这不符合真实编辑流程，也不利于时间线和文案的互相对齐。v2 必须显式区分“前期构思”和“时间线后精修”。

## Acceptance Criteria

本稿评审通过，至少意味着以下结论已经被写清楚，而且审阅者能够明确回答。

- 三层协议是否切得足够干净。
- Truth Layer 是否控制在“准确但不冗余”的范围内。
- Synthesis Layer 是否把“slice 如何长成全片骨架”正式表达出来了。
- 主模型是否只消费 packet，而不是直接面对 truth objects 或 synthesis objects。
- packet 是否已经从固定数量帽改成预算规则与表示隔离。
- 两阶段文案和时间线双向微调是否被正式写死。
- `Pharos` / GPS / 轨迹证据是否被正式分层，而不是继续以 loose hints 形式存在。
- 文档中是否还残留任何“为了兼容旧链路而妥协”的措辞。

## Implementation Follow-up

本稿通过评审后，下一步工作顺序固定如下。

第一，先同步主文档：`README.md`、`AGENTS.md`、`designs/current-solution-summary.md`、`designs/architecture.md`。

第二，重写协议 schema 与 store，使 `SemanticAsset`、`SemanticSlice`、`StyleFunctionProfile`、`MotifBundle`、`ArrangementSkeleton`、`SegmentCard` 和四类 packet 成为正式类型。

第三，替换 Analyze 的正式输出，使其产出 truth layer，而不是旧的弱结构主链。

第四，新增 Arrangement Synthesis 工作流，使其按 `SemanticSlice -> MotifBundle -> ArrangementSkeleton -> SegmentCard` 产出正式综合层对象。

第五，替换 Style Analysis，使其产出 `StyleFunctionProfile`，并让 `segmentArchetypes[]` 与 `transitionRules[]` 成为正式资产，而不是只把长文风格报告当输入。

第六，替换 Script 工作流，使其按 `ProjectArrangementPacket -> SegmentPacket -> BeatPacket -> TimelineRefinementPacket` 分层推进。

第七，替换 Timeline 与脚本精修之间的反馈面，让文案与时间线具备正式的小范围双向回调合同。

本稿到此为止。它的职责是把 v2 协议和工作方式写死，为下一轮主文档同步和实现重构提供一个可评审、可执行、可否决的正式基线。
