import { access, readFile, readdir } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import type { EColorSourceProfile } from '../../protocol/schema.js';

export interface IColorSourceTruth {
  logProfile?: EColorSourceProfile;
  /** Enable request from explicit per-file evidence; not proof of successful OFX loading. */
  gyro?: boolean;
  /** Motion-data declaration, independent from the enable request. Missing evidence is unknown. */
  gyroDataAvailable?: boolean;
  deviceFamilyKeys: string[];
  sourceKinds: string[];
}

interface ISonySourceTruth {
  logProfile?: EColorSourceProfile;
  hasGyroscope?: boolean;
}

export async function extractColorSourceTruth(
  filePath: string,
  _tools?: unknown,
): Promise<IColorSourceTruth> {
  const sourceKinds = new Set<string>();

  const sonySidecarTruth = await extractSonySidecarTruth(filePath);
  if (sonySidecarTruth.logProfile) sourceKinds.add('sony-sidecar-xml');
  if (sonySidecarTruth.hasGyroscope) sourceKinds.add('sony-sidecar-xml');

  const hasGyroflowProject = await hasGyroflowProjectForFile(filePath);
  if (hasGyroflowProject) {
    sourceKinds.add('gyroflow-project');
  }

  const logProfile = sonySidecarTruth.logProfile;
  const gyroDataAvailable = sonySidecarTruth.hasGyroscope;
  const gyro = (hasGyroflowProject || gyroDataAvailable === true) || undefined;
  return {
    logProfile,
    gyro,
    gyroDataAvailable,
    deviceFamilyKeys: [],
    sourceKinds: [...sourceKinds],
  };
}

async function extractSonySidecarTruth(filePath: string): Promise<ISonySourceTruth> {
  const xml = await readSonySidecarXml(filePath);
  if (!xml) return {};

  const acquisitionItems = new Map<string, string>();
  for (const match of xml.matchAll(/<Item\b[^>]*name="([^"]+)"[^>]*value="([^"]*)"/gu)) {
    const key = match[1]?.trim();
    const value = match[2]?.trim();
    if (!key || !value) continue;
    acquisitionItems.set(key, value);
  }

  return {
    logProfile: normalizeColorSourceProfile(
      acquisitionItems.get('CaptureGammaEquation')
      ?? acquisitionItems.get('CodingEquations'),
    ),
    hasGyroscope: /<ChangeTable\b[^>]*name="Gyroscope"/iu.test(xml) || undefined,
  };
}

async function readSonySidecarXml(filePath: string): Promise<string | undefined> {
  const extension = extname(filePath);
  const stem = extension ? filePath.slice(0, -extension.length) : filePath;
  const directory = dirname(filePath);
  const baseName = stem.slice(directory.length > 1 ? directory.length + 1 : 0);
  const candidates = [
    `${stem}M01.XML`,
    `${stem}.XML`,
    join(directory, `${baseName}M01.XML`),
    join(directory, `${baseName}.XML`),
  ];
  for (const candidate of [...new Set(candidates)]) {
    const xml = await readFile(candidate, 'utf-8').catch(() => null);
    if (typeof xml === 'string' && xml.trim()) {
      return xml;
    }
  }
  return undefined;
}

async function hasGyroflowProjectForFile(filePath: string): Promise<boolean> {
  const extension = extname(filePath);
  const stem = extension ? filePath.slice(0, -extension.length) : filePath;
  if (await fileExists(`${stem}.gyroflow`)) {
    return true;
  }

  const directory = dirname(filePath);
  const baseName = stem.slice(directory.length > 1 ? directory.length + 1 : 0);
  const entries = await readdir(directory).catch(() => []);
  return entries.some(entry => (
    entry.startsWith(baseName)
    && entry.toLowerCase().endsWith('.gyroflow')
  ));
}

async function fileExists(filePath: string): Promise<boolean> {
  return access(filePath).then(() => true, () => false);
}

function normalizeColorSourceProfile(value: string | undefined): EColorSourceProfile | undefined {
  const normalized = value?.trim().toLowerCase() || '';
  if (!normalized) return undefined;
  if (/s[\s-]?log3/iu.test(normalized)) return 'slog3';
  if (/d[\s-]?log(?![\s-]?m)/iu.test(normalized)) return 'dlog';
  if (/d[\s-]?log[\s-]?m/iu.test(normalized)) return 'dlog-m';
  if (/\bhlg\b/iu.test(normalized)) return 'hlg';
  if (/rec[\s.-]?709/iu.test(normalized)) return 'rec709';
  return undefined;
}
