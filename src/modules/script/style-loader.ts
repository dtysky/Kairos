import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  IArrangementBias,
  IStyleArrangementStructure,
  IStyleCatalog,
  IStyleCatalogEntry,
  IStyleFunctionBlock,
  IStyleProfile,
  IStyleSection,
  IStyleSegmentArchetype,
  IStyleTransitionRule,
} from '../../protocol/schema.js';

export interface IStyleLoadOptions {
  name?: string;
  category?: string;
  guidancePrompt?: string;
}

/**
 * 从 markdown 文件加载风格档案。
 * 将 h2 章节拆为 sections，提取结构化参数。
 * 支持 front-matter 中的 category 和 guidancePrompt。
 */
export async function loadStyleFromMarkdown(
  filePath: string,
  options?: string | IStyleLoadOptions,
): Promise<IStyleProfile> {
  const raw = await readFile(filePath, 'utf-8');
  const opts: IStyleLoadOptions = typeof options === 'string'
    ? { name: options }
    : options ?? {};
  return parseStyleMarkdown(raw, opts, [filePath]);
}

/**
 * 从分类目录加载指定类别的风格档案。
 */
export async function loadStyleByCategory(
  stylesDir: string,
  category: string,
): Promise<IStyleProfile | null> {
  const catalogPath = join(stylesDir, 'catalog.json');
  try {
    const catalogRaw = await readFile(catalogPath, 'utf-8');
    const catalog: IStyleCatalog = JSON.parse(catalogRaw);
    const entry = catalog.entries.find(e => e.category === category);
    if (!entry) return null;
    return loadStyleFromMarkdown(join(stylesDir, entry.profilePath), {
      category: entry.category,
      name: entry.name,
    });
  } catch {
    const mdPath = join(stylesDir, `${category}.md`);
    try {
      return await loadStyleFromMarkdown(mdPath, { category });
    } catch {
      return null;
    }
  }
}

/**
 * 列出所有可用的风格分类。
 */
export async function listStyleCategories(
  stylesDir: string,
): Promise<IStyleCatalogEntry[]> {
  const catalogPath = join(stylesDir, 'catalog.json');
  try {
    const raw = await readFile(catalogPath, 'utf-8');
    const catalog: IStyleCatalog = JSON.parse(raw);
    return catalog.entries;
  } catch {
    const files = await readdir(stylesDir).catch(() => []);
    return files
      .filter(f => f.endsWith('.md'))
      .map(f => {
        const category = f.replace(/\.md$/, '');
        return {
          id: category,
          category,
          name: category,
          profilePath: f,
          sourceVideoCount: 0,
          createdAt: '',
          updatedAt: '',
        };
      });
  }
}

export function parseStyleMarkdown(
  markdown: string,
  options?: IStyleLoadOptions,
  sourceFiles: string[] = [],
): IStyleProfile {
  const { body, frontMatter } = extractFrontMatter(markdown);
  const sections = splitSections(body);
  const params = extractParameters(body);
  const antiPatterns = extractAntiPatterns(sections);
  const narrative = extractNarrative(params);
  const voice = extractVoice(params);
  const derived = deriveStyleProtocolV2Fields(sections, params, antiPatterns);
  const now = new Date().toISOString();

  return {
    id: randomUUID(),
    name: options?.name ?? frontMatter['name'] ?? extractTitle(body) ?? '风格档案',
    category: options?.category ?? frontMatter['category'],
    guidancePrompt: options?.guidancePrompt ?? frontMatter['guidancePrompt'],
    sourceFiles,
    narrative,
    voice,
    rawReference: markdown,
    sections,
    antiPatterns,
    parameters: params,
    arrangementBias: derived.arrangementBias,
    arrangementStructure: derived.arrangementStructure,
    segmentArchetypes: derived.segmentArchetypes,
    transitionRules: derived.transitionRules,
    functionBlocks: derived.functionBlocks,
    globalConstraints: derived.globalConstraints,
    createdAt: now,
    updatedAt: now,
  };
}

