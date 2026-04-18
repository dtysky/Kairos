---
name: kairos-script
description: >-
  Phase 3: Load style profile, build an evidence-driven outline from spans, and
  write beats or narration only where needed. Use when writing script, beat
  design, source-speech planning, or the user mentions script, story, or
  narrate.
---

# Kairos: Phase 3 — Script

加载风格档案 → `/script` 自动保存风格分类 → `[subagent: overview-cartographer]` / `[subagent: brief-editor]` 生成初版 `script-brief` 与材料概览 → 用户审查并手动保存 brief → `/script` 做 deterministic prep → `[subagent: beat-writer]` 写正式脚本。

**核心特点**：粗剪脚本以证据和素材原声为优先；旁白只是可选表达，不是默认目标。

当前正式 script prep 链路已经切成：
- `Analyze -> Material Overview`
- `Material Overview + Script Brief + arrangementStructure + narrationConstraints -> Segment Plan`
- `Segment Plan -> Material Slots -> Bundle Lookup -> Chosen SpanIds -> Beat / Script`

当前正式 script agent chain 是：
- `[main agent]` 只负责流程路由、前置条件核对、packet 准备、用户 handoff 与 reviewer 闸门执行
- `[subagent: overview-cartographer]` 只写 `script/material-overview.md`
- `[subagent: brief-editor]` 只写初版 `script-brief`
- `[subagent: segment-architect]` 只写 `script/segment-plan.json`
- `[subagent: route-slot-planner]` 只写 `script/material-slots.json`
- `[subagent: beat-writer]` 只写 `script/current.json`
- `[subagent: script-reviewer]` 只做阶段审查，不直接生成正式稿

每个 subagent 都必须：
- 只读取自己的 stage packet
- 使用独立身份 prompt
- 不继承主线程长历史
- 缺证据时保守，不脑补
- stage packet 是唯一正式上下文；runtime 不得在 packet 之外再偷偷附加 `previousDraft`、`revisionBrief` 或主线程历史
- 正式执行后端应优先使用宿主 packet runner / 真实 clean-context subagent 链；直接 `ILlmClient` chat 只作为非 agent 宿主或本地调试的兼容 fallback

## 读者与职责边界

- 标注为 `[main agent]` 的段落，是给当前总控代理看的：负责 workflowState 判断、用户引导、packet / review 文件流转和何时停下说明阻塞。
- 标注为 `[subagent:*]` 的段落，是给对应 clean-context stage worker 看的：只负责自己的 stage artifact 和 review 输入。
- 主代理阅读 `[subagent:*]` 段落，是为了正确准备 packet、理解 reviewer 预期和执行闸门，不代表主代理可以本地兼任这些阶段。
- 如果当前宿主策略或本轮用户授权不允许启动 formal subagent / reviewer 链，主代理必须先停下说明原因；不要把多阶段写作和审稿静默折叠成一次本地起稿。

## 硬规则

- 风格档案必须由用户人工指定；系统不能根据当前项目素材自动生成、自动挑选或自动推断风格档案。
- `style` / `arrangement signals` 只约束顺序、阶段完整、素材角色、功能位和禁区，不默认推出总时长或段落预算。
- `targetDurationMs` 只保留为可选审阅提示；除非用户明确给出成片时长、交付窗口或某段硬时长，否则不要在 brief、segment plan、material slots 或 beat 中自动补全。
- script prep 与 rough-cut recall 默认高召回：优先保留过程证据、阶段证据、事件节点和可用原声，只移除空白、坏段和高重叠近重复。
- `material-slots` 的 deterministic base draft 是高召回下限；`route-slot-planner` 不能把 base `chosenSpanIds` 静默删掉，reviewer 也必须把 silent span drops 当 blocker。
- `script-reviewer` 的 blocker 是推进下一阶段和落成 `script/current.json` 的硬闸门。
- `script/current.json` 的正式落盘形状必须是 bare `IKtepScript[]`；如果 transport 返回 `{ "segments": [...] }`，只能由 stage runner 在持久化前解包，不能由 `[main agent]` 事后补写 normalize。
- `script-current` 每个 attempt 只允许一次正式 `beat-writer` 调用；不要先额外跑一轮 full-script writer 当“预草稿”。
- writer / reviewer 失败必须立刻写出真实 pipeline 失败态；不能让 `script/agent-pipeline.json` 停在旧阶段的 `pending`。
- 高召回不等于机械一 span 一 beat：outline 在交给 `beat-writer` 前，应先过滤明显设备口令 / 导航播报 / noisy-ASR 的 source-speech 锚点，并把连续非口播 evidence 聚成更少的 beat。
- agent-host 场景下，不要把“缺 formal stage runner”翻译成“让用户提供 LLM key”；应先报出宿主 packet runner 缺失或未接通。

