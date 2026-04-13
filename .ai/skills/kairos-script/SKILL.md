---
name: kairos-script
description: >-
  Phase 3: Load style profile, build narrative outline from spans, and write
  narration for each segment. The agent writes narration directly using its own
  LLM capabilities. Use when writing script, narration, voiceover, or the user
  mentions script, story, or narrate.
---

# Kairos: Phase 3 — Script

加载风格档案 → `/script` 自动保存风格分类 → Agent 生成初版 `script-brief` → 用户审查并手动保存 brief → `/script` 做 deterministic prep → Agent 写正式脚本。

**核心特点**：旁白由 agent 自身直接创作，不需要外部 LLM API。

当前正式 script prep 链路已经切成：
- `Analyze -> Material Overview`
- `Material Overview + Script Brief + arrangementStructure + narrationConstraints -> Segment Plan`
- `Segment Plan -> Material Slots -> Bundle Lookup -> Chosen SpanIds -> Beat / Script`

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
- 风格档案必须由用户人工指定；系统不能根据当前项目素材自动生成、自动挑选或自动推断风格档案。
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

### Step 1: 加载风格档案

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
Agent 可以列出可用档案供用户选择，但不能自行替用户决定，也不能根据当前素材自动生成一份“临时风格档案”。

当前 Console 的正式口径是：
- workspace 风格库维护在 `/style`
- Script 页先选择 `styleCategory`，并立即自动保存
- 关键 handoff 会通过持续可见的 workflow prompt 与 hana modal 明确提示“下一步回到 Agent / 点击准备”，而不是只靠轻量行内提示
- `script/script-brief.json` 内部继续保存 `categoryId`
- `script/script-brief.md` 可以显示友好名称，但不能替代内部 `categoryId`

**注意 `guidancePrompt`**：如果风格档案包含用户指导词（`style.guidancePrompt`），
agent 在创作旁白时应将其作为额外的创作指导。

### Step 2: 先让用户在 `/script` 指定风格，再由 Agent 起草 Script Brief

当前正式口径分两层：

- `/script` 页负责脚本阶段的流程入口与人工审查面
- Agent 负责起草初版 brief 与正式脚本写作

正式顺序固定为：

1. 用户在 `/script` 选择 `styleCategory`，选择后立即自动保存
2. Agent 读取 style profile、spans、chronology、asset reports、Pharos context，生成 `script/material-overview.md` 与初版 `script-brief`
3. 用户回到 `/script` 审查并手动保存 brief
4. `/script` 会用更显眼的 workflow prompt / modal 提示用户点击 `准备给 Agent`
5. Console 校验前置条件并刷新 `script/material-overview.facts.json` 与 `analysis/material-bundles.json`
6. Agent 再继续写正式 `script/current.json`

Console prep 不允许做的事：
- 自动起草初版 `script-brief`
- 自动写 `script/current.json`
- 自动批准 `segment plan`
- 自动生成并推进 `outline`

Agent 起草初版 brief 时，应根据：
- `analysis/asset-reports/*.json`
- `media/chronology.json`
- `store/spans.json`
- 风格档案

Agent 起草 brief 时，不要只总结“语气是什么”，还应把当前选中的风格分类归纳成更可执行的拍法提示，例如：
- 片头 / montage 应该按哪些节奏阶段推进
- `aerial / timelapse / drive / talking-head / broll / nat sound` 各自在当前风格里承担什么角色
- 哪些镜头语法更适合 `开场建场 / 地理重置 / 情绪释放`
- 明确的素材禁区 / 镜头禁区是什么

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

如果用户已经修改过当前 brief，而又想让 Agent 重新生成一版初稿：

- Agent 不能静默覆盖
- 正式路径是让用户回到 `/script` 点击 `重新生成初版 brief`
- 覆盖确认必须在 UI 中通过 hana modal 显式完成；确认后，下一次 Agent 才允许覆盖

