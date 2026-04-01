# Remove `path-timezones` And Redesign `manual-itinerary` 实施计划

**目标**: 让素材时间统一以文件 `create_time(UTC)` 为真值，删除 `path-timezones` 依赖，并把空间来源优先级明确为 `GPX > manual-itinerary > none`。

**架构**: 将“素材时间真值”与“分析得到的空间上下文”彻底分层：`IKtepAsset` 只保留 UTC 时间事实，`IAssetCoarseReport` 新增结构化 inferred GPS；如果项目提供了 GPX，则优先使用 GPX 匹配结果；`manual-itinerary` 不再接受 timezone 输入，只作为无 GPX / GPX 不匹配时的 fallback，通过地点文本解析坐标。

**技术栈**: TypeScript, Zod, `vitest@0.32.0` + `vite@4.5.5`（Node 16 兼容）, 注入式 location resolver（地点文本 → timezone / 经纬度）

**风险引用**: R10, R11

**风险缓解**:
- 用最小测试基建覆盖 `resolveCaptureTime()` 和 `manual-itinerary -> inferred GPS`
- 保留 `creation_time -> filename -> filesystem` fallback，避免时间链路断裂
- 结构化 GPS 只落在分析层，避免污染 asset 真值

---

## Task 1: 补最小测试基建并锁定时间行为

**文件**: 修改 `package.json`，创建 `vitest.config.ts`、`test/media/capture-time.test.ts`
**测试**: `test/media/capture-time.test.ts`

### Step 1: 编写失败测试

```ts
it('uses ffprobe creation_time as UTC capturedAt', async () => {
  const result = await resolveCaptureTime('/tmp/a.mp4', {
    creationTime: '2026-03-31T08:15:30Z',
    // ...other probe fields
  });
  expect(result.capturedAt).toBe('2026-03-31T08:15:30.000Z');
  expect(result.source).toBe('container');
});

it('falls back to filename timestamp without timezone input', async () => {
  const result = await resolveCaptureTime('/tmp/20260331_081530.mp4', {
    creationTime: null,
    // ...other probe fields
  });
  expect(result.source).toBe('filename');
});
```

### Step 2: 运行测试验证失败

```bash
pnpm add -D vitest@0.32.0 vite@4.5.5
pnpm test -- test/media/capture-time.test.ts
```

预期：测试因当前 `resolveCaptureTime()` 仍接收 timezone 参数或测试基建未就绪而失败。

### Step 3: 编写最小实现

- 在 `capture-time.ts` 中去掉 timezone 入参依赖
- 只保留 `creation_time -> filename -> filesystem` 链路

### Step 4: 运行测试验证通过

```bash
pnpm test -- test/media/capture-time.test.ts
```

### Step 5: 提交

`test: lock capture time to UTC creation_time`

---

## Task 2: 移除 ingest / analyze 对 `path-timezones` 的依赖

**文件**: 修改 `src/modules/media/project-ingest.ts`、`src/modules/media/project-analyze.ts`、`src/store/spatial-context.ts`、`src/store/index.ts`
**测试**: `test/media/project-ingest.test.ts`

### Step 1: 编写失败测试

```ts
it('does not write effectiveTimezone metadata during ingest', async () => {
  const asset = await buildAssetFromScanLikeFixture(/* ... */);
  expect(asset.metadata?.effectiveTimezone).toBeUndefined();
  expect(asset.metadata?.effectiveTimezoneSource).toBeUndefined();
});
```

### Step 2: 运行测试验证失败

```bash
pnpm test -- test/media/project-ingest.test.ts
```

### Step 3: 编写最小实现

- `project-ingest.ts` 不再 `loadPathTimezones()` / `matchPathTimezoneOverride()`
- `project-analyze.ts` 不再读取 `pathTimezones`
- `spatial-context.ts` 删除 `path-timezones` 相关类型和加载函数
- `store/index.ts` 删除对应导出

### Step 4: 运行测试验证通过

```bash
pnpm test -- test/media/project-ingest.test.ts
```

### Step 5: 提交

`refactor: remove path-timezones from media pipeline`

---

## Task 3: 让 `manual-itinerary` 输出结构化 inferred GPS

**文件**: 修改 `src/protocol/schema.ts`、`src/modules/media/asset-report.ts`、`src/modules/media/project-analyze.ts`、`src/store/spatial-context.ts`
**测试**: `test/media/manual-itinerary-gps.test.ts`

### Step 1: 编写失败测试

```ts
it('builds one inferred GPS from matched manual itinerary segment', async () => {
  const result = await resolveManualSpatialContextLikeFixture({
    assetCapturedAt: '2026-03-31T08:15:30.000Z',
    itinerary: '日期 + 时间窗 + 地点文本',
    geocode: async () => ({ lat: 39.909187, lng: 116.397463 }),
  });
  expect(result?.inferredGps).toEqual(expect.objectContaining({
    source: 'manual-itinerary',
    lat: 39.909187,
    lng: 116.397463,
  }));
});

it('returns null inferred GPS when location text cannot resolve', async () => {
  const result = await resolveManualSpatialContextLikeFixture({
    geocode: async () => null,
  });
  expect(result?.inferredGps).toBeUndefined();
});
```

### Step 2: 运行测试验证失败

```bash
pnpm test -- test/media/manual-itinerary-gps.test.ts
```

### Step 3: 编写最小实现

- 在 `schema.ts` 新增 `IInferredGps`
- 在 `IAssetCoarseReport` 上新增 `inferredGps`
- `manual-itinerary` 去掉 `timezone/defaultTimezone` 输入语义
- 新增独立 `manual-spatial.ts`，通过注入的 resolver 完成：
  - 汇总地点文本
  - 推断 timezone
  - geocode 成单点坐标
  - 写入单条 `inferredGps`
  - 继续保留 `gpsSummary/placeHints` 供现有下游消费

### Step 4: 运行测试验证通过

```bash
pnpm test -- test/media/manual-itinerary-gps.test.ts
```

### Step 5: 提交

`feat: store inferred gps from manual itinerary`

---

## Task 4: 同步设计文档并做最终验证

**文件**: 修改 `designs/2026-03-28--middle-version-protocol-first.md`、`designs/2026-03-29--m1-protocol-and-store.md`、`designs/project-structure.md`
**测试**: 构建与测试全集

### Step 1: 更新总览文档

- 删除 `path-timezones` 相关表述
- 将 `manual-itinerary` 改写为“GPS 推断输入”
- 补充 `IAssetCoarseReport.inferredGps`

### Step 2: 运行完整验证

```bash
pnpm test
pnpm build
```

### Step 3: 检查需求满足

- `IKtepAsset` 不再依赖 timezone 输入解析
- `path-timezones` 退出实现与文档
- `manual-itinerary` 只推断 GPS
- inferred GPS 存储在分析层

### Step 4: 提交

`docs: sync UTC capture time and manual itinerary gps design`
