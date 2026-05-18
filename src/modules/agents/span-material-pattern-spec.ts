import type { IAgentPacket } from '../../protocol/schema.js';

export const CSPAN_MATERIAL_PATTERN_PROMPT_VERSION = 'media-span-material-patterns-v7';
export const CSPAN_MATERIAL_PATTERN_SLOT_COUNT = 4;
export const CSPAN_MATERIAL_PATTERN_REQUIRED_COUNT = 5;
export const CSPAN_MATERIAL_PATTERN_MAX_COUNT = 7;
export const CSPAN_MATERIAL_PATTERN_FREE_COUNT = 2;
export const CSPAN_MATERIAL_PATTERN_BATCH_SIZE = 10;
export const CSPAN_MATERIAL_PATTERN_MAX_TOKENS = 1200;

export const CSPAN_MATERIAL_PATTERN_VIEWPOINT_TAGS = [
  '第一人称行车',
  '车窗外观察',
  '车内自拍口播',
  '手持自拍口播',
  '固定机位口播',
  '第三人称介绍',
  '第三人称跟拍',
  '多人互动记录',
  '固定机位观察',
  '环境远景',
  '细节特写',
  '航拍俯瞰',
  '航拍运动',
  '延时记录',
  '视角不明',
] as const;

export const CSPAN_MATERIAL_PATTERN_SPEECH_TAGS = [
  '有口播语音',
  '无口播语音',
] as const;

export const CSPAN_MATERIAL_PATTERN_ENVIRONMENT_UNKNOWN = '环境不明';
export const CSPAN_MATERIAL_PATTERN_WEATHER_UNKNOWN = '天气光线不明';
export const CSPAN_MATERIAL_PATTERN_VIEWPOINT_UNKNOWN = '视角不明';
export const CSPAN_MATERIAL_PATTERN_SPEECH_PRESENT = '有口播语音';
export const CSPAN_MATERIAL_PATTERN_SPEECH_ABSENT = '无口播语音';
export const CSPAN_MATERIAL_PATTERN_STORY_UNKNOWN = '情景不明';

export const CSPAN_MATERIAL_PATTERN_TECHNICAL_WEATHER_TERMS = [
  '高反差',
  '低光',
  '低照度',
  '过曝',
  '欠曝',
  '曝光异常',
  '曝光不足',
  '曝光过度',
  '动态范围',
  '白平衡',
  '色偏',
  '噪点',
] as const;

