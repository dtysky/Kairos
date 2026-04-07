import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const pharosDesignsDir = path.resolve(repoRoot, '..', 'Pharos', 'designs');
const baselinePath = path.resolve(repoRoot, '.ai', 'pharos-protocol-baseline.json');

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

async function collectMarkdownFiles(rootDir, currentDir = rootDir) {
  const entries = await readdir(currentDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const absolutePath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectMarkdownFiles(rootDir, absolutePath));
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.md')) {
      continue;
    }
    const content = await readFile(absolutePath);
    files.push({
      path: path.relative(rootDir, absolutePath).replaceAll(path.sep, '/'),
      sha256: sha256(content),
    });
  }
  return files;
}

function buildManifest(files) {
  return {
    sourceRoot: '../Pharos/designs',
    generatedAt: new Date().toISOString(),
    combinedSha256: sha256(JSON.stringify(files)),
    files,
  };
}

async function readBaseline() {
  try {
    return JSON.parse(await readFile(baselinePath, 'utf-8'));
  }
  catch {
    return null;
  }
}

async function main() {
  const files = await collectMarkdownFiles(pharosDesignsDir);
  const manifest = buildManifest(files);
  const baseline = await readBaseline();
  const baselineMatches = baseline?.combinedSha256 === manifest.combinedSha256;

  if (process.argv.includes('--write-baseline')) {
    await writeFile(`${baselinePath}`, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
  }

  process.stdout.write(`${JSON.stringify({
    ...manifest,
    baselinePath: path.relative(repoRoot, baselinePath).replaceAll(path.sep, '/'),
    baselineCombinedSha256: baseline?.combinedSha256 ?? null,
    baselineMatches,
  }, null, 2)}\n`);

  if (process.argv.includes('--check') && !baselineMatches) {
    process.exitCode = 2;
  }
}

await main();