export function deriveStyleProtocolV2Fields(
  sections: IStyleSection[],
  parameters: Record<string, string>,
  antiPatterns: string[] = [],
): {
  arrangementBias: IArrangementBias;
  arrangementStructure: IStyleArrangementStructure;
  segmentArchetypes: IStyleSegmentArchetype[];
  transitionRules: IStyleTransitionRule[];
  functionBlocks: IStyleFunctionBlock[];
  globalConstraints: string[];
} {
  const segmentArchetypes = buildSegmentArchetypes(sections, parameters);
  const transitionRules = buildTransitionRules(segmentArchetypes);
  const functionBlocks = buildFunctionBlocks(sections, parameters, antiPatterns);
  const arrangementBias = buildArrangementBias(parameters, sections);
  const arrangementStructure = buildArrangementStructure(sections, parameters);
  const globalConstraints = dedupeStrings([
    ...(antiPatterns ?? []),
    parameters['全局约束'],
    parameters['段落禁区'],
    parameters['镜头禁区'],
  ]);

  return {
    arrangementBias,
    arrangementStructure,
    segmentArchetypes,
    transitionRules,
    functionBlocks,
    globalConstraints,
  };
}

function extractFrontMatter(md: string): { body: string; frontMatter: Record<string, string> } {
  const match = md.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
  if (!match) return { body: md, frontMatter: {} };

  const fm: Record<string, string> = {};
  const lines = match[1].split('\n');
  let i = 0;
  while (i < lines.length) {
    const kv = lines[i].match(/^(\w+)\s*:\s*(.*)$/);
    if (!kv) { i++; continue; }

    const key = kv[1].trim();
    const inlineVal = kv[2].trim();

    if (inlineVal === '|' || inlineVal === '>') {
      const collected: string[] = [];
      i++;
      while (i < lines.length && /^\s+/.test(lines[i])) {
        collected.push(lines[i].replace(/^\s{2}/, ''));
        i++;
      }
      fm[key] = inlineVal === '>'
        ? collected.join(' ').trim()
        : collected.join('\n').trim();
    } else {
      fm[key] = inlineVal;
      i++;
    }
  }
  return { body: md.slice(match[0].length), frontMatter: fm };
}

/**
 * Serialize key-value pairs into YAML-like front-matter.
 * Multi-line values use block literal (|) syntax.
 */
export function buildFrontMatter(fields: Record<string, string | undefined>): string {
  const lines: string[] = ['---'];
  for (const [key, val] of Object.entries(fields)) {
    if (val == null) continue;
    if (val.includes('\n')) {
      lines.push(`${key}: |`);
      for (const line of val.split('\n')) {
        lines.push(`  ${line}`);
      }
    } else {
      lines.push(`${key}: ${val}`);
    }
  }
  lines.push('---', '');
  return lines.join('\n');
}

