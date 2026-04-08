# Kairos 素材语义协议重订：Asset Evidence -> Span -> Bundle Graph

## Status

当前状态：评审稿。

本稿的职责是把新的素材语义协议正式写清楚，作为后续 Analyze / Script / Timeline 重构的设计基线。本稿不承担实现说明，不承担兼容迁移设计，也不代表主文档已经同步完成。当前结论采用 **Clean Break** 立场：协议结构、层次边界与对象职责先定死，再决定如何替换当前主链。

本稿的中心链路固定为：

`Asset Evidence -> Span -> Bundle Graph -> Segment Archetype -> Packet`

本稿明确不再回到以下方向：

- 不再以五轴语义为协议中心。
- 不再引入胖 `ObservationFacts` 作为正式主对象。
- 不再把旧 `slice` 视为唯一正式素材真值中心。

文末所有词表都只作为附录草案存在，统一标记为 `pending-revision`。它们服务当前设计讨论，不代表最终正式闭集。

## Summary

Kairos 当前的素材语义来自多处拼接，而不是来自一套统一的语义本体。`schema.ts` 先定义字段名，`semantic-slice.ts` 再根据 `clipType`、`semanticWindow`、`transcript`、`recognition`、`GPS / Pharos` 等信号，用启发式往 `IKtepSlice` 上补五轴语义；`style-loader.ts` 再从 prose 里用关键词长出 archetype 和 function block；`arrangement-synthesis.ts` 最后消费这些混合字段去拼 bundle 和 skeleton。结果是：观察事实、剪辑解释、风格偏置和空间证据被揉在一起，系统内部的人也很难说清“这些语义到底是从哪来的”。

新的协议不再试图修补当前五轴，而是整体换成证据优先链路。上游分析只负责产出时间锚定的 `Asset Evidence`，包括 transcript、视觉识别、候选时间窗、音频信号、GPS 与 Pharos 证据等。正式素材语义单元改为 `Span`。`Span` 不再承载胖事实树，而是由语义模型一步生成最终的时间窗、`role`、稀疏 `observedCues[]`、`grounding` 与 `affordance`。

`observedCues[]` 是新的现象事实层，但它不是完整世界描述，而是每个 span 只保留 3 到 6 条高价值线索。模型只能从上游证据中挑选、归一化、压缩这些 cue，不能自由发明事实。`affordance` 则明确回答“这段素材适合承担什么剪辑动作”，同时附带原声和变速等消费约束。`grounding` 继续独立保存空间与说话证据，不被并入 cue。项目级词集协议统一挂到 `Project Brief`，并且正式词项采用自然语言短语本身作为正式身份。

再往后，`bundle` 也不再是按时间扫出来的互斥团块，而是全片复用的 `Bundle Graph`。一个 span 可以同时属于多个 bundle。Bundle 的作用是为段落组织提供稳定中间表示，避免主 LLM 回头扫全量 span。`Segment Archetype` 位于 bundle 之后，负责段落组织；`Style` 只提供偏置、连接规则和禁区；主 LLM 只消费 packet，不直接看细证据。

这份协议的核心目标不是“把素材描述得更完整”，而是“把证据、事实、用途和段落组织拆开”，并把复杂性吸收到系统内部，尽可能减少主模型的幻觉来源。

## Problem Statement

当前协议的问题不是字段太少，而是来源混杂、边界模糊。

首先，当前五轴并不是从一个明确的事实层长出来的。`narrativeFunctions`、`shotGrammar`、`viewpointRoles`、`subjectStates`、`grounding` 这些字段，表面上看像一套正式合同，实际上却来自不同性质的信号：有些是从 `clipType` 直接映射出来的，有些来自 `semanticWindow` 的判断，有些靠 `recognition.description` 补充，有些又来自 transcript 或 GPS。这使得“这是什么”与“这适合怎么剪”天然混在了一起。

