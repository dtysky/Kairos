import type { IKtepAsset, IAssetCoarseReport, IColorAnalysisEvidence, IColorClassification } from '../../protocol/schema.js';

export const COLOR_CATEGORY_LABELS: Record<IColorClassification['category'], string> = {
  portrait: '竖屏', presenter: '出镜口播', overexposed: '明显过曝', 'dark-noisy': '大暗光高噪点',
  'high-contrast': '大光比', night: '夜景', twilight: '清晨黄昏', 'day-drive-cast': '白天行车偏色', day: '普通白天', review: '待确认',
};

/** Deterministic policy over structured Analyze facts. No filename/description keyword inference. */
export function classifyAnalyzedColor(asset: IKtepAsset, type: IAssetCoarseReport['clipTypeGuess'], evidence?: IColorAnalysisEvidence): IColorClassification {
  const width = Number(asset.metadata?.displayWidth) || asset.width || 0;
  const height = Number(asset.metadata?.displayHeight) || asset.height || 0;
  const reviewFlags: string[] = [];
  if (evidence?.lightChange) reviewFlags.push('片内光线变化，需要分段检查');
  if (evidence?.flicker === 'suspected') reviewFlags.push('疑似灯光闪烁，需要连续帧检测');
  const result = (category: IColorClassification['category'], reason: string): IColorClassification => ({ ruleVersion: 'scene-v1', category, reasons: [reason], reviewFlags });
  if (width > 0 && height > width) return result('portrait', '显示尺寸为竖屏，排他分类');
  if (width <= 0 || height <= 0) return result('review', '缺少显示尺寸，不能排除竖屏');
  if (!evidence) return result('review', '缺少结构化调色证据');
  if (evidence.visiblePresenter === true) return result('presenter', '画面内可见正在口播的人物');
  if (evidence.overexposed === true) return result('overexposed', '主要画面明显过曝');
  if (evidence.veryDarkNoisy === true) return result('dark-noisy', '画面特别黑并可见明显噪点');
  if (evidence.highContrast === true) return result('high-contrast', '主体与背景大光比');
  if (evidence.timeOfDay === 'night') return result('night', '夜景；行车不另立夜景类');
  if (evidence.timeOfDay === 'twilight') return result('twilight', '清晨或黄昏可见光线');
  if (evidence.timeOfDay === 'day' && type === 'drive' && evidence.windshieldCast === true) return result('day-drive-cast', 'drive 类型且白天可见前挡偏色');
  if (evidence.timeOfDay === 'day') return result('day', '普通白天');
  return result('review', '当前证据不足以确定主类');
}
