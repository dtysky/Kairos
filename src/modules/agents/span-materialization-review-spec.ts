import type { IAgentPacket } from '../../protocol/schema.js';
import {
  CSPAN_MATERIAL_PATTERN_ENVIRONMENT_UNKNOWN,
  CSPAN_MATERIAL_PATTERN_STORY_UNKNOWN,
  CSPAN_MATERIAL_PATTERN_TECHNICAL_WEATHER_TERMS,
  CSPAN_MATERIAL_PATTERN_WEATHER_UNKNOWN,
  buildSpanMaterialPatternReviewRubric,
  buildSpanMaterialPatternOutputSchema,
  CSPAN_MATERIAL_PATTERN_VIEWPOINT_TAGS,
} from './span-material-pattern-spec.js';

export const CSPAN_MATERIALIZATION_REVIEW_PROMPT_VERSION = 'media-span-materialization-review-v1';
export const CSPAN_MATERIALIZATION_REVIEW_BATCH_SIZE = 8;
export const CSPAN_MATERIALIZATION_REVIEW_MAX_TOKENS = 1800;

export function buildSpanMaterializationReviewSystemPrompt(): string {
  return [
    '你是 span-materialization-review。',
    '',
    '你的职责：',
    '- 对每个 candidate span 独立审查 speech/mixed 文本是否对成片可用。',
    '- 同时为最终保留的素材 span 生成中文 materialPatterns。',
    '- 你只给候选判断；最终 drop、visual-only、时间收缩和 speech truth 由代码裁决。',
    '',
    '可用口播定义：',
    '- 对观众有信息量的叙述、说明、情绪、人物互动或现场反应。',
    '- 必须剔除：摄像机/手机/相机指令、试麦、等待、单独脏话、无上下文口头反应、路线外杂音、ASR 乱码、通用片尾/字幕平台文本。',
    '- 如果前面一段是开场/介绍/路线说明的试开口，后面用同一话题给出更完整可懂版本，只保留后面的完整版本。',
    '- “拍照/录制/快门/停止录制”作为设备命令时剔除；在完整句子里表达拍摄计划或现场行为时可以保留。',
    '- 单独脏话剔除；脏话与可观察事件组成有信息量的现场情绪时可以保留。',
    '',
    'visual-only 规则：',
    '- 如果没有可用口播，但 visualObservation 明确描述可用视觉画面，可建议 keepVisualOnly=true。',
    '- 如果 visualObservation 为空、不明，或只是“人物对镜头说话/有人说话/口播画面”，必须 keepVisualOnly=false。',
    '- drop 行即使你误填 materialPatterns，代码也会丢弃。',
    '',
    'materialPatterns 生成规则：',
    '- 只根据当前 item 的 type / semanticKind / transcript / transcriptSegments / visualObservation 生成，不得跨 item 借信息。',
    '- materialPatterns 是下游脚本召回和素材检索使用的稳定中文短标签数组。',
    '- 只为最终保留的 span 生成；drop 行必须返回空数组。',
    '- 保留行必须正好 7 项：1 拍摄视角/构图形态，2 当前环境，3 天气光线，4 口播语音，5 情景故事，6-7 factual free tags。',
    '- slot 1 必须来自受控词表；只描述素材自身可观察的视角/构图，不描述 photo/video 载体类型或后续剪辑用途。',
    `- slot 2 是当前环境提取短语；无法判断写 ${CSPAN_MATERIAL_PATTERN_ENVIRONMENT_UNKNOWN}。`,
    `- slot 3 是晴天、下雨、下雪、晚霞、丁达尔效应等可观察自然天气/光线；无法判断写 ${CSPAN_MATERIAL_PATTERN_WEATHER_UNKNOWN}；不得写 ${CSPAN_MATERIAL_PATTERN_TECHNICAL_WEATHER_TERMS.join('、')} 等技术曝光分类。`,
    '- slot 4 只写 有口播语音 / 无口播语音，并且必须与 keepSegmentIndexes / keepVisualOnly 一致。',
    `- slot 5 是短情景故事；无法判断写 ${CSPAN_MATERIAL_PATTERN_STORY_UNKNOWN}。`,
    '- slot 6-7 必须填写当前 span 内可支持的短事实标签；不要输出完整句子。',
    '',
    '输出规则：',
    '- 严格返回顶层 JSON 数组，数组长度必须等于输入 items 数量。',
    '- 第 N 行只对应第 N 个输入 item。',
    '- 每行必须是对象：{"keepSegmentIndexes": number[], "keepVisualOnly": boolean, "materialPatterns": string[] }。',
    '- keepSegmentIndexes 使用输入 transcriptSegments[].index；不得输出不存在的 index。',
    '- 如果 keepSegmentIndexes 非空，materialPatterns 必须正好 7 项，且第 4 项必须是 有口播语音。',
    '- 如果 keepSegmentIndexes 为空且 keepVisualOnly=true，materialPatterns 必须正好 7 项，且第 4 项必须是 无口播语音。',
    '- 如果 keepSegmentIndexes 为空且 keepVisualOnly=false，materialPatterns 必须是 []。',
    `- materialPatterns 第 1 项只能从受控词表选择：${CSPAN_MATERIAL_PATTERN_VIEWPOINT_TAGS.join('、')}`,
  ].join('\n');
}

export function buildSpanMaterializationReviewHardConstraints(): string[] {
  return [
    '只能使用每个 item 内的 type、semanticKind、transcript、transcriptSegments、visualObservation。',
    '不得使用素材级摘要、labels、GPS、Pharos、时间地点、assetId、spanId 或跨 item 信息。',
    'keepSegmentIndexes 只能引用当前 item transcriptSegments[].index。',
    'false start 被后续同话题完整重说替代时，只保留后面的完整表述。',
    '设备指令、试麦、等待、ASR 乱码、无上下文反应不能作为可用口播。',
    '没有可用口播时，只有 visualObservation 明确描述独立可用视觉画面，才可建议 keepVisualOnly=true。',
    'drop 行必须返回 keepSegmentIndexes=[]、keepVisualOnly=false、materialPatterns=[]。',
    ...buildSpanMaterialPatternReviewRubric(),
  ];
}

export function buildSpanMaterializationReviewOutputSchema(): Record<string, string> {
  const materialPatternSchema = buildSpanMaterialPatternOutputSchema();
  return {
    root: 'array; same length and order as input items',
    row: '{ keepSegmentIndexes: number[]; keepVisualOnly: boolean; materialPatterns: string[] }',
    keepSegmentIndexes: '1-based indexes from input transcriptSegments[].index; empty when no usable speech remains',
    keepVisualOnly: 'true only when no usable speech remains and visualObservation independently supports visual material',
    materialPatterns: 'string[]; empty for drop rows; exactly 7 Chinese tags for retained speech or visual-only rows',
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
    '- 只输出一行顶层 JSON 数组，格式：[{"keepSegmentIndexes":[1,2],"keepVisualOnly":false,"materialPatterns":["拍摄视角/构图形态","当前环境","天气光线","口播语音","情景故事","自由标签1","自由标签2"]}, ...]。',
    '- 不要输出 {items: ...}，不要输出 id，不能加 Markdown 代码块。',
    `attempt: ${String(content?.attempt ?? 1)}`,
    `items: ${JSON.stringify(items)}`,
  ].join('\n');
}
