import type { IKtepAsset, IMediaRoot } from '../../protocol/schema.js';
import type { IProjectDerivedTrack } from '../../store/index.js';
import { type IManualSpatialContext } from './manual-spatial.js';
import { resolveDerivedTrackSpatialContext } from './derived-track-spatial.js';
import { resolveEmbeddedGpsContext } from './gps-embedded.js';
import { resolveGpxSpatialContext } from './gpx-spatial.js';

export interface IResolveAssetSpatialContextInput {
  asset: Pick<IKtepAsset, 'capturedAt' | 'sourcePath' | 'metadata'>;
  root?: Pick<IMediaRoot, 'id' | 'label'>;
  gpxPaths?: string[];
  gpxMatchToleranceMs?: number;
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

  return resolveDerivedTrackSpatialContext({
    asset: input.asset,
    root: input.root,
    derivedTrack: input.derivedTrack,
    pointMatchToleranceMs: input.derivedTrackPointMatchToleranceMs,
  });
}
