import type { IColorInput } from '../../store/color-inputs.js';
import { readSceneEvidence, type SceneEvidence } from './scene-evidence.js';
import { buildSolarContext, type SolarContext } from './solar-context.js';
import type { ColorTechnicalReport } from './technical-measurement.js';
import { resolveColorLighting, type ColorLighting } from './lighting-context.js';
import { applyHighContrastScenePolicy } from './high-contrast-measurement.js';

export const COLOR_CATEGORY_LABELS = {
  portrait: '竖屏', presenter: '出镜口播', overexposed: '大面积过曝', noisy: '明显噪点',
  'high-contrast': '逆光／大光比', night: '普通夜景', twilight: '清晨／黄昏', 'day-drive-cast': '白天前挡行车', day: '常规日景',
} as const;
export type ColorCategory = keyof typeof COLOR_CATEGORY_LABELS;
export interface ColorDecision {
  ruleVersion: 'scene-v7'; category: ColorCategory | null; status: 'classified' | 'needs-review';
  reasons: string[]; reviewFlags: string[]; scene: SceneEvidence; solar: SolarContext;
  lighting: ColorLighting;
  highContrast: ReturnType<typeof applyHighContrastScenePolicy<ColorTechnicalReport['highContrast']>>;
}

/** Material-level classification; source type and Analyze reports are immutable. */
export function classifyAnalyzedColor(input: IColorInput, technical?: ColorTechnicalReport): ColorDecision {
  const scene = readSceneEvidence(input), solar = buildSolarContext(input);
  const lighting = resolveColorLighting(scene, solar, input.facts?.type);
  const highContrast = applyHighContrastScenePolicy<ColorTechnicalReport['highContrast']>(technical?.highContrast ?? { state: 'unknown', reasons: ['反差测量未知'], intervals: [] },
    lighting.phase === 'unknown' ? 'unknown' : lighting.phase === 'night' ? 'night' : 'non-night');
  const flags: string[] = ['偏色幅度与频闪未检测'];
  if (highContrast.state === 'excluded') flags.push(highContrast.reason);
  else if (highContrast.state === 'detected') flags.push('已检出持续亮暗反差；高优先级主类保留，是否修正另行决定');
  else if (highContrast.state === 'not-dominant') flags.push(...highContrast.measurement.reasons);
  else if (highContrast.state === 'unknown' || highContrast.state === 'needs-review') flags.push(highContrast.reason, ...highContrast.measurement.reasons);
  if (!technical || technical.exposure.state === 'unknown') flags.push('曝光测量未知');
  if (!technical || technical.noise.state === 'unknown') flags.push('噪声测量未知');
  if (technical?.status === 'unavailable') flags.push(`技术检测不可用：${technical.exposure.reasons.join('；')}`);
  if (technical?.exposure.state === 'detected' || technical?.exposure.state === 'needs-review') flags.push(...technical.exposure.reasons);
  if (technical?.noise.state === 'detected') flags.push('连续帧已检出显著噪声，是否降噪及幅度另行决定');
  if (scene.sceneChange) flags.push('存在片内场景/光线变化，保留原窗口区间；未定位到精确转换时刻');
  const result = (category: ColorCategory | null, reason: string): ColorDecision => ({ ruleVersion: 'scene-v7', category,
    status: category ? 'classified' : 'needs-review', reasons: [reason], reviewFlags: flags, scene, solar, lighting, highContrast });
  const { facts } = input;
  // Color operates on raw. Analyze may use an already transformed target, whose
  // dimensions/rotation neither establish nor contradict the raw orientation.
  const source = technical?.probe;
  const width = source?.displayWidth, height = source?.displayHeight;
  if (!source || !width || !height || width <= 0 || height <= 0) return result(null, '待调原片显示方向未知');
  const rotation = source.rotationDegrees;
  if (rotation !== undefined && rotation !== null && source.width && source.height) {
    const quarter = Math.abs(rotation % 180) === 90;
    const expectedPortrait = quarter ? source.width > source.height : source.height > source.width;
    if (Math.abs(rotation % 90) > 0.001 || expectedPortrait !== (height > width)) return result(null, '待调原片旋转与显示尺寸冲突，需复核方向');
  }
  if (height > width) return result('portrait', '有效显示方向为竖屏，排他归类');
  if (input.analysisStatus !== 'current' || !facts) return result(null, '缺少当前素材级 Analyze 事实');
  if (scene.presenter === 'yes') return result('presenter', '已有描述明确人物出镜讲述且有语音证据；不限定自拍或素材 type');
  if (scene.presenter === 'uncertain') return result(null, '出镜讲述证据不完整/不一致，不能按 type 或仅有人声归类');
  if (technical?.exposure.state === 'detected') {
    if (scene.whiteSceneAmbiguous) return result(null, '大面积偏亮与白墙/雪雾/天空等内容存在歧义');
    flags.push('曝光问题按检测区间记录，不代表整条素材需要相同补偿；源端剪切另行审计');
    return result('overexposed', '原片诊断显示视图存在持续的大面积整体偏亮');
  }
  if (technical?.exposure.state === 'needs-review') return result(null, technical.exposure.reasons.join('；'));
  if (technical?.noise.state === 'detected') return result('noisy', '原分辨率连续帧确认明显噪点；不要求画面极暗');
  if (lighting.phase === 'unknown') return result(null, lighting.reason);
  if (!technical || technical.exposure.state === 'unknown') return result(null, '曝光概览尚不可用，保留场景证据待复核');
  if (lighting.phase === 'night') return result('night', `${lighting.reason}；夜景排除逆光／大光比`);
  if (highContrast.state === 'detected') {
    if (scene.whiteSceneAmbiguous) return result(null, '亮区存在白色物体/雪雾/满屏天空歧义，保留反差区间复核');
    return result('high-contrast', '非夜景且持续亮暗反差覆盖超过一半时长；不推断物理光比或修正参数');
  }
  if (highContrast.state === 'needs-review' || highContrast.state === 'unknown') return result(null, highContrast.measurement.reasons.join('；'));
  if (lighting.phase === 'twilight') return result('twilight', lighting.reason);
  if (lighting.phase === 'day') {
    if (!lighting.indoor && facts.type === 'drive') return scene.forwardDrive ? result('day-drive-cast', '白天、drive 与向前道路/前挡视角共同支持；不代表存在偏色')
      : result(null, '白天 drive 缺少明确前挡/向前道路视角，需复核');
    return result('day', lighting.reason);
  }
  return result(null, '现有画面描述、GPS/时间不足以确定主类');
}