其次，当前系统没有独立的证据层。上游识别结果、候选窗口、ASR、视觉描述、GPS 和 Pharos 证据并没有先收口成一个正式的 `Asset Evidence` 层，而是被直接消耗、直接投影、直接重写成下游字段。这样一来，后续很难追溯某个语义值到底来自哪类证据，也很难防止模型或规则在中间层擅自脑补。

第三，当前没有统一的正式素材语义单元。旧 `slice` 一部分是按镜头边界切出来的，一部分是按 interesting window 切出来的，一部分又带 edit range 调整。它更像是“当前流程方便用的切片”，而不是“明确承载素材语义的正式对象”。下游又把它当成编排、脚本和时间线的共同基础，导致语义层和编辑层纠缠在一起。

第四，当前 style archetype 也不是正式全局词表。它更像是从 prose 中按关键词抽出来的一层工作性提示。它对工作有帮助，但不应该和素材观察、剪辑用途一起并列为正式协议真值。

因此，这轮重订的重点不是再发明一套更胖的字段树，而是把下列几件事拆开：

- 素材分析到底先保留什么证据。
- 哪个对象才是正式素材语义单元。
- 哪些属于可观察线索，哪些属于剪辑动作。
- 哪些属于段落组织，哪些只是 style 偏置。

## Core Principles

### 1. Asset Evidence 先于正式语义

上游分析阶段只负责产生结构化证据和候选时间锚点，不直接把这些证据重写为正式剪辑语义。

### 2. Span 是唯一正式素材语义单元

后续所有素材级语义判断都挂在 `Span` 上，不再让旧 `slice` 同时承担切片、事实、用途和编辑边界四种职责。

### 3. 现象线索必须稀疏

事实层不再追求“把世界描述完整”，而只保留少量高价值、低幻觉、可追溯的 `observedCues[]`。

### 4. 剪辑动作单独建层

`affordance` 回答“这段拿来怎么剪”，不和现象线索、空间证据、style 偏置混写。

### 5. Bundle 是复用图，不是时间互斥分组

素材团块的正式定义不再依赖时间相邻。一个 span 可以在全片多个位置复用，bundle 的价值在于形成稳定的用途池。

### 6. 主模型默认不看细证据

系统内部可以保留更复杂的 evidence graph，但主 LLM 默认只看 packet，不直接看细证据、全量 span 或全量 bundle 图。

## Key Changes

### 1. 真值单元从 `Slice` 改为 `Span`

新的正式中心对象是 `Span`。它不等于旧 `slice` 的换名，而是新的语义单元。`Span` 由候选时间窗发展而来，可以在生成时进行合并、拆分和微调，因此它不受旧切片边界完全约束。后续的脚本选择与时间线引用都应当以 `spanId + 可选更窄子区间` 为正式引用方式。

建议的正式形状如下：

```ts
type SpanRole = 'speech-led' | 'visual-led' | 'mixed';

type IKtepSpan = {
  id: string;
  assetId: string;
  role: SpanRole;

  focusInMs: number;
  focusOutMs: number;
  preferredEditInMs: number;
  preferredEditOutMs: number;

  transcript?: string;
  transcriptSegments?: ITranscriptSegment[];
  speedCandidate?: ISpeedCandidateHint;
  pharosRefs?: IPharosRef[];

  observedCues: ObservedCue[];
  grounding: SpanGrounding;
  affordance: SpanAffordance;
};
```

### 2. 上游只产出 `Asset Evidence`

Analyze 上游阶段不再直接写正式语义。它只负责生成 `Asset Evidence`，包括 transcript、视觉识别结果、shot / window 候选、音频状态、GPS、project GPX、derived track、Pharos 证据等。当前 `summary`、`labels`、`placeHints` 等文本摘要仍可保留为调试副产物，但不再作为正式下游输入。

`Asset Evidence` 的职责只有两个：

- 提供可追溯的原始结构化信号。
- 提供候选时间锚点，供 `Span` 生成使用。

它不负责直接回答“这段适合拿来做开场还是推进”。

