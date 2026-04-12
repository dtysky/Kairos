# Kairos 编排链路重订：Model-Driven Arrangement

## Status

当前状态：评审稿。

本稿替换同日早前版本，并把今天已经讨论收敛的口径重新落定。它的目标不是把更多中间对象协议化，而是把主链重新理清，并明确哪些地方应该由模型动态决定，哪些地方只该做薄约束和检索支撑。

本稿当前确认的新主链为：

`Analyze -> Material Overview -> Script Brief -> Segment Plan -> Material Slots -> Bundle Lookup -> Chosen SpanIds -> Beat / Script`

## Summary

本稿确认以下结论：

- 视频 `fine-scan` 仍然是高精度语义生成阶段，不只是执行成本阶段。
- `scene-detect` 不是并列语义阶段，而是 `fine-scan` 内部的可选边界细化工具。
- `style analysis` 也要拆成两层：
  - `arrangementStructure` 作为结构程序层
  - `narrationConstraints` 作为脚本叙述约束层
- Analyze 内部要明确拆开三层判断：
  - `keep / drop`
  - 是否进入正式 spans 池
  - 通过 `fine-scan` 还是 `direct path` 产正式语义
- 第一版里，所有非 `drop` 的视觉素材都进入正式 spans 池，不引入 `context-only` 视觉素材层。
- `material overview` 是独立文档，不是新的 JSON 协议。
- `script brief` 在 `segment` 之前只负责目标与硬约束。
- `segment planning` 必须是 LLM-first，不能预设成一套可被规则完全约束的固定模板。
- `Material Slot` 保留，但只作为第二轮运行时薄检索指令。
- `bundle` 保留，但只做 `materialPatterns` 驱动的粗索引入口，不承担叙事骨架或长期身份。
- `localEditingIntent` 直接删除，不再作为正式素材合同。

## Why Rewrite

当前这份草稿原本已经纠正了“`fine-scan` 只是成本阶段”这一点，但仍然不够完整，问题主要有四类。

第一，它还没有把主链写成完整的：

`Analyze -> Overview -> Brief -> Segment -> Slot -> Retrieval`

而只是停在“segment 从 overview 长出来，slot 再去找 bundle”的中段表达，缺了 workflow 入口与审查顺序。

第二，它对 `segment` 的定义仍然偏静态。真实剪辑里，即使整体由时间推进，某个 `A -> B` 路段有时会长成独立段落，有时只是一笔带过，有时中途发生事，有时只有航拍或行车，有时什么都没有。`segment` 不能被写成一套“按规则套模板”的产物。

第三，它仍然把 `localEditingIntent` 写成“待删除”，而不是明确写成“本稿决定删除”。这会让后续实现继续把它当兼容真值保留。

第四，它虽然把 `slot` 和 `bundle` 变轻了，但还没有把 `chosenSpanIds`、`material overview` 的生成方式、`script brief` 的位置和 overview workflow 状态写完整。

## Main Chain

本稿确认的正式准备链如下：

1. `Analyze`
2. `Material Overview`
3. `Script Brief`
4. `Segment Plan`
5. `Material Slots`
6. `Bundle Lookup`
7. `Chosen SpanIds`
8. `Beat / Script`

这里的含义是：

- Analyze 负责正式材料语义产出。
- Overview 负责把整体素材边界、阶段感和缺口写成模型可读文档。
- Brief 负责在 segment 之前冻结目标与硬约束。
- Segment 负责长出段落意图序列。
- Slot 负责把段落意图翻译成薄检索需求。
- Bundle 只负责第一层粗索引。
- `chosenSpanIds` 是 retrieval 的正式结果回写位。
- 最后才进入 beat 和脚本创作。

## Style Analysis Output

### 1. `style analysis` 不再等于固定 segment 模板

`style analysis` 不能被理解成“提前替项目写好 segment plan”。

它可以稳定产出的，是可复用的风格结构与叙述约束，而不是项目级段落实例。

因此，本稿要求把 style output 明确拆成两层：

- `arrangementStructure`
- `narrationConstraints`

### 2. `arrangementStructure` 的正式语义

保留现有字段名 `arrangementStructure`，但正式语义改成**结构程序层**。

它回答的是：

- 主组织轴是什么
- 有哪些辅轴
- 章节通常怎么拆
- 每类章节通常装什么材料
- 章节之间通常怎么过渡

