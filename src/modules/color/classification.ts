import type { IColorInput } from '../../store/color-inputs.js';
import { readSceneEvidence, type SceneEvidence } from './scene-evidence.js';
import { buildSolarContext, type SolarContext } from './solar-context.js';
import type { ColorTechnicalReport } from './technical-measurement.js';

export const COLOR_CATEGORY_LABELS = {
  portrait: '竖屏', presenter: '出镜口播', overexposed: '大面积过曝', noisy: '明显噪点',
  'high-contrast': '逆光／大光比', night: '普通夜景', twilight: '清晨／黄昏', 'day-drive-cast': '白天前挡行车', day: '常规日景',
} as const;
export type ColorCategory = keyof typeof COLOR_CATEGORY_LABELS;
export interface ColorDecision {
  ruleVersion: 'scene-v4'; category: ColorCategory | null; status: 'classified' | 'needs-review';
  reasons: string[]; reviewFlags: string[]; scene: SceneEvidence; solar: SolarContext;
}

/** Material-level classification; source type and Analyze reports are immutable. */
export function classifyAnalyzedColor(input: IColorInput, technical?: ColorTechnicalReport): ColorDecision {
  const scene = readSceneEvidence(input), solar = buildSolarContext(input);
  const flags: string[] = ['逆光／大光比、偏色幅度与频闪未检测'];
  if (!technical || technical.exposure.state === 'unknown') flags.push('曝光测量未知');
  if (!technical || technical.noise.state === 'unknown') flags.push('噪声测量未知');
  if (technical?.status === 'unavailable') flags.push(`技术检测不可用：${technical.exposure.reasons.join('；')}`);
  if (technical?.exposure.state === 'detected' || technical?.exposure.state === 'needs-review') flags.push(...technical.exposure.reasons);
  if (technical?.noise.state === 'detected') flags.push('连续帧已检出显著噪声，是否降噪及幅度另行决定');
  if (scene.sceneChange) flags.push('存在片内场景/光线变化，保留原窗口区间；未定位到精确转换时刻');
  const result = (category: ColorCategory | null, reason: string): ColorDecision => ({ ruleVersion: 'scene-v4', category,
    status: category ? 'classified' : 'needs-review', reasons: [reason], reviewFlags: flags, scene, solar });
  const { media, facts } = input;
  const width = media.displayWidth ?? media.width, height = media.displayHeight ?? media.height;
  if (!width || !height) return result(null, '显示方向未知');
  if (technical?.probe && (technical.probe.displayHeight > technical.probe.displayWidth) !== (height > width)) return result(null, '待调原片与资产显示方向不一致');
  const rotation = media.rotationDegrees;
  if (rotation !== undefined && rotation !== null && media.width && media.height) {
    const quarter = Math.abs(rotation % 180) === 90;
    const expectedPortrait = quarter ? media.width > media.height : media.height > media.width;
    if (Math.abs(rotation % 90) > 0.001 || expectedPortrait !== (height > width)) return result(null, '旋转与显示尺寸冲突，需复核方向');
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
  if (scene.sceneChange || (scene.day && scene.night)) return result(null, '已有描述包含片内场景/光线变化，不能统一处理；转换区间以原窗口为准');
  if (!technical || technical.exposure.state === 'unknown') return result(null, '曝光概览尚不可用，保留场景证据待复核');
  const phases = new Set(solar.samples.map(s => s.phase));
  if (scene.indoor || (scene.cabin && !(facts.type === 'drive' && scene.forwardDrive))) {
    if (scene.outdoor) return result(null, '描述同时涉及室内外，缺少整片统一光线证据');
    if (scene.day) return result('day', '已有描述支持正常照明室内');
    return result(null, '室内画面照明未明确，不能按室外太阳位置归类');
  }
  const solarNight = phases.size === 1 && phases.has('night'), solarDay = phases.size === 1 && phases.has('day');
  if ((scene.day && solarNight) || (scene.night && solarDay) || (scene.twilight && (solarNight || solarDay))) return result(null, '画面描述与日照几何冲突，需复核时间/位置/描述');
  if (phases.size > 1) return result(null, '素材跨越日照阶段，保留开始/中间/结束太阳高度供复核');
  if (scene.twilight || (scene.outdoor && (phases.has('low-sun') || phases.has('civil-twilight')))) return result('twilight', '晨昏描述或室外低太阳/民用曙暮光上下文支持，保留自然冷暖');
  if (scene.night || (scene.outdoor && solarNight)) return result('night', '夜间画面描述或室外画面与日照时间共同支持');
  if (scene.day || (scene.outdoor && solarDay)) {
    if (facts.type === 'drive') return scene.forwardDrive ? result('day-drive-cast', '白天、drive 与向前道路/前挡视角共同支持；不代表存在偏色')
      : result(null, '白天 drive 缺少明确前挡/向前道路视角，需复核');
    return result('day', '现有画面描述与日照上下文支持常规日景');
  }
  return result(null, '现有画面描述、GPS/时间不足以确定主类');
}