### 3. 现象事实层改为稀疏 `ObservedCue[]`

新的事实层不再是完整的多分面 `ObservationFacts`，而是稀疏扁平的 `ObservedCue[]`。每个 span 只保留 3 到 6 条最有价值的观测线索。每条 cue 都必须来自受控的自然语言短语集，并且必须能回溯到上游证据摘录。

建议的正式形状如下：

```ts
type ObservedCue = {
  phrase: string;
  channel: 'scene' | 'camera' | 'people' | 'audio' | 'space';
  confidence: number;
  excerpt?: string;
  evidenceRefs: string[];
};
```

这里的 `excerpt` 不是模型自由编写的解释句，而是来自 transcript 片段、window reason、vision label、location text 等上游原摘录。Cue 的目标是尽量少、尽量准、尽量可追溯，而不是形成完整世界模型。

### 4. `Span` 由语义模型一步生成

新的 `Span` 生成不再依赖 `semantic-slice.ts` 那样的后补启发式映射。正式流程改为由一个语义模型，基于 `candidateWindows[]` 与资产级证据，一步决定：

- 最终 span 时间窗
- `role`
- `observedCues[]`
- `grounding`
- `affordance`

这意味着上游的 `Asset Evidence` 和下游的 `Span` 之间不再插入一个“先拼完整事实树再压缩”的胖中间层。`semantic-slice.ts` 一类模块如果保留，其职责也应当退化为输入拼装、schema 校验、词表归一化和安全修正，而不再承担正式语义生成中心。

### 5. `SpanAffordance` 继续做剪辑动作层

`affordance` 明确表示“这段素材最适合承担什么剪辑动作”。它不是观察事实，不是段落原型，也不是风格偏置。它只回答用途与消费约束。这里的正式值不再使用代码式枚举，而改用项目级批准的自然语言判断短语。

建议的正式形状如下：

```ts
type SpanAffordance = {
  primaryUsePhrase: string;
  secondaryUsePhrases: string[];
  forbiddenUsePhrases: string[];
  sourceAudioPolicy: 'must-use' | 'prefer-use' | 'optional' | 'prefer-mute' | 'must-mute';
  speedPolicy: 'forbid' | 'allow-mild' | 'allow-strong';
  confidence: number;
  reasons: string[];
};
```

这里的 `reasons` 默认只引用命中的观察线索短语，而不是长自然语言解释。这样可以减少自由发挥的空间，让“这段为什么被判成适合推进路途”尽可能回到可检查的 cue。

### 6. `Span` 允许有限重叠

新协议不要求所有 span 严格互斥。有限重叠是被正式允许的，但必须受角色和数量约束控制。建议约束如下：

- 同一时间点最多 2 个 span。
- 只有互补角色允许重叠。
- `speech-led` 可与 `visual-led` 重叠。
- `mixed` 不与其他 span 重叠。
- `speech-led + speech-led` 不重叠。
- `visual-led + visual-led` 不重叠。

这样做的目的是保留“同一时间既有可用原声解释，又有可用观察画面”的表达能力，同时避免无限叠 span 导致下游失控。

### 7. `Bundle` 改为全片复用图

新的 `bundle` 不再定义为按时间连续性扫出来的互斥团块，而是全片复用的 `Bundle Graph` 节点。一个 span 可以进入多个 bundle。Bundle 的主键不再是“时间相邻”，而是“用途相容、线索相容、style 偏置可接受”。

这里需要明确一条硬规则：`Bundle` 不是第四套正式词表层。它继续是正式图结构对象，但它的语言层复用 `Span 用途短语`，再补一段 bundle 级说明，而不是再发明一组 bundle 专用词。

建议的正式形状如下：

```ts
type MotifBundle = {
  id: string;
  primaryUsePhrase: string;
  memberSpanIds: string[];
  representativeSpanIds: string[];
  supportingObservedPhrases: string[];
  bundleNote: string;
  sourceAudioBias: 'speech-led' | 'nat-sound-led' | 'mute-led' | 'mixed';
};
```