## 变更工作流规则

只要本轮任务涉及需求、行为、接口、工作流、正式入口或用户路径变更，必须遵守下面顺序：

1. 先进入 `Plan` 模式；如果宿主没有显式 `Plan mode`，先给出结构化计划并得到确认。
2. 计划确认后，先更新相关设计文档，再开始实现。
3. 实现完成后，必须回查并同步受影响的设计文档、rules 和 skills，再结束本轮。
4. 如果变更影响正式入口、监控页、工作流主路径或用户操作方式，还要同步更新 `README.md`、`designs/current-solution-summary.md` 和 `designs/architecture.md`。

## 强规则：Pharos 驱动脚本前先校验上游协议

脚本阶段如果要引入、修改或解释 `Pharos` 输入，必须先：

1. 运行 `node scripts/pharos-protocol-hash.mjs`
2. 对比 `.ai/pharos-protocol-baseline.json`
3. 若 hash 不一致，先阅读 `../Pharos/designs/` 下当前协议文档，再继续设计或实现

不要把旧版 `Pharos` 结构记忆直接当成当前脚本阶段的正式输入真值。

## 前置条件

- `store/spans.json` 存在且非空
- 风格档案可用（以下方式任选其一）：
  - 分类档案：`<workspaceRoot>/config/styles/{category}.md`（由 [kairos-style-analysis](../kairos-style-analysis/SKILL.md) 生成）
  - 手写样板：`test/style-profile.md`
  - 如果还没有 workspace 风格档案，先执行 [kairos-style-analysis](../kairos-style-analysis/SKILL.md)

**硬性规则**：
- 如果用户没有明确指定某个风格档案，或没有明确说这次不用风格档案，Script 阶段必须暂停并先向用户确认。
- `kairos-style-analysis` 只能在用户明确要求做风格分析时执行，不能作为 Script 的隐式前置步骤自动触发。
- 项目内只保存 `script/script-brief.json.styleCategory` 这类“本项目选哪个 workspace 风格分类”的状态；可复用风格库不再属于项目目录。

## 可用工具

```typescript
// 从 markdown 文件加载风格档案
loadStyleFromMarkdown(filePath: string, options?: IStyleLoadOptions): Promise<IStyleProfile>

// 按分类名加载风格档案
loadStyleByCategory(stylesDir: string, category: string): Promise<IStyleProfile | null>

// 列出所有可用的风格分类
listStyleCategories(stylesDir: string): Promise<IStyleSourceCategoryConfig[]>

// 生成风格提示词（供 agent 参考）
buildStylePrompt(style: IStyleProfile): string

// 脚本编辑工具（纯函数，同步）
reorderSegments(segments: IKtepScript[], order: string[]): IKtepScript[]
updateNarration(segments: IKtepScript[], segmentId: string, narration: string): IKtepScript[]
removeSegment(segments: IKtepScript[], segmentId: string): IKtepScript[]
insertSegment(segments: IKtepScript[], afterId: string | null, segment: IKtepScript): IKtepScript[]

// LLM 辅助改写（需要 ILlmClient，异步）
rewriteNarration(llm: ILlmClient, segment: IKtepScript, instruction: string): Promise<string>
// 返回修改后的旁白文本（string），需要再用 updateNarration 替换到数组中
```

## 工作流程

### Step 1 [Main Agent]: 加载风格档案

```typescript
// 方式 1：按分类加载（推荐，支持多种风格）
const stylesDir = join(workspaceRoot, 'config/styles');
const categories = await listStyleCategories(stylesDir);
// 展示可用分类给用户选择，或由用户直接指定
const style = await loadStyleByCategory(stylesDir, 'travel-doc');

// 方式 2：加载手写样板
const style = await loadStyleFromMarkdown('test/style-profile.md');
```

风格档案包含：叙事结构、语言风格、情绪表达、主题价值观、风格禁区，以及可直接消费的节奏阶段、素材角色、运镜语言、功能位偏好和参数表。
来源可以是 `kairos-style-analysis` 自动生成，也可以是人工编写。

当前应优先读取的 style 信号包括：
- `style.sections` 中关于节奏阶段、素材编排、摄影 / 运镜、镜头功能位的章节
- `style.parameters` 中的稳定 key-value
- `style.antiPatterns` 中的风格禁区

