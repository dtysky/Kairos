---
name: kairos-script
description: >-
  Phase 3: Load style profile, build narrative outline from slices, and write
  narration for each segment. The agent writes narration directly using its own
  LLM capabilities. Use when writing script, narration, voiceover, or the user
  mentions script, story, or narrate.
---

# Kairos: Phase 3 — Script

加载风格档案 → 构建叙事骨架 → 为每个段落写旁白。

**核心特点**：旁白由 agent 自身直接创作，不需要外部 LLM API。

## 前置条件

- `store/slices.json` 存在且非空
- 风格档案可用（`test/style-profile.md` 或用户指定的文件）

## 可用工具

```typescript
// 从 markdown 文件加载风格档案
loadStyleFromMarkdown(filePath: string, name?: string): Promise<IStyleProfile>

// 构建叙事骨架：切片 → 段落结构
buildOutline(slices: IKtepSlice[], targetDurationMs: number): IOutlineSegment[]
// IOutlineSegment = { role, title, sliceIds, evidence, estimatedDurationMs }

// 生成风格提示词（供 agent 参考）
buildStylePrompt(style: IStyleProfile): string

// 生成骨架提示词（供 agent 参考）
buildOutlinePrompt(outline: IOutlineSegment[]): string

// 脚本编辑工具
reorderSegments(segments: IKtepScript[], order: string[]): IKtepScript[]
updateNarration(segments: IKtepScript[], segmentId: string, narration: string): IKtepScript[]
removeSegment(segments: IKtepScript[], segmentId: string): IKtepScript[]
insertSegment(segments: IKtepScript[], afterId: string | null, segment: IKtepScript): IKtepScript[]
```

## 工作流程

### Step 1: 加载风格档案

```typescript
const style = await loadStyleFromMarkdown('test/style-profile.md');
```

风格档案包含：叙事结构、语言风格、情绪表达、主题价值观、风格禁区等。

### Step 2: 构建叙事骨架

```typescript
const slices = await readJson('store/slices.json', z.array(IKtepSlice));
const outline = buildOutline(slices, 5 * 60 * 1000); // 目标 5 分钟
```

骨架结构：
- `intro`（约 10%）→ 开篇
- `scene` / `highlight`（约 80%）→ 主体段落
- `outro`（约 5%）→ 结尾

### Step 3: Agent 直接写旁白

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

### Step 4: 存储

```typescript
await writeJson(join(projectRoot, 'script/current.json'), scriptSegments);
```

### Step 5: 迭代微调（可选）

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

## 备选路径

如果需要用外部 LLM API（非 agent 模式），可以使用：

```typescript
import { generateScript } from 'kairos';
const script = await generateScript(llmClient, outline, style);
```

这需要配置 `OpenAIClient`，不是主推流程。
