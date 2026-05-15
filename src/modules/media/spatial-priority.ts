import type { IInferredGps } from '../../protocol/schema.js';
import type { IPharosTimedSpatialContext } from '../pharos/gpx-timed.js';
import type { IManualSpatialContext } from './manual-spatial.js';

type TSpatialWithGps = Pick<IManualSpatialContext, 'gpsSummary' | 'inferredGps'>;
type TPharosSpatialWithGps = Pick<IPharosTimedSpatialContext, 'gpsSummary' | 'inferredGps'>;

export interface IAnalyzePrimarySpatial {
  gpsSummary?: string;
  inferredGps?: IInferredGps;
}

export function hasEmbeddedSpatialTruth(
  spatial?: Pick<IManualSpatialContext, 'inferredGps'> | null,
): boolean {
  return spatial?.inferredGps?.source === 'embedded';
}

export function resolveAnalyzePrimarySpatial(input: {
  manualSpatial?: TSpatialWithGps | null;
  pharosSpatial?: TPharosSpatialWithGps | null;
}): IAnalyzePrimarySpatial {
  if (hasEmbeddedSpatialTruth(input.manualSpatial)) {
    return {
      gpsSummary: input.manualSpatial?.gpsSummary,
      inferredGps: input.manualSpatial?.inferredGps,
    };
  }

  if (input.pharosSpatial?.inferredGps) {
    return {
      gpsSummary: input.pharosSpatial.gpsSummary,
      inferredGps: input.pharosSpatial.inferredGps,
    };
  }

  return {
    gpsSummary: input.manualSpatial?.gpsSummary,
    inferredGps: input.manualSpatial?.inferredGps,
  };
}
