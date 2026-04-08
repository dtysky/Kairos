# Kairos 素材语义协议重订：Asset Evidence -> Span -> Bundle Graph

## Status

当前状态：评审稿。

本稿的职责是把新的素材语义协议正式写清楚，作为后续 Analyze / Script / Timeline 重构的设计基线。本稿不承担实现说明，不承担兼容迁移设计，也不代表主文档已经同步完成。当前结论采用 **Clean Break** 立场：协议结构、层次边界与对象职责先定死，再决定如何替换当前主链。

本稿的中心链路固定为：

`Asset Evidence -> Span -> Bundle Graph -> Style-Driven Arrangement -> Packet`

本稿明确不再回到以下方向：

- 不再以五轴语义为协议中心。
- 不再引入胖 `ObservationFacts` 作为正式主对象。
- 不再把旧 `slice` 视为唯一正式素材真值中心。
- 不再内置一套固定的 `Segment` 正式词表。

文末所有词表都只作为附录草案存在，统一标记为 `pending-revision`。它们服务当前设计讨论，不代表最终正式闭集。

## Summary

Kairos 当前的素材语义来自多处拼接，而不是来自一套统一的语义本体。`schema.ts` 先定义字段名，`semantic-slice.ts` 再根据 `clipType`、`semanticWindow`、`transcript`、`recognition`、`GPS / Pharos` 等信号，用启发式往 `IKtepSlice` 上补五轴语义；`style-loader.ts` 再从 prose 里用关键词长出 archetype 和 function block；`arrangement-synthesis.ts` 最后消费这些混合字段去拼 bundle 和 skeleton。结果是：观察事实、剪辑解释、风格偏置和空间证据被揉在一起，系统内部的人也很难说清“这些语义到底是从哪来的”。

新的协议不再试图修补当前五轴，而是整体换成证据优先链路。上游分析只负责产出时间锚定的 `Asset Evidence`，包括 transcript、视觉识别、候选时间窗、音频信号、GPS 与 Pharos 证据等。正式素材语义单元改为 `Span`。`Span` 不再承载抽象的大词，而是由语义模型一步生成最终的时间窗、`role`、更具体的 `materialPatterns[]`、`grounding` 与 `localEditingIntent`。

这里的 `materialPatterns[]` 不是完整世界描述，也不是抽象事实标签，而是编辑和模型都能稳定识别的材料模式短语，例如“人物正在介绍地点”“交通工具内静态自拍”“车内行进中自拍”“静态照片作为记忆或背景材料”“导航界面作为路线或判断证据”。每个 span 只保留少量高价值模式。`localEditingIntent` 则只回答“这段材料在局部剪辑里适合承担什么作用”，例如“适合证明路线正在真实发生”“适合承接解释信息”。

再往后，`Bundle Graph` 不再是按时间扫出来的互斥团块，也不是 style 直接命名的段落标签池，而是素材侧的预聚合复用图。一个 span 可以同时属于多个 bundle。Bundle 的身份来自“可一起使用的材料母题”，例如“一组证明路线真实发生的行进材料”“一组现实摩擦与现场判断材料”“一组高辨识度地点建立材料”。Bundle 先在素材侧成立，不由 style 直接发明。

`Style` 继续保持独立分析资产身份。它不依赖项目级词集，也不直接消费项目里的段落词表。style 的正式作用变成：给出组织模式与段落程序，例如更偏“叙事段落驱动”，还是“时间自然行进型”；更偏“先用地点证据开门，再压现实摩擦”，还是“从一个地点出发，行车，到另一个地点，照片放段尾收束”。也就是说，段落不再由固定词表承载，而是由 `Style + 当前任务 + 全局材料库存` 现场生成自然语言段落对象。

这份协议的核心目标不是“把素材描述得更完整”，而是“把证据、材料模式、局部剪辑作用、素材预聚合和风格生成的段落程序拆开”，并把复杂性吸收到系统内部，尽可能减少主模型的幻觉来源。

## Problem Statement

当前协议的问题不是字段太少，而是来源混杂、边界模糊。

