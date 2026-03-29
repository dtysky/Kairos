---
name: kairos-ingest
description: >-
  Phase 1: Scan media directories, probe file metadata, resolve capture times,
  and generate the asset list. Supports incremental append for adding new media
  to an existing project. Use when importing raw footage, adding new media
  sources, or the user mentions ingest, scan, import, or append media.
---

# Kairos: Phase 1 — Ingest

扫描用户素材目录，提取每个媒体文件的元数据，生成 `IKtepAsset[]` 资产清单。
支持**首次导入**和**增量追加**两种模式。

## 前置条件

- 项目已初始化（`store/manifest.json` 存在）
- 用户已指定素材目录路径

## 可用工具

```typescript
// 递归扫描目录，返回所有媒体文件（视频/照片/音频）
scanDirectory(dir: string): Promise<IScannedFile[]>
// IScannedFile = { path, kind: 'video'|'photo'|'audio', sizeBytes }

// 用 ffprobe 提取元数据
probe(filePath: string): Promise<IProbeResult>
// IProbeResult = { durationMs, width, height, fps, codec, creationTime, rawTags }

// 按优先级解析拍摄时间：container > filename > filesystem
resolveCaptureTime(filePath: string, probeResult: IProbeResult, defaultTimezone?: string): Promise<ICaptureTime>

// 从文件路径/文件夹名生成证据
evidenceFromPath(filePath: string, folderNotes?: string[]): IKtepEvidence[]

// 原子写入 JSON
writeJson(path: string, data: unknown): Promise<void>

// 读取 JSON（带 Zod 校验）
readJson<T>(path: string, schema: ZodType<T>): Promise<T>
readJsonOrNull<T>(path: string, schema: ZodType<T>): Promise<T | null>

// 增量合并工具
mergeAssets(existing: IKtepAsset[], incoming: IKtepAsset[]): IMergeResult
// IMergeResult = { assets, added, duplicateCount }

appendAssets(projectRoot: string, incoming: IKtepAsset[]): Promise<IMergeResult>
// 读取现有 assets.json → 合并 → 保存（一步到位）

findUnanalyzedAssets(assets: IKtepAsset[], slices: IKtepSlice[]): IKtepAsset[]
// 找出还没有对应切片的资产（用于增量分析）
```

## 模式判断

Agent 需要先判断当前是**首次导入**还是**追加导入**：

```typescript
const existing = await readJsonOrNull(join(projectRoot, 'store/assets.json'), z.array(IKtepAsset));
const isIncremental = existing !== null && existing.length > 0;
```

## 工作流程 A：首次导入

1. **询问用户**素材在哪个目录（可以有多个）

2. **扫描目录**

```typescript
const files = await scanDirectory('/path/to/footage');
```

3. **逐文件探测**元数据并构建资产

```typescript
const assets: IKtepAsset[] = [];
for (const file of files) {
  const meta = await probe(file.path);
  const time = await resolveCaptureTime(file.path, meta);
  assets.push({
    id: randomUUID(),
    kind: file.kind,
    sourcePath: file.path,
    displayName: basename(file.path),
    durationMs: meta.durationMs ?? undefined,
    fps: meta.fps ?? undefined,
    width: meta.width ?? undefined,
    height: meta.height ?? undefined,
    capturedAt: time.capturedAt,
    captureTimeSource: time.source,
    captureTimeConfidence: time.confidence,
    ingestedAt: new Date().toISOString(),
  });
}
```

4. **存储**

```typescript
await writeJson(join(projectRoot, 'store/assets.json'), assets);
```

## 工作流程 B：增量追加

用户后续追加新素材时使用此流程。

1. **确认追加意图**

告知用户当前已有多少资产，确认是追加还是重新导入。

2. **扫描新目录**

```typescript
const newFiles = await scanDirectory('/path/to/new-footage');
```

3. **构建新资产**（同 A 的步骤 3）

4. **合并去重**

```typescript
const result = await appendAssets(projectRoot, newAssets);
// result.added — 实际新增的资产
// result.duplicateCount — 按 sourcePath 去重跳过的数量
```

5. **向用户报告**

```
已追加 ${result.added.length} 个新素材
跳过 ${result.duplicateCount} 个重复文件
当前总计 ${result.assets.length} 个资产
```

6. **提示后续**

追加后，agent 应提示用户：
- 新素材需要 Phase 2 分析（仅分析新增部分，已有分析保留）
- 如果已有脚本/时间线，追加素材后可能需要重新编排

## 产出

| 文件 | 格式 | 内容 |
|------|------|------|
| `store/assets.json` | `IKtepAsset[]` | 所有识别到的媒体资产（含历史 + 新增） |

## 决策点

- **时区**：不同设备/相机的时区可能不同。如果用户告知拍摄地时区，传入 `defaultTimezone` 参数
- **过滤**：扫描后可以让用户确认是否排除某些文件（临时素材、导出文件等）
- **命名**：`displayName` 默认用文件名，agent 可以根据文件夹结构赋予更有意义的名称
- **追加 vs 重建**：如果用户修改了已有素材（重命名、移动），可能需要重新导入而非追加
- **ingestRootId**：多次追加时，可以为每批素材分配不同的 `ingestRootId`，便于按批次管理