它不是：

- 项目级 `segment` 模板
- 固定 slot 模板
- 固定 bundle 骨架

本稿建议它显式承载：

- `primaryAxis`
- `secondaryAxes`
- `chapterPrograms[]`
- `chapterSplitPrinciples[]`
- `chapterTransitionNotes[]`

### 3. `chapterPrograms[]` 的形态

`chapterPrograms[]` 使用开放短语定义章节类型，不收成固定枚举。

本稿把它的最小正式形状写死为：

- `type`
- `intent`
- `materialRoles`
- `promotionSignals`
- `transitionBias`

这五个字段的语义分别是：

- `type`
  - 开放短语的章节类型
- `intent`
  - 这一类章节想完成什么
- `materialRoles`
  - 这一类章节通常需要哪些材料角色
- `promotionSignals`
  - 什么材料或事件出现时，常被升格成独立章节
- `transitionBias`
  - 它通常如何接前后章节

如果需要章节级叙述补充，可以在单个 chapter program 上附加可选 `localNarrationNote`，但它不属于最小正式字段集合。

每个 chapter program 只描述：

- 章节意图
- 常见材料角色
- 章节边界或升格线索
- 过渡倾向

这里的“每个章节有什么”表达的是**材料角色约束**，不是 retrieval 模板。

因此它可以写：

- 这一类章节通常需要哪些材料角色
- 哪些材料缺席时仍可成立
- 哪些材料出现时常被升格成独立章节

但它到 retrieval 的正式桥接链路应写成：

`chapterPrograms[].materialRoles -> slot query -> materialPatterns / targetBundles -> bundle lookup`

也就是说：

- `chapterPrograms[].materialRoles` 先表达风格层的材料角色短语
- `slot` 生成阶段再把这些角色归一到 `materialPatterns`
- `targetBundles` 继续以 `materialPatterns` 作为第一层入口

但它不直接下沉成：

- 固定 slot 列表
- 固定 bundle 骨架
- 固定项目级 segment 序列
- `targetBundles`
- retrieval 模板

### 4. `narrationConstraints` 的正式语义

`narrationConstraints` 是脚本叙述约束层。

它回答的是：

- 人称 / 视角
- 语气
- 信息密度
- 解释倾向
- 常见禁区

这一层以全局约束为主，允许少量章节级补充。

这里的章节级补充不单独挂在 `narrationConstraints` 内部。

如果某个 chapter program 需要局部叙述补充，应作为该 chapter program 的可选 `localNarrationNote` 挂载。

它才更接近通常意义上的“文学风格”。

### 5. Style 到 Segment 的关系

因此，正式关系应写成：

- `style analysis` 产出结构程序与叙述约束
- `material overview` 提供这次项目的材料边界与缺口
- `script brief` 提供这次项目的目标与硬约束
- `segment planner` 再结合当前素材把它们实例化成这一次的 `segment plan`

这里主次关系也要写清：

- `segment planner` 主要消费 `arrangementStructure`
- `narrationConstraints` 只弱影响 segment 的表达倾向
- `narrationConstraints` 不直接决定 segment 结构

也就是说：

- `style` 可以约束和引导 `segment`
- 但不应直接预制项目级 `segment`

## Analyze Semantics

### 1. `keep / drop`、spans 池与 materialization path 必须拆开

Analyze 内部不应继续把一堆判断挤在 `shouldFineScan` 或 `fineScanMode` 上。

本稿要求至少概念上拆成三层：

- `keep / drop`
- 是否进入正式 spans 池
- 通过 `fine-scan` 还是 `direct path` 生成正式语义

第一版里，规则先写简单：

- 所有非 `drop` 的视觉素材都进入正式 spans 池
- 先不引入 `context-only` 视觉素材

### 2. `finalize` 的职责

`finalize` 是资产级判断与召回规划阶段。

它负责：

- `clipType`
- 资产级 `visualSummary`
- `interestingWindows`
- `keep / drop`
- semantic materialization path 的主判

它不应假装自己已经完成视频的最终细粒度 span 语义。

### 3. 视频的正式语义主路径仍是 `fine-scan`

对视频来说，最准确的正式语义仍然优先来自 `fine-scan`，因为它直接消费被保留素材的原始局部信息。