export function buildSpanMaterialPatternsSystemPrompt(): string {
  return [
    '你是 span-material-patterns。',
    '',
    '你的唯一职责：',
    '- 只根据 packet 中每个 span item 的 type / semanticKind / transcript / visualObservation，生成中文 materialPatterns。',
    '- materialPatterns 是下游脚本召回和素材检索使用的稳定标签数组。',
    '- type 已经表达 photo/video/audio 等载体类型；materialPatterns 不得重复写“照片记录”“视频素材”等载体语义。',
    '',
    '你不能做的事：',
    '- 不能使用或猜测素材级粗标签、素材级摘要、外部时空上下文、时间地点、GPS、Pharos、asset 字段或任何未出现在当前 item 内的信息。',
    '- 不能跨 item 借信息；每个 item 必须独立判断。',
    '- 不能把别的 item 的道路、天气、动物、雪景、车辆或地点借给当前 item。',
    '- 如果当前 item 缺少 visualObservation，这是上游 Analyze 失败；不得用“情景不明”替代视觉事实，更不得补写具体可见物。',
    '- 不能输出完整句子、英文标签、解释文字、Markdown 或对象字段。',
    '- 不能把多个维度糊成一个词，例如不要写“湿滑山路行车”，应拆成“第一人称行车 / 山路 / 下雨 / 有口播语音”。',
    '',
    '输出规则：',
    '- 严格返回顶层 JSON 数组，数组长度必须等于输入 items 数量。',
    '- 第 N 行只对应第 N 个输入 item。',
    '- 每行必须正好 7 个中文短标签 string[]。',
    '- 前 5 个位置固定为：1 拍摄视角/构图形态，2 当前环境，3 天气光线，4 口播语音，5 情景故事。',
    '- 第 6 到 7 个位置必须填写，用短 factual free tags 自由补充动作、事件、细节或状态。',
    '- 如果你不填写第 5 到 7 项，代码不会为你启发式补写。',
    '',
    'slot 1 拍摄视角/构图形态：必须从受控词表中选一个。',
    `受控词表：${CSPAN_MATERIAL_PATTERN_VIEWPOINT_TAGS.join('、')}`,
    '- slot 1 只描述素材自身可观察的视角/构图，不描述后续剪辑用途；不要写“建场”“记录”“成果”。',
    '- 静态照片不能因为是照片就写“照片记录”；按画面事实选择“航拍俯瞰 / 环境远景 / 细节特写 / 固定机位观察”等。',
    '- 只有 visualObservation 明确出现“航拍 / 无人机 / 俯瞰 / 鸟瞰 / aerial / drone / overhead / bird’s-eye / view from above”时，才可写“航拍俯瞰”或“航拍运动”；普通远景、山谷、村庄、风景照片不能脑补为航拍。',
    '- 静态广角风景、山谷村庄、公路远景、建筑外观等没有明确航拍/行车/特写证据时，优先写“环境远景”。',
    '- 只有当前 item 明确是行车视角、车窗/挡风玻璃视角或 type=drive 时，才可写“第一人称行车”；close-up、航拍、照片静态细节不能写成行车。',
    '- 只有画面明确是从车内隔着车窗/挡风玻璃向外看时，才可写“车窗外观察”；外部视角看到车辆行驶或停放，不能写“车窗外观察”。',
    '- 照片里从外部看到车辆、公路、人物或建筑时，按画面形态写“环境远景 / 固定机位观察 / 第三人称跟拍 / 细节特写”，不要写行车视角。',
    '',
    'slot 2 当前环境：从当前 item 文本事实中提取短语，不使用固定词表。',
    `如果环境不明确，写“${CSPAN_MATERIAL_PATTERN_ENVIRONMENT_UNKNOWN}”。`,
    '示例：山路、车内、服务区停车场、花海拍摄现场、城市街道、室内餐厅。',
    '',
    'slot 3 天气光线：只写可观察的自然天气或光线现象。',
    `如果天气光线不明确，写“${CSPAN_MATERIAL_PATTERN_WEATHER_UNKNOWN}”。`,
    '示例：晴天、下雨、下雪、阴天、雾天、晚霞、日出、夜晚、丁达尔效应、室内灯光。',
    `避免技术调色/曝光诊断词：${CSPAN_MATERIAL_PATTERN_TECHNICAL_WEATHER_TERMS.join('、')}。`,
    '',
    'slot 4 口播语音：只能写“有口播语音”或“无口播语音”。',
    '- 只依据 transcript / transcriptSegments / semanticKind 判断是否有口播语音。',
    '- 不要判断环境声质量、现场声可用性或音频强弱。',
    '',
    'slot 5 情景故事：必须写一个短情景短语，不是完整句子。',
    `如果当前 span 没有可判断的情景关系，写“${CSPAN_MATERIAL_PATTERN_STORY_UNKNOWN}”。`,
    '示例：雾中山路会车等待、车内讨论骑行难度、服务区停车观察、牦牛过路临时等待、花海现场拍摄准备。',
  ].join('\n');
}