不要把 style profile 只当成一篇“帮助感受语气”的长文；它现在还承担 `recall / outline / intro / montage` 的直接指导输入。

这里的关键前提是：**使用哪一份风格档案，必须由用户手动指定。**
`[main agent]` 可以列出可用档案供用户选择，但不能自行替用户决定，也不能根据当前素材自动生成一份“临时风格档案”。

当前 Console 的正式口径是：
- workspace 风格库维护在 `/style`
- Script 页先选择 `styleCategory`，并立即自动保存
- 一旦 `styleCategory` 改变，当前项目应立即清空旧的 `material-overview`、brief 草稿、outline、`segment-plan`、`material-slots` 与 `script/current.json`，再回到 `await_brief_draft`
- 关键 handoff 会通过持续可见的 workflow prompt 与 hana modal 明确提示“下一步回到 Agent / 点击准备”，而不是只靠轻量行内提示
- `script/script-brief.json` 内部继续保存 `categoryId`
- `script/script-brief.md` 可以显示友好名称，但不能替代内部 `categoryId`

**注意 `guidancePrompt`**：如果风格档案包含用户指导词（`style.guidancePrompt`），
agent 在创作旁白时应将其作为额外的创作指导。

### Step 2 [Main Agent]: 先让用户在 `/script` 指定风格，再推进初版 brief

当前正式口径分两层：

- `[main agent]` 负责脚本阶段的流程入口、人工审查 handoff、packet / review 流转与 reviewer 闸门
- `[subagent: overview-cartographer]` 和 `[subagent: brief-editor]` 负责初版材料整理与 brief 起草

正式顺序固定为：

1. 用户在 `/script` 选择 `styleCategory`，选择后立即自动保存
2. `[main agent]` 准备 packet，并调度 `[subagent: overview-cartographer]` / `[subagent: brief-editor]` 读取 style profile、spans、chronology、asset reports、Pharos context，生成 `script/material-overview.md` 与初版 `script-brief`
3. 用户回到 `/script` 审查并手动保存 brief
4. `/script` 会用更显眼的 workflow prompt / modal 提示用户点击 `准备给 Agent`
5. Console 校验前置条件并刷新 `script/material-overview.facts.json` 与 `analysis/material-bundles.json`
6. `[main agent]` 再继续推进 clean-context staged pipeline：
   - 先写 `script/spatial-story.json` / `script/spatial-story.md`
   - 再写 `script/agent-contract.json`
   - 然后按 packet 推进 `segment-plan -> material-slots -> script/current.json`
   - 每个阶段都要经过 `script-reviewer`，review 结果写到 `script/reviews/{stage}.json`

Console prep 不允许做的事：
- 自动起草初版 `script-brief`
- 自动写 `script/current.json`
- 自动批准 `segment plan`
- 自动生成并推进 `outline`

#### [Subagent: overview-cartographer]

写 `script/material-overview.md` 时，应根据：
- `analysis/asset-reports/*.json`
- `media/chronology.json`
- `store/spans.json`
- 风格档案

默认按高召回整理材料：
- 优先保留过程证据、阶段证据、事件节点和可用原声
- 不要先把材料压缩成少量“代表镜头”
- 只移除空白、坏段和高重叠近重复

#### [Subagent: brief-editor]

起草初版 brief 时，应根据：
- `analysis/asset-reports/*.json`
- `media/chronology.json`
- `store/spans.json`
- 风格档案

起草 brief 时，不要只总结“语气是什么”，还应把当前选中的风格分类归纳成更可执行的拍法提示，例如：
- 片头 / montage 应该按哪些节奏阶段推进
- `aerial / timelapse / drive / talking-head / broll / nat sound` 各自在当前风格里承担什么角色
- 哪些镜头语法更适合 `开场建场 / 地理重置 / 情绪释放`
- 明确的素材禁区 / 镜头禁区是什么
- 对时间驱动 / 路程驱动风格，只把“顺序正确、阶段完整、素材角色如何分配”写成结构约束，不要把它翻译成默认总时长或段落预算
- 除非用户明确给出成片时长、交付窗口或某段硬时长，否则 brief 不应预填总时长或每段预算

补全并审阅一份集中式：

```text
script/script-brief.md
```

这份 brief 至少要包含：
- 全片目标建议
- 叙事约束建议
- 段落方案审查建议
- 每段的简单备注

用户的职责是**审查和修改这份 brief**，而不是从空白开始手写所有内容。

