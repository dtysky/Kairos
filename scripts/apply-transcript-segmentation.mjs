import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { applyTranscriptSegmentationToAssetReport } from '../dist/modules/media/transcript-segmentation-report.js';
import { IAssetCoarseReport } from '../dist/protocol/schema.js';
import { markChronologyStale, markSpansStale, touchProjectUpdatedAt } from '../dist/store/index.js';

const projectId = process.argv[2];
const dryRun = process.argv.includes('--dry-run');
const assetIds = process.argv.slice(3).filter(value => value !== '--dry-run');
if (!projectId || assetIds.length === 0) {
  throw new Error('Usage: node scripts/apply-transcript-segmentation.mjs <projectId> <assetId...>');
}

const workspaceRoot = process.cwd();
const projectRoot = join(workspaceRoot, 'projects', projectId);
const completedAt = new Date().toISOString();
const runId = completedAt.replace(/[:.]/g, '-');
const auditRoot = join(projectRoot, '.tmp', 'transcript-segmentation-targeted', runId);
const beforeRoot = join(auditRoot, 'before');
await mkdir(beforeRoot, { recursive: true });

const updates = [];
for (const assetId of assetIds) {
  const path = join(projectRoot, 'analysis', 'asset-reports', `${assetId}.json`);
  const raw = await readFile(path, 'utf8');
  const current = IAssetCoarseReport.parse(JSON.parse(raw));
  if (current.assetId !== assetId) throw new Error(`${path} 的 assetId 不匹配`);
  const applied = applyTranscriptSegmentationToAssetReport(current, completedAt);
  updates.push({ path, raw, ...applied });
}

if (!dryRun) {
  for (const update of updates) {
    await copyFile(update.path, join(beforeRoot, `${update.summary.assetId}.json`));
  }
  for (const update of updates) {
    await writeJsonAtomic(update.path, update.report);
  }
  await Promise.all([
    markSpansStale(projectRoot, 'transcript segmentation updated asset reports; rerun /chronology span-rebuild'),
    markChronologyStale(projectRoot),
    touchProjectUpdatedAt(projectRoot),
  ]);
}

const audit = {
  schemaVersion: 1,
  projectId,
  completedAt,
  policyVersion: updates[0]?.report.transcriptSegmentation?.policyVersion,
  assetIds,
  updates: updates.map(update => ({
    ...update.summary,
    timingValidation: update.report.transcriptSegmentation?.timingValidation,
    segmentsBefore: IAssetCoarseReport.parse(JSON.parse(update.raw)).transcriptSegments ?? [],
    segmentsAfter: update.report.transcriptSegments ?? [],
  })),
};
if (!dryRun) {
  await writeJsonAtomic(join(auditRoot, 'report.json'), audit);
  await writeFile(join(auditRoot, 'report.md'), renderMarkdown(audit), 'utf8');
}
console.log(JSON.stringify({
  ...audit,
  dryRun,
  auditRoot: dryRun ? null : auditRoot,
  previews: updates.map(update => ({
    assetId: update.summary.assetId,
    segments: update.report.transcriptSegments?.map(segment => ({
      startMs: segment.startMs,
      endMs: segment.endMs,
      text: segment.text,
    })),
  })),
}, null, 2));

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporaryPath, path);
}

function renderMarkdown(audit) {
  const rows = audit.updates.map(item => (
    `| ${item.assetId} | ${item.segmentCountBefore} | ${item.segmentCountAfter} | ${item.repairedTokenCount} | ${item.originalMaxTokenDurationMs} | ${item.repairedMaxTokenDurationMs} |`
  ));
  const lines = [
    '# 定点字幕拆分报告',
    '',
    `- 项目：\`${audit.projectId}\``,
    `- 完成时间：\`${audit.completedAt}\``,
    `- 策略：\`${audit.policyVersion}\``,
    '- 本次只更新下列 asset report 的字级时间、字幕段和已有 speech/mixed fine-scan window 的字幕真值；未运行 ASR 或视觉分析。',
    '',
    '| 素材 | 原分段 | 新分段 | 修复 token | 原最大字时长 ms | 修复后最大字时长 ms |',
    '|---|---:|---:|---:|---:|---:|',
    ...rows,
    '',
  ];
  for (const update of audit.updates) {
    lines.push(`## ${update.assetId}`, '');
    lines.push('| token | 字符 | 锚点 | 原时间 ms | 修复时间 ms |', '|---:|---|---|---:|---:|');
    for (const repair of update.timingValidation?.repairs ?? []) {
      lines.push(`| ${repair.index} | ${escapeCell(repair.text)} | ${repair.anchor} | ${repair.originalStartMs}-${repair.originalEndMs} | ${repair.repairedStartMs}-${repair.repairedEndMs} |`);
    }
    if ((update.timingValidation?.repairs?.length ?? 0) === 0) {
      lines.push('| - | - | - | 无异常 | 无需修复 |');
    }
    lines.push('', '| # | 原拆句 | 新拆句 |', '|---:|---|---|');
    const count = Math.max(update.segmentsBefore.length, update.segmentsAfter.length);
    for (let index = 0; index < count; index += 1) {
      lines.push(`| ${index + 1} | ${renderSegment(update.segmentsBefore[index])} | ${renderSegment(update.segmentsAfter[index])} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function renderSegment(segment) {
  if (!segment) return '';
  return `${segment.startMs}-${segment.endMs} ${escapeCell(segment.text)}`;
}

function escapeCell(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}