function extractTitle(md: string): string | null {
  const m = md.match(/^#\s+(.+)/m);
  return m ? m[1].trim() : null;
}

function splitSections(md: string): IStyleSection[] {
  const parts = md.split(/^##\s+/m).slice(1);
  return parts.map((part, i) => {
    const lines = part.split('\n');
    const title = lines[0].trim();
    const content = lines.slice(1).join('\n').trim();
    const tags = extractSectionTags(title);
    return {
      id: `section-${i + 1}`,
      title,
      content,
      tags,
    };
  });
}

function extractSectionTags(title: string): string[] {
  const tagMap: Record<string, string[]> = {
    '叙事': ['narrative', 'structure'],
    '语言': ['language', 'voice'],
    '情绪': ['emotion', 'mood'],
    '节奏': ['rhythm', 'editing', 'material-grammar'],
    '剪辑': ['rhythm', 'editing', 'material-grammar'],
    '摄影': ['photography', 'visual'],
    '画面': ['photography', 'visual'],
    '照片': ['photo', 'material-grammar'],
    '延时': ['timelapse', 'material-grammar'],
    '航拍': ['aerial', 'material-grammar'],
    '空镜': ['broll', 'material-grammar'],
    '素材编排': ['editing', 'material-grammar'],
    '主题': ['theme', 'values'],
    '价值': ['theme', 'values'],
    '结构': ['structure', 'template'],
    '模板': ['structure', 'template'],
    '禁区': ['anti-pattern', 'constraints'],
    '参数': ['parameters'],
    '风格': ['style'],
  };

  const tags: string[] = [];
  for (const [keyword, t] of Object.entries(tagMap)) {
    if (title.includes(keyword)) tags.push(...t);
  }
  return [...new Set(tags)];
}

function extractAntiPatterns(sections: IStyleSection[]): string[] {
  const antiSection = sections.find(s =>
    s.tags?.includes('anti-pattern') || s.title.includes('禁区') || s.title.includes('避免'),
  );
  if (!antiSection) return [];

  return antiSection.content
    .split('\n')
    .filter(line => /^\d+\.\s+\*\*/.test(line))
    .map(line => line.replace(/^\d+\.\s+/, '').replace(/\*\*/g, '').trim());
}

function extractParameters(md: string): Record<string, string> {
  const params: Record<string, string> = {};
  const lines = md.split('\n');
  const headerIndex = lines.findIndex(line => /^\|\s*参数\s*\|\s*值\s*\|$/.test(line.trim()));
  if (headerIndex < 0) return params;

  for (let i = headerIndex + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith('|')) break;
    const m = line.match(/^\|\s*(.+?)\s*\|\s*(.+?)\s*\|$/);
    if (m && !m[1].includes('---') && m[1].trim() !== '参数') {
      params[m[1].trim()] = m[2].trim();
    }
  }
  return params;
}

function extractNarrative(params: Record<string, string>): IStyleProfile['narrative'] {
  return {
    introRatio: parseNumberParam(params['开场占比']) ?? 0.08,
    outroRatio: parseNumberParam(params['结尾占比']) ?? 0.05,
    avgSegmentDurationSec: parseNumberParam(params['平均段落时长（秒）'] ?? params['平均段落时长']) ?? 25,
    brollFrequency: parseNumberParam(params['B-roll 频率'] ?? params['Broll 频率']) ?? 0.3,
    pacePattern: params['节奏模式'] ?? params['叙事结构'] ?? '线性叙事',
  };
}

function extractVoice(params: Record<string, string>): IStyleProfile['voice'] {
  const perspective = params['叙述视角'] ?? params['叙事视角'] ?? '';
  const density = parseDensity(params['语言密度']);
  return {
    person: (perspective.includes('2nd') || perspective.includes('第二') ? '2nd'
      : perspective.includes('3rd') || perspective.includes('第三') ? '3rd'
      : '1st') as '1st' | '2nd' | '3rd',
    tone: params['主语气'] ?? params['语言风调'] ?? params['语言风格'] ?? '平实',
    density,
    sampleTexts: [],
  };
}

function buildArrangementBias(
  parameters: Record<string, string>,
  sections: IStyleSection[],
): IArrangementBias {
  const text = [
    parameters['编排主轴'],
    parameters['段落组织方式'],
    ...sections
      .filter(section => section.title.includes('叙事') || section.title.includes('结构'))
      .map(section => section.content),
  ].filter(Boolean).join('\n');

  const preferredStrategies = dedupeStrings([
    /空间|地点|地理/u.test(text) ? 'space-first' : undefined,
    /时间|chronology|顺序/u.test(text) ? 'time-first' : undefined,
    /事件|冲突|桥段/u.test(text) ? 'event-first' : undefined,
  ]) as IArrangementBias['preferredStrategies'];

  return {
    preferredStrategies: preferredStrategies.length > 0 ? preferredStrategies : ['mixed'],
    notes: parameters['编排备注'],
  };
}

function buildArrangementStructure(
  sections: IStyleSection[],
  parameters: Record<string, string>,
): IStyleArrangementStructure {
  const organizationModes = dedupeStrings([
    parameters['组织模式'],
    parameters['段落组织方式'],
    parameters['编排主轴'],
    ...collectOrganizationModes(sections, parameters),
  ]);
  const explicitPrograms = collectArrangementPrograms(sections, parameters);
  const arrangementPrograms = explicitPrograms;
  return {
    organizationModes: organizationModes.length > 0 ? organizationModes : ['叙事段落驱动'],
    arrangementPrograms,
    bundlePreferenceNotes: sections
      .filter(section =>
        section.title.includes('素材')
        || section.title.includes('结构')
        || section.title.includes('编排')
        || section.title.includes('段落程序')
        || section.title.includes('组织程序'))
      .map(section => section.content.trim())
      .filter(Boolean)
      .slice(0, 6),
  };
}

function collectArrangementPrograms(
  sections: IStyleSection[],
  parameters: Record<string, string>,
): IStyleArrangementStructure['arrangementPrograms'] {
  const values = dedupeStrings([
    ...extractArrangementProgramLines(parameters['段落程序']),
    ...extractArrangementProgramLines(parameters['组织程序']),
    ...extractArrangementProgramLines(parameters['片头段落程序']),
    ...extractArrangementProgramLines(parameters['正文段落程序']),
    ...extractArrangementProgramLines(parameters['收尾段落程序']),
    ...sections
      .filter(section =>
        section.title.includes('段落程序')
        || section.title.includes('组织程序')
        || section.title.includes('片头结构')
        || section.title.includes('正文结构')
        || section.title.includes('收尾结构'))
      .flatMap(section => extractArrangementProgramLines(section.content)),
  ]);

  return values
    .filter(phrase => !/^组织模式[:：]/u.test(phrase))
    .map((phrase, index) => ({
    id: `program-${index + 1}-${toProgramSlug(phrase)}`,
    phrase,
    bundlePreferencePhrases: [],
    }));
}

function collectOrganizationModes(
  sections: IStyleSection[],
  parameters: Record<string, string>,
): string[] {
  const rawLines = [
    parameters['组织模式'],
    parameters['段落组织方式'],
    ...sections
      .filter(section => section.title.includes('段落程序') || section.title.includes('组织程序'))
      .flatMap(section => extractArrangementProgramLines(section.content)),
  ];
  return dedupeStrings(rawLines.flatMap(line => {
    if (!line) return [];
    const match = line.match(/^组织模式[:：]\s*(.+)$/u);
    return match?.[1] ? [match[1].trim()] : [];
  }));
}

function buildSegmentArchetypes(
  sections: IStyleSection[],
  parameters: Record<string, string>,
): IStyleSegmentArchetype[] {
  const signalText = buildStyleSignalText(sections, parameters);
  const candidates = [
    maybeCreateArchetypeFromSignal({
      signalText,
      keywords: ['开场', '引入', '开头', '建场'],
      id: 'opening-intro',
      name: '开场引入',
      functions: ['establish', 'geo-reset'],
      preferredMaterials: ['aerial', 'broll', 'timelapse'],
      preferredShotGrammar: ['aerial', 'locked-timelapse'],
      typicalTiming: 'opening',
      notes: collectMatchingSections(sections, ['开场', '引入', '开头']),
    }),
    maybeCreateArchetypeFromSignal({
      signalText,
      keywords: ['景点介绍', '地点介绍', '第三视角', '对镜讲解', '人物讲解'],
      id: 'poi-intro',
      name: '第三视角介绍',
      functions: ['info-delivery', 'geo-reset'],
      preferredMaterials: ['shot', 'talking-head', 'broll'],
      preferredShotGrammar: ['third-person-to-camera', 'handheld-observe'],
      typicalTiming: 'middle',
      notes: collectMatchingSections(sections, ['景点', '介绍', '第三视角']),
    }),
    maybeCreateArchetypeFromSignal({
      signalText,
      keywords: ['路途', '行车', '路线推进', '开车', '在路上'],
      id: 'route-advance',
      name: '路途推进',
      functions: ['route-advance', 'transition'],
      preferredMaterials: ['drive', 'aerial'],
      preferredShotGrammar: ['windshield-drive', 'car-interior-drive', 'follow-vehicle'],
      typicalTiming: 'middle',
      notes: collectMatchingSections(sections, ['路途', '行车', '推进']),
    }),
    maybeCreateArchetypeFromSignal({
      signalText,
      keywords: ['跟车', '跟人', '桥段连接', '空间过桥', '人物过桥'],
      id: 'bridge-follow',
      name: '过桥跟随',
      functions: ['transition', 'emotion-release'],
      preferredMaterials: ['aerial', 'shot', 'broll'],
      preferredShotGrammar: ['follow-vehicle', 'handheld-observe'],
      typicalTiming: 'bridge',
      notes: collectMatchingSections(sections, ['过渡', '跟车', '跟人', '桥']),
    }),
    maybeCreateArchetypeFromSignal({
      signalText,
      keywords: ['冲突', 'drama', '戏剧转折', '冲突桥段', '情节转折'],
      id: 'drama-turn',
      name: '冲突桥段',
      functions: ['conflict-event', 'conflict-foreshadow'],
      preferredMaterials: ['talking-head', 'shot', 'broll'],
      preferredShotGrammar: ['handheld-observe', 'walk-and-talk'],
      typicalTiming: 'middle',
      notes: collectMatchingSections(sections, ['冲突', 'drama', '转折', '桥段']),
    }),
    maybeCreateArchetypeFromSignal({
      signalText,
      keywords: ['延时', '拔升', '抬升', '时间流逝'],
      id: 'time-lift',
      name: '时间拔升',
      functions: ['time-passage', 'emotion-release'],
      preferredMaterials: ['timelapse', 'aerial'],
      preferredShotGrammar: ['locked-timelapse', 'pull-back'],
      typicalTiming: 'bridge',
      notes: collectMatchingSections(sections, ['延时', '拔升', '抬升']),
    }),
    maybeCreateArchetypeFromSignal({
      signalText,
      keywords: ['结尾', '收尾', '回落', '收束'],
      id: 'closure',
      name: '收束结尾',
      functions: ['arrival', 'emotion-release', 'transition'],
      preferredMaterials: ['aerial', 'broll', 'talking-head'],
      preferredShotGrammar: ['pull-back', 'third-person-to-camera'],
      typicalTiming: 'ending',
      notes: collectMatchingSections(sections, ['结尾', '收尾', '回落', '收束']),
    }),
  ].filter(Boolean) as IStyleSegmentArchetype[];

  if (candidates.length > 0) return candidates;

  return [{
    id: 'generic-observational',
    name: '通用观察式段落',
    functions: ['transition', 'info-delivery'],
    preferredShotGrammar: ['handheld-observe'],
    preferredViewpoints: [],
    preferredMaterials: ['shot', 'broll'],
    typicalTiming: 'middle',
    notes: parameters['段落组织方式'] ?? parameters['编排主轴'] ?? '未明确',
  }];
}

function buildTransitionRules(
  archetypes: IStyleSegmentArchetype[],
): IStyleTransitionRule[] {
  const ordered = archetypes.map(item => item.id);
  const transitions: IStyleTransitionRule[] = [];
  for (let i = 0; i < ordered.length - 1; i++) {
    transitions.push({
      from: ordered[i],
      to: ordered[i + 1],
      purpose: `${ordered[i]} -> ${ordered[i + 1]}`,
      preferredTransitions: derivePreferredTransitions(ordered[i], ordered[i + 1]),
    });
  }
  return transitions;
}

function buildFunctionBlocks(
  sections: IStyleSection[],
  parameters: Record<string, string>,
  antiPatterns: string[],
): IStyleFunctionBlock[] {
  const signalText = buildStyleSignalText(sections, parameters);
  const blocks: IStyleFunctionBlock[] = [];
  const pushBlock = (
    id: string,
    functions: string[],
    preferredMaterials: string[],
    preferredShotGrammar: string[],
    preferredTransitions: string[],
    timingBias?: IStyleFunctionBlock['timingBias'],
    notes?: string,
  ) => {
    blocks.push({
      id,
      functions,
      preferredShotGrammar,
      preferredMaterials,
      preferredTransitions,
      disallowedPatterns: antiPatterns.slice(0, 5),
      timingBias,
      notes,
    });
  };

  if (hasStyleSignal(signalText, ['开场', '引入', '建场'])) {
    pushBlock(
      'opening-establish',
      ['establish', 'geo-reset'],
      ['aerial', 'timelapse', 'broll'],
      ['aerial', 'locked-timelapse'],
      ['fade', 'cross-dissolve'],
      'opening',
      collectMatchingSections(sections, ['开场', '引入', '建场']),
    );
  }
  if (hasStyleSignal(signalText, ['行车', '路途', '路线推进', '开车', '在路上'])) {
    pushBlock(
      'route-advance',
      ['route-advance', 'transition'],
      ['drive', 'aerial'],
      ['windshield-drive', 'follow-vehicle'],
      ['cut', 'cross-dissolve'],
      'middle',
      parameters['行车素材职责'] ?? collectMatchingSections(sections, ['行车', '路途']),
    );
  }
  if (hasStyleSignal(signalText, ['延时', '拔升', '抬升', '时间流逝'])) {
    pushBlock(
      'time-lift',
      ['time-passage', 'emotion-release'],
      ['timelapse', 'aerial'],
      ['locked-timelapse', 'pull-back'],
      ['fade', 'cross-dissolve'],
      'bridge',
      parameters['延时使用关系'] ?? collectMatchingSections(sections, ['延时', '拔升']),
    );
  }
  if (hasStyleSignal(signalText, ['结尾', '收束', '回落', '收尾'])) {
    pushBlock(
      'closure',
      ['arrival', 'emotion-release'],
      ['aerial', 'broll', 'talking-head'],
      ['pull-back', 'third-person-to-camera'],
      ['fade'],
      'ending',
      collectMatchingSections(sections, ['结尾', '收束']),
    );
  }

  return blocks;
}

function maybeCreateArchetypeFromSignal(input: {
  signalText: string;
  keywords: string[];
  id: string;
  name: string;
  functions: string[];
  preferredMaterials: string[];
  preferredShotGrammar: string[];
  typicalTiming: IStyleSegmentArchetype['typicalTiming'];
  notes?: string;
}): IStyleSegmentArchetype | null {
  if (!hasStyleSignal(input.signalText, input.keywords)) {
    return null;
  }
  return createArchetypeFromHint(
    input.id,
    input.name,
    input.functions,
    input.preferredMaterials,
    input.preferredShotGrammar,
    input.typicalTiming,
    input.notes,
  );
}

function createArchetypeFromHint(
  id: string,
  name: string,
  functions: string[],
  preferredMaterials: string[],
  preferredShotGrammar: string[],
  typicalTiming: IStyleSegmentArchetype['typicalTiming'],
  notes?: string,
): IStyleSegmentArchetype {
  return {
    id,
    name,
    functions,
    preferredShotGrammar,
    preferredViewpoints: [],
    preferredMaterials,
    typicalTiming,
    notes,
  };
}

function extractArrangementProgramLines(text?: string): string[] {
  if (!text) return [];
  return text
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => line.replace(/^[-*]\s*/, '').replace(/^\d+[.)]\s*/, '').trim())
    .filter(line => line.length >= 6);
}