如果用户已经修改过当前 brief，而又想让 `[subagent: brief-editor]` 重新生成一版初稿：

- `[main agent]` / `[subagent: brief-editor]` 都不能静默覆盖
- 正式路径是让用户回到 `/script` 点击 `重新生成初版 brief`
- 覆盖确认必须在 UI 中通过 hana modal 显式完成；确认后，下一次 `[subagent: brief-editor]` 才允许覆盖

**重要规则**：
- `material overview` 采用文档型输入，结构化事实底稿写入 `script/material-overview.facts.json`。
- `segment plan`、`material slots`、`outline` 和 `script/current.json` 都应视为 subagent 阶段产物，不再由 Console prep 自动生成。
- `script/script-brief.json.workflowState` 是脚本阶段的正式流程真值；`[main agent]` 应根据它判断当前该做“提示选风格 / 起草 brief / 等待用户审查 / 写正式脚本”中的哪一步。
- `script/spatial-story.json` / `script/agent-contract.json` / `script/agent-packets/` / `script/reviews/` / `script/agent-pipeline.json` 都属于 Script 内部 orchestration 资产，不改变 Timeline / Export 正式输入协议。
- 首轮 stage packet 默认不应携带 previous draft；只有 reviewer 返工后，writer 才读取 revision brief 与上一轮草稿。

### Step 3 [Main Agent + Subagents]: 生成 Segment Plan 与 Material Slots

```typescript
const spans = await readJson('store/spans.json', z.array(IKtepSlice));
```

当前需要注意的 span 语义：

- `span.sourceInMs / sourceOutMs` 是 focus/evidence window
- `span.editSourceInMs / editSourceOutMs` 是 Analyze 已经扩好的 edit-friendly bounds
- `span.materialPatterns[]` 是材料模式短语
- `material-bundles` 只用作 `materialPatterns` 驱动的粗索引层，但它现在应覆盖项目内全部有效 spans，而不是被提前缩成 shortlist
- `segment plan` 只保留段落本体：`id`、`title`、`intent`、可选 `targetDurationMs`、可选 `roleHint` / `notes`
- `material slots` 只保留运行时薄检索信息：`id`、`query`、`requirement`、`targetBundles`、`chosenSpanIds`
- 当前 Script 执行层还会基于现有 style profile 解析一个内部 `ResolvedArrangementSignals`：
  - 它不是新的公开协议
  - 它只用于判断当前风格主轴更偏时间推进、空间推进、情感推进还是结果回看
  - 如果 style 明确强调 `chronology / route continuity / continuous process`，顺时序会成为正式执行约束，而不是只有 prompt 偏好

#### [Subagent: segment-architect]

生成 `segment plan` 时，优先用风格档案里的结构化提示，而不是只凭通用直觉：

- `节奏阶段一 / 二 / 三 / 四...` 决定段落和 beat 的推进方式
- `chapterPrograms[]` 里的 `materialRoles`、`promotionSignals`、`transitionBias` 决定段落如何长出来
- `高频运镜 / 低频运镜` 决定镜头语言偏好
- `开场建场镜头语法 / 地理重置镜头语法 / 情绪释放镜头语法` 决定这些功能位分别该用什么画面组织
- `素材禁区 / 镜头禁区 / antiPatterns` 决定哪些候选就算“好看”也不该进当前风格
- 当当前风格主轴明显偏时间 / 路程推进时：
  - 先按 `capturedAt + chronology + Pharos trip/day/shot` 建立单调递增的时间带
  - 再把段落分配到各自合法时间带里
  - 不允许后段跨窗回捞前段素材来填空
- `targetDurationMs` 现在只是一种可选审阅提示，不再是粗剪默认预算：
  - 不要从 style 平均章节时长、材料容量或模板习惯自动补一个预算
  - 先把关键过程视频、可保留原声、结果照片组、事件节点尽量枚举出来
  - 只有用户明确要求某段时长时，才把它写成显式 `targetDurationMs`

#### [Subagent: route-slot-planner]

生成 `material slots` 时，遵循：

- `segment intent -> slot query -> targetBundles -> bundle lookup -> chosenSpanIds`
- bundle 命中后，再按 time / GPS / chronology / Pharos day-shot 线索做二次过滤
- `chosenSpanIds` 是 retrieval 的正式结果回写位
- 粗剪默认是高召回保留：
  - 不要再按固定 `3-4` 个 span 上限做代表性抽样
  - 有信息增量的 span 默认都应进入 `chosenSpanIds`
  - 只应去掉空白、坏段和高重叠近重复