因此本稿确认：

- 视频正式语义主路径仍是 `fine-scan`
- `fine-scan` 不是“只是更贵的执行成本阶段”
- `fine-scan` 仍然是高精度语义生成阶段

### 4. `scene-detect` 是 `fine-scan` 内部工具，不是并列阶段

`scene-detect` 的职责只有一个：帮助 `fine-scan` 获得更细边界。

因此：

- 不做 `scene-detect`，`fine-scan` 仍然照常生成语义
- 做了 `scene-detect`，只是边界更细

它不应再被描述成与 `fine-scan` 并列的一条正式语义阶段。

### 5. `skip` 收紧为真 `drop`

`skip` 不应再混入“无需 scene-detect”或“无需 fine-scan”这类含义。

本稿口径是：

- `skip` 只表示正式丢弃
- 也就是语义上的 `drop`

进一步地：

- 非 `drop` 且没有可信 `window` 的视频素材
- 不应直接停在 `skip`
- 应补一个 `[0, duration]` 的全片大 `window`
- 然后进入 `fine-scan`

### 6. `direct path` 的地位

`direct path` 是 `fine-scan` 之外的正式语义产出路径。

它的主判规则是：

- 由 unified `finalize` 模型纯 LLM 主判
- 不靠代码 heuristics 抢先判定
- 如果模型没有明确给出 `direct path`
- 默认回 `fine-scan`

第一版 `direct path` 的覆盖范围只包括：

- `photo`
- 少量语义原子的视觉素材

它不按某个 `clipType` 整类放开。

### 7. 照片路径

照片不再占用视频式 `fine-scan` / `scene-detect` 语义。

更准确的口径是：

- 照片仍基于原始信息直接生成正式语义
- 但它应走 `direct path`
- 而不是假装进入视频式 `fine-scan`

### 8. `fineScanMode` 的位置

`fineScanMode` 可以暂时保留为兼容字段，但本稿不再把它当成完整语义中心。

原因很直接：它混合了至少两类本该分开的判断：

- 保留 / 丢弃
- 边界细化 / materialization 路径

本稿只先明确：它不是最终稳定语义中心。

## Material Overview

### 1. `material overview` 是独立文档，不是新协议

`material overview` 采用：

- `Markdown`
- 最小 metadata

它不是新的 JSON 主体，也不是需要长期维持的厚 schema。

建议落点为：

- `script/material-overview.md`

### 2. `material overview` 的生成方式

本稿要求它按两段生成：

1. 代码先编译事实底稿
2. LLM 再把事实底稿写成 overview 文档

也就是说，overview 不是直接让模型“自由看全盘再总结”，而是基于明确事实底稿长出来。

### 3. `material overview` 应写什么

overview 重点不是把素材重新枚举一遍，而是帮助模型理解：

- 天然边界
- 材料强弱
- 明显缺口
- 哪些阶段不该硬切
- `Pharos` 的 planned / actual 差异

### 4. `material overview` 的来源

它只有一个对象，但允许有不同来源：

- 有 `Pharos` 时，以 `Pharos` 行程归纳为主，再结合实际素材补全 / 校正
- 没有 `Pharos` 时，允许用户给一个初步概要，再结合实际素材补全 / 校正

因此：

- `Pharos`
- 用户概要
- 素材事实底稿

不是三个并列正式协议输入，而是同一篇 `material overview` 的来源。

### 5. overview 的 workflow 位置

本稿要求 Script workflow 显式插入 overview 阶段：

1. `style`
2. `overview`
3. `brief`
4. `segment`
5. `slot / retrieval`
6. `script`

overview 是独立状态，建议用户先审，但不是硬闸门。

## Script Brief And Segment Planning

### 1. `script brief` 在 `segment` 之前只冻结目标与约束

`script brief` 不应继续承担“先写完整段落方案，再等 segment 落地”的混合职责。

本稿确认：

- `brief` 先于 `segment`
- `brief` 只承担全片目标与硬约束
- `segment` 相关 section 应在 `segment plan` 之后再补入

### 2. `segment planning` 必须是 LLM-first

`segment planning` 的输入固定为：

- `arrangementStructure`
- `narrationConstraints`
- reviewed `material overview`
- reviewed hard constraints

它不应被写成一套可完全由规则约束的模板系统。