其中 `primaryUsePhrase` 必须直接复用一条 `Span 用途短语`。`bundleNote` 则用自然语言解释“这一组素材为什么会被放在一起、适合在哪些地方复用”，但它不是独立词表。Bundle Graph 的核心价值是把可复用素材从时间轴里解放出来，让系统能够明确表达“这些 span 共同适合承担哪种用途”，并且让后续 packet 只消费 representative spans，而不是重新回头扫全量素材。

### 8. `Segment / Style` 都改用自然语言短语，但保持彼此独立

段落原型层位于 bundle 之后，职责是组织片子，而不是描述素材。正式段落原型不再使用代码式枚举，而改用项目级批准的自然语言判断短语。`Style` 也要改用自然语言短语，但它仍然是独立分析资产，不能依赖任何项目级 `Project Brief` 词集，也不直接消费项目里的正式 Segment 短语。

建议的正式 `SegmentCard` 形状如下：

```ts
type SegmentCard = {
  id: string;
  primaryArchetypePhrase: string;
  bundleIds: string[];
  segmentGoal: string;
  connectionPurposeFromPrev?: string;
  connectionPurposeToNext?: string;
  hardConstraints: string[];
  narrativeSketch: string;
};
```

这意味着 travel-doc 风格下常见的 `poi-intro`、`route-advance`、`drama-turn`、`time-lift` 等表达，不再以标签形式存在，而要改写成 style-native 自然语言短语。它们不进入项目正式词表，也不绑定到某个项目配置。下游不会为 style 建正式映射表，而是要求 style 短语尽可能写得能与 segment 短语互相理解，再按语言接近去匹配。`segmentArchetypes` 这个字段名在设计稿里暂时保留，但它在 style 层表达的是“风格分析抽出的自然语言短语”，不是项目里的正式 Segment 词表。`Style` 的正式职责应该收缩到：

- `useBias[]`
- `archetypeBias[]`
- `transitionBias[]`
- `globalConstraints[]`
- `antiPatterns[]`
- `voice / narrative / proseReference`

## Project-Level Vocabulary Protocol

项目级词集协议不新开独立 semantic vocab 文件，而是直接复用 `Project Brief` 审查面。人类可编辑入口仍然是：

- `config/project-brief.md`
- `config/project-brief.json`

在现有 `路径映射` 与 `Pharos` 之外，项目级 brief 需要新增 3 个正式章节：

- `观察线索短语`
- `Span 用途短语`
- `Segment 原型短语`

这三层语义必须分开分析、分开维护、分开失效。

`观察线索短语` 只服务 `ObservedCue`。它回答“看到了什么线索”，使用自然语言判断短语，默认只写正向线索，不系统记录缺失。像“镜头在跟着车移动”“人物正在对镜说话”“画面在交代一个新的地点”都属于这一层。

`Span 用途短语` 只服务 `SpanAffordance`。它回答“这段素材适合拿来怎么剪”。像“适合用来推进路途”“适合用来交代空间”“适合用来承接解释信息”都属于这一层。

`Segment 原型短语` 只服务段落组织层。它回答“这一段在整片里负责什么”。像“这一段负责持续推进路途”“这一段负责进入人物或地点介绍”“这一段负责收束结尾”都属于这一层。

这里还要明确第二条硬规则：正式词项采用自然语言短语，且 **短语即正式身份**。系统不再额外引入一套对外不可见的内部 key。也正因为如此，项目词集应该在第一次正式 Analyze 之前完成首轮填写；Analyze 后仍允许修改，但必须明确警告会导致已有分析结果失效。

默认失效规则按层切分：

- 修改 `观察线索短语`
  - 保留 `Asset Evidence`
  - 重做 `Span` 及其下游
- 修改 `Span 用途短语`
  - 保留 `Asset Evidence` 与观察线索选择
  - 重做 `SpanAffordance / Bundle / Segment / Packet / Script / Timeline`