- deterministic base draft 里的 `chosenSpanIds` 默认继续保留；除非某个 span 已被别的 slot 合法承接，或明确属于空白 / 坏段 / 高重叠近重复，否则不要静默删除
- 对时间主轴强的风格，二次过滤必须服从时间带窗口；局部打分只能在当前窗口里择优，不能跨窗乱拿素材
- 关键过程视频如果承载不可替代的时间推进、事件推进、人物关系推进或有效原声，应保留为独立 beat，不要让它被更泛的 summary 段或静态成果材料吞掉

### Step 3.5 [Subagent: script-reviewer]: 阶段审查

每个阶段审查都至少检查：

- stage 产物是否只使用了本阶段 packet 和允许的输入
- 是否错误地把 style 当成默认总时长或段落预算模板
- 是否保住了高召回目标，没有把过程证据、阶段证据、事件节点或可用原声提前压缩掉
- 对时间 / 路程主轴风格，是否遵守 chronology 窗口与阶段顺序
- 如存在 blocker，必须写入 review 并阻止推进下一阶段；不要带着 blocker 继续落稿

### Step 4 [Subagent: beat-writer]: 编排 beat，并只在必要时写旁白

**这是 beat-writer 把风格约束落到证据上的核心环节。**

beat-writer 需要：

1. 阅读完整风格档案（`style.rawReference` 或 `buildStylePrompt(style)`），并优先提取其中的 sections / parameters / antiPatterns
2. 理解叙事骨架的每个段落（`buildOutlinePrompt(outline)`）
3. 查看每个段落关联的切片证据（scene descriptions, ASR text, place hints）
4. 为每个段落组织 beat；只有在素材没有可用原声时才补写必要旁白，且严格遵循风格档案

对于 `intro / montage / transition` 这类高度依赖镜头组织的段落，优先按下面顺序消费风格信息：

1. 先看节奏阶段与功能位参数
2. 再看素材角色参数
3. 再看运镜 / 镜头语言章节
4. 最后才让自由创作去填具体措辞与细节

粗剪阶段的默认写法分三类：

1. 有可用原声的视频：
   - 优先写成 source-speech beat
   - `beat.text` 只做成片文字层或审阅锚点，不额外补解释性旁白
   - `beat.audioSelections[]` 负责原声锚点；`beat.visualSelections[]` 负责同拍内要保留的陪衬画面
   - 相邻 spoken units 若 gap `<= 3000ms` 且无强句末边界，应优先写进同一个 source-speech beat，交给下游合并成一个 audio unit
2. 照片：
   - 生成独立 photo beat
   - 不写 `utterances`
   - 不把照片当 narration beat 使用
3. 无可用原声的视频：
   - 允许用 `beat.text` / `beat.utterances` 完整组织旁白
   - 仍然必须基于切片证据，不要凭空解释

输出格式 — 每个段落一个 `IKtepScript`：

```typescript
const scriptSegment: IKtepScript = {
  id: randomUUID(),
  role: 'scene',           // 'intro' | 'scene' | 'transition' | 'highlight' | 'outro'
  title: '段落标题',
  narration: '旁白文本...',
  // targetDurationMs: 30000,  // 可选，仅在用户或交付约束明确要求时填写
  linkedSliceIds: ['slice-id-1', 'slice-id-2'],
};
```

正式输出时，`beat` 是更重要的编排单元：
- `beat.text` 表示这一小拍最终要落到成片文字层或字幕层的文字锚点
- 如果一个 beat 内本来就有多段配音与停顿，可额外提供 `beat.utterances?: Array<{ text, pauseBeforeMs?, pauseAfterMs? }>`
- `beat.actions?.preserveNatSound = true` 表示这拍要尽量保留原声
- `beat.actions?.muteSource = true` 表示这拍即使素材里有人声，也应静音后改走旁白
- `beat.actions?.speed = number` 只在你明确要做速度蒙太奇时使用；它现在是显式 retime 请求，不应用“裁很短的 source”去间接制造
- `actions.speed` 只应该写给本质上是 `drive / aerial` montage 的 beat；混入 `talking-head / broll / shot / timelapse / photo / unknown` 时，不要给整拍写 speed

### Step 4.5 [Subagent: beat-writer]: 原声与旁白的协同规则

脚本阶段不需要把“是否保留原声”全部手工写死，但要理解下游的默认行为：

