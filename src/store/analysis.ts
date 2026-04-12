import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  IAssetCoarseReport,
  IKtepAsset,
} from '../protocol/schema.js';
import { readJsonOrNull, writeJson } from './writer.js';

export function getAssetReportsRoot(projectRoot: string): string {
  return join(projectRoot, 'analysis/asset-reports');
}

export function getAssetReportPath(projectRoot: string, assetId: string): string {
  return join(getAssetReportsRoot(projectRoot), `${assetId}.json`);
}

export async function loadAssetReport(
  projectRoot: string,
  assetId: string,
): Promise<IAssetCoarseReport | null> {
  return readJsonOrNull(
    getAssetReportPath(projectRoot, assetId),
    IAssetCoarseReport,
  ) as Promise<IAssetCoarseReport | null>;
}

export async function writeAssetReport(
  projectRoot: string,
  report: IAssetCoarseReport,
): Promise<void> {
  await writeJson(getAssetReportPath(projectRoot, report.assetId), report);
}

export async function loadAssetReports(
  projectRoot: string,
): Promise<IAssetCoarseReport[]> {
  const root = getAssetReportsRoot(projectRoot);
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const reports: IAssetCoarseReport[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const report = await readJsonOrNull(
      join(root, entry.name),
      IAssetCoarseReport,
    ) as IAssetCoarseReport | null;
    if (report) reports.push(report);
  }

  return reports.sort((a, b) => a.assetId.localeCompare(b.assetId));
}

export function findUnreportedAssets(
  assets: IKtepAsset[],
  reports: IAssetCoarseReport[],
): IKtepAsset[] {
  const reportedIds = new Set(reports.map(report => report.assetId));
  return assets.filter(asset => !reportedIds.has(asset.id));
}

export async function appendAssetReports(
  projectRoot: string,
  incoming: IAssetCoarseReport[],
): Promise<void> {
  for (const report of incoming) {
    await writeAssetReport(projectRoot, report);
  }
}
