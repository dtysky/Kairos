import type { IProbeResult } from '../../../src/modules/media/probe.js';

export function testProbeResult(): IProbeResult {
  return {
    durationMs: 3000, width: 1920, height: 1080,
    displayWidth: 1920, displayHeight: 1080, rotationDegrees: 0,
    fps: 25, codec: 'h264', hasAudioStream: true, audioStreamCount: 1,
    audioCodec: 'aac', audioSampleRate: 48000, audioChannels: 2, audioBitRate: 192000,
    creationTime: '2026-05-01T06:00:00.000Z', rawTags: { make: 'Test' },
  };
}
