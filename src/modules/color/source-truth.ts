import { access, readFile, readdir } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import type { EColorSourceProfile } from '../../protocol/schema.js';

export interface IColorSourceTruth {
  logProfile?: EColorSourceProfile;
  gyro?: boolean;
  deviceFamilyKeys: string[];
  sourceKinds: string[];
}

interface ISonySourceTruth {
  logProfile?: EColorSourceProfile;
  hasGyroscope?: boolean;
  deviceModel?: string;
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
  const gyro = shouldEnableGyroForClip({
    hasGyroflowProject,
    sonySidecarTruth,
  }) || undefined;
  return {
    logProfile,
    gyro,
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
    deviceModel: extractSonyXmlDeviceModel(xml),
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

function shouldEnableSonyGyro(sidecarTruth: ISonySourceTruth): boolean {
  const deviceModel = sidecarTruth.deviceModel;
  const hasGyroscope = sidecarTruth.hasGyroscope === true;
  return hasGyroscope && isSupportedGyroflowSonyModel(deviceModel);
}

function shouldEnableGyroForClip(input: {
  hasGyroflowProject: boolean;
  sonySidecarTruth: ISonySourceTruth;
}): boolean {
  return input.hasGyroflowProject
    || shouldEnableSonyGyro(input.sonySidecarTruth);
}

function extractSonyXmlDeviceModel(xml: string): string | undefined {
  const patterns = [
    /<Device\b[^>]*\bmodelName="([^"]+)"/iu,
    /\bDeviceModelName="([^"]+)"/iu,
    /<DeviceModelName\b[^>]*>([^<]+)<\/DeviceModelName>/iu,
  ];
  for (const pattern of patterns) {
    const match = xml.match(pattern);
    const value = match?.[1]?.trim();
    if (value) return value;
  }
  return undefined;
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

function normalizeDeviceCandidateString(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\.proto\b/gu, '')
    .replace(/[^a-z0-9]+/gu, '');
}

const SUPPORTED_GYROFLOW_SONY_MODEL_PATTERNS = [
  /^(ilce)?1$/u,
  /^(ilce)?7c$/u,
  /^(ilce)?7rm5$/u,
  /^a7rv$/u,
  /^(ilce)?7m4$/u,
  /^a7iv$/u,
  /^(ilce)?7sm3$/u,
  /^a7siii$/u,
  /^(ilce)?9m2$/u,
  /^a9ii$/u,
  /^(ilce)?9m3$/u,
  /^a9iii$/u,
  /^ilmefx3$/u,
  /^fx3$/u,
  /^ilmefx6$/u,
  /^fx6$/u,
  /^ilmefx9$/u,
  /^fx9$/u,
  /^dscrx0m2$/u,
  /^rx0ii$/u,
  /^dscrx100m7$/u,
  /^rx100vii$/u,
  /^zv1$/u,
  /^zve10$/u,
  /^zve10m2$/u,
  /^zve1$/u,
  /^(ilce)?6700$/u,
  /^a6700$/u,
];

function isSupportedGyroflowSonyModel(model: string | undefined): boolean {
  const normalized = normalizeDeviceCandidateString(model ?? '');
  return normalized.length > 0
    && SUPPORTED_GYROFLOW_SONY_MODEL_PATTERNS.some(pattern => pattern.test(normalized));
}
