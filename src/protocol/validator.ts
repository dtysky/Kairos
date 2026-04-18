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

  const trackMap = new Map(doc.timeline.tracks.map(track => [track.id, track]));
  const assetMap = new Map(doc.assets.map(asset => [asset.id, asset]));
  const spans = doc.spans ?? doc.slices ?? [];
  const sliceMap = new Map(spans.map(slice => [slice.id, slice]));
  const trackIds = new Set(trackMap.keys());
  const assetIds = new Set(assetMap.keys());
  const sliceIds = new Set(sliceMap.keys());

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

    const track = trackMap.get(clip.trackId);
    const asset = assetMap.get(clip.assetId);
    if (track?.kind === 'audio' && asset) {
      if (asset.kind === 'photo') {
        errors.push({
          rule: 'audio-asset-kind',
          message: `clip ${clip.id}: audio track cannot reference photo asset "${asset.id}"`,
          path: `timeline.clips.${clip.id}`,
        });
      }
      if (asset.kind === 'video') {
        if (clip.audioSource === 'embedded') {
          // Dialogue clips may legally pull embedded source audio from the bound video asset.
          continue;
        }
        if (clip.audioSource === 'protection') {
          if (!asset.protectionAudio) {
            errors.push({
              rule: 'audio-asset-kind',
              message: `clip ${clip.id}: audio track referencing video asset "${asset.id}" with audioSource=protection requires asset.protectionAudio`,
              path: `timeline.clips.${clip.id}`,
            });
          }
          continue;
        }

        errors.push({
          rule: 'audio-asset-kind',
          message: `clip ${clip.id}: audio track referencing video asset "${asset.id}" must declare audioSource=embedded or audioSource=protection`,
          path: `timeline.clips.${clip.id}`,
        });
      }
    }

    if (track?.kind === 'video' && asset?.kind === 'audio') {
      errors.push({
        rule: 'video-asset-kind',
        message: `clip ${clip.id}: video track cannot reference audio asset "${asset.id}"`,
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

    if (clip.speed != null) {
      const slice = clip.sliceId != null ? sliceMap.get(clip.sliceId) : undefined;
      if (!slice || (slice.type !== 'drive' && slice.type !== 'aerial')) {
        errors.push({
          rule: 'clip-speed-type',
          message: `clip ${clip.id}: speed is only allowed on drive/aerial slices`,
          path: `timeline.clips.${clip.id}`,
        });
      }
    }
  }

  // Rule 3 also applies to slices
  for (const slice of spans) {
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