- 修改 `Segment 原型短语`
  - 保留 `Asset Evidence / Span / Bundle`
  - 重做 `Segment / Packet / Script / Timeline`

由于 `Bundle` 没有独立正式词表，所以不会出现单独“改 bundle 词表”的失效路径。Bundle 的语言层总是来自 `Span 用途短语 + bundle 说明`。

## Style Phrase Matching

`Style` 分析继续保持 workspace 级独立资产身份，因此 style 短语不能依赖项目级段落词集，也不能反向被项目里的 `Segment 原型短语` 约束。

style 短语和 segment 短语之间不建立正式映射表，不新增全局规范层，也不要求一对一对应。正式规则只有一条：两边都必须使用可对齐的自然语言短语，下游按语言接近去匹配。

这里的“语言接近匹配”不是放任 style 随便写，而是要求 style 短语尽量避免过度私有化、隐喻化、文学化，否则下游无法稳定判断它更接近哪类 segment 任务。也就是说，style 短语可以保留自己的风格语言，但它必须仍然是可消费的工作语言。

像旧的 `poi-intro / route-advance / drama-turn / time-lift` 这类表达，新的推荐写法应更接近：

- “先用地点证据把观众带进一个新地方”
- “用持续行进的素材把旅程真正推进起来”
- “先把现实摩擦或风险压上来形成转折”
- “用延时或大尺度环境把情绪抬起来”

这些短语是 style-native 结构化偏好输出，不是项目级正式词表。

## Hallucination Control

这套协议的设计目标之一，就是降低主模型的幻觉空间。

首先，主模型不直接读取 `Asset Evidence` 细证据。Transcript 细片段、visual label、GPS 命中、Pharos match reason 等信息可以内部持久化，但默认不直接暴露给主 LLM。

其次，主模型不直接读取全量 `Span[]`。即使 `Span` 已经比旧 `slice` 更干净，也不意味着主模型应该直接面对素材海洋。主模型默认只消费 packet，而 packet 只能携带当前阶段相关的 representative spans、它们的观察线索短语摘要、`affordance` 结果以及必要的硬约束。

第三，cue 自身也必须低幻觉。观察线索短语必须来自 `Project Brief` 中批准的受控短语集；`excerpt` 必须来自上游原摘录；`affordance.reasons` 默认只引用观察线索短语，不鼓励自由长文理由。也就是说，系统可以做推理，但正式合同中的事实锚点必须尽量短、尽量硬、尽量可追溯。

最后，`Bundle Graph` 与 `Segment Archetype` 的存在，本身就是为了替主模型吸收复杂性。系统内部可以复杂，但复杂性必须在进入 packet 之前被吸收，而不是被原样塞进 prompt。

## Test Plan

新的协议至少要通过以下验证。

第一，同一时间段允许有限重叠 span，但重叠必须受约束控制。一个原声说明素材可以产生一个 `speech-led` span；同一时间允许再叠一个 `visual-led` 观察 span；但不能无限追加第三个 span。

第二，每个 span 只能保留少量 observed cues。事实层不再追求把世界填满，而要验证每个 span 只有 3 到 6 条高价值 cue，并且这些 cue 足以支撑后续 `affordance`。

第三，观察线索短语必须全部来自项目级批准词集。未知值必须失败或回退，不能静默放行。`excerpt` 必须能追溯到上游原摘录，不能是模型自由改写的“解释句”。

第四，`affordance.reasons` 默认引用观察线索短语，而不是长自然语言。需要验证一个 span 被判成“适合用来推进路途”“适合用来做段落之间的过桥”或“适合用来承接解释信息”时，理由能直接回到 cue 集合，而不是靠自由文本兜底。

第五，一个 span 可以进入多个 bundle。Bundle 必须能够跨时间收集远距 span，而不再被时间邻近强绑定。

第六，主模型 packet 默认不暴露细证据。Packet 只应包含 representative spans、observed cues 摘要、affordance 以及必要的原声 / 变速约束。

