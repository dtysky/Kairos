import type {
  IDeviceMediaMapFile,
  IKtepAsset,
  IKtepClip,
  IKtepDoc,
  IKtepSubtitle,
  IKtepTimeline,
  IMediaRoot,
} from '../../protocol/schema.js';
import type { IRuntimeConfig } from '../../store/project.js';
import type { INleAdapter, INleCapabilities, INleIdMap } from './adapter.js';
import {
  buildJianyingDraftSpec,
  JianyingDraftBuilder,
  mapTransitionType,
  msToRange,
  msToTimeStr,
  normalizeMaterialPath,
  type IJianyingBuilderConfig,
  type IJianyingDraftBuildResult,
  type IJianyingDraftSpec,
} from './jianying-spec.js';
import {
  CPYJIANYINGDRAFT_COMPATIBILITY_MESSAGE,
  JianyingLocalRunner,
  type IJianyingExportResult,
  type IJianyingLocalConfig,
} from './jianying-local.js';

export interface IJianyingConfig extends IJianyingBuilderConfig, IJianyingLocalConfig {
  outputPath?: string;
  subtitleY?: number;
  subtitleSize?: number;
  mediaRoots?: IMediaRoot[];
  deviceMaps?: IDeviceMediaMapFile;
}

const CDEFAULTS: IJianyingConfig = {
  backend: 'pyjianyingdraft',
  subtitleY: -0.8,
  subtitleSize: 6.0,
};

/**
 * 剪映时间线应用器。
 * 它在 TypeScript 侧构建一个一次性的 Jianying 草稿 spec，
 * 然后交给本地 Python 后端直接写出 pyJianYingDraft 草稿。
 */
export class JianyingAdapter implements INleAdapter {
  readonly name = 'jianying';
  readonly capabilities: INleCapabilities = {
    subtitleTrack: true,
    transform: true,
    kenBurns: false,
    transition: true,
    nestedTimeline: false,
  };

  private config: IJianyingConfig;
  private builder: JianyingDraftBuilder;
  private runner: JianyingLocalRunner;
  private lastExportResult: IJianyingExportResult | null = null;

  constructor(config: Partial<IJianyingConfig> = {}) {
    this.config = { ...CDEFAULTS, ...config };
    this.builder = new JianyingDraftBuilder(this.config);
    this.runner = new JianyingLocalRunner(this.config);
  }

  async validate(doc: IKtepDoc): Promise<void> {
    await this.builder.validate(doc);
  }

  async ensureProject(projectName: string): Promise<void> {
    await this.builder.ensureProject(projectName);
  }

  async importAssets(assets: IKtepAsset[]): Promise<void> {
    await this.builder.importAssets(assets);
  }

  async createTimeline(timeline: IKtepTimeline): Promise<void> {
    await this.builder.createTimeline(timeline);
  }

  async placeClips(clips: IKtepClip[]): Promise<void> {
    await this.builder.placeClips(clips);
  }

  async addSubtitles(cues: IKtepSubtitle[]): Promise<void> {
    await this.builder.addSubtitles(cues);
  }

  async exportDraft(): Promise<string | null> {
    const result = await this.exportDraftDetailed();
    return result.outputPath;
  }

  async exportDraftDetailed(): Promise<IJianyingExportResult> {
    const result = await this.runner.export(this.builder.build());
    this.lastExportResult = result;
    return result;
  }

  getIdMap(): INleIdMap {
    return this.builder.getIdMap();
  }

  getWarnings(): string[] {
    return this.builder.getWarnings();
  }

  getLastExportResult(): IJianyingExportResult | null {
    return this.lastExportResult;
  }

  getCompatibilityNotice(): string {
    return CPYJIANYINGDRAFT_COMPATIBILITY_MESSAGE;
  }
}

export async function exportJianyingDraft(
  doc: IKtepDoc,
  config: IJianyingConfig = {},
): Promise<IJianyingDraftBuildResult & { result: IJianyingExportResult }> {
  const buildResult = await buildJianyingDraftSpec(doc, config);
  const runner = new JianyingLocalRunner({ ...CDEFAULTS, ...config });
  const result = await runner.export(buildResult.spec);
  return {
    ...buildResult,
    result,
  };
}

export function buildJianyingConfigFromRuntime(
  runtimeConfig: Partial<IRuntimeConfig>,
  overrides: Partial<IJianyingConfig> = {},
): IJianyingConfig {
  const backend = runtimeConfig.jianyingBackend === 'pyjianyingdraft'
    ? 'pyjianyingdraft'
    : undefined;

  return {
    ...CDEFAULTS,
    backend,
    draftRoot: runtimeConfig.jianyingDraftRoot,
    pythonPath: runtimeConfig.jianyingPythonPath,
    uvPath: runtimeConfig.jianyingUvPath,
    pyProjectRoot: runtimeConfig.jianyingPyProjectRoot,
    ...overrides,
  };
}

export function createJianyingAdapter(
  config: Partial<IJianyingConfig> = {},
): JianyingAdapter {
  return new JianyingAdapter({ ...CDEFAULTS, ...config });
}

export {
  CPYJIANYINGDRAFT_COMPATIBILITY_MESSAGE,
  buildJianyingDraftSpec,
  mapTransitionType,
  msToRange,
  msToTimeStr,
  normalizeMaterialPath,
  type IJianyingDraftSpec,
  type IJianyingExportResult,
};
