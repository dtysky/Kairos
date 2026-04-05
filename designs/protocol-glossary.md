# Kairos Protocol Glossary

> 本文档是 Kairos 正式术语表。
> 目标是把协议层和设计层里反复出现、且容易被混用的术语收口成统一定义。
> 当前重点覆盖媒体分析阶段的 `clipType` 相关术语。

## 1. 适用范围

本文档适用于：

- 协议设计
- 正式设计文档
- 代码实现中的协议含义
- 输出字段的正式解释

本文档当前不负责：

- 临时评估文档里的自由描述措辞
- prompt 内部的临时标签扩展
- 调试时为了便于理解而使用的非正式场景词

如果本文档与临时说明冲突，以本文档为准。

## 1.1 变更与入口术语

### `Plan mode`

指任何需求、行为、接口、工作流、正式入口或用户路径变更前的计划确认阶段。

- 如果宿主支持显式 `Plan` 模式，应先进入该模式
- 如果宿主不支持显式 `Plan mode`，则必须先给出结构化计划并确认

### `design-first change`

指当前正式变更顺序：

1. `Plan mode`
2. 先更新设计文档
3. 再实现
4. 实现后回查并同步设计文档、rules 和 skills

### `official console`

指当前正式本地运行与监控入口：

- `Supervisor + React console (apps/kairos-console/)`
- 正式监控主路由是 `/analyze` 与 `/style`

### `legacy monitor helper`

指仍保留在仓库里、但不再代表正式入口的兼容 / 调试工具，例如：

- `scripts/kairos-progress.ps1`
- `scripts/kairos-progress.sh`
- `scripts/style-analysis-progress-viewer.html`

## 2. 术语分层

在媒体分析里，容易混在一起的其实是三种不同层级的词：

### 2.1 正式协议类型

这类词可以直接进入协议字段，例如：

- `clipType`
- `clipTypeGuess`

它们必须使用受控枚举值。

### 2.2 描述性场景词

这类词可以出现在设计讨论、评估分析、人工说明里，但**不是正式协议枚举**。

例如：

- `vlog speech`
- `portrait`
- `landscape`
- `driving shot`
- `aerial shot`

它们可以帮助人理解，但不能直接替代协议字段。

### 2.3 支撑信号

这类字段不是类型本身，而是帮助类型判断的证据或约束。

例如：

- `speechCoverage`
- `transcriptSegments`
- `interestingWindows`
- `semanticKind`
- `labels`
- `placeHints`

这些字段用来解释“为什么某条素材被判成某种类型”，而不是用来直接扩充新的类型枚举。

## 3. 正式 `clipType` 枚举

当前正式 `clipType` / `clipTypeGuess` 只允许使用以下值：

- `drive`
- `talking-head`
- `aerial`
- `timelapse`
- `broll`
- `unknown`

下面是这些值的统一定义。

### 3.1 `drive`

`drive` 指素材的核心观看价值在于“沿途推进”本身。

典型特征：

- 视觉主体是路线前进、空间推进、道路或路径展开
- 重点是沿途变化、地貌推进、前进过程
- 不以人物口播为主要观看价值

典型例子：

- 车载镜头沿山路持续前进
- 第一视角沿公路、海岸线、山谷向前推进
- 无人机高位跟随道路前进，但主体仍然是路线和沿途风景

不应因为素材里“有说话声”就自动排除 `drive`。  
如果路线推进仍是主导价值，仍然可以是 `drive`，同时通过 `speechCoverage` 或 `transcriptSegments` 表达口播存在。

如果同一条 `drive` 素材里既存在口播窗口，也存在明显景色推进窗口，不应把两者强行混成同一种剪辑语义。正式 `clipType` 仍然保持 `drive`，但窗口和切片可以再通过 `semanticKind` 区分 `speech / visual`。

### 3.2 `talking-head`

`talking-head` 指素材的核心价值在于“画面中的人正在承担讲述”。

这里的关键不是字面上的“只有头部特写”，而是：

- 人是否是主要叙事主体
- 口播是否是主要信息来源
- 画面是否主要服务于人物讲述，而不是服务于路线推进或纯景色展示

因此，下列情况都可以属于 `talking-head`：

- 正对镜头讲话
- 半身或全身出镜讲话
- 自拍口播
- 轻微走动或边走边讲，但叙事中心仍然是“人对镜头讲述”

典型例子：

- 站在观景台前介绍“我们现在到了哪里”
- 自拍边走边讲今天的路线和感受
- 路边停下后，对镜头解释眼前景色或个人判断

不应把 `talking-head` 误解成只能是：

- 静态室内采访
- 头部特写
- 镜头完全不动

### 3.3 `aerial`

`aerial` 指素材的核心价值在于航拍视角本身。

典型特征：

- 重点是空间展开、视角优势、地貌结构
- 观众主要看的是俯视或高位视角的信息
- 人物讲述不是主导价值

典型例子：

- 无人机俯瞰牛群、田野、山体
- 航拍河流、海岸线、冰川、山谷、城市结构

### 3.4 `timelapse`

`timelapse` 指素材的主要价值来自时间压缩后的节奏变化。