第七，项目级词集协议必须明确回答：

- 词集在哪里编辑
- 三层词集分别服务哪一层对象
- `Bundle` 为什么没有独立正式词表
- 正式身份到底是自然语言短语还是内部 key
- 改词后哪一层需要失效重跑

第八，style 相关口径必须明确回答：

- style 为什么不能依赖项目级 segment 词表
- style 常见表达是否也要改成自然语言短语
- style 短语和 segment 短语如何建立关系
- 为什么这里不做正式映射表

第九，在旧五轴退出正式主链之后，Analyze -> Script -> Timeline 仍然需要能完整跑通。也就是说，协议重订不能只停留在命名层，而必须能支撑端到端链路继续成立。

## Assumptions

- 这轮按 `Clean Break` 推进，不保留旧 `slice` 正式语义兼容。
- 正式命名采用 `Span`，避免继续和旧 `slice` 共享心智模型。
- `observedCues[]` 是新的事实层，但它是稀疏线索层，不是完整世界描述。
- 细证据内部保存，默认不暴露给主 LLM。
- `Span` 由语义模型一步生成，不拆成单独的“完整事实树构建”阶段。
- `Project Brief` 是项目级词集协议的正式编辑入口。
- 正式词项采用自然语言短语，且短语本身就是正式身份。
- `Bundle` 继续保留为正式图结构对象，但不单独拥有正式词表。
- `Style` 分析继续保持 workspace 级独立资产身份。
- 设计稿里继续沿用 `segmentArchetypes` 这个字段名，但它在 style 层表示 style-native 自然语言短语。
- style 与 segment 的关系采用语言接近匹配，不新增全局规范层，不建显式映射表。

## Appendix A: Vocabulary Drafts (Pending Revision)

本附录仅用于汇总当前协议讨论中涉及的词表。以下词表都不是最终正式闭集，统一状态为 `pending-revision`。后续必须结合真实素材样本继续修订。

### A.1 观察线索短语草案

| 词 | 来源 | 状态 |
| --- | --- | --- |
| `镜头在跟着车或人移动` | proposal | pending-revision |
| `画面是车内向前看的行进视角` | proposal | pending-revision |
| `人物正在对镜说话` | proposal | pending-revision |
| `人物在边走边说` | proposal | pending-revision |
| `现场人声可以直接使用` | proposal | pending-revision |
| `画面在交代一个新的地点` | proposal | pending-revision |
| `画面在持续展示路途中的移动` | proposal | pending-revision |
| `这是延时摄影形成的时间流逝感` | proposal | pending-revision |
| `画面在展示高处俯看的整体空间` | proposal | pending-revision |
| `画面里有明显的人群或环境活动` | proposal | pending-revision |

说明：这组短语服务 `ObservedCue`。它们是正式候选短语，不再使用代码式标签；默认只描述正向线索，不系统描述缺失。

### A.2 Span 用途短语草案

| 词 | 来源 | 状态 |
| --- | --- | --- |
| `适合用来交代空间` | proposal | pending-revision |
| `适合用来介绍人物或地点` | proposal | pending-revision |
| `适合用来推进路途` | proposal | pending-revision |
| `适合用来做段落之间的过桥` | proposal | pending-revision |
| `适合用来承接解释信息` | proposal | pending-revision |
| `适合用来抬升情绪` | proposal | pending-revision |
| `适合用来表达时间流逝` | proposal | pending-revision |
| `适合用来走向抵达` | proposal | pending-revision |
| `适合用来收束结尾` | proposal | pending-revision |

说明：这组短语服务 `SpanAffordance`。`Bundle` 不单独拥有一套正式词表，而是复用这里的用途短语，再补 `bundle note`。

### A.3 Segment 原型短语草案

