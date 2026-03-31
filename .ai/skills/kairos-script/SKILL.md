---
name: kairos-script
description: >-
  Phase 3: Load style profile, build narrative outline from slices, and write
  narration for each segment. The agent writes narration directly using its own
  LLM capabilities. Use when writing script, narration, voiceover, or the user
  mentions script, story, or narrate.
---

# Kairos: Phase 3 — Script

加载风格档案 → 结合全量素材归纳自动起草 brief → 用户审查段落方案 → 为每个段落写旁白。

**核心特点**：旁白由 agent 自身直接创作，不需要外部 LLM API。

## 前置条件

- `store/slices.json` 存在且非空
- 风格档案可用（以下方式任选其一）：
  - 分类档案：`config/styles/{category}.md`（由 [kairos-style-analysis](../kairos-style-analysis/SKILL.md) 生成）
  - 单一档案：`config/style-profile.md`
  - 手写样板：`test/style-profile.md`
  - 如果还没有风格档案，先执行 [kairos-style-analysis](../kairos-style-analysis/SKILL.md)

**硬性规则**：
- 风格档案必须由用户人工指定；系统不能根据当前项目素材自动生成、自动挑选或自动推断风格档案。
- 如果用户没有明确指定某个风格档案，或没有明确说这次不用风格档案，Script 阶段必须暂停并先向用户确认。
- `kairos-style-analysis` 只能在用户明确要求做风格分析时执行，不能作为 Script 的隐式前置步骤自动触发。

## 可用工具

```typescript
// 从 markdown 文件加载风格档案
loadStyleFromMarkdown(filePath: string, options?: IStyleLoadOptions): Promise<IStyleProfile>

// 按分类名加载风格档案
loadStyleByCategory(stylesDir: string, category: string): Promise<IStyleProfile | null>

// 列出所有可用的风格分类
listStyleCategories(stylesDir: string): Promise<IStyleCatalogEntry[]>

// 构建叙事骨架：切片 → 段落结构
buildOutline(slices: IKtepSlice[], targetDurationMs: number): IOutlineSegment[]
// IOutlineSegment = { role, title, sliceIds, evidence, estimatedDurationMs }

// 生成风格提示词（供 agent 参考）
buildStylePrompt(style: IStyleProfile): string

// 生成骨架提示词（供 agent 参考）
buildOutlinePrompt(outline: IOutlineSegment[]): string

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
const categories = await listStyleCategories('config/styles');
// 展示可用分类给用户选择，或由用户直接指定
const style = await loadStyleByCategory('config/styles', 'travel-doc');

// 方式 2：加载单一档案（兜底）
const style = await loadStyleFromMarkdown('config/style-profile.md');

// 方式 3：加载手写样板
const style = await loadStyleFromMarkdown('test/style-profile.md');
```

风格档案包含：叙事结构、语言风格、情绪表达、主题价值观、风格禁区等。
来源可以是 `kairos-style-analysis` 自动生成，也可以是人工编写。

这里的关键前提是：**使用哪一份风格档案，必须由用户手动指定。**
Agent 可以列出可用档案供用户选择，但不能自行替用户决定，也不能根据当前素材自动生成一份“临时风格档案”。

**注意 `guidancePrompt`**：如果风格档案包含用户指导词（`style.guidancePrompt`），
agent 在创作旁白时应将其作为额外的创作指导。

### Step 2: 自动起草 Script Brief（不要让用户从空白填写）

系统应先根据：
- `analysis/asset-reports/*.json`
- `media/chronology.json`
- `store/slices.json`
- 风格档案

自动写出一份集中式：

```text
script/script-brief.md
```

这份 brief 至少要包含：
- 全片目标建议
- 叙事约束建议
- 段落方案审查建议
- 每段的简单备注

用户的职责是**审查和修改这份初稿**，而不是从空白开始手写所有内容。

**重要规则**：
- `material digest` 可以由代码基于素材统计、chronology 和 asset reports 构建。
- 但 `segment plan drafts` 必须由 LLM 主驱动生成，不能默认用启发式规则硬拆段落。
- 启发式规划只允许作为 fallback：例如 LLM 不可用、返回非法 JSON、或明确要求离线保底时。
- 如果当前段落方案明显是规则硬驱动的“平均分段”或“标签直推分段”，应视为不合格，需要回退到 LLM 重新生成。

### Step 3: 构建叙事骨架

```typescript
const slices = await readJson('store/slices.json', z.array(IKtepSlice));
const outline = buildOutline(slices, 5 * 60 * 1000); // 目标 5 分钟
```

骨架结构：
- `intro`（约 10%）→ 开篇
- `scene` / `highlight`（约 80%）→ 主体段落
- `outro`（约 5%）→ 结尾

### Step 4: Agent 直接写旁白

**这是 agent 发挥创意的核心环节。**

Agent 需要：

1. 阅读完整风格档案（`style.rawReference` 或 `buildStylePrompt(style)`）
2. 理解叙事骨架的每个段落（`buildOutlinePrompt(outline)`）
3. 查看每个段落关联的切片证据（scene descriptions, ASR text, place hints）
4. 为每个段落写旁白，严格遵循风格档案

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
- `beat.actions?.preserveNatSound = true` 表示这拍要尽量保留原声
- `beat.actions?.muteSource = true` 表示这拍即使素材里有人声，也应静音后改走旁白

### Step 4.5: 原声与旁白的协同规则

脚本阶段不需要把“是否保留原声”全部手工写死，但要理解下游的默认行为：

- 如果候选切片里有明确 transcript，且这段原话本身值得直接进入正片，优先写成贴近原话的 `beat.text`，并显式设置 `preserveNatSound=true`
- 如果一个有声音的素材主要承担 `intro / transition / 铺垫 / 空间建立 / 情绪过门`，而不是要直接使用它说的话，应显式设置 `muteSource=true`，让下游走旁白
- 如果脚本里没有显式写这两个动作，时间线阶段会根据 `slice.transcript / transcriptSegments / speechCoverage`、`beat.text` 与 transcript 的匹配度、以及 segment role 自动推论
- 当前默认推论是偏保守的：`intro / transition / outro` 不会因为“素材里有声音”就自动保留原声，除非 beat 明显在引用原话

### Step 5: 存储

```typescript
await writeJson(join(projectRoot, 'script/current.json'), scriptSegments);
```

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

## 备选路径

如果需要用外部 LLM API（非 agent 模式），可以使用：

```typescript
import { generateScript } from 'kairos';
const script = await generateScript(llmClient, outline, style);
```

这需要配置 `OpenAIClient`，不是主推流程。