这里进一步明确：

- `arrangementStructure` 主导结构决策
- `narrationConstraints` 只弱影响表达倾向
- `narrationConstraints` 不直接决定 `segment` 结构

### 3. `segment` 必须被理解为动态结果，而不是规则模板

这点是本稿的关键结论之一。

即使一条片子整体上是时间驱动，`segment` 也不是“按时间自然切块”就够了。比如：

- `A -> B` 途中有时会发生一件事，值得长成独立段落
- 有时途中什么都没发生，只应作为到达前的过门
- 有时会有一组航拍把路段抬起来
- 有时根本没有可用途中材料，应该直接跳到到达后的段落

因此：

- chronology、`Pharos`、day / place、planned / actual 差异
- 这些都只是 segment 的边界提示和材料 affordance
- 它们不是 segment 的硬模板

更准确的说法是：

- segment planner 可以把一个 transit 提升成独立 segment
- 也可以把它折叠进前后 segment
- 也可以只在 slot 层把它当作某个段落的局部材料需求

这件事必须由模型结合 overview、style 和约束动态决定。

### 4. `segment` 输出应当瘦身

`segment` 只保留段落本体，不再带厚检索提示。

建议形状为：

- `id`
- `title`
- `intent`
- `targetDurationMs`
- 可选弱 `roleHint`
- 可选备注

因此，从 `segment` 中移除：

- `preferredClipTypes`
- `preferredLabels`
- `preferredPlaceHints`

这些检索提示不再属于 segment。

## Material Slots, Bundles And Retrieval

### 1. `slot` 改为第二轮生成

`slot` 不应和 `segment` 同轮生成。

更合理的顺序是：

- 先有 `segment intent sequence`
- 再长出 `Material Slot`

这样可以让 segment 先回答“这一段要干什么”，slot 再回答“这一段需要找什么材料”。

### 2. `Material Slot` 的职责

`Material Slot` 只作为运行时薄检索指令。

它只保留：

- `id`
- `query`
- `requirement = required | optional`
- `targetBundles`
- `chosenSpanIds`

这里的 `chosenSpanIds` 是 retrieval 完成后的结果回写位，按优先级排序。

本稿不再单独发明 `slot fill` 对象；slot 自身就是结果容器。

### 3. `bundle` 的职责

`bundle` 继续保留，但只做粗索引入口。

它不再承担：

- 叙事骨架
- 段落身份
- 长期用途标签
- 唯一分组身份

### 4. `bundle key` 直接复用 `materialPatterns`

本稿进一步收紧 bundle 语义：

- `bundle key` 直接复用 `materialPatterns` 的稳定词表名
- 不再另造 bundle vocabulary

也就是说，bundle 的正式身份首先是：

- `materialPatterns` 倒排索引入口

而不是 narrative title。

### 5. `slot` 与 `bundle` 的关系

本稿确认：

- `slot` = 查询意图
- `bundle` = 粗索引入口

推荐链路为：

`Segment Intent -> Slot -> Bundle Lookup -> Span Filtering -> chosenSpanIds -> Beat / Script`

### 6. 二次过滤的职责

bundle 命中之后，再做更细的过滤。

适合放在 bundle 命中后的，是：

- 时间
- GPS
- chronology
- `Pharos` day / shot / planned-actual 线索

这些不是 bundle 身份本身，而是二次过滤条件。

### 7. bundle 允许重叠

既然 bundle 是索引层，就不应强迫一个 span 只属于一个 bundle。

因此：

- span 允许进入多个 bundles
- 这不是冲突
- 这是索引重叠

## Public Interfaces And Compatibility

本稿对公开接口的态度如下：

- `localEditingIntent`
  - 本稿结论是直接删除
  - 不再作为正式素材合同

- `IStyleProfile`
  - 显式承载两层：
    - `arrangementStructure`
    - `narrationConstraints`

- `materialPatterns`
  - 继续保留为 Analyze 正式语义核心
  - 也是 `slot -> bundle lookup` 的第一层入口

- `arrangementStructure`
  - 保留字段名
  - 正式语义改成结构程序层

- `chapterPrograms[].type`
  - 使用开放短语
  - 不收成固定枚举

