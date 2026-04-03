#!/usr/bin/env node

import { spawn, execFile as execFileCallback } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { cpus } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const logicalCpuCount = Math.max(1, cpus().length);

async function main() {
  const options = parseArgs(process.argv.slice(2));
  validateOptions(options);

  const outputDir = options.output ? dirname(resolve(options.output)) : null;
  if (outputDir) {
    await mkdir(outputDir, { recursive: true });
  }

  const scenarios = options.sampleCounts.map(sampleCount => ({
    sampleCount,
    timestampsMs: buildTimestamps(options.durationMs, sampleCount),
  }));

  const results = [];
  for (const scenario of scenarios) {
    for (const concurrency of options.concurrencyCandidates) {
      const result = await runSingleBenchmark({
        videoPath: options.videoPath,
        timestampsMs: scenario.timestampsMs,
        concurrency,
        label: options.label,
        intervalMs: options.intervalMs,
        tools: {
          ffmpegHwaccel: options.ffmpegHwaccel,
          analysisProxyWidth: options.analysisProxyWidth,
          analysisProxyPixelFormat: options.analysisProxyPixelFormat,
          keyframeExtractConcurrency: concurrency,
        },
      });
      results.push({
        label: options.label,
        sampleCount: scenario.sampleCount,
        concurrency,
        ...result,
      });
      printResultLine({
        label: options.label,
        sampleCount: scenario.sampleCount,
        concurrency,
        ...result,
      });
    }
  }

  const summarized = buildScenarioSummary(results);
  const payload = {
    generatedAt: new Date().toISOString(),
    label: options.label,
    videoPath: options.videoPath,
    durationMs: options.durationMs,
    logicalCpuCount,
    samplingIntervalMs: options.intervalMs,
    tools: {
      ffmpegHwaccel: options.ffmpegHwaccel,
      analysisProxyWidth: options.analysisProxyWidth,
      analysisProxyPixelFormat: options.analysisProxyPixelFormat,
    },
    scenarios: summarized,
  };

  if (options.output) {
    await writeFile(resolve(options.output), `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
    console.log(`Saved benchmark report to ${resolve(options.output)}`);
  }
}

function parseArgs(argv) {
  const options = {
    label: 'keyframe-benchmark',
    videoPath: '',
    durationMs: Number.NaN,
    sampleCounts: [18],
    concurrencyCandidates: [1, 2, 3, 4],
    intervalMs: 250,
    analysisProxyWidth: 1024,
    analysisProxyPixelFormat: 'yuv420p',
    ffmpegHwaccel: 'videotoolbox',
    output: '',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1];
    switch (token) {
      case '--label':
        options.label = next ?? options.label;
        index += 1;
        break;
      case '--video':
        options.videoPath = next ?? options.videoPath;
        index += 1;
        break;
      case '--duration-ms':
        options.durationMs = Number(next);
        index += 1;
        break;
      case '--samples':
        options.sampleCounts = parseCsvNumbers(next);
        index += 1;
        break;
      case '--concurrency':
        options.concurrencyCandidates = parseCsvNumbers(next);
        index += 1;
        break;
      case '--interval-ms':
        options.intervalMs = Number(next);
        index += 1;
        break;
      case '--analysis-width':
        options.analysisProxyWidth = Number(next);
        index += 1;
        break;
      case '--pixel-format':
        options.analysisProxyPixelFormat = next ?? options.analysisProxyPixelFormat;
        index += 1;
        break;
      case '--hwaccel':
        options.ffmpegHwaccel = next ?? options.ffmpegHwaccel;
        index += 1;
        break;
      case '--output':
        options.output = next ?? options.output;
        index += 1;
        break;
      case '--help':
        printUsageAndExit(0);
        break;
      default:
        printUsageAndExit(1, `Unknown argument: ${token}`);
        break;
    }
  }

  return options;
}

function parseCsvNumbers(value) {
  if (!value) return [];
  return [...new Set(
    value
      .split(',')
      .map(item => Number(item.trim()))
      .filter(item => Number.isFinite(item) && item > 0)
      .map(item => Math.floor(item)),
  )].sort((left, right) => left - right);
}

function validateOptions(options) {
  if (!options.videoPath) {
    printUsageAndExit(1, 'Missing required --video');
  }
  if (!Number.isFinite(options.durationMs) || options.durationMs <= 0) {
    printUsageAndExit(1, 'Missing or invalid --duration-ms');
  }
  if (options.sampleCounts.length === 0) {
    printUsageAndExit(1, 'Missing or invalid --samples');
  }
  if (options.concurrencyCandidates.length === 0) {
    printUsageAndExit(1, 'Missing or invalid --concurrency');
  }
  if (!Number.isFinite(options.intervalMs) || options.intervalMs <= 0) {
    printUsageAndExit(1, 'Missing or invalid --interval-ms');
  }
}

function printUsageAndExit(exitCode, message) {
  if (message) {
    console.error(message);
  }
  console.error([
    'Usage:',
    '  node scripts/keyframe-concurrency-benchmark.mjs \\',
    '    --label c1501 \\',
    '    --video "/path/to/video.mp4" \\',
    '    --duration-ms 54555 \\',
    '    --samples 6,18 \\',
    '    --concurrency 1,2,3,4 \\',
    '    --output ".tmp/run/keyframe-benchmark-c1501.json"',
  ].join('\n'));
  process.exit(exitCode);
}

function buildTimestamps(durationMs, sampleCount) {
  const safeCount = Math.max(1, Math.floor(sampleCount));
  const lastMs = Math.max(0, durationMs - 500);
  if (safeCount === 1) return [0];
  return Array.from(
    { length: safeCount },
    (_, index) => Math.round((index * lastMs) / Math.max(1, safeCount - 1)),
  );
}

async function runSingleBenchmark(input) {
  const child = spawnTimedWorker(input);
  const monitorPromise = monitorProcessTree(child.pid, input.intervalMs);
  const completed = await waitForChild(child);
  const monitoring = await monitorPromise;

  if (completed.exitCode !== 0) {
    throw new Error([
      `Benchmark worker failed with exit code ${completed.exitCode}`,
      completed.stderr.trim(),
    ].filter(Boolean).join('\n'));
  }

  const payload = parseJsonPayload(completed.stdout);
  const timing = parseTimeOutput(completed.stderr);
  return {
    frameCount: payload.frameCount,
    wallMs: payload.wallMs,
    timeRealSec: timing.realSec,
    timeUserSec: timing.userSec,
    timeSysSec: timing.sysSec,
    cpuTimeSec: timing.userSec + timing.sysSec,
    monitoring,
  };
}

function spawnTimedWorker(input) {
  const payload = JSON.stringify({
    videoPath: input.videoPath,
    timestampsMs: input.timestampsMs,
    tools: input.tools,
  });
  const workerSource = [
    "import { mkdtemp, rm } from 'node:fs/promises';",
    "import { join } from 'node:path';",
    "import { tmpdir } from 'node:os';",
    "import { extractKeyframes } from './dist/modules/media/keyframe.js';",
    'const payload = JSON.parse(process.env.KAIROS_KEYFRAME_BENCH_PAYLOAD ?? "{}");',
    "const outputDir = await mkdtemp(join(tmpdir(), 'kairos-keyframe-bench-'));",
    'const startedAt = Date.now();',
    'try {',
    '  const results = await extractKeyframes(payload.videoPath, outputDir, payload.timestampsMs, payload.tools);',
    '  console.log(JSON.stringify({ frameCount: results.length, wallMs: Date.now() - startedAt }));',
    '} finally {',
    '  await rm(outputDir, { recursive: true, force: true });',
    '}',
  ].join('\n');

  return spawn(
    '/usr/bin/time',
    ['-p', process.execPath, '--input-type=module', '-e', workerSource],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        KAIROS_KEYFRAME_BENCH_PAYLOAD: payload,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
}

function waitForChild(child) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', exitCode => {
      resolve({
        exitCode: exitCode ?? 1,
        stdout,
        stderr,
      });
    });
  });
}

function parseJsonPayload(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error('Benchmark worker did not emit JSON output.');
  }
  return JSON.parse(trimmed);
}

function parseTimeOutput(stderr) {
  const realMatch = stderr.match(/(^|\n)real\s+([0-9.]+)/);
  const userMatch = stderr.match(/(^|\n)user\s+([0-9.]+)/);
  const sysMatch = stderr.match(/(^|\n)sys\s+([0-9.]+)/);
  return {
    realSec: realMatch ? Number(realMatch[2]) : 0,
    userSec: userMatch ? Number(userMatch[2]) : 0,
    sysSec: sysMatch ? Number(sysMatch[2]) : 0,
  };
}

async function monitorProcessTree(rootPid, intervalMs) {
  const samples = [];
  while (await isAlive(rootPid)) {
    const snapshot = await sampleProcessTree(rootPid);
    if (snapshot) {
      samples.push(snapshot);
    }
    await sleep(intervalMs);
  }
  const finalSnapshot = await sampleProcessTree(rootPid);
  if (finalSnapshot) {
    samples.push(finalSnapshot);
  }

  if (samples.length === 0) {
    return {
      sampleCount: 0,
      avgCpuPercent: 0,
      peakCpuPercent: 0,
      avgCpuSystemSharePercent: 0,
      peakCpuSystemSharePercent: 0,
      avgRssMb: 0,
      peakRssMb: 0,
      peakProcessCount: 0,
      peakFfmpegCount: 0,
    };
  }

  const totalCpuPercent = samples.reduce((sum, sample) => sum + sample.cpuPercent, 0);
  const totalRssKb = samples.reduce((sum, sample) => sum + sample.rssKb, 0);
  const peakCpuPercent = Math.max(...samples.map(sample => sample.cpuPercent));
  const peakRssKb = Math.max(...samples.map(sample => sample.rssKb));
  const peakProcessCount = Math.max(...samples.map(sample => sample.processCount));
  const peakFfmpegCount = Math.max(...samples.map(sample => sample.ffmpegCount));

  return {
    sampleCount: samples.length,
    avgCpuPercent: round(totalCpuPercent / samples.length, 2),
    peakCpuPercent: round(peakCpuPercent, 2),
    avgCpuSystemSharePercent: round((totalCpuPercent / samples.length) / logicalCpuCount, 2),
    peakCpuSystemSharePercent: round(peakCpuPercent / logicalCpuCount, 2),
    avgRssMb: round((totalRssKb / samples.length) / 1024, 2),
    peakRssMb: round(peakRssKb / 1024, 2),
    peakProcessCount,
    peakFfmpegCount,
  };
}

async function sampleProcessTree(rootPid) {
  const processes = await readProcessTable();
  const subtree = collectSubtree(processes, rootPid);
  if (subtree.length === 0) return null;

  return {
    cpuPercent: subtree.reduce((sum, process) => sum + process.cpuPercent, 0),
    rssKb: subtree.reduce((sum, process) => sum + process.rssKb, 0),
    processCount: subtree.length,
    ffmpegCount: subtree.filter(process => /\bffmpeg\b/.test(process.command)).length,
  };
}

async function readProcessTable() {
  const { stdout } = await execFile('ps', ['-Ao', 'pid=,ppid=,%cpu=,rss=,command='], {
    cwd: repoRoot,
  });
  return stdout
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(parseProcessLine)
    .filter(Boolean);
}

function parseProcessLine(line) {
  const match = line.match(/^(\d+)\s+(\d+)\s+([0-9.]+)\s+(\d+)\s+(.*)$/);
  if (!match) return null;
  return {
    pid: Number(match[1]),
    ppid: Number(match[2]),
    cpuPercent: Number(match[3]),
    rssKb: Number(match[4]),
    command: match[5],
  };
}

function collectSubtree(processes, rootPid) {
  const byPid = new Map(processes.map(process => [process.pid, process]));
  const childrenByParent = new Map();

  for (const process of processes) {
    const siblings = childrenByParent.get(process.ppid) ?? [];
    siblings.push(process.pid);
    childrenByParent.set(process.ppid, siblings);
  }

  const queue = [rootPid];
  const seen = new Set();
  const subtree = [];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current == null || seen.has(current)) continue;
    seen.add(current);
    const process = byPid.get(current);
    if (!process) continue;
    subtree.push(process);
    for (const childPid of childrenByParent.get(current) ?? []) {
      queue.push(childPid);
    }
  }

  return subtree;
}

async function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function buildScenarioSummary(results) {
  const groups = new Map();
  for (const result of results) {
    const list = groups.get(result.sampleCount) ?? [];
    list.push(result);
    groups.set(result.sampleCount, list);
  }

  return [...groups.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([sampleCount, entries]) => {
      const sorted = [...entries].sort((left, right) => left.concurrency - right.concurrency);
      const baseline = sorted[0];
      return {
        sampleCount,
        baselineConcurrency: baseline.concurrency,
        results: sorted.map(result => ({
          ...result,
          deltaFromBaseline: {
            wallMsPct: round(percentDelta(baseline.wallMs, result.wallMs), 2),
            cpuTimePct: round(percentDelta(baseline.cpuTimeSec, result.cpuTimeSec), 2),
            avgCpuPct: round(percentDelta(baseline.monitoring.avgCpuPercent, result.monitoring.avgCpuPercent), 2),
            peakCpuPct: round(percentDelta(baseline.monitoring.peakCpuPercent, result.monitoring.peakCpuPercent), 2),
            peakRssPct: round(percentDelta(baseline.monitoring.peakRssMb, result.monitoring.peakRssMb), 2),
          },
        })),
      };
    });
}

function printResultLine(result) {
  console.log([
    `[${result.label}]`,
    `samples=${result.sampleCount}`,
    `concurrency=${result.concurrency}`,
    `wall=${result.wallMs}ms`,
    `cpuTime=${round(result.cpuTimeSec, 2)}s`,
    `avgCpu=${result.monitoring.avgCpuPercent}%`,
    `peakCpu=${result.monitoring.peakCpuPercent}%`,
    `peakRss=${result.monitoring.peakRssMb}MB`,
    `peakFfmpeg=${result.monitoring.peakFfmpegCount}`,
  ].join(' '));
}

function percentDelta(baseline, current) {
  if (!Number.isFinite(baseline) || baseline === 0) return 0;
  return ((current - baseline) / baseline) * 100;
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
