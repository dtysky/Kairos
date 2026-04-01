import type { IKtepAsset, IMediaRoot } from '../../protocol/schema.js';
import type { ILoadedManualItinerary } from '../../store/spatial-context.js';
import {
  inferManualItineraryGps,
  type IManualSpatialContext,
} from './manual-spatial.js';
import { resolveEmbeddedGpsContext } from './gps-embedded.js';
import { resolveGpxSpatialContext } from './gpx-spatial.js';

export interface IResolveAssetSpatialContextInput {
  asset: Pick<IKtepAsset, 'capturedAt' | 'sourcePath' | 'metadata'>;
  root?: Pick<IMediaRoot, 'id' | 'label'>;
  itinerary: ILoadedManualItinerary;
  gpxPaths?: string[];
  gpxMatchToleranceMs?: number;
  resolveTimezoneFromLocation?: (location: string) => Promise<string | null>;
  geocodeLocation?: (location: string) => Promise<{ lat: number; lng: number } | null>;
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

  if (!input.resolveTimezoneFromLocation || !input.geocodeLocation) {
    return null;
  }

  return inferManualItineraryGps({
    asset: input.asset,
    root: input.root,
    itinerary: input.itinerary,
    resolveTimezoneFromLocation: input.resolveTimezoneFromLocation,
    geocodeLocation: input.geocodeLocation,
  });
}
