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
    expectedRowCount?: unknown;
    validationFeedback?: unknown;
  } | undefined;
  const items = Array.isArray(content?.items) ? content.items : [];
  const expectedRowCount = typeof content?.expectedRowCount === 'number'
    ? content.expectedRowCount
    : items.length;
  const validationFeedback = Array.isArray(content?.validationFeedback)
    ? content.validationFeedback
    : [];
  if (validationFeedback.length > 0 && expectedRowCount === 1) {
    return buildFocusedSingleItemCorrectionPrompt({
      item: items[0],
      validationFeedback,
      attempt: content?.attempt,
    });
  }
  return [
    buildSpanMaterializationReviewSystemPrompt(),
    '',
    '本地 text-LM 输出补充要求：',
    '- 只输出一行顶层 JSON 数组，格式：[["拍摄视角/构图形态","当前环境","天气光线","口播语音","情景故事","自由标签1","自由标签2"], ...]。',
    `- 顶层数组长度必须正好是 expectedRowCount=${expectedRowCount}；如果 expectedRowCount=1，只能返回一个内层 string[]，不得补写其它历史 item。`,
    '- 不要输出 {items: ...}，不要输出 id，不能加 Markdown 代码块。',
    '- 如果 validationFeedback 非空，必须逐条修正反馈中列出的 slot；反馈只描述输出协议错误，不提供新的画面事实。',
    `attempt: ${String(content?.attempt ?? 1)}`,
    `expectedRowCount: ${expectedRowCount}`,
    `items: ${JSON.stringify(items)}`,
    validationFeedback.length > 0
      ? `validationFeedback: ${JSON.stringify(validationFeedback)}`
      : '',
  ].join('\n');
}

function buildFocusedSingleItemCorrectionPrompt(input: {
  item: unknown;
  validationFeedback: unknown[];
  attempt: unknown;
}): string {
  const schema = buildSpanMaterializationReviewOutputSchema();
  return [
    '你是 span materialPatterns 的单行 JSON 纠错器。',
    '任务：根据当前 item 与机器校验结果，重新生成一行满足固定 schema 的完整数据。',
    '事实边界：只能使用 currentItem 的 type、semanticKind、transcript、transcriptSegments、visualObservation；不能决定 speech keep/drop、裁切或 visual-only。',
    `attempt: ${String(input.attempt ?? 1)}`,
    `currentItem: ${JSON.stringify(input.item ?? {})}`,
    `validationFeedback: ${JSON.stringify(input.validationFeedback)}`,
    `schema: ${JSON.stringify(schema)}`,
    '约束：顶层和内层数组均只有一行；该行恰好七个非空中文短标签；slot 4 等于 validationFeedback.expectedSpeechTag；slot 6 与 slot 7 互异且不重复前五项。',
    '修正 validationFeedback 指出的字段并返回完整行。只输出 JSON，不要解释或 Markdown。',
  ].join('\n');
}
