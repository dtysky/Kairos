# GPX Priority Over `manual-itinerary` 实施计划

**目标**: 在 Analyze 阶段把空间来源优先级明确实现为 `GPX > manual-itinerary > none`。

**架构**: 给 `analyzeWorkspaceProjectMedia()` 增加可选 `gpxPaths` / `gpxMatchToleranceMs` 输入；新增最小 GPX 解析/时间匹配模块，在粗扫报告生成时先尝试 GPX 命中，只有未命中时才回落到现有 `manual-itinerary` fallback。

**技术栈**: TypeScript, `vitest@0.32.0`, Node 16 兼容的内置 GPX 最小解析器

**风险引用**: R11, R12, R13

**风险缓解**:
- 用单元测试锁住“GPX 命中优先、未命中 fallback”
- 最小实现只支持带 `time` 的 `trkpt/rtept/wpt`
- 通过默认匹配容差避免离谱误匹配

---

## Task 1: 为 GPX 解析与优先级编写失败测试

**文件**: 创建 `test/media/gpx-spatial.test.ts`
**测试**: `test/media/gpx-spatial.test.ts`

### Step 1: 编写失败测试

```ts
it('uses GPX match before manual-itinerary fallback', async () => {
  const result = await resolveAssetSpatialContext({
    asset: { capturedAt: '2026-03-31T08:15:30.000Z', sourcePath: 'clip.mp4' },
    itinerary: { warnings: [], segments: [/* manual match */] },
    gpxPaths: ['/tmp/track.gpx'],
    resolveTimezoneFromLocation: async () => 'Asia/Shanghai',
    geocodeLocation: async () => ({ lat: 39.9, lng: 116.3 }),
  });
  expect(result?.inferredGps?.source).toBe('gpx');
});

it('falls back to manual-itinerary when GPX has no match', async () => {
  const result = await resolveAssetSpatialContext({
    asset: { capturedAt: '2026-03-31T08:15:30.000Z', sourcePath: 'clip.mp4' },
    itinerary: { warnings: [], segments: [/* manual match */] },
    gpxPaths: ['/tmp/far-away-track.gpx'],
    resolveTimezoneFromLocation: async () => 'Asia/Shanghai',
    geocodeLocation: async () => ({ lat: 39.9, lng: 116.3 }),
  });
  expect(result?.inferredGps?.source).toBe('manual-itinerary');
});
```

### Step 2: 运行测试验证失败

```bash
pnpm test -- test/media/gpx-spatial.test.ts
```

### Step 3: 编写最小实现

- 新增 `src/modules/media/gpx-spatial.ts`
- 新增 `resolveAssetSpatialContext()` 统一调度 GPX / manual
- 扩展 `IInferredGps.source`

### Step 4: 运行测试验证通过

```bash
pnpm test -- test/media/gpx-spatial.test.ts
```

### Step 5: 提交

`feat: prefer gpx matches over manual itinerary`

---

## Task 2: 将 GPX 优先级接入 analyze 主流程

**文件**: 修改 `src/modules/media/project-analyze.ts`、`src/modules/media/index.ts`、`src/protocol/schema.ts`
**测试**: `test/media/project-analyze-gpx-priority.test.ts`

### Step 1: 编写失败测试

```ts
it('writes gpx-derived gps into coarse report when gpx matches', async () => {
  const report = await analyzeSingleAssetLikeFixture({
    gpxPaths: ['/tmp/track.gpx'],
    manualItinerary: /* also matches */,
  });
  expect(report.inferredGps?.source).toBe('gpx');
});
```

### Step 2: 运行测试验证失败

```bash
pnpm test -- test/media/project-analyze-gpx-priority.test.ts
```

### Step 3: 编写最小实现

- `analyzeWorkspaceProjectMedia()` 增加 `gpxPaths?: string[]`
- `finalizePreparedAsset()` / `finalizePhotoPreparedAsset()` 统一走 `resolveAssetSpatialContext()`
- GPX 命中时写 `gpsSummary + inferredGps`

### Step 4: 运行测试验证通过

```bash
pnpm test -- test/media/project-analyze-gpx-priority.test.ts
```

### Step 5: 提交

`feat: wire gpx priority into analyze pipeline`

---

## Task 3: 文档与验证

**文件**: 修改 `designs/2026-04-01--remove-path-timezones-use-utc-create-time.md`、`.ai/skills/kairos-analyze/SKILL.md`
**测试**: 全量测试 + 构建

### Step 1: 更新文档

- 标注 GPX 已有代码级优先实现
- `manual-itinerary` 仅作为 fallback

### Step 2: 运行完整验证

```bash
pnpm test
pnpm build
```

### Step 3: 检查需求满足

- 给出 `gpxPaths` 时，GPX 命中优先于 `manual-itinerary`
- GPX 未命中时，manual fallback 仍工作
- chronology / report 能保留正确来源

### Step 4: 提交

`docs: sync gpx priority behavior`
