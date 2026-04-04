import { describe, expect, it } from 'vitest';
import { extractFilenameCaptureTimeHint, resolveExifCaptureTime } from '../../src/modules/media/capture-time.js';

describe('capture time resolution', () => {
  it('prefers EXIF original datetime with offset for photos', () => {
    const result = resolveExifCaptureTime({
      subsecdatetimeoriginal: '2026:02:08 06:49:36.000+13:00',
      offsettimeoriginal: '+13:00',
      filemodifydate: '2026:03:28 19:57:47+08:00',
    });

    expect(result).toEqual(expect.objectContaining({
      capturedAt: '2026-02-07T17:49:36.000Z',
      originalTimezone: '+13:00',
      source: 'exif',
    }));
  });

  it('falls back to EXIF create date when original date is missing', () => {
    const result = resolveExifCaptureTime({
      createdate: '2026:02:19 11:42:57',
      offsettimedigitized: '+13:00',
    });

    expect(result).toEqual(expect.objectContaining({
      capturedAt: '2026-02-18T22:42:57.000Z',
      originalTimezone: '+13:00',
      source: 'exif',
    }));
  });

  it('extracts date and time hints from camera filenames', () => {
    expect(extractFilenameCaptureTimeHint('DJI_20260219023043_0782_D.jpg')).toEqual({
      date: '2026-02-19',
      time: '02:30:43',
      originalValue: '2026-02-19T02:30:43',
    });
  });
});