首先，当前五轴并不是从一个明确的材料层长出来的。`narrativeFunctions`、`shotGrammar`、`viewpointRoles`、`subjectStates`、`grounding` 这些字段，表面上看像一套正式合同，实际上却来自不同性质的信号：有些是从 `clipType` 直接映射出来的，有些来自 `semanticWindow` 的判断，有些靠 `recognition.description` 补充，有些又来自 transcript 或 GPS。这使得“这是什么材料”与“这适合怎么剪”天然混在了一起。

其次，当前系统没有独立的证据层。上游识别结果、候选窗口、ASR、视觉描述、GPS 和 Pharos 证据并没有先收口成一个正式的 `Asset Evidence` 层，而是被直接消耗、直接投影、直接重写成下游字段。这样一来，后续很难追溯某个语义值到底来自哪类证据，也很难防止模型或规则在中间层擅自脑补。

第三，当前没有统一的正式素材语义单元。旧 `slice` 一部分是按镜头边界切出来的，一部分是按 interesting window 切出来的，一部分又带 edit range 调整。它更像是“当前流程方便用的切片”，而不是“明确承载素材语义的正式对象”。

第四，当前把“段落”也想得太像词表了。真实剪辑里，intro、正文、探险段、路书段、趣闻段、时间推进段的组织方式差异很大。如果预先内置一套固定段落短语，再让所有风格去匹配它们，很快就会显得假，也无法支撑像“叙事段落驱动”和“时间自然行进型”这种完全不同的组织逻辑。

第五，当前 style archetype 也不是正式全局词表。它更像是从 prose 中按关键词抽出来的一层工作性提示。它对工作有帮助，但不应该和素材观察、局部剪辑作用一起并列为正式协议真值。

因此，这轮重订的重点不是再发明一套更胖的字段树，而是把下列几件事拆开：

- 素材分析到底先保留什么证据。
- 哪个对象才是正式素材语义单元。
- 哪些属于具体可复现的材料模式，哪些属于局部剪辑作用。
- 哪些属于素材侧预聚合，哪些属于风格驱动生成的段落程序。

## Core Principles

### 1. Asset Evidence 先于正式语义

上游分析阶段只负责产生结构化证据和候选时间锚点，不直接把这些证据重写为正式剪辑语义。

### 2. Span 是唯一正式素材语义单元

后续所有素材级语义判断都挂在 `Span` 上，不再让旧 `slice` 同时承担切片、事实、用途和编辑边界四种职责。

### 3. 事实层优先写成材料模式

素材层不再优先追求抽象“观察事实”，而优先保留更具体、可复现、可直接拿来判断的材料模式短语。

### 4. 局部剪辑作用单独建层

`localEditingIntent` 只回答“这段材料在局部剪辑里适合承担什么作用”，不和材料模式、空间证据、style 偏置混写。

### 5. Bundle 是素材侧预聚合复用图

bundle 的正式定义不再依赖时间相邻，也不直接等于风格段落身份。它先在素材侧成立，作为可复用的材料母题池。

### 6. 段落由风格现场生成，不由内置词表预定

`Style` 负责输出组织模式和段落程序；段落对象在具体项目与具体任务下生成，不再由一套固定段落词表承载。

### 7. 主模型默认不看细证据

