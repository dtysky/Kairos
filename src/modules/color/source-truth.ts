import { execFile } from 'node:child_process';
import { access, readFile, readdir } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { promisify } from 'node:util';
import { toExecutableInputPath } from '../media/tool-path.js';
import type { IMediaToolConfig } from '../media/probe.js';
import type { EColorSourceProfile } from '../../protocol/schema.js';

const exec = promisify(execFile);

export interface IColorSourceTruth {
  logProfile?: EColorSourceProfile;
  gyro?: boolean;
  deviceFamilyKeys: string[];
  sourceKinds: string[];
}

interface IExiftoolLine {
  group: string;
  key: string;
  value: string;
}

interface ISonySourceTruth {
  logProfile?: EColorSourceProfile;
  hasGyroscope?: boolean;
  deviceModel?: string;
}

interface IDjiSourceTruth {
  logProfile?: EColorSourceProfile;
  gyro?: boolean;
  deviceFamilyKeys: string[];
}

export async function extractColorSourceTruth(
  filePath: string,
  tools?: Pick<IMediaToolConfig, 'exiftoolPath'>,
): Promise<IColorSourceTruth> {
  const lines = await readExiftoolLines(filePath, tools).catch(() => []);
  const sourceKinds = new Set<string>();

  const sonyTruth = extractSonyTruth(lines);
  const sonySidecarTruth = await extractSonySidecarTruth(filePath);
  if (sonyTruth.logProfile) sourceKinds.add('sony-acquisition-record');
  if (sonyTruth.hasGyroscope) sourceKinds.add('sony-acquisition-record');
  if (sonySidecarTruth.logProfile) sourceKinds.add('sony-sidecar-xml');
  if (sonySidecarTruth.hasGyroscope) sourceKinds.add('sony-sidecar-xml');

  const hasDjiPrivateMetadata = lines.some(line => (
    line.key.toLowerCase() === 'protocol' && line.value.toLowerCase().includes('dvtm_')
  ) || line.key.toLowerCase().includes('dvtm_'));
  if (hasDjiPrivateMetadata) {
    sourceKinds.add('dji-private-video-metadata');
  }
  const djiTruth: IDjiSourceTruth = hasDjiPrivateMetadata
    ? extractDjiPrivateTruth(lines)
    : { deviceFamilyKeys: [] };
  if (djiTruth.logProfile) {
    sourceKinds.add('dji-private-video-metadata');
  }

  const hasGyroflowProject = await hasGyroflowProjectForFile(filePath);
  if (hasGyroflowProject) {
    sourceKinds.add('gyroflow-project');
  }

  const logProfile = sonyTruth.logProfile ?? sonySidecarTruth.logProfile ?? djiTruth.logProfile;
  const gyro = shouldEnableGyroForClip({
    hasGyroflowProject,
    sonyTruth,
    sonySidecarTruth,
    djiTruth,
  }) || undefined;
  return {
    logProfile,
    gyro,
    deviceFamilyKeys: djiTruth.deviceFamilyKeys ?? [],
    sourceKinds: [...sourceKinds],
  };
}