- `chapterPrograms[]`
  - 最小正式字段为：
    - `type`
    - `intent`
    - `materialRoles`
    - `promotionSignals`
    - `transitionBias`
  - 可选局部叙述补充挂在单个 chapter program 的 `localNarrationNote`
  - 不定义 slot 模板

- `segmentArchetypes`
  - 若继续保留，只能视为兼容遗留或弱参考
  - 不再作为正式风格输入中心

- `fineScanMode`
  - 暂不要求立刻拆分或重命名
  - 但不再被视为完整正式语义中心

- `material overview`
  - 不新增结构化 schema
  - 只作为文档型输入

- `Material Slot`
  - 只定义为运行时薄层
  - 不承诺厚持久化协议

- `bundle`
  - 目标身份是 `materialPatterns` 粗索引层
  - 不再以 narrative fields 作为目标方向

## Validation Scenarios

- 视频素材没有可信 `window`，但也不是真 `drop`
  - 补一个全片大 `window`
  - 仍进入 `fine-scan`

- 视频素材不做 `scene-detect`
  - 仍由 `fine-scan` 生成正式语义
  - 只是边界不做 shot 级细化

- `photo` 与少量语义原子视觉素材
  - 可由 `finalize` 模型判为 `direct path`
  - 直接产正式 spans

- 模型没有明确给出 `direct path`
  - 默认回 `fine-scan`

- 所有非 `drop` 的视觉素材
  - 都进入正式 spans 池
  - 可被 slot / bundle 检索

- 有 `Pharos` 的项目
  - `material overview` 以行程归纳为主
  - 再结合实际素材补全 / 校正

- 无 `Pharos` 的项目
  - 用户给粗概要
  - 系统结合素材事实补全
  - 同样可生成 segments

- 一条时间驱动的素材链里，`A -> B` 途中只出现弱材料
  - 允许不长成独立 segment
  - 只在 slot 层作为过门材料被召回

- 一条时间驱动的素材链里，`A -> B` 途中发生了明确事件
  - 允许被提升成独立 segment
  - 不要求与固定规则模板一致

- 一个 slot 例如 `DAY2 从广州到深圳途中行车`
  - 先命中 `行车` 对应的 `materialPatterns` bundle
  - 再按 day / GPS / time / chronology 过滤 spans
  - 最后回写有序 `chosenSpanIds`

- 同一 span 同时进入多个 bundles
  - 作为索引重叠被允许
  - 不视为冲突

- 时间轴主导的参考片
  - 风格分析可产出 `primaryAxis = 时间`
  - 可带 `secondaryAxes = 空间`
  - 章节程序能表达出发 / 路途 / 到达 / 停留
  - 但不直接变成项目 segment 模板

- 空间轴主导的参考片
  - 可产出以地点推进为主的章节程序
  - 不必硬套时间段

- 主体轴或意识流参考片
  - 仍可产出主轴 + 辅轴
  - 不被强迫映射到旅行时间链

- `chapterPrograms[]`
  - 最小正式字段固定为 `type / intent / materialRoles / promotionSignals / transitionBias`
  - 只表达材料角色约束
  - 不产固定 slot 列表
  - 不产固定 bundle 骨架
  - 如需局部叙述补充，挂在 chapter program 的 `localNarrationNote`

- retrieval 桥接
  - `chapterPrograms[].materialRoles` 先进入 slot query
  - 再归一到 `materialPatterns / targetBundles`
  - 再进入 bundle lookup

- Script 实例化时
  - `arrangementStructure + material overview + brief + 当前素材`
  - 共同决定 segment
  - 而不是只照抄 style 结构
  - 其中 `arrangementStructure` 主导结构，`narrationConstraints` 只弱影响表达

## Non-Goals

本稿当前不解决以下问题：

- `fineScanMode` 最终是否拆成多个字段
- `direct path` 的最终 clip coverage 闭集
- `Material Slot` 的最终实现细节与持久化策略
- 是否未来保留轻量 `Backbone / Chapter` 概念
- 所有旧 schema/store 的一次性迁移方案

这些问题后续继续讨论，但不应反过来改变本稿当前主链。

## Migration Note

本稿当前只重写这份评审稿本身：

- 不同步 `README.md`
- 不同步 `designs/current-solution-summary.md`
- 不同步 `designs/architecture.md`
- 不同步 `.ai/skills/`

本稿的任务是先把设计中心改正，再决定如何同步主文档和实现。