- 只要 `beat.audioSelections[]` 有可用 `transcriptSegments`，且没有显式 `muteSource=true`，时间线默认就会把这拍当 source-speech 处理
- 对于想保留原声的 beat，优先把承担一句或一组相近口语的 selections 放进 `audioSelections[]`，把陪衬画面放进 `visualSelections[]`
- 相邻 spoken selections 若 gap `<= 3000ms` 且无强句末边界，会在时间线阶段并成一个 audio unit；写稿时不要为了回避这件事把一句话硬拆成多个 beat
- 如果一个带音轨素材不应该使用原话，就显式设置 `muteSource=true`，让下游改走旁白
- 照片 beat 默认是静默画面：不要写 `utterances`，也不要用照片承接 narration
- 对于无可用原声的视频，如果需要旁白，请直接在 `beat.text` / `beat.utterances[]` 里把文字结构写完整
- 如果这拍旁白在头部 / 中间 / 尾部需要明确留白，不要只把话全塞进 `beat.text`；应直接写 `beat.utterances[]` 把 pause 表达出来
- 如果候选 beat 提示了 `speedCandidate`（例如 `2x / 5x / 10x`），下游 rough cut 对 silent `drive / aerial` 已会默认按 `2x` 自动加速；只有你明确想覆盖这个默认时才填写 `actions.speed`
- `targetDurationMs` 不再驱动粗剪 placement；不要为了对齐预算而压缩原话、吞掉关键过程，或拉长照片
- 如果脚本没有显式写这两个动作，时间线阶段会根据 `transcriptSegments / speechCoverage / muteSource` 默认推论；这个默认现在偏向“有可用原声就保原声”
- 对于最终走 source-speech 的 beat，时间线会先把 `audioSelections[]` 并成 merged audio units，再按短分句产字幕；如果某个 cue 清洗后不可读，会只跳过那个 cue；只有整段都不可读时才保留原声且不生成字幕
- 如果模型返回了比 edit-friendly bounds 短得多的 `selection.sourceInMs / sourceOutMs`，系统会先做 clamp/保守扩回，避免再次无意识裁到过短

### Step 5 [Subagent: beat-writer]: 存储

```typescript
await writeJson(join(projectRoot, 'script/current.json'), scriptSegments);
```

这里的正式作者是 `[subagent: beat-writer]`。
`[main agent]` 只负责在 reviewer 通过后推进到这个步骤；如果是 Console / Supervisor 的 `script` job，不应写这个文件。

### Step 6 [Main Agent]: 迭代微调（可选）

```typescript
// 修改某段旁白
const updated = updateNarration(segments, segId, '新的旁白');

// 重新排序
const reordered = reorderSegments(segments, ['id3', 'id1', 'id2']);

// 删除段落
const trimmed = removeSegment(segments, segId);
```

## 产出

| 文件 | 格式 | 内容 |
|------|------|------|
| `script/current.json` | `IKtepScript[]` | 完整脚本（含 beat / 必要旁白） |

## 创作指南（适用于 `[subagent: brief-editor]`、`[subagent: segment-architect]`、`[subagent: route-slot-planner]`、`[subagent: beat-writer]`）

`[subagent: brief-editor]`、`[subagent: segment-architect]`、`[subagent: route-slot-planner]`、`[subagent: beat-writer]` 写 script / beat 相关产物时应遵守：

1. **人称/语气**：严格按照风格档案中的设定（第一人称？平实？感性？）
2. **旁白克制**：优先使用有效原声；只有无可用原声的视频才补必要旁白，照片不要补写旁白
3. **风格禁区**：风格档案中列出的禁止表达方式绝对不用
4. **证据驱动**：旁白应基于切片证据（场景描述、地点线索、ASR 文本），不要凭空编造
5. **节奏**：开篇引人入胜，主体循序渐进，结尾收束有力，但不要为了时长预算硬做压缩或填充
6. **原声判断**：不要把“素材里有人说话”和“这段就该静音旁白”画等号；只要原话本身有价值，粗剪默认应保留
7. **照片处理**：照片默认是一秒静默信息点；只有显式 `holdMs` 才应拉长
8. **直接消费 style 参数**：优先使用风格档案里已经明确写出的节奏阶段、素材角色、运镜语言、功能位和禁区，不要把这些又退回成纯主观猜测

## 备选路径

仓库里仍保留了一些脚本生成 helper，供 `[main agent]` 在手动协调阶段按需调用。
但当前正式流程不是“Console 后台自动写稿”，而是“Console 准备，subagent 创作”。