async function readExiftoolLines(
  filePath: string,
  tools?: Pick<IMediaToolConfig, 'exiftoolPath'>,
): Promise<IExiftoolLine[]> {
  const exiftool = tools?.exiftoolPath?.trim() || 'exiftool';
  const inputPath = toExecutableInputPath(filePath, exiftool);
  const { stdout } = await exec(exiftool, [
    '-ee',
    '-a',
    '-u',
    '-G1',
    '-s',
    inputPath,
  ], {
    env: buildStableToolExecEnv(),
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout
    .split(/\r?\n/gu)
    .map(parseExiftoolLine)
    .filter((line): line is IExiftoolLine => Boolean(line));
}

function parseExiftoolLine(line: string): IExiftoolLine | null {
  const match = line.match(/^\[([^\]]+)\]\s+([^:]+?)\s*:\s*(.*)$/u);
  if (!match) return null;
  const group = match[1]?.trim();
  const key = match[2]?.trim();
  const value = match[3]?.trim();
  if (!group || !key || !value) return null;
  return { group, key, value };
}

function extractSonyTruth(lines: IExiftoolLine[]): ISonySourceTruth {
  const acquisitionItems = new Map<string, string>();
  for (let index = 0; index < lines.length; index += 1) {
    const current = lines[index];
    const next = lines[index + 1];
    if (!current || !next) continue;
    if (current.key !== 'AcquisitionRecordGroupItemName' || next.key !== 'AcquisitionRecordGroupItemValue') {
      continue;
    }
    acquisitionItems.set(current.value, next.value);
  }

  return {
    logProfile: normalizeColorSourceProfile(
      acquisitionItems.get('CaptureGammaEquation')
      ?? acquisitionItems.get('CodingEquations'),
    ),
    hasGyroscope: lines.some(line => (
      line.key === 'AcquisitionRecordChangeTableName'
      && line.value.toLowerCase() === 'gyroscope'
    )) || undefined,
    deviceModel: firstLineValue(lines, ['DeviceModelName', 'Model']),
  };
}

function extractDjiPrivateTruth(lines: IExiftoolLine[]): IDjiSourceTruth {
  const privateLines = lines.filter(line => (
    line.key.toLowerCase() === 'protocol'
    || line.key.toLowerCase().includes('dvtm_')
    || line.key.toLowerCase().includes('model')
    || line.key.toLowerCase().includes('product')
    || line.key.toLowerCase().includes('camera')
    || line.group.toLowerCase().includes('dji')
    || line.group.toLowerCase().includes('microsoft')
  ));
  const logProfile = extractExplicitLogProfile(privateLines);
  const hasDjiTelemetryProtocol = privateLines.some(line => (
    line.key.toLowerCase() === 'protocol'
    && /^dvtm_/iu.test(line.value.trim())
  ));
  const hasDjiMotionMetadata = hasDjiTelemetryProtocol
    || privateLines.some(line => line.key.toLowerCase().includes('dvtm_'));
  const deviceFamilyKeys = extractDeviceFamilyKeys(privateLines);
  const gyro = (
    hasDjiMotionMetadata
    && deviceFamilyKeys.some(key => SUPPORTED_GYROFLOW_DJI_DEVICE_KEYS.has(key))
  ) || undefined;
  return {
    logProfile,
    gyro,
    deviceFamilyKeys,
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

function shouldEnableSonyGyro(
  sourceTruth: ISonySourceTruth,
  sidecarTruth: ISonySourceTruth,
): boolean {
  const deviceModel = sourceTruth.deviceModel ?? sidecarTruth.deviceModel;
  const hasGyroscope = sourceTruth.hasGyroscope === true || sidecarTruth.hasGyroscope === true;
  return hasGyroscope && isSupportedGyroflowSonyModel(deviceModel);
}

function shouldEnableGyroForClip(input: {
  hasGyroflowProject: boolean;
  sonyTruth: ISonySourceTruth;
  sonySidecarTruth: ISonySourceTruth;
  djiTruth: IDjiSourceTruth;
}): boolean {
  return input.hasGyroflowProject
    || shouldEnableSonyGyro(input.sonyTruth, input.sonySidecarTruth)
    || input.djiTruth.gyro === true;
}

function firstLineValue(lines: IExiftoolLine[], keys: string[]): string | undefined {
  const keySet = new Set(keys);
  return lines.find(line => keySet.has(line.key))?.value;
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

function extractExplicitLogProfile(lines: IExiftoolLine[]): EColorSourceProfile | undefined {
  for (const line of lines) {
    const candidate = normalizeColorSourceProfile(`${line.key} ${line.value}`);
    if (candidate) return candidate;
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

function extractDeviceFamilyKeys(lines: IExiftoolLine[]): string[] {
  const candidates = lines.flatMap(line => buildDeviceCandidateStrings(line));
  const matchedKeys: string[] = [];
  for (const matcher of COLOR_DEVICE_FAMILY_MATCHERS) {
    if (candidates.some(candidate => matcher.patterns.some(pattern => pattern.test(candidate)))) {
      matchedKeys.push(matcher.key);
    }
  }
  return matchedKeys;
}

function buildDeviceCandidateStrings(line: IExiftoolLine): string[] {
  const parts = [
    line.group,
    line.key,
    line.value,
    `${line.key} ${line.value}`,
  ].filter(Boolean);
  return [...new Set(parts.map(part => normalizeDeviceCandidateString(part)))];
}

function normalizeDeviceCandidateString(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\.proto\b/gu, '')
    .replace(/[^a-z0-9]+/gu, '');
}

const COLOR_DEVICE_FAMILY_MATCHERS: Array<{
  key: string;
  patterns: RegExp[];
}> = [
  {
    key: 'Action5',
    patterns: [
      /osmoaction5/u,
      /action5/u,
    ],
  },
  {
    key: 'Action4',
    patterns: [
      /osmoaction4/u,
      /action4/u,
    ],
  },
  {
    key: 'Action2',
    patterns: [
      /osmoaction2/u,
      /action2/u,
    ],
  },
  {
    key: 'Avata2',
    patterns: [
      /djiavata2/u,
      /^avata2$/u,
    ],
  },
  {
    key: 'Avata',
    patterns: [
      /djiavata(?!2)/u,
      /^avata$/u,
    ],
  },
  {
    key: 'O3AirUnit',
    patterns: [
      /o3airunit/u,
    ],
  },
  {
    key: 'Neo',
    patterns: [
      /djineo/u,
      /^neo$/u,
    ],
  },
  {
    key: 'Mavic4',
    patterns: [
      /mavic4pro/u,
      /mavic4/u,
      /dvtmmavic4/u,
      /l3d100c/u,
    ],
  },
  {
    key: 'Action6',
    patterns: [
      /osmoaction6/u,
      /action6/u,
    ],
  },
];

const SUPPORTED_GYROFLOW_DJI_DEVICE_KEYS = new Set([
  'Action2',
  'Action4',
  'Action5',
  'Avata',
  'Avata2',
  'O3AirUnit',
  'Neo',
]);

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

function buildStableToolExecEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    LC_ALL: 'C',
    LANG: 'C',
    LC_CTYPE: 'C',
  };
}
