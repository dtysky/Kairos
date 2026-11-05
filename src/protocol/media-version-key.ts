import { extname } from 'node:path';
import type { IKtepAsset } from './schema.js';

/** Directory and stem retain case; encoding extensions do not define material identity. */
export function materialVersionKey(kind: IKtepAsset['kind'], relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, '/');
  return `${kind}:${normalized.slice(0, normalized.length - extname(normalized).length)}`;
}
