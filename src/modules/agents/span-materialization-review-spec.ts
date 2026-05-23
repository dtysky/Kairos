import type { IAgentPacket } from '../../protocol/schema.js';
import {
  buildSpanMaterialPatternsSystemPrompt,
  buildSpanMaterialPatternHardConstraints,
  buildSpanMaterialPatternReviewRubric,
  buildSpanMaterialPatternOutputSchema,
} from './span-material-pattern-spec.js';

export const CSPAN_MATERIALIZATION_REVIEW_PROMPT_VERSION = 'media-span-materialization-patterns-v2';
export const CSPAN_MATERIALIZATION_REVIEW_BATCH_SIZE = 8;
export const CSPAN_MATERIALIZATION_REVIEW_MAX_TOKENS = 1800;

export function buildSpanMaterializationReviewSystemPrompt(): string {
  return [
    '你是 span-materialization-patterns。',
    '',
    '职责边界：',
    '- 你只为 span-builder 候选 spans 生成 provisional materialPatterns。',
    '- 你不能决定 speech keep/drop，不能裁切 transcript segments，不能把 speech 转 visual-only。',
    '- 如果 item 是 speech/mixed 或带 transcript，slot 4 可以按候选事实写 有口播语音；最终 speech truth 会由后置 Codex/Agent speech-window review 改写。',
    '',
    buildSpanMaterialPatternsSystemPrompt(),
  ].join('\n');
}

export function buildSpanMaterializationReviewHardConstraints(): string[] {
  return [
    '只能生成 materialPatterns；不得输出裁切、保留、丢弃、visual-only 建议或解释文字。',
    '只能使用每个 item 内的 type、semanticKind、transcript、transcriptSegments、visualObservation。',
    '不得使用素材级摘要、labels、GPS、Pharos、时间地点、assetId、spanId 或跨 item 信息。',
    'speech/mixed 候选的口播可用性不是本 prompt 的职责；不要因为 ASR 噪声而删除候选，也不要声称它已最终可用。',
    ...buildSpanMaterialPatternHardConstraints(),
    ...buildSpanMaterialPatternReviewRubric(),
  ];
}

export function buildSpanMaterializationReviewOutputSchema(): Record<string, string> {
  const materialPatternSchema = buildSpanMaterialPatternOutputSchema();
  return {
    root: 'string[][]; same length and order as input items',
    row: 'string[] materialPatterns only; exactly 7 Chinese tags',
    materialPatterns: 'string[]; exactly 7 Chinese tags for the candidate span; provisional when speech/mixed',
    materialPatternSlot1: materialPatternSchema.slot1,
    materialPatternSlot2: materialPatternSchema.slot2,
    materialPatternSlot3: materialPatternSchema.slot3,
    materialPatternSlot4: materialPatternSchema.slot4,
    materialPatternSlot5: materialPatternSchema.slot5,
    materialPatternSlots6to7: materialPatternSchema.slots6to7,
  };
}

export function buildSpanMaterializationReviewMlPrompt(packet: IAgentPacket): string {
  const content = packet.inputArtifacts?.[0]?.content as {
    items?: unknown;
    attempt?: unknown;
  } | undefined;
  const items = Array.isArray(content?.items) ? content.items : [];
  return [
    buildSpanMaterializationReviewSystemPrompt(),
    '',
    '本地 text-LM 输出补充要求：',
    '- 只输出一行顶层 JSON 数组，格式：[["拍摄视角/构图形态","当前环境","天气光线","口播语音","情景故事","自由标签1","自由标签2"], ...]。',
    '- 不要输出 {items: ...}，不要输出 id，不能加 Markdown 代码块。',
    `attempt: ${String(content?.attempt ?? 1)}`,
    `items: ${JSON.stringify(items)}`,
  ].join('\n');
}
