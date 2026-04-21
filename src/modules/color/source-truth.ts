import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { promisify } from 'node:util';
import { toExecutableInputPath } from '../media/tool-path.js';
import type { IMediaToolConfig } from '../media/probe.js';
import type { EColorSourceProfile } from '../../protocol/schema.js';

const exec = promisify(execFile);

export interface IColorSourceTruth {
  logProfile?: EColorSourceProfile;
  gyro?: boolean;
  lowlight?: boolean;
  deviceFamilyKeys: string[];
  sourceKinds: string[];
}

interface IExiftoolLine {
  group: string;
  key: string;
  value: string;
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
  if (sonyTruth.gyro) sourceKinds.add('sony-acquisition-record');
  if (sonySidecarTruth.logProfile) sourceKinds.add('sony-sidecar-xml');
  if (sonySidecarTruth.gyro) sourceKinds.add('sony-sidecar-xml');

  const hasDjiPrivateMetadata = lines.some(line => (
    line.key.toLowerCase() === 'protocol' && line.value.toLowerCase().includes('dvtm_')
  ) || line.key.toLowerCase().includes('dvtm_'));
  if (hasDjiPrivateMetadata) {
    sourceKinds.add('dji-private-video-metadata');
  }
  const djiTruth = hasDjiPrivateMetadata
    ? extractDjiPrivateTruth(lines)
    : {};
  if (djiTruth.logProfile) {
    sourceKinds.add('dji-private-video-metadata');
  }

  const logProfile = sonyTruth.logProfile ?? sonySidecarTruth.logProfile ?? djiTruth.logProfile;
  const gyro = sonyTruth.gyro || sonySidecarTruth.gyro || djiTruth.gyro || undefined;
  const lowlight = sonyTruth.lowlight || sonySidecarTruth.lowlight || djiTruth.lowlight || undefined;

  return {
    logProfile,
    gyro,
    lowlight,
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

function extractSonyTruth(lines: IExiftoolLine[]): Partial<IColorSourceTruth> {
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
    gyro: lines.some(line => (
      line.key === 'AcquisitionRecordChangeTableName'
      && line.value.toLowerCase() === 'gyroscope'
    )) || undefined,
  };
}

function extractDjiPrivateTruth(lines: IExiftoolLine[]): Partial<IColorSourceTruth> {
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
  const gyro = privateLines.some(line => /gyro|gimbal/iu.test(`${line.key} ${line.value}`)) || undefined;
  const deviceFamilyKeys = extractDeviceFamilyKeys(privateLines);
  return {
    logProfile,
    gyro,
    deviceFamilyKeys,
  };
}

async function extractSonySidecarTruth(filePath: string): Promise<Partial<IColorSourceTruth>> {
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
    gyro: /<ChangeTable\b[^>]*name="Gyroscope"/iu.test(xml) || undefined,
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

function buildStableToolExecEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    LC_ALL: 'C',
    LANG: 'C',
    LC_CTYPE: 'C',
  };
}
