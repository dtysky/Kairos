import { spawn } from 'node:child_process';
import { toExecutableInputPath } from '../media/tool-path.js';

export interface IVoiceoverAudioEnvelope {
  frameMs: number;
  durationMs: number;
  levelsDbfs: number[];
}

/** Read-only analysis of the original TTS audio; no filtering or ASR. */
export async function readVoiceoverAudioEnvelope(
  path: string,
  ffmpegPath = 'ffmpeg',
): Promise<IVoiceoverAudioEnvelope> {
  const sampleRate = 24000;
  const samplesPerFrame = 240;
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, [
      '-nostdin', '-v', 'error', '-i', toExecutableInputPath(path, ffmpegPath),
      '-map', '0:a:0', '-ac', '1', '-ar', String(sampleRate), '-f', 'f32le', 'pipe:1',
    ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const levelsDbfs: number[] = [];
    let remainder = Buffer.alloc(0);
    let sampleCount = 0;
    let frameCount = 0;
    let sumSquares = 0;
    let stderr = '';
    let invalid = false;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Voiceover audio analysis timed out'));
    }, 120_000);
    const finishFrame = () => {
      levelsDbfs.push(20 * Math.log10(Math.max(1e-6, Math.sqrt(sumSquares / frameCount))));
      frameCount = 0;
      sumSquares = 0;
    };
    child.stdout.on('data', (chunk: Buffer) => {
      const bytes = remainder.length ? Buffer.concat([remainder, chunk]) : chunk;
      const end = bytes.length - bytes.length % 4;
      for (let offset = 0; offset < end; offset += 4) {
        const sample = bytes.readFloatLE(offset);
        if (!Number.isFinite(sample)) invalid = true;
        sumSquares += sample * sample;
        sampleCount++;
        frameCount++;
        if (frameCount === samplesPerFrame) finishFrame();
      }
      remainder = Buffer.from(bytes.subarray(end));
    });
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-2000); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0 || invalid || remainder.length || !sampleCount) {
        reject(new Error(`Cannot decode voiceover audio: ${stderr || `exit ${code}`}`));
        return;
      }
      if (frameCount) finishFrame();
      resolve({ frameMs: 10, durationMs: sampleCount * 1000 / sampleRate, levelsDbfs });
    });
  });
}
