import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  IAssetCoarseReport,
  IKtepAsset,
} from '../protocol/schema.js';
import { loadAssets } from './incremental.js';
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
  const report = await readJsonOrNull(getAssetReportPath(projectRoot, assetId), IAssetCoarseReport) as IAssetCoarseReport | null;
  if (!report) return null;
  const asset = (await loadAssets(projectRoot)).find(asset => asset.id === assetId);
  return asset && isAssetReportCurrent(asset, report) ? report : null;
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

  const assets = new Map((await loadAssets(projectRoot)).map(asset => [asset.id, asset]));
  return reports.filter(report => {
    const asset = assets.get(report.assetId);
    return asset && isAssetReportCurrent(asset, report);
  }).sort((a, b) => a.assetId.localeCompare(b.assetId));
}

export function findUnreportedAssets(
  assets: IKtepAsset[],
  reports: IAssetCoarseReport[],
): IKtepAsset[] {
  const byId = new Map(reports.map(report => [report.assetId, report]));
  return assets.filter(asset => !byId.has(asset.id) || !isAssetReportCurrent(asset, byId.get(asset.id)!));
}

export async function appendAssetReports(
  projectRoot: string,
  incoming: IAssetCoarseReport[],
): Promise<void> {
  for (const report of incoming) {
    await writeAssetReport(projectRoot, report);
  }
}

export function isAssetReportCurrent(asset: IKtepAsset, report: IAssetCoarseReport): boolean {
  if (!asset.mediaVersions) return true; // Legacy projects remain readable until their first versioned Ingest.
  return Boolean(asset.analysisInput && !asset.analysisInput.blocker
    && report.analysisInput?.fingerprint === asset.analysisInput.fingerprint);
}
