import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import type { ICaptureTime, ECaptureTimeSource } from '../../protocol/schema.js';
import type { IProbeResult } from './probe.js';

/**
 * 按优先级提取拍摄时间：
 * 1. ffprobe creation_time (container/quicktime)
 * 2. 文件名中的时间戳
 * 3. 文件系统修改时间
 */
export async function resolveCaptureTime(
  filePath: string,
  probeResult: IProbeResult,
  defaultTimezone?: string,
): Promise<ICaptureTime> {
  // Priority 1: container metadata
  if (probeResult.creationTime) {
    const parsed = tryParseIso(probeResult.creationTime);
    if (parsed) {
      return {
        capturedAt: parsed,
        originalValue: probeResult.creationTime,
        source: 'container',
        confidence: 0.9,
      };
    }
  }

  // Priority 2: filename pattern
  const fromName = tryParseFilename(basename(filePath), defaultTimezone);
  if (fromName) return fromName;

  // Priority 3: filesystem mtime
  try {
    const info = await stat(filePath);
    return {
      capturedAt: info.mtime.toISOString(),
      originalValue: info.mtime.toISOString(),
      source: 'filesystem',
      confidence: 0.3,
    };
  } catch {
    return { source: 'filesystem', confidence: 0 };
  }
}

function tryParseIso(value: string): string | null {
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

// Common filename patterns from cameras/drones
const CFILENAME_PATTERNS: RegExp[] = [
  /(\d{4})[-_]?(\d{2})[-_]?(\d{2})[-_T ]?(\d{2})[-_:]?(\d{2})[-_:]?(\d{2})/,
  /(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/,
  /IMG_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/,
  /DSC(\d{5})/,  // Sony — no time info, skip
];

function tryParseFilename(
  name: string,
  defaultTimezone?: string,
): ICaptureTime | null {
  for (const pattern of CFILENAME_PATTERNS) {
    const m = name.match(pattern);
    if (!m) continue;

    if (m.length >= 7) {
      const [, yr, mo, dy, hr, mi, sc] = m;
      const iso = `${yr}-${mo}-${dy}T${hr}:${mi}:${sc}`;
      const d = new Date(iso + (defaultTimezone ? '' : 'Z'));
      if (!isNaN(d.getTime())) {
        return {
          capturedAt: d.toISOString(),
          originalValue: iso,
          originalTimezone: defaultTimezone,
          source: 'filename',
          confidence: 0.5,
        };
      }
    }
  }
  return null;
}
