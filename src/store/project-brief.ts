export interface IProjectBriefTemplateInput {
  name: string;
  description?: string;
  createdAt?: string;
}

export interface IProjectBriefPathMapping {
  path: string;
  description: string;
}

export interface IParsedProjectBrief {
  name?: string;
  description?: string;
  createdAt?: string;
  mappings: IProjectBriefPathMapping[];
  warnings: string[];
}

export function buildProjectBriefTemplate(
  input: IProjectBriefTemplateInput,
): string {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const description = input.description?.trim() || '（待填写）';

  return [
    `# ${input.name}`,
    '',
    `- 项目说明：${description}`,
    `- 创建日期：${createdAt}`,
    '- 当前状态：已初始化，待登记素材源与设备路径映射',
    '',
    '## 路径映射',
    '',
    '路径：',
    '说明：',
    '',
    '路径：',
    '说明：',
    '',
  ].join('\n');
}

export function parseProjectBrief(content: string): IParsedProjectBrief {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const warnings: string[] = [];

  let name: string | undefined;
  let description: string | undefined;
  let createdAt: string | undefined;

  const mappings: IProjectBriefPathMapping[] = [];
  let inMappings = false;
  let pendingPath: string | null = null;
  let pendingDescription: string | null = null;
  let expectPathValue = false;
  let expectDescriptionValue = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith('# ')) {
      name = line.slice(2).trim() || name;
      continue;
    }

    if (line.startsWith('- 项目说明：')) {
      description = line.slice('- 项目说明：'.length).trim() || description;
      continue;
    }

    if (line.startsWith('- 创建日期：')) {
      createdAt = line.slice('- 创建日期：'.length).trim() || createdAt;
      continue;
    }

    if (line === '## 路径映射') {
      inMappings = true;
      continue;
    }

    if (!inMappings) continue;

    if (line.startsWith('## ')) break;

    if (line.startsWith('路径：')) {
      pushPendingMapping(mappings, warnings, pendingPath, pendingDescription);
      pendingPath = null;
      pendingDescription = null;

      const value = line.slice('路径：'.length).trim();
      if (value) {
        pendingPath = value;
        expectPathValue = false;
      } else {
        expectPathValue = true;
      }
      expectDescriptionValue = false;
      continue;
    }

    if (line.startsWith('说明：')) {
      const value = line.slice('说明：'.length).trim();
      if (value) {
        pendingDescription = value;
        expectDescriptionValue = false;
      } else {
        expectDescriptionValue = true;
      }

      if (pendingPath && pendingDescription) {
        pushPendingMapping(mappings, warnings, pendingPath, pendingDescription);
        pendingPath = null;
        pendingDescription = null;
      }
      continue;
    }

    if (expectPathValue) {
      pendingPath = line;
      expectPathValue = false;
      continue;
    }

    if (expectDescriptionValue) {
      pendingDescription = line;
      expectDescriptionValue = false;
      if (pendingPath && pendingDescription) {
        pushPendingMapping(mappings, warnings, pendingPath, pendingDescription);
        pendingPath = null;
        pendingDescription = null;
      }
      continue;
    }
  }

  pushPendingMapping(mappings, warnings, pendingPath, pendingDescription);

  const duplicatePaths = findDuplicatePaths(mappings);
  for (const path of duplicatePaths) {
    warnings.push(`路径映射中存在重复路径：${path}`);
  }

  return {
    name,
    description,
    createdAt,
    mappings,
    warnings,
  };
}

export function normalizeProjectBriefLocalPath(path: string): string {
  const trimmed = path.trim();
  if (process.platform === 'win32') return trimmed;

  const winMatch = trimmed.match(/^([a-zA-Z]):[\\/](.*)$/);
  if (!winMatch) return trimmed.replace(/\\/g, '/');

  const drive = winMatch[1].toLowerCase();
  const rest = winMatch[2].replace(/[\\/]+/g, '/');
  return `/mnt/${drive}/${rest}`;
}

function pushPendingMapping(
  out: IProjectBriefPathMapping[],
  warnings: string[],
  path: string | null,
  description: string | null,
): void {
  if (!path && !description) return;
  if (!path) {
    warnings.push('存在缺少路径的路径映射条目。');
    return;
  }
  if (!description) {
    warnings.push(`路径映射缺少说明：${path}`);
    out.push({ path, description: '（待补充说明）' });
    return;
  }
  out.push({ path, description });
}

function findDuplicatePaths(
  mappings: IProjectBriefPathMapping[],
): string[] {
  const counts = new Map<string, number>();
  for (const mapping of mappings) {
    const key = mapping.path.trim().toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return mappings
    .map(mapping => mapping.path)
    .filter((path, index, all) => {
      const key = path.trim().toLowerCase();
      return (counts.get(key) ?? 0) > 1 && all.findIndex(item => item.trim().toLowerCase() === key) === index;
    });
}