function toProgramSlug(phrase: string): string {
  const normalized = phrase
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return normalized.length > 0 ? normalized.slice(0, 40) : randomUUID();
}

function collectMatchingSections(sections: IStyleSection[], keywords: string[]): string | undefined {
  const values = sections
    .filter(section => keywords.some(keyword => section.title.includes(keyword) || section.content.includes(keyword)))
    .map(section => `${section.title}: ${section.content}`.trim())
    .filter(Boolean);
  return values.length > 0 ? values.slice(0, 2).join('\n\n') : undefined;
}

function buildStyleSignalText(
  sections: IStyleSection[],
  parameters: Record<string, string>,
): string {
  return [
    ...sections.map(section => `${section.title}\n${section.content}`),
    ...Object.entries(parameters).map(([key, value]) => `${key}: ${value}`),
  ].join('\n');
}

function hasStyleSignal(signalText: string, keywords: string[]): boolean {
  return keywords.some(keyword => containsPositiveStyleKeyword(signalText, keyword));
}

function containsPositiveStyleKeyword(signalText: string, keyword: string): boolean {
  const chunks = signalText
    .split(/[\n。！？；;]+/u)
    .map(chunk => chunk.trim())
    .filter(Boolean);

  for (const chunk of chunks) {
    let searchFrom = 0;
    while (searchFrom < chunk.length) {
      const index = chunk.indexOf(keyword, searchFrom);
      if (index < 0) break;
      const before = chunk.slice(Math.max(0, index - 8), index);
      if (!hasNegativeCueBeforeKeyword(before)) {
        return true;
      }
      searchFrom = index + keyword.length;
    }
  }

  return false;
}

function hasNegativeCueBeforeKeyword(context: string): boolean {
  return [
    '不做',
    '不要',
    '不想',
    '不该',
    '不宜',
    '不再',
    '不强调',
    '不主打',
    '不承担',
    '不需要',
    '无需',
    '无须',
    '避免',
    '禁止',
    '别把',
    '并非',
    '不是',
    '不能',
    '不会',
    '少用',
  ].some(cue => context.includes(cue));
}

function derivePreferredTransitions(from: string, to: string): string[] {
  if (from.includes('opening') || to.includes('closure')) return ['fade'];
  if (from.includes('time') || to.includes('time')) return ['cross-dissolve'];
  return ['cut'];
}

function dedupeStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.map(value => value?.trim()).filter(Boolean) as string[])];
}

function parseNumberParam(value?: string): number | undefined {
  if (!value) return undefined;
  const match = value.match(/-?\d+(?:\.\d+)?/);
  if (!match) return undefined;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseDensity(value?: string): 'low' | 'moderate' | 'high' {
  if (!value) return 'moderate';
  const normalized = value.trim().toLowerCase();
  if (normalized.includes('high') || normalized.includes('高')) return 'high';
  if (normalized.includes('low') || normalized.includes('低')) return 'low';
  return 'moderate';
}
