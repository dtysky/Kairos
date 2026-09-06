import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const SAMPLE_ASSET_IDS = [
  'C3282_zve1',
  'C3284_zve1',
  'C0057_a7r6',
  'C3277_zve1',
  'C3287_zve1',
  'C3288_zve1',
  'C3415_zve1',
  'C0053_a7r6',
  'C3519_zve1',
  'C3570_zve1',
];

const mode = process.argv[2];
const projectId = process.argv[3] || 'thirty-third-birthday-trip';
const workspaceRoot = process.cwd();
const projectRoot = join(workspaceRoot, 'projects', projectId);
const checkpointRoot = join(projectRoot, 'analysis', 'audio-checkpoints');
const reportRoot = join(projectRoot, 'analysis', 'asset-reports');
const auditRoot = join(projectRoot, '.tmp', 'transcript-segmentation-audit');
const legacyRoot = join(auditRoot, 'legacy-v2');
const expectedPolicyVersion = 'asr-punctuation-gap-v1';

if (!['snapshot', 'report'].includes(mode)) {
  throw new Error('Usage: node scripts/transcript-segmentation-audit.mjs <snapshot|report> [projectId]');
}

if (mode === 'snapshot') {
  await mkdir(legacyRoot, { recursive: true });
  const copied = [];
  for (const assetId of SAMPLE_ASSET_IDS) {
    const source = join(checkpointRoot, `${assetId}.json`);
    const target = join(legacyRoot, `${assetId}.json`);
    const legacy = await readJson(source);
    if (legacy.schemaVersion !== 2) {
      throw new Error(`${assetId} expected schema v2 before the full rerun, got ${legacy.schemaVersion}`);
    }
    if (!await exists(target)) {
      await copyFile(source, target);
    }
    copied.push({ assetId, source, target });
  }
  await writeJson(join(auditRoot, 'snapshot-manifest.json'), {
    schemaVersion: 1,
    projectId,
    createdAt: new Date().toISOString(),
    samples: copied,
  });
  console.log(JSON.stringify({ mode, projectId, copied: copied.length, auditRoot }, null, 2));
} else {
  const fullAudit = await auditAllCurrentTranscripts();
  const samples = [];
  for (const assetId of SAMPLE_ASSET_IDS) {
    const legacy = await readJson(join(legacyRoot, `${assetId}.json`));
    const transcript = await readCurrentTranscript(assetId);
    if (transcript?.segmentation?.status !== 'completed') {
      throw new Error(`${assetId} transcript segmentation is not completed`);
    }
    samples.push({
      assetId,
      legacy: {
        transcript: legacy.selectedTranscript?.transcript ?? '',
        segments: legacy.selectedTranscript?.segments ?? [],
      },
      current: {
        rawText: transcript?.rawText ?? '',
        transcript: transcript?.transcript ?? '',
        segmentation: transcript?.segmentation ?? null,
        segments: transcript?.segments ?? [],
        alignedTokens: transcript?.alignedTokens ?? [],
      },
    });
  }

  const report = {
    schemaVersion: 1,
    projectId,
    generatedAt: new Date().toISOString(),
    focus: ['词内断句', '跨长停顿合句', '重复口语', '长素材稳定性'],
    fullAudit,
    samples,
  };
  await writeJson(join(auditRoot, 'report.json'), report);
  await writeFile(join(auditRoot, 'report.md'), renderMarkdown(report), 'utf8');
  console.log(JSON.stringify({ mode, projectId, samples: samples.length, auditRoot }, null, 2));
}