| 词 | 来源 | 状态 |
| --- | --- | --- |
| `这一段负责开场建立整体空间` | proposal | pending-revision |
| `这一段负责进入人物或地点介绍` | proposal | pending-revision |
| `这一段负责持续推进路途` | proposal | pending-revision |
| `这一段负责承担段落之间的过桥` | proposal | pending-revision |
| `这一段负责进入转折或冲突` | proposal | pending-revision |
| `这一段负责用时间流逝或情绪拔升抬段` | proposal | pending-revision |
| `这一段负责走向抵达` | proposal | pending-revision |
| `这一段负责收束结尾` | proposal | pending-revision |

说明：这组短语服务段落组织层。后续 style 只能偏置它们，而不再自造正式 archetype id。

### A.4 当前仓库已出现的旧语义词与 style archetype 词

#### 当前 `semantic-slice.ts` 中已出现的旧素材语义词

| 词 | 来源 | 状态 |
| --- | --- | --- |
| `establish` | current-code | pending-revision |
| `route-advance` | current-code | pending-revision |
| `time-passage` | current-code | pending-revision |
| `info-delivery` | current-code | pending-revision |
| `transition` | current-code | pending-revision |
| `arrival` | current-code | pending-revision |
| `departure` | current-code | pending-revision |
| `emotion-release` | current-code | pending-revision |
| `windshield-drive` | current-code | pending-revision |
| `follow-vehicle` | current-code | pending-revision |
| `pull-back` | current-code | pending-revision |
| `locked-timelapse` | current-code | pending-revision |
| `third-person-to-camera` | current-code | pending-revision |
| `handheld-observe` | current-code | pending-revision |
| `driving-selfie` | current-code | pending-revision |
| `car-interior-drive` | current-code | pending-revision |
| `non-self-to-camera` | current-code | pending-revision |
| `walk-and-talk` | current-code | pending-revision |
| `en-route` | current-code | pending-revision |
| `admiring` | current-code | pending-revision |
| `explaining` | current-code | pending-revision |

#### 当前 `style-loader.ts` 中已出现的旧 style archetype / function 词

| 词 | 来源 | 状态 |
| --- | --- | --- |
| `opening-intro` | current-code | pending-revision |
| `poi-intro` | current-code | pending-revision |
| `route-advance` | current-code | pending-revision |
| `bridge-follow` | current-code | pending-revision |
| `drama-turn` | current-code | pending-revision |
| `time-lift` | current-code | pending-revision |
| `closure` | current-code | pending-revision |
| `generic-observational` | current-code | pending-revision |
| `opening-establish` | current-code | pending-revision |

#### Style 常见表达的自然语言短语示例

| 词 | 来源 | 状态 |
| --- | --- | --- |
| `先用地点证据把观众带进一个新地方` | proposal | pending-revision |
| `先让人物或第三视角把地点介绍清楚` | proposal | pending-revision |
| `用持续行进的素材把旅程真正推进起来` | proposal | pending-revision |
| `先把现实摩擦或风险压上来形成转折` | proposal | pending-revision |
| `用延时或大尺度环境把情绪抬起来` | proposal | pending-revision |
| `用最强空间镜头和一句邀请把这一段收住` | proposal | pending-revision |

说明：这组短语属于 style-native 表达示例，不属于项目正式词表。它们只用于保持 style 分析的独立性，并让下游能够按语言接近去匹配 segment 短语。

#### 用户在当前讨论中明确给出的结构词

| 词 | 来源 | 状态 |
| --- | --- | --- |
| `引入航拍` | user-example | pending-revision |
| `第三视角景点介绍` | user-example | pending-revision |
| `开车聚合` | user-example | pending-revision |
| `航拍跟车跟人聚合` | user-example | pending-revision |
| `drama桥段聚合` | user-example | pending-revision |
| `延时摄影拔升` | user-example | pending-revision |
| `收尾拉入整片` | user-example | pending-revision |

再次说明：本附录只用于保留当前讨论上下文，帮助后续修订。它不是最终正式词表，也不构成实现时可直接硬编码的最终协议真理。
