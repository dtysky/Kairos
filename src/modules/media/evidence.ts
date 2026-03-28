import type { IKtepEvidence, IKtepSlice } from '../../protocol/schema.js';

/**
 * 合并多来源证据到 slice 上，去重并按置信度排序。
 */
export function mergeEvidence(
  slice: IKtepSlice,
  ...sources: IKtepEvidence[][]
): IKtepSlice {
  const all = [...slice.evidence];
  for (const batch of sources) {
    all.push(...batch);
  }

  const deduped = dedup(all);
  deduped.sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));

  return { ...slice, evidence: deduped };
}

function dedup(evidence: IKtepEvidence[]): IKtepEvidence[] {
  const seen = new Set<string>();
  const result: IKtepEvidence[] = [];
  for (const e of evidence) {
    const key = `${e.source}:${e.value}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(e);
    }
  }
  return result;
}

/**
 * 从文件路径和目录注解生成证据。
 */
export function evidenceFromPath(
  filePath: string,
  folderNotes?: string[],
): IKtepEvidence[] {
  const evidence: IKtepEvidence[] = [];

  const parts = filePath.replace(/\\/g, '/').split('/');
  const folder = parts.length >= 2 ? parts[parts.length - 2] : null;
  if (folder) {
    evidence.push({
      source: 'folder',
      value: folder,
      confidence: 0.3,
    });
  }

  if (folderNotes) {
    for (const note of folderNotes) {
      evidence.push({
        source: 'manual-root-note',
        value: note,
        confidence: 0.6,
      });
    }
  }

  return evidence;
}