典型特征：

- 单帧信息不是重点
- 连续时间变化才是重点
- 主要观察对象是云层、车流、人流、光线、天气等变化过程

典型例子：

- 日落延时
- 城市夜景车流延时
- 天空云层快速移动

### 3.5 `broll`

`broll` 指素材主要用于补画面、承接节奏、提供氛围或视觉说明。

典型特征：

- 它可以有人、物、景
- 但叙事核心不是“这个人正在讲”
- 也不是“路线正在推进”
- 主要价值是画面说明、节奏承接、情绪补充

典型例子：

- 街头细节
- 餐馆内景
- 手部特写
- 室内陈设
- 环境抓拍

### 3.6 `unknown`

`unknown` 不是失败状态，而是正式保留值。

它表示：

- 当前信号不足
- 或者同一素材里存在多种竞争解释
- 暂时不应强行归入某个更具体的类型

应优先把 `unknown` 理解成“当前证据不足以稳定分类”，而不是“分析系统出错”。

## 4. `vlog speech` 的正式定位

`vlog speech` 可以作为设计讨论里的**描述性场景词**，但它**不是正式协议枚举值**。

它表达的是：

- 这条素材里存在明显的 VLOG 风格口播
- 人声讲述在素材价值里占比较高
- 但这并不自动等于一个新的正式类型

所以：

- `vlog speech` 可以出现在说明文字里
- `vlog speech` 不应直接写入 `clipType`
- 不应因为出现 `vlog speech`，就把协议枚举扩成一个新值

## 5. `vlog speech` 与正式 `clipType` 的关系

当一条素材被描述为 `vlog speech` 时，在正式协议里通常有两种落法：

### 5.1 落到 `talking-head`

如果人物对镜头讲述是主导价值，则优先落到 `talking-head`。

例如：

- 自拍边走边讲，但主体仍然是“我在对你说”
- 站在路边或景点前，对镜头解释行程和感受

### 5.2 仍然落到其他正式类型

如果路线推进、环境变化、景物观察更强，而口播只是附着其上，则仍可保持：

- `drive`
- `broll`
- `unknown`

同时通过这些支撑信号表达“这条素材里有强口播窗口”：

- `speechCoverage`
- `transcriptSegments`
- `interestingWindows`

也就是说：

- `talking-head` 是正式类型
- `vlog speech` 是描述性场景
- 两者不是同一级字段

## 6. `semanticKind` 的正式定位

`semanticKind` 不是新的 `clipType`，而是附着在窗口 / slices / recall candidate 上的二级语义标签。

当前只允许：

- `speech`
- `visual`

### 6.1 它解决什么问题

- 同一条 `drive` 素材里，口播窗口和景色窗口都可能值得剪
- 两类窗口在后续剪辑中的作用不同，不应在 planning 阶段直接 merge
- 因此需要在不改 `clipType = drive` 的前提下保留二级语义

### 6.2 它出现在哪些对象上

- `IInterestingWindow`
- `IKtepSlice`
- `ISegmentRecallCandidate`

### 6.3 它不等于新的正式类型

- `drive + speech` 不是新的 `clipType`
- `drive + visual` 也不是新的 `clipType`
- `semanticKind` 只用于表达“同一正式素材类型内部，这个窗口/切片更偏哪种剪辑语义”

### 6.4 当前使用口径

- `speech`：主要价值来自口播、叙述、解释、人物发言
- `visual`：主要价值来自景色变化、路线推进、画面观察、非口播视觉段落

## 7. 使用规则

为了避免协议层和分析层概念漂移，建议统一遵守以下规则：

### 7.1 正式协议字段只写正式枚举

以下字段只允许写正式值：

- `clipType`
- `clipTypeGuess`

不要把以下词直接写进去：

- `vlog speech`
- `portrait`
- `landscape`
- `driving shot`
- `aerial shot`

这些词如果需要保留，应进入：

- `labels`
- `summary`
- `decisionReasons`
- 文档说明文字

### 7.2 不要把“有口播”直接等同于 `talking-head`

有口播只表示：

- 这条素材有人声信号
- 可能存在强讲述窗口

它不自动意味着正式类型一定是 `talking-head`。

例如：

- 一条持续推进的行车视频里有人在讲话，仍然可能是 `drive`
- 一条环境观察段落里有说明性人声，仍然可能是 `broll`

### 7.3 `unknown` 是允许且必要的

当证据不足时，优先保留 `unknown`，不要为了“看起来更聪明”而强行归类。

## 8. 当前结论

当前正式口径应统一为：

- `talking-head` 是正式 `clipType`
- `vlog speech` 不是正式 `clipType`
- `vlog speech` 只作为描述性场景词存在
- 当素材存在强口播但不适合直接归成 `talking-head` 时，应优先保留正式类型，再用 `speechCoverage / transcriptSegments / interestingWindows` 表达口播信号
- `semanticKind` 只作为窗口 / 切片 / recall candidate 的二级语义标签，不替代正式 `clipType`
- `drive` 可以保持正式类型不变，同时把 `speech / visual` 窗口分开进入后续规划