系统内部可以保留更复杂的 evidence graph、bundle graph 与段落生成中间态，但主 LLM 默认只看 packet，不直接看细证据、全量 span 或全量 bundle 图。

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

  materialPatterns: MaterialPattern[];
  grounding: SpanGrounding;
  localEditingIntent: LocalEditingIntent;
};
```

### 2. 上游只产出 `Asset Evidence`

Analyze 上游阶段不再直接写正式语义。它只负责生成 `Asset Evidence`，包括 transcript、视觉识别结果、shot / window 候选、音频状态、GPS、project GPX、derived track、Pharos 证据等。当前 `summary`、`labels`、`placeHints` 等文本摘要仍可保留为调试副产物，但不再作为正式下游输入。

`Asset Evidence` 的职责只有两个：

- 提供可追溯的原始结构化信号。
- 提供候选时间锚点，供 `Span` 生成使用。

它不负责直接回答“这段适合拿来做开场还是推进”，也不负责直接产出段落身份。

### 3. 事实层改为更具体的 `MaterialPattern[]`

新的事实层不再以抽象 `ObservedCue[]` 为中心，而是以更具体的 `MaterialPattern[]` 为中心。每个 span 只保留 3 到 6 条最有价值的材料模式短语。每条模式都必须来自受控自然语言短语集，并且必须能回溯到上游证据摘录。

建议的正式形状如下：

```ts
type MaterialPattern = {
  phrase: string;
  confidence: number;
  excerpt?: string;
  evidenceRefs: string[];
};
```

这里的 `phrase` 应优先描述人一眼能认出的材料模式，例如：

- “人物正在介绍地点”
- “交通工具内静态自拍”
- “车内行进中自拍”
- “车外沿路前进”
- “静态照片作为记忆或背景材料”
- “导航界面作为路线或判断证据”

这里的 `excerpt` 不是模型自由编写的解释句，而是来自 transcript 片段、window reason、vision label、location text 等上游原摘录。Material Pattern 的目标是尽量少、尽量准、尽量可复现，而不是形成完整世界模型。

### 4. `Span` 由语义模型一步生成

新的 `Span` 生成不再依赖 `semantic-slice.ts` 那样的后补启发式映射。正式流程改为由一个语义模型，基于 `candidateWindows[]` 与资产级证据，一步决定：

- 最终 span 时间窗
- `role`
- `materialPatterns[]`
- `grounding`
- `localEditingIntent`

这意味着上游的 `Asset Evidence` 和下游的 `Span` 之间不再插入一个“先拼完整事实树再压缩”的胖中间层。`semantic-slice.ts` 一类模块如果保留，其职责也应当退化为输入拼装、schema 校验、词表归一化和安全修正，而不再承担正式语义生成中心。

### 5. `LocalEditingIntent` 继续做局部剪辑作用层

`localEditingIntent` 明确表示“这段材料在局部剪辑里最适合承担什么作用”。它不是材料事实，不是 bundle 身份，也不是段落原型。它只回答用途与消费约束。这里的正式值不再使用代码式枚举，而改用项目级批准的自然语言判断短语。

建议的正式形状如下：

```ts
type LocalEditingIntent = {
  primaryPhrase: string;
  secondaryPhrases: string[];
  forbiddenPhrases: string[];
  sourceAudioPolicy: 'must-use' | 'prefer-use' | 'optional' | 'prefer-mute' | 'must-mute';
  speedPolicy: 'forbid' | 'allow-mild' | 'allow-strong';
  confidence: number;
  reasons: string[];
};
```

这里的 `primaryPhrase` 应优先表达更局部的剪辑作用，例如：

- “适合证明路线正在真实发生”
- “适合承接解释性信息”
- “适合先把观众带进一个地方”
- “适合把现实摩擦或压力压上来”

这里的 `reasons` 默认只引用命中的材料模式短语，而不是长自然语言解释。这样可以减少自由发挥的空间，让“这段为什么被判成适合证明路线正在发生”尽可能回到可检查的材料模式集合。

### 6. `Span` 允许有限重叠

新协议不要求所有 span 严格互斥。有限重叠是被正式允许的，但必须受角色和数量约束控制。建议约束如下：

- 同一时间点最多 2 个 span。
- 只有互补角色允许重叠。
- `speech-led` 可与 `visual-led` 重叠。
- `mixed` 不与其他 span 重叠。
- `speech-led + speech-led` 不重叠。
- `visual-led + visual-led` 不重叠。

这样做的目的是保留“同一时间既有可用原声解释，又有可用观察画面”的表达能力，同时避免无限叠 span 导致下游失控。

### 7. `Bundle Graph` 改为素材侧预聚合图

新的 `bundle` 不再定义为按时间连续性扫出来的互斥团块，也不直接等于 style 里的段落标签，而是素材侧预聚合出来的 `Bundle Graph` 节点。一个 span 可以进入多个 bundle。Bundle 的主键不再是“时间相邻”，而是“可一起使用的材料母题是否成立”。

这里需要明确三条硬规则：

- `Bundle` 不是第四套正式词表层。
- `Bundle` 不直接从 style 名称长出来。
- `Bundle` 先在素材侧成立，后续再被段落层选用或重组。

建议的正式形状如下：

```ts
type MotifBundle = {
  id: string;
  title: string;
  description: string;
  memberSpanIds: string[];
  representativeSpanIds: string[];
  dominantMaterialPatterns: string[];
  compatibleLocalIntentPhrases: string[];
  audioPolicyHint: string;
  reuseHints: string[];
};
```

Bundle 的 `title` 和 `description` 都是自然语言对象身份，而不是固定词表。例如：

- “一组证明路线真实发生的行进材料”
- “一组现实摩擦与现场判断材料”
- “一组把观众带进新地点的建立材料”
- “一组可独立成趣闻小段的材料”
- “一组大尺度环境与航拍抬升材料”

Bundle Graph 的核心价值是把可复用素材从时间轴里解放出来，让系统能够明确表达“这些 span 放在一起，会形成哪种局部组织单元”，并且让后续 packet 只消费 representative spans，而不是重新回头扫全量素材。

### 8. `Style` 负责生成组织模式和段落程序

`Style` 继续保持 workspace 级独立分析资产身份。它不依赖项目级词集，也不直接消费项目里的固定段落词表。它的正式作用从“偏置某个固定 archetype”改成“生成组织模式与段落程序”。

这一步至少要回答两类问题：

- 当前更偏哪种组织模式，例如“叙事段落驱动”还是“时间自然行进型”。
- 在这种组织模式下，当前片段应该长成哪些自然语言段落对象。

这里的段落不再是固定词表，而是 style 驱动生成的自然语言对象。例如在 intro 场景里，可能出现：

- “一些切片构成的空间地点介绍”
- “一些时间主轴、空间为辅的行车记录”
- “一些趣闻片段集合”
- “航拍大场景镜头群”
- “延时摄影聚合群”

在正文场景里，可能出现：

- “从一个地点出发，行车，到另一个地点，适当加入照片在末尾”
- “一个地点的探险，从开始到结束，如果有延时摄影则在段尾抬一下”

这些段落对象不是项目级固定词表，而是当前 style、当前任务和当前材料库存共同生成的结果。

### 9. 正式脚本流程改为“两次组织”

新的脚本准备流程不再是“style 先给段落名字，再把素材硬塞进去”，而是“两次组织”：

1. `Span` 真值化  
2. `Bundle Graph` 在素材侧预聚合  
3. `Style + 约束 + 全局材料库存` 生成大概脉络  
4. 为每个段落对象选 bundle、重组 bundle，必要时补选 span  
5. 生成 packet、outline、script

这意味着：

- bundle 不是 style 直接决定的。
- style 也不是在无材料约束下自由写段落。
- 段落层消费的是素材侧预聚合 bundle 与 representative spans，而不是全量 span 海洋。

## Project-Level Vocabulary Protocol

项目级词集协议不新开独立 semantic vocab 文件，而是直接复用 `Project Brief` 审查面。人类可编辑入口仍然是：

- `config/project-brief.md`
- `config/project-brief.json`

在现有 `路径映射` 与 `Pharos` 之外，项目级 brief 只保留 2 个正式章节：

- `材料模式短语`
- `局部剪辑作用短语`

这两层语义必须分开分析、分开维护、分开失效。

`材料模式短语` 只服务 `MaterialPattern`。它回答“这是一种什么材料模式”，使用自然语言判断短语，优先写成更具体、更可复现的镜头或素材模式。像“人物正在介绍地点”“交通工具内静态自拍”“车内向前行进视角”“静态照片作为记忆或背景材料”都属于这一层。

`局部剪辑作用短语` 只服务 `LocalEditingIntent`。它回答“这段材料在局部剪辑里适合承担什么作用”。像“适合证明路线正在真实发生”“适合承接解释性信息”“适合把现实摩擦或压力压上来”都属于这一层。

这里还要明确第二条硬规则：正式词项采用自然语言短语，且 **短语即正式身份**。系统不再额外引入一套对外不可见的内部 key。也正因为如此，项目词集应该在第一次正式 Analyze 之前完成首轮填写；Analyze 后仍允许修改，但必须明确警告会导致已有分析结果失效。

默认失效规则按层切分：

- 修改 `材料模式短语`
  - 保留 `Asset Evidence`
  - 重做 `Span` 及其下游
- 修改 `局部剪辑作用短语`
  - 保留 `Asset Evidence` 与材料模式选择
  - 重做 `LocalEditingIntent / Bundle / Style-Driven Arrangement / Packet / Script / Timeline`

由于 `Bundle` 和 `Segment` 都不再拥有独立正式词表，所以不会出现单独“改 bundle 词表”或“改段落词表”的失效路径。

## Style-Driven Arrangement

`Style` 分析继续保持 workspace 级独立资产身份，因此 style 稿不依赖项目级 `Project Brief` 词集，也不反向被项目词集约束。

style 的正式输出不再是“我命中了哪个固定段落 archetype”，而是更接近下面两种东西：

- 组织模式判断
- 可直接消费的段落程序短语

例如，一个 intro 风格可以写成：

- “先用高辨识度国家意象快速开门”
- “很快落到必须亲自进入现场的个人动机”
- “用道路、车内行进和空间切换证明路线真的在发生”
- “用交通混乱、导航误导和现场摩擦把真实感压出来”
- “最后用判断句把观众送进这个国家当下的真实现场”

这些短语是 style-native 结构化偏好输出，不是项目级正式词表，也不是 bundle 名称。真正的段落对象由 arrangement builder 在读取 style 稿、当前约束和 bundle 库后生成。

## Worked Example: Egypt Intro

以 [埃及旅拍纪录片的 Intro 风格档案](/Users/dtysky/Projects/dtysky/Kairos/config/styles/egypt-travel-documentary-intro.md) 为例，新协议下应当这样预演：

第一步，素材侧先长出 spans。常见 `materialPatterns` 可能包括：

- “高辨识度地点快速建场”
- “人物正在介绍当前处境”
- “车内向前行进视角”
- “车内行进中自拍”
- “现场正在发生交通、规则或秩序压力”
- “静态照片作为记忆或背景材料”

对应的 `localEditingIntent` 可能包括：

- “适合先把观众带进一个地方”
- “适合让人物出场并交代当前处境”
- “适合证明路线正在真实发生”
- “适合把现实摩擦或压力压上来”

第二步，素材侧预聚合出 bundle。常见 bundle 可能包括：

- “一组把观众带进埃及的文明入口材料”
- “一组证明路线真实发生的行进材料”
- “一组现实摩擦与现场判断材料”
- “一组把尺度与判断收束起来的结尾材料”

第三步，style 稿给出组织程序，而不是固定 archetype 标签。对于埃及 intro，更像：

- 先把文明想象打出来
- 再把个人动机落锚
- 然后用路线材料证明穿越真的在发生
- 接着把现实摩擦压出来
- 最后用判断句收束成“真实埃及”的邀请

第四步，arrangement builder 基于 style 程序与 bundle 库生成段落对象，例如：

- “先用国家级意象建立埃及的第一印象”
- “再落到为什么我必须亲自来”
- “用从城市到道路再到沙漠的连续材料证明路线展开”
- “用导航误导、交通混乱和现场吐槽把真实感压出来”
- “最后回到判断与邀请，把观众送进正片”

第五步，每个段落对象再去选 bundle、重组 bundle、必要时补 span，而不是直接从全量素材里重新找。这样能避免：

- style 直接污染 bundle 身份
- 段落层回头重新扫全量 span
- “drama-turn” 这种叙事作用被误当成材料标签

## Hallucination Control

这套协议的设计目标之一，就是降低主模型的幻觉空间。

首先，主模型不直接读取 `Asset Evidence` 细证据。Transcript 细片段、visual label、GPS 命中、Pharos match reason 等信息可以内部持久化，但默认不直接暴露给主 LLM。

其次，主模型不直接读取全量 `Span[]`。即使 `Span` 已经比旧 `slice` 更干净，也不意味着主模型应该直接面对素材海洋。主模型默认只消费 packet，而 packet 只能携带当前阶段相关的 representative spans、它们的材料模式摘要、`localEditingIntent` 结果以及必要的硬约束。

第三，材料模式自身也必须低幻觉。材料模式短语必须来自 `Project Brief` 中批准的受控短语集；`excerpt` 必须来自上游原摘录；`localEditingIntent.reasons` 默认只引用材料模式短语，不鼓励自由长文理由。也就是说，系统可以做推理，但正式合同中的材料锚点必须尽量短、尽量硬、尽量可复现。

第四，`Bundle Graph` 与 `Style-Driven Arrangement` 的存在，本身就是为了替主模型吸收复杂性。系统内部可以复杂，但复杂性必须在进入 packet 之前被吸收，而不是被原样塞进 prompt。

## Test Plan

新的协议至少要通过以下验证。

第一，同一时间段允许有限重叠 span，但重叠必须受约束控制。一个原声说明素材可以产生一个 `speech-led` span；同一时间允许再叠一个 `visual-led` 观察 span；但不能无限追加第三个 span。

第二，每个 span 只能保留少量 `materialPatterns`。材料层不再追求把世界填满，而要验证每个 span 只有 3 到 6 条高价值模式，并且这些模式足以支撑后续 `localEditingIntent`。

第三，材料模式短语必须全部来自项目级批准词集。未知值必须失败或回退，不能静默放行。`excerpt` 必须能追溯到上游原摘录，不能是模型自由改写的“解释句”。

第四，`localEditingIntent.reasons` 默认引用材料模式短语，而不是长自然语言。需要验证一个 span 被判成“适合证明路线正在真实发生”“适合承接解释性信息”或“适合把现实摩擦压上来”时，理由能直接回到材料模式集合，而不是靠自由文本兜底。

第五，一个 span 可以进入多个 bundle。Bundle 必须能够跨时间收集远距 span，而不再被时间邻近强绑定。

第六，bundle 必须先在素材侧预聚合，再被 style 生成的段落程序选用。需要验证系统不会直接把 style 里的“drama 桥段”“地点介绍”“时间抬升”硬写成 bundle 名称。

第七，项目级词集协议必须明确回答：

- 词集在哪里编辑
- 两层词集分别服务哪一层对象
- `Bundle` 为什么没有独立正式词表
- 正式身份到底是自然语言短语还是内部 key
- 改词后哪一层需要失效重跑

第八，style 相关口径必须明确回答：

- style 为什么不能依赖项目级词集
- style 常见表达是否也要改成自然语言短语
- style 是否直接决定 bundle
- style 如何生成段落程序

第九，在旧五轴退出正式主链之后，Analyze -> Script -> Timeline 仍然需要能完整跑通。也就是说，协议重订不能只停留在命名层，而必须能支撑端到端链路继续成立。

## Assumptions

- 这轮按 `Clean Break` 推进，不保留旧 `slice` 正式语义兼容。
- 正式命名采用 `Span`，避免继续和旧 `slice` 共享心智模型。
- `materialPatterns[]` 是新的事实层，但它是稀疏材料模式层，不是完整世界描述。
- 细证据内部保存，默认不暴露给主 LLM。
- `Span` 由语义模型一步生成，不拆成单独的“完整事实树构建”阶段。
- `Project Brief` 是项目级词集协议的正式编辑入口。
- 项目级正式词集只保留两层：
  - `材料模式短语`
  - `局部剪辑作用短语`
- `Bundle` 是自然语言对象，不是固定词表层。
- `Segment` 不是固定词表层，而是 style 驱动生成的自然语言对象。

## Appendix A: Vocabulary Drafts (Pending Revision)

以下词表仅为当前协议讨论用候选集合，后续必须结合真实素材样本继续修订，不视为最终正式闭集。

### A.1 材料模式短语草案

| 短语 | 来源 | 状态 |
|------|------|------|
| `人物正在介绍地点` | proposal | pending-revision |
| `人物正在介绍当前处境` | proposal | pending-revision |
| `人物正在解释接下来要做什么` | proposal | pending-revision |
| `人物正在对镜记录当下感受` | proposal | pending-revision |
| `人物正在观察或确认现场` | proposal | pending-revision |
| `人物与地点同框作为尺度尺` | proposal | pending-revision |
| `交通工具内静态自拍` | user-example | pending-revision |
| `车内行进中自拍` | user-example | pending-revision |
| `第一人称日常记录` | user-example | pending-revision |
| `车内向前行进视角` | proposal | pending-revision |
| `车外沿路前进` | proposal | pending-revision |
| `镜头在跟着交通工具移动` | proposal | pending-revision |
| `镜头在跟着人物移动` | proposal | pending-revision |
| `从一个空间切到另一个空间` | proposal | pending-revision |
| `高辨识度地点快速建场` | proposal | pending-revision |
| `地点局部细节作为记忆点` | proposal | pending-revision |
| `道路、桥梁、河流或海岸在证明路线` | proposal | pending-revision |
| `现场人声可以直接使用` | proposal | pending-revision |
| `现场环境声本身有表达价值` | proposal | pending-revision |
| `现场正在发生现实摩擦或阻碍` | proposal | pending-revision |
| `现场正在发生交通、规则或秩序压力` | proposal | pending-revision |
| `天气或环境压力正在逼近` | proposal | pending-revision |
| `画面在呈现明显的时间流逝` | proposal | pending-revision |
| `静态照片作为记忆或背景材料` | user-example | pending-revision |
| `导航界面作为路线或判断证据` | user-example | pending-revision |

说明：这组短语服务 `MaterialPattern`。它们优先表达具体可复现的材料模式，而不是抽象观察事实。

### A.2 局部剪辑作用短语草案

| 短语 | 来源 | 状态 |
|------|------|------|
| `适合先把观众带进一个地方` | proposal | pending-revision |
| `适合立起一个地方的第一印象` | proposal | pending-revision |
| `适合让人物出场并交代当前处境` | proposal | pending-revision |
| `适合承接解释性信息` | proposal | pending-revision |
| `适合证明路线正在真实发生` | proposal | pending-revision |
| `适合完成空间切换或地理重置` | proposal | pending-revision |
| `适合把现实摩擦或压力压上来` | proposal | pending-revision |
| `适合表达时间流逝或状态变化` | proposal | pending-revision |
| `适合抬高尺度、气势或情绪` | proposal | pending-revision |
| `适合做收束、抵达或递送到下一段` | proposal | pending-revision |

说明：这组短语服务 `LocalEditingIntent`。它们表达局部剪辑作用，不等于 bundle 身份，也不等于段落任务。

### A.3 Bundle 自然语言对象示例

| 示例描述 | 来源 | 状态 |
|------|------|------|
| `一组把观众带进新地点的建立材料` | proposal | pending-revision |
| `一组证明路线真实发生的行进材料` | proposal | pending-revision |
| `一组现实摩擦与现场判断材料` | proposal | pending-revision |
| `一组可独立成趣闻小段的材料` | user-example | pending-revision |
| `一组大尺度环境与航拍抬升材料` | user-example | pending-revision |
| `一组时间主轴、空间为辅的行车记录材料` | user-example | pending-revision |
| `一组延时摄影聚合材料` | user-example | pending-revision |

说明：这组短语不是正式词表，而是 bundle 作为自然语言对象时常见的描述方式。

### A.4 Style 驱动段落程序示例

| 示例描述 | 来源 | 状态 |
|------|------|------|
| `一些切片构成的空间地点介绍` | user-example | pending-revision |
| `一些时间主轴、空间为辅的行车记录` | user-example | pending-revision |
| `一些趣闻片段集合` | user-example | pending-revision |
| `航拍大场景镜头群` | user-example | pending-revision |
| `延时摄影聚合群` | user-example | pending-revision |
| `从一个地点出发，行车，到另一个地点，适当加入照片在末尾` | user-example | pending-revision |
| `一个地点的探险，从开始到结束，如果有延时摄影则在段尾抬一下` | user-example | pending-revision |

说明：这组短语也不是正式词表，而是 style 驱动生成段落对象时常见的自然语言表达方式。

### A.5 当前仓库已出现的旧语义词与 style archetype 词

#### 当前 `semantic-slice.ts` 中已出现的旧语义词

| 词项 | 来源 | 状态 |
|------|------|------|
| `establish` | current-code | pending-revision |
| `route-advance` | current-code | pending-revision |
| `time-passage` | current-code | pending-revision |
| `info-delivery` | current-code | pending-revision |
| `arrival` | current-code | pending-revision |
| `departure` | current-code | pending-revision |
| `transition` | current-code | pending-revision |
| `emotion-release` | current-code | pending-revision |

#### 当前 `style-loader.ts` 中已出现的旧 style 表达

| 词项 | 来源 | 状态 |
|------|------|------|
| `opening-intro` | current-code | pending-revision |
| `poi-intro` | current-code | pending-revision |
| `route-advance` | current-code | pending-revision |
| `bridge-follow` | current-code | pending-revision |
| `drama-turn` | current-code | pending-revision |
| `time-lift` | current-code | pending-revision |
| `closure` | current-code | pending-revision |

说明：这些旧词保留在附录里，只用于帮助后续迁移和对照，不再视为新协议中的正式中心语言。

以下内容同样只是讨论草案，不视为最终正式闭集。