**重要规则**：
- `material overview` 采用文档型输入，结构化事实底稿写入 `script/material-overview.facts.json`。
- `segment plan`、`material slots`、`outline` 和 `script/current.json` 都应视为 Agent 阶段产物，不再由 Console prep 自动生成。
- `script/script-brief.json.workflowState` 是脚本阶段的正式流程真值；Agent 应根据它判断当前该做“提示选风格 / 起草 brief / 等待用户审查 / 写正式脚本”中的哪一步。

### Step 3: Agent 生成 Segment Plan 与 Material Slots

```typescript
const spans = await readJson('store/spans.json', z.array(IKtepSlice));
```

当前需要注意的 span 语义：

- `span.sourceInMs / sourceOutMs` 是 focus/evidence window
- `span.editSourceInMs / editSourceOutMs` 是 Analyze 已经扩好的 edit-friendly bounds
- `span.materialPatterns[]` 是材料模式短语
- `material-bundles` 只用作 `materialPatterns` 驱动的粗索引层
- `segment plan` 只保留段落本体：`id`、`title`、`intent`、`targetDurationMs`、可选 `roleHint` / `notes`
- `material slots` 只保留运行时薄检索信息：`id`、`query`、`requirement`、`targetBundles`、`chosenSpanIds`
- 当前 Script 执行层还会基于现有 style profile 解析一个内部 `ResolvedArrangementSignals`：
  - 它不是新的公开协议
  - 它只用于判断当前风格主轴更偏时间推进、空间推进、情感推进还是结果回看
  - 如果 style 明确强调 `chronology / route continuity / continuous process`，顺时序会成为正式执行约束，而不是只有 prompt 偏好

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
- `targetDurationMs` 不应再主要从 style 平均章节时长直接拍脑袋得出：
  - 先看这一段实际能承载多少关键过程视频、多少可保留原声、多少结果照片组、多少事件节点
  - style 只继续调节节奏与上下限

生成 `material slots` 时，遵循：

- `segment intent -> slot query -> targetBundles -> bundle lookup -> chosenSpanIds`
- bundle 命中后，再按 time / GPS / chronology / Pharos day-shot 线索做二次过滤
- `chosenSpanIds` 是 retrieval 的正式结果回写位
- 对时间主轴强的风格，二次过滤必须服从时间带窗口；局部打分只能在当前窗口里择优，不能跨窗乱拿素材
- 关键过程视频如果承载不可替代的时间推进、事件推进、人物关系推进或有效原声，应保留为独立 beat，不要让它被更泛的 summary 段或静态成果材料吞掉

### Step 4: Agent 直接写旁白

**这是 agent 发挥创意的核心环节。**

Agent 需要：

1. 阅读完整风格档案（`style.rawReference` 或 `buildStylePrompt(style)`），并优先提取其中的 sections / parameters / antiPatterns
2. 理解叙事骨架的每个段落（`buildOutlinePrompt(outline)`）
3. 查看每个段落关联的切片证据（scene descriptions, ASR text, place hints）
4. 为每个段落写旁白，严格遵循风格档案

对于 `intro / montage / transition` 这类高度依赖镜头组织的段落，优先按下面顺序消费风格信息：

1. 先看节奏阶段与功能位参数
2. 再看素材角色参数
3. 再看运镜 / 镜头语言章节
4. 最后才让自由创作去填具体措辞与细节

输出格式 — 每个段落一个 `IKtepScript`：

```typescript
const scriptSegment: IKtepScript = {
  id: randomUUID(),
  role: 'scene',           // 'intro' | 'scene' | 'transition' | 'highlight' | 'outro'
  title: '段落标题',
  narration: '旁白文本...',
  targetDurationMs: 30000,  // 预计时长
  linkedSliceIds: ['slice-id-1', 'slice-id-2'],
};
```