function renderMarkdown(report) {
  const lines = [
    '# ASR v3 确定性字幕拆句抽检',
    '',
    `- 项目：\`${report.projectId}\``,
    `- 生成时间：\`${report.generatedAt}\``,
    `- 检查重点：${report.focus.join('、')}`,
    `- 全量发现有效转写：${report.fullAudit.transcriptCount}`,
    `- 带字级时间转写：${report.fullAudit.alignedTranscriptCount}`,
    `- 仅保留 rawText：${report.fullAudit.rawOnlyTranscriptCount}`,
    `- 字级 token：${report.fullAudit.alignedTokenCount}`,
    `- 字幕段：${report.fullAudit.segmentCount}`,
    `- 修复字级时间素材：${report.fullAudit.repairedTranscriptCount}`,
    `- 固定 ASR confidence=0.8 残留：${report.fullAudit.fixedAsrConfidenceEvidenceCount}`,
    '',
  ];
  for (const sample of report.samples) {
    lines.push(`## ${sample.assetId}`, '');
    lines.push(`- ASR rawText：${escapeCell(sample.current.rawText)}`);
    lines.push(`- 新 transcript：${escapeCell(sample.current.transcript)}`);
    lines.push(`- segmentation：\`${JSON.stringify(sample.current.segmentation)}\``, '');
    lines.push('| # | 旧拆句（起止 ms） | 新拆句（token range 派生起止 ms） |', '|---:|---|---|');
    const rowCount = Math.max(sample.legacy.segments.length, sample.current.segments.length);
    for (let index = 0; index < rowCount; index += 1) {
      lines.push(`| ${index + 1} | ${renderSegment(sample.legacy.segments[index])} | ${renderSegment(sample.current.segments[index])} |`);
    }
    lines.push('', '| token | 字符 | startMs | endMs | gapAfterMs |', '|---:|---|---:|---:|---:|');
    for (const token of sample.current.alignedTokens) {
      lines.push(`| ${token.index} | ${escapeCell(token.text)} | ${token.startMs} | ${token.endMs} | ${token.gapAfterMs} |`);
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

async function auditAllCurrentTranscripts() {
  const currentByAssetId = new Map();
  let nullCheckpointCount = 0;
  for (const name of await listJsonFiles(checkpointRoot)) {
    const checkpoint = await readJson(join(checkpointRoot, name));
    const assetId = name.slice(0, -'.json'.length);
    if (checkpoint.schemaVersion !== 3) {
      throw new Error(`${assetId} current checkpoint schema is ${checkpoint.schemaVersion}, expected 3`);
    }
    if (checkpoint.alignmentContractVersion !== 'qwen3-character-alignment-v2') {
      throw new Error(`${assetId} current checkpoint is missing qwen3-character-alignment-v2`);
    }
    if (checkpoint.selectedTranscript) {
      currentByAssetId.set(assetId, checkpoint.selectedTranscript);
    } else {
      nullCheckpointCount += 1;
    }
  }

  let fixedAsrConfidenceEvidenceCount = 0;
  for (const name of await listJsonFiles(reportRoot)) {
    const report = await readJson(join(reportRoot, name));
    fixedAsrConfidenceEvidenceCount += countFixedAsrConfidenceEvidence(report);
    const assetId = name.slice(0, -'.json'.length);
    if (currentByAssetId.has(assetId)) continue;
    if (
      typeof report.asrRawText !== 'string'
      && !Array.isArray(report.alignedTokens)
      && report.transcriptSegmentation == null
    ) continue;
    currentByAssetId.set(assetId, {
      rawText: report.asrRawText ?? '',
      alignedTokens: report.alignedTokens ?? [],
      segmentation: report.transcriptSegmentation,
      transcript: report.transcript ?? '',
      segments: report.transcriptSegments ?? [],
    });
  }

  const summary = {
    transcriptCount: currentByAssetId.size,
    alignedTranscriptCount: 0,
    rawOnlyTranscriptCount: 0,
    nullCheckpointCount,
    alignedTokenCount: 0,
    segmentCount: 0,
    repairedTranscriptCount: 0,
    fixedAsrConfidenceEvidenceCount,
    policyVersion: expectedPolicyVersion,
  };
  for (const [assetId, transcript] of currentByAssetId) {
    const counts = validateCurrentTranscript(assetId, transcript);
    summary.alignedTranscriptCount += counts.aligned ? 1 : 0;
    summary.rawOnlyTranscriptCount += counts.rawOnly ? 1 : 0;
    summary.alignedTokenCount += counts.tokenCount;
    summary.segmentCount += counts.segmentCount;
    summary.repairedTranscriptCount += counts.repaired ? 1 : 0;
  }
  if (summary.fixedAsrConfidenceEvidenceCount !== 0) {
    throw new Error(
      `found ${summary.fixedAsrConfidenceEvidenceCount} fixed ASR confidence=0.8 evidence rows`,
    );
  }
  return summary;
}

function validateCurrentTranscript(assetId, transcript) {
  const rawText = String(transcript.rawText ?? '');
  const tokens = Array.isArray(transcript.alignedTokens) ? transcript.alignedTokens : [];
  const segments = Array.isArray(transcript.segments) ? transcript.segments : [];
  const segmentation = transcript.segmentation;
  if (tokens.length === 0) {
    if (segments.length > 0 || stripPunctuationAndWhitespace(transcript.transcript ?? '')) {
      throw new Error(`${assetId} has subtitle text without aligned tokens`);
    }
    if (!stripPunctuationAndWhitespace(rawText)) {
      throw new Error(`${assetId} has an empty transcript record`);
    }
    return { aligned: false, rawOnly: true, tokenCount: 0, segmentCount: 0, repaired: false };
  }

  if (segmentation?.status !== 'completed') {
    throw new Error(`${assetId} transcript segmentation is not completed`);
  }
  if (segmentation.policyVersion !== expectedPolicyVersion) {
    throw new Error(
      `${assetId} policyVersion=${segmentation.policyVersion}, expected ${expectedPolicyVersion}`,
    );
  }
  if (segmentation.attempts !== 0) {
    throw new Error(`${assetId} has invalid segmentation attempts=${segmentation.attempts}`);
  }
  if (typeof segmentation.completedAt !== 'string' || !segmentation.completedAt) {
    throw new Error(`${assetId} completed segmentation is missing completedAt`);
  }

  for (const [index, token] of tokens.entries()) {
    if (token.index !== index) {
      throw new Error(`${assetId} aligned token index ${token.index} is not contiguous at ${index}`);
    }
    if (!Number.isInteger(token.startMs) || !Number.isInteger(token.endMs) || token.endMs < token.startMs) {
      throw new Error(`${assetId} aligned token ${index} has invalid time bounds`);
    }
    if (Array.from(stripPunctuationAndWhitespace(token.text)).length !== 1) {
      throw new Error(`${assetId} aligned token ${index} is not one Unicode character`);
    }
    const next = tokens[index + 1];
    const expectedGap = next ? next.startMs - token.endMs : 0;
    if (expectedGap < 0) {
      throw new Error(`${assetId} aligned token ${index} overlaps token ${index + 1}`);
    }
    if (token.gapAfterMs !== expectedGap) {
      throw new Error(
        `${assetId} aligned token ${index} gapAfterMs=${token.gapAfterMs}, expected ${expectedGap}`,
      );
    }
  }

  const tokenText = tokens.map(token => token.text).join('');
  if (stripPunctuationAndWhitespace(rawText) !== tokenText) {
    throw new Error(`${assetId} rawText does not exactly cover the aligned token sequence`);
  }
  if (segments.length === 0) {
    throw new Error(`${assetId} has aligned tokens but no transcript segments`);
  }
  let tokenCursor = 0;
  for (const [segmentIndex, segment] of segments.entries()) {
    const bodyLength = Array.from(stripPunctuationAndWhitespace(segment.text)).length;
    if (bodyLength < 1 || tokenCursor + bodyLength > tokens.length) {
      throw new Error(`${assetId} segment ${segmentIndex} has an invalid token range`);
    }
    const expectedStart = tokens[tokenCursor].startMs;
    const expectedEnd = tokens[tokenCursor + bodyLength - 1].endMs;
    if (segment.startMs !== expectedStart || segment.endMs !== expectedEnd) {
      throw new Error(
        `${assetId} segment ${segmentIndex} time=${segment.startMs}-${segment.endMs}, expected ${expectedStart}-${expectedEnd}`,
      );
    }
    if (segment.endMs <= segment.startMs) {
      throw new Error(`${assetId} segment ${segmentIndex} has no positive duration`);
    }
    tokenCursor += bodyLength;
  }
  if (tokenCursor !== tokens.length) {
    throw new Error(`${assetId} segments cover ${tokenCursor}/${tokens.length} aligned tokens`);
  }
  const segmentText = segments.map(segment => stripPunctuationAndWhitespace(segment.text)).join('');
  if (segmentText !== tokenText) {
    throw new Error(`${assetId} transcript segments do not preserve the aligned token text`);
  }
  if (stripPunctuationAndWhitespace(transcript.transcript ?? '') !== tokenText) {
    throw new Error(`${assetId} transcript does not preserve the aligned token text`);
  }
  return {
    aligned: true,
    rawOnly: false,
    tokenCount: tokens.length,
    segmentCount: segments.length,
    repaired: segmentation.timingValidation?.status === 'repaired',
  };
}

function countFixedAsrConfidenceEvidence(value) {
  if (Array.isArray(value)) {
    return value.reduce((count, item) => count + countFixedAsrConfidenceEvidence(item), 0);
  }
  if (value == null || typeof value !== 'object') return 0;
  let count = value.source === 'asr' && value.confidence === 0.8 ? 1 : 0;
  for (const nested of Object.values(value)) {
    count += countFixedAsrConfidenceEvidence(nested);
  }
  return count;
}

function stripPunctuationAndWhitespace(value) {
  return String(value ?? '').replace(/[\s\p{P}]+/gu, '');
}

async function listJsonFiles(root) {
  try {
    return (await readdir(root)).filter(name => name.endsWith('.json'));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

function renderSegment(segment) {
  if (!segment) return '';
  return `\`${segment.startMs}-${segment.endMs}\` ${escapeCell(segment.text)}`;
}

function escapeCell(value) {
  return String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', '<br>');
}

async function exists(path) {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function readCurrentTranscript(assetId) {
  const checkpointPath = join(checkpointRoot, `${assetId}.json`);
  if (await exists(checkpointPath)) {
    const checkpoint = await readJson(checkpointPath);
    if (checkpoint.schemaVersion !== 3) {
      throw new Error(`${assetId} requires a completed schema v3 checkpoint, got ${checkpoint.schemaVersion}`);
    }
    if (checkpoint.alignmentContractVersion !== 'qwen3-character-alignment-v2') {
      throw new Error(`${assetId} is missing the current character-alignment contract`);
    }
    return checkpoint.selectedTranscript;
  }

  const reportPath = join(reportRoot, `${assetId}.json`);
  const report = await readJson(reportPath);
  if (!Array.isArray(report.alignedTokens)) {
    throw new Error(`${assetId} final asset report is missing alignedTokens`);
  }
  return {
    rawText: report.asrRawText ?? '',
    alignedTokens: report.alignedTokens,
    segmentation: report.transcriptSegmentation,
    transcript: report.transcript ?? '',
    segments: report.transcriptSegments ?? [],
  };
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
