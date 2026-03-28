import { writeFile } from 'node:fs/promises';
import type { IKtepSubtitle } from '../../protocol/schema.js';

/**
 * 导出 SRT 字幕文件。
 */
export async function exportSrt(
  cues: IKtepSubtitle[],
  outputPath: string,
): Promise<void> {
  const content = formatSrt(cues);
  await writeFile(outputPath, content, 'utf-8');
}

export function formatSrt(cues: IKtepSubtitle[]): string {
  const sorted = [...cues].sort((a, b) => a.startMs - b.startMs);
  return sorted.map((cue, i) => {
    const start = msToSrtTime(cue.startMs);
    const end = msToSrtTime(cue.endMs);
    return `${i + 1}\n${start} --> ${end}\n${cue.text}\n`;
  }).join('\n');
}

/**
 * 导出 WebVTT 字幕文件。
 */
export async function exportVtt(
  cues: IKtepSubtitle[],
  outputPath: string,
): Promise<void> {
  const content = formatVtt(cues);
  await writeFile(outputPath, content, 'utf-8');
}

export function formatVtt(cues: IKtepSubtitle[]): string {
  const sorted = [...cues].sort((a, b) => a.startMs - b.startMs);
  const lines = ['WEBVTT\n'];
  for (const cue of sorted) {
    const start = msToVttTime(cue.startMs);
    const end = msToVttTime(cue.endMs);
    lines.push(`${start} --> ${end}\n${cue.text}\n`);
  }
  return lines.join('\n');
}

function msToSrtTime(ms: number): string {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const f = ms % 1000;
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(f, 3)}`;
}

function msToVttTime(ms: number): string {
  return msToSrtTime(ms).replace(',', '.');
}

function pad(n: number, len: number): string {
  return String(n).padStart(len, '0');
}
