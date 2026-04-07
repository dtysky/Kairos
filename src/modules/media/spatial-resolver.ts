import type { IKtepAsset, IMediaRoot } from '../../protocol/schema.js';
import type { IProjectDerivedTrack } from '../../store/index.js';
import type { IProjectPharosContext } from '../../protocol/schema.js';
import { resolvePharosSpatialContext } from '../pharos/matcher.js';
import { type IManualSpatialContext } from './manual-spatial.js';
import { resolveDerivedTrackSpatialContext } from './derived-track-spatial.js';
import { resolveEmbeddedGpsContext } from './gps-embedded.js';
import { resolveGpxSpatialContext } from './gpx-spatial.js';

export interface IResolveAssetSpatialContextInput {
  asset: Pick<IKtepAsset, 'capturedAt' | 'sourcePath' | 'metadata' | 'embeddedGps'>;
  root?: Pick<IMediaRoot, 'id' | 'label'>;
  gpxPaths?: string[];
  gpxMatchToleranceMs?: number;
  pharosContext?: IProjectPharosContext | null;
  derivedTrack?: IProjectDerivedTrack | null;
  derivedTrackPointMatchToleranceMs?: number;
}

export async function resolveAssetSpatialContext(
  input: IResolveAssetSpatialContextInput,
): Promise<IManualSpatialContext | null> {
  const embeddedSpatial = resolveEmbeddedGpsContext(input.asset);
  if (embeddedSpatial) return embeddedSpatial;

  const gpxSpatial = await resolveGpxSpatialContext({
    asset: input.asset,
    gpxPaths: input.gpxPaths ?? [],
    matchToleranceMs: input.gpxMatchToleranceMs,
  });
  if (gpxSpatial) return gpxSpatial;

  const pharosSpatial = resolvePharosSpatialContext({
    asset: input.asset,
    context: input.pharosContext ?? null,
  });
  if (pharosSpatial) return pharosSpatial;

  return resolveDerivedTrackSpatialContext({
    asset: input.asset,
    root: input.root,
    derivedTrack: input.derivedTrack,
    pointMatchToleranceMs: input.derivedTrackPointMatchToleranceMs,
  });
}
