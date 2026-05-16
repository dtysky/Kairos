import type {
  IAssetCoarseReport,
  IPharosMatch,
  IProjectPharosContext,
  IProjectPharosShot,
  IKtepAsset,
} from '../../protocol/schema.js';

export interface IMatchAssetToPharosInput {
  asset: Pick<IKtepAsset, 'sourcePath' | 'capturedAt' | 'metadata'>;
  context: IProjectPharosContext | null;
  report?: Pick<IAssetCoarseReport, 'clipTypeGuess' | 'summary' | 'placeHints' | 'labels'>;
  limit?: number;
}

export function matchAssetToPharos(
  input: IMatchAssetToPharosInput,
): IPharosMatch[] {
  if (!input.context || input.context.status === 'empty' || input.context.shots.length === 0) {
    return [];
  }

  const matches = input.context.shots.map(shot => scoreShotMatch(shot, input))
    .filter((item): item is IScoredMatch => item != null && item.score > 0);

  return matches
    .sort((left, right) =>
      right.score - left.score
      || left.match.ref.tripId.localeCompare(right.match.ref.tripId)
      || left.match.ref.shotId.localeCompare(right.match.ref.shotId))
    .slice(0, input.limit ?? matches.length)
    .map(item => item.match);
}

interface IScoredMatch {
  score: number;
  match: IPharosMatch;
}

function scoreShotMatch(
  shot: IProjectPharosShot,
  input: IMatchAssetToPharosInput,
): IScoredMatch | null {
  const reasons: string[] = [];
  const timeScore = scoreTimeMatch(input.asset.capturedAt, shot, reasons);
  if (timeScore <= 0) return null;

  let score = timeScore;
  score += scoreDeviceMatch(input.asset, shot, reasons);
  score += scoreClipTypeMatch(input.report?.clipTypeGuess, shot, reasons);
  score += scoreTextMatch(input.report, shot, reasons);

  if (shot.status === 'expected') {
    score += 0.4;
  }

  if (score <= 0) return null;
  return {
    score,
    match: {
      ref: shot.ref,
      confidence: normalizeScore(score),
      status: shot.status,
      tripTitle: shot.tripTitle,
      dayTitle: shot.dayTitle,
      shotKind: shot.type,
      shotLocation: shot.location,
      shotDescription: shot.description,
      matchReasons: dedupeStrings(reasons),
    },
  };
}

function scoreTimeMatch(
  capturedAt: string | undefined,
  shot: IProjectPharosShot,
  reasons: string[],
): number {
  if (shot.status !== 'expected' && shot.status !== 'unexpected') return 0;
  if (!capturedAt) return 0;
  const capturedMs = Date.parse(capturedAt);
  if (!Number.isFinite(capturedMs)) return 0;

  const actualStartMs = parseTime(shot.actualTimeStart);
  const actualEndMs = parseTime(shot.actualTimeEnd);
  if (actualStartMs == null || actualEndMs == null) return 0;
  if (actualEndMs < actualStartMs) return 0;
  if (capturedMs < actualStartMs || capturedMs > actualEndMs) return 0;

  reasons.push('actual-time:within-window');
  return shot.type === 'continuous' ? 6.5 : 7;
}

function scoreDeviceMatch(
  asset: IMatchAssetToPharosInput['asset'],
  shot: IProjectPharosShot,
  reasons: string[],
): number {
  const assetTokens = collectAssetDeviceTokens(asset);
  if (assetTokens.length === 0) return 0;
  const shotTokens = dedupeStrings([
    shot.device,
    ...shot.devices,
  ].flatMap(token => tokenizeDeviceToken(token ?? '')));
  const overlap = assetTokens.filter(token => shotTokens.includes(token));
  if (overlap.length === 0) return 0;
  reasons.push(`device:${overlap[0]}`);
  return shot.type === 'continuous' ? 2.2 : 1.6;
}

function scoreClipTypeMatch(
  clipTypeGuess: IAssetCoarseReport['clipTypeGuess'] | undefined,
  shot: IProjectPharosShot,
  reasons: string[],
): number {
  if (!clipTypeGuess) return 0;
  const mapped = mapPharosShotTypeToClipType(shot.type);
  if (mapped !== clipTypeGuess) return 0;
  reasons.push(`clip-type:${clipTypeGuess}`);
  return clipTypeGuess === 'drive' || clipTypeGuess === 'aerial' ? 1.6 : 1.2;
}

function scoreTextMatch(
  report: IMatchAssetToPharosInput['report'] | undefined,
  shot: IProjectPharosShot,
  reasons: string[],
): number {
  if (!report) return 0;
  const targetTokens = dedupeStrings([
    ...tokenize(shot.location),
    ...tokenize(shot.description),
    shot.dayTitle,
    shot.tripTitle,
  ]);
  if (targetTokens.length === 0) return 0;

  const sourceTokens = dedupeStrings([
    ...(report.placeHints ?? []),
    ...(report.labels ?? []),
    ...tokenize(report.summary ?? ''),
  ]);
  const overlap = sourceTokens.filter(token => targetTokens.includes(token));
  if (overlap.length === 0) return 0;
  reasons.push(`context:${overlap.length}`);
  return Math.min(2.5, overlap.length * 0.6);
}

function collectAssetDeviceTokens(
  asset: IMatchAssetToPharosInput['asset'],
): string[] {
  const tokens = new Set<string>();
  const metadata = asset.metadata && typeof asset.metadata === 'object'
    ? asset.metadata
    : {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!/device|camera|model|make/i.test(key)) continue;
    if (typeof value === 'string') {
      for (const token of tokenizeDeviceToken(value)) tokens.add(token);
    }
  }
  for (const token of tokenizeDeviceToken(asset.sourcePath)) {
    tokens.add(token);
  }
  return [...tokens];
}

function tokenizeDeviceToken(input: string): string[] {
  return input
    .split(/[^a-zA-Z0-9]+/u)
    .map(token => token.trim().toLowerCase())
    .filter(token => token.length >= 2);
}

function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fa5]+/u)
    .map(token => token.trim())
    .filter(token => token.length >= 2);
}

function dedupeStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.map(value => value?.trim()).filter(Boolean) as string[])];
}

function parseTime(value: string | undefined): number | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function mapPharosShotTypeToClipType(type: string): IAssetCoarseReport['clipTypeGuess'] {
  switch (type) {
    case 'continuous':
      return 'drive';
    case 'timelapse':
      return 'timelapse';
    case 'aerial':
      return 'aerial';
    default:
      return 'unknown';
  }
}

function normalizeScore(score: number): number {
  return Math.max(0.05, Math.min(0.99, score / 10));
}
