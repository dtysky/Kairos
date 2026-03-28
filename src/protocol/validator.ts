import type { IKtepDoc } from './schema.js';

export interface IValidationError {
  rule: string;
  message: string;
  path?: string;
}

export interface IValidationResult {
  ok: boolean;
  errors: IValidationError[];
}

export function validateKtepDoc(doc: IKtepDoc): IValidationResult {
  const errors: IValidationError[] = [];

  const trackIds = new Set(doc.timeline.tracks.map(t => t.id));
  const assetIds = new Set(doc.assets.map(a => a.id));
  const sliceIds = new Set(doc.slices.map(s => s.id));

  for (const clip of doc.timeline.clips) {
    // Rule 2: timelineOutMs > timelineInMs
    if (clip.timelineOutMs <= clip.timelineInMs) {
      errors.push({
        rule: 'timeline-range',
        message: `clip ${clip.id}: timelineOutMs (${clip.timelineOutMs}) must be > timelineInMs (${clip.timelineInMs})`,
        path: `timeline.clips.${clip.id}`,
      });
    }

    // Rule 3: sourceOutMs > sourceInMs (if both present)
    if (
      clip.sourceInMs != null &&
      clip.sourceOutMs != null &&
      clip.sourceOutMs <= clip.sourceInMs
    ) {
      errors.push({
        rule: 'source-range',
        message: `clip ${clip.id}: sourceOutMs (${clip.sourceOutMs}) must be > sourceInMs (${clip.sourceInMs})`,
        path: `timeline.clips.${clip.id}`,
      });
    }

    // Rule 4: trackId must reference existing track
    if (!trackIds.has(clip.trackId)) {
      errors.push({
        rule: 'track-ref',
        message: `clip ${clip.id}: trackId "${clip.trackId}" not found in timeline.tracks`,
        path: `timeline.clips.${clip.id}`,
      });
    }

    // Rule 5: assetId must reference existing asset
    if (!assetIds.has(clip.assetId)) {
      errors.push({
        rule: 'asset-ref',
        message: `clip ${clip.id}: assetId "${clip.assetId}" not found in assets`,
        path: `timeline.clips.${clip.id}`,
      });
    }

    // Rule 6: sliceId, if present, must reference existing slice
    if (clip.sliceId != null && !sliceIds.has(clip.sliceId)) {
      errors.push({
        rule: 'slice-ref',
        message: `clip ${clip.id}: sliceId "${clip.sliceId}" not found in slices`,
        path: `timeline.clips.${clip.id}`,
      });
    }
  }

  // Rule 3 also applies to slices
  for (const slice of doc.slices) {
    if (
      slice.sourceInMs != null &&
      slice.sourceOutMs != null &&
      slice.sourceOutMs <= slice.sourceInMs
    ) {
      errors.push({
        rule: 'source-range',
        message: `slice ${slice.id}: sourceOutMs (${slice.sourceOutMs}) must be > sourceInMs (${slice.sourceInMs})`,
        path: `slices.${slice.id}`,
      });
    }
  }

  // Rule 7: subtitle time range must not be negative
  if (doc.subtitles) {
    for (const sub of doc.subtitles) {
      if (sub.endMs <= sub.startMs) {
        errors.push({
          rule: 'subtitle-range',
          message: `subtitle ${sub.id}: endMs (${sub.endMs}) must be > startMs (${sub.startMs})`,
          path: `subtitles.${sub.id}`,
        });
      }
    }
  }

  // Rule 8 is enforced by schema design (adapterHints is the only escape hatch)

  return { ok: errors.length === 0, errors };
}
