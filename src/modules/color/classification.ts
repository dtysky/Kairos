import type { SolarContext } from './solar-context.js';
import type { ColorTechnicalReport } from './technical-measurement.js';
import type { applyHighContrastScenePolicy } from './high-contrast-measurement.js';

export const COLOR_CATEGORY_LABELS = {
  portrait: '竖屏', presenter: '出镜口播', overexposed: '大面积过曝', noisy: '明显噪点',
  'high-contrast': '逆光／大光比', night: '夜景／低照度', twilight: '清晨／黄昏', 'day-drive-cast': '白天前挡行车', day: '常规日景',
} as const;
export type ColorCategory = keyof typeof COLOR_CATEGORY_LABELS;
export const COLOR_AGENT_POLICY_VERSION = 'color-agent-v1' as const;
export interface ColorAgentSemantic {
  presenter: 'yes' | 'no' | 'uncertain'; viewpoint: string;
  lighting: 'day' | 'night' | 'low-light' | 'twilight' | 'mixed' | 'unknown';
  nightContext: 'night' | 'non-night' | 'unknown'; dominantScene: string;
}
export interface ColorDecision {
  ruleVersion: typeof COLOR_AGENT_POLICY_VERSION; category: ColorCategory | null; status: 'classified' | 'needs-review';
  reasons: string[]; reviewFlags: string[]; semantic: ColorAgentSemantic; solar: SolarContext;
  highContrast: ReturnType<typeof applyHighContrastScenePolicy<ColorTechnicalReport['highContrast']>>;
}
