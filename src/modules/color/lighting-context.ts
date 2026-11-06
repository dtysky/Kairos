import type { SceneEvidence } from './scene-evidence.js';
import type { SolarContext } from './solar-context.js';

export interface ColorLighting {
  phase: 'day' | 'night' | 'twilight' | 'unknown';
  indoor: boolean;
  reason: string;
}
/** Shared scene resolution for category routing and the high-contrast night exclusion. */
export function resolveColorLighting(scene: SceneEvidence, solar: SolarContext, type?: string): ColorLighting {
  const indoor = scene.indoor || (scene.cabin && !(type === 'drive' && scene.forwardDrive));
  const result = (phase: ColorLighting['phase'], reason: string): ColorLighting => ({ phase, indoor, reason });
  if (scene.sceneChange || (scene.day && scene.night) || (scene.night && scene.twilight))
    return result('unknown', '已有描述包含片内场景/光线变化或冲突，不能统一处理；转换区间以原窗口为准');
  if (indoor) {
    if (scene.outdoor) return result('unknown', '描述同时涉及室内外，缺少整片统一光线证据');
    if (scene.day) return result('day', '已有描述支持正常照明室内');
    return result('unknown', '室内画面照明未明确，不能按室外太阳位置归类');
  }
  const phases = new Set(solar.status === 'available' ? solar.samples.map(s => s.phase) : []);
  const solarNight = phases.size === 1 && phases.has('night'), solarDay = phases.size === 1 && phases.has('day');
  if ((scene.day && solarNight) || (scene.night && solarDay) || (scene.twilight && (solarNight || solarDay)))
    return result('unknown', '画面描述与日照几何冲突，需复核时间/位置/描述');
  if (phases.size > 1) return result('unknown', '素材跨越日照阶段，保留开始/中间/结束太阳高度供复核');
  if (scene.night || (scene.outdoor && solarNight)) return result('night', '夜间画面描述或室外画面与日照时间共同支持');
  if (scene.twilight || (scene.outdoor && (phases.has('low-sun') || phases.has('civil-twilight'))))
    return result('twilight', '晨昏描述或室外低太阳/民用曙暮光上下文支持，保留自然冷暖');
  if (scene.day || (scene.outdoor && solarDay)) return result('day', '现有画面描述与日照上下文支持常规日景');
  return result('unknown', '现有画面描述、GPS/时间不足以确定主类');
}