正式输出时，`beat` 是更重要的编排单元：
- `beat.text` 表示这一小拍最终要落到字幕/朗读层的文字
- 如果一个 beat 内本来就有多段配音与停顿，可额外提供 `beat.utterances?: Array<{ text, pauseBeforeMs?, pauseAfterMs? }>`
- `beat.actions?.preserveNatSound = true` 表示这拍要尽量保留原声
- `beat.actions?.muteSource = true` 表示这拍即使素材里有人声，也应静音后改走旁白
- `beat.actions?.speed = number` 只在你明确要做速度蒙太奇时使用；它现在是显式 retime 请求，不应用“裁很短的 source”去间接制造
- `actions.speed` 只应该写给本质上是 `drive / aerial` montage 的 beat；混入 `talking-head / broll / shot / timelapse / photo / unknown` 时，不要给整拍写 speed

### Step 4.5: 原声与旁白的协同规则

脚本阶段不需要把“是否保留原声”全部手工写死，但要理解下游的默认行为：

- 如果候选切片里有明确 transcript，且这段原话本身值得直接进入正片，优先写成贴近原话的 `beat.text`，并显式设置 `preserveNatSound=true`
- 对于 `preserveNatSound=true` 的 beat，优先只绑定一个主讲话 selection，并确保选区覆盖完整一句 `transcriptSegments`，不要切在句中
- 如果一个有声音的素材主要承担 `intro / transition / 铺垫 / 空间建立 / 情绪过门`，而不是要直接使用它说的话，应显式设置 `muteSource=true`，让下游走旁白
- 如果这拍旁白在头部 / 中间 / 尾部需要明确留白，不要只把话全塞进 `beat.text`；应直接写 `beat.utterances[]` 把 pause 表达出来
- 如果候选 beat 提示了 `speedCandidate`（例如 `2x / 5x / 10x`），把它理解为“可以考虑加速”，而不是默认必须加速；只有你明确想做速度段落时才填写 `actions.speed`
- 如果一条原声完整句子明显长于当前 beat 预算，默认优先保句子完整；下游会延长 beat，而不是把原话切断
- 如果脚本里没有显式写这两个动作，时间线阶段会根据 `slice.transcript / transcriptSegments / speechCoverage`、`beat.text` 与 transcript 的匹配度、以及 segment role 自动推论
- 当前默认推论是偏保守的：`intro / transition / outro` 不会因为“素材里有声音”就自动保留原声，除非 beat 明显在引用原话
- 对于 `muteSource=true` 或被时间线判定为不走原声的 beat，下游会把命中的带音轨视频静音，避免旁白与素材原音叠在一起
- 如果模型返回了比 outline fallback 窗口短得多的 `selection.sourceInMs / sourceOutMs`，系统会先做 clamp/保守扩回，避免再次无意识裁到过短

### Step 5: 存储

```typescript
await writeJson(join(projectRoot, 'script/current.json'), scriptSegments);
```

这里的正式作者是 **Agent**。
如果是 Console / Supervisor 的 `script` job，不应写这个文件。

### Step 6: 迭代微调（可选）

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
| `script/current.json` | `IKtepScript[]` | 完整脚本（带旁白） |

## 创作指南

Agent 写旁白时应遵守：

1. **人称/语气**：严格按照风格档案中的设定（第一人称？平实？感性？）
2. **旁白密度**：与段落时长匹配，避免过密或过疏
3. **风格禁区**：风格档案中列出的禁止表达方式绝对不用
4. **证据驱动**：旁白应基于切片证据（场景描述、地点线索、ASR 文本），不要凭空编造
5. **节奏**：开篇引人入胜，主体循序渐进，结尾收束有力
6. **原声判断**：不要把“素材里有人说话”和“这段就该保留原声”画等号；很多带人声的 intro / 过门素材仍然应静音换旁白
7. **直接消费 style 参数**：优先使用风格档案里已经明确写出的节奏阶段、素材角色、运镜语言、功能位和禁区，不要把这些又退回成纯主观猜测

## 备选路径

仓库里仍保留了一些脚本生成 helper，供 Agent 手动阶段按需调用。
但当前正式流程不是“Console 后台自动写稿”，而是“Console 准备，Agent 创作”。