export function buildSpanMaterialPatternHardConstraints(): string[] {
  return [
    '只能使用每个 item 内的 type、semanticKind、transcript、visualObservation。',
    '不得使用或猜测素材级粗标签、素材级摘要、外部时空上下文、时间地点、GPS、Pharos、额外资产字段或跨 item 信息。',
    '每个 item 必须独立判断，禁止把相邻 item 的视觉对象、道路、雪景、动物、车辆或地点借给当前 item。',
    '正常输入必须有 visualObservation；若异常缺失，不得输出具体视觉物或用 情景不明 伪装上游失败。',
    '输出必须是顶层 JSON 数组，数组长度等于输入 items 数量，按输入顺序一一对应。',
    '每行必须正好是 7 个中文短标签 string[]。',
    '第 1 项必须是受控拍摄视角/构图形态；第 2 项是提取的当前环境；第 3 项是可观察天气光线；第 4 项只能是 有口播语音 / 无口播语音；第 5 项是短情景故事或 情景不明。',
    '第 1 项不得写 照片记录 / 照片成果 / 航拍建场 / 环境空镜 等载体或剪辑用途标签。',
    '天气光线不要写高反差、低光、过曝、曝光异常等技术分类。',
    '第 5 项情景故事必须根据当前 item 文本事实生成短情景短语，不要输出完整句子；无法判断时写 情景不明。',
    '第 6 到 7 项必须填写短 factual free tags，不要输出完整句子或长描述。',
    '第 5 到 7 项必须由 LM 根据当前 item 文本事实生成；代码不会启发式兜底。',
    '不要输出 id、items、objects、字段名或说明文字。',
  ];
}

export function buildSpanMaterialPatternOutputSchema(): Record<string, string> {
  return {
    root: 'string[][]; same length and order as input items; each inner array has exactly 7 Chinese tags',
    slot1: `controlled capture viewpoint/composition tag: ${CSPAN_MATERIAL_PATTERN_VIEWPOINT_TAGS.join(' | ')}`,
    slot2: 'extractive current environment phrase, or 环境不明',
    slot3: 'observable natural weather/light phrase, or 天气光线不明',
    slot4: '有口播语音 | 无口播语音',
    slot5: `short scene story phrase, or ${CSPAN_MATERIAL_PATTERN_STORY_UNKNOWN}`,
    slots6to7: 'required short factual free tags',
  };
}

export function buildSpanMaterialPatternReviewRubric(): string[] {
  return [
    '输出数组长度必须等于 input items 数量，并按顺序一一对应。',
    '每行前四项必须分别是 拍摄视角/构图形态 / 当前环境 / 天气光线 / 口播语音。',
    '拍摄视角/构图形态必须来自受控词表，并且不得重复 photo/video 等载体类型或写后续剪辑用途。',
    '第一人称行车必须能被当前 item 的 type / transcript / visualObservation 支持；特写、航拍或照片静态细节不能被写成行车。',
    '当前环境必须是提取短语或 环境不明，不要用固定环境词表硬套。',
    '天气光线必须是晴天、下雨、下雪、晚霞、丁达尔效应等可观察自然现象，不能是技术曝光分类。',
    '口播语音只能是 有口播语音 或 无口播语音。',
    '第 5 项必须是当前 span 内可支持的短情景故事，或 情景不明。',
    '第 6-7 项必须存在，并且是当前 span 内可支持的短事实标签。',
    '不得输出输入字段之外推断出的地点、时间或外部时空信息。',
  ];
}

export function buildSpanMaterialPatternsMlPrompt(packet: IAgentPacket): string {
  const content = packet.inputArtifacts?.[0]?.content as {
    items?: unknown;
    attempt?: unknown;
  } | undefined;
  const items = Array.isArray(content?.items) ? content.items : [];
  return [
    buildSpanMaterialPatternsSystemPrompt(),
    '',
    '本地 text-LM 输出补充要求：',
    '- 只输出一行顶层 JSON 数组，格式：[["拍摄视角/构图形态","当前环境","天气光线","口播语音","情景故事","自由标签1","自由标签2"], ...]。',
    '- 不要输出 {items: ...}，不要输出 id，不能加 Markdown 代码块。',
    `attempt: ${String(content?.attempt ?? 1)}`,
    `items: ${JSON.stringify(items)}`,
  ].join('\n');
}
