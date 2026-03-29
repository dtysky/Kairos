---
name: kairos-ingest
description: >-
  Phase 1: Scan media directories, probe file metadata, resolve capture times,
  and generate the asset list. Use when importing raw footage, adding new media
  sources, or the user mentions ingest, scan, or import media.
---

# Kairos: Phase 1 — Ingest

扫描用户素材目录，提取每个媒体文件的元数据，生成 `IKtepAsset[]` 资产清单。

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
```

## 工作流程

1. **询问用户**素材在哪个目录（可以有多个）

2. **扫描目录**

```typescript
const files = await scanDirectory('/path/to/footage');
// files: IScannedFile[]
```

3. **逐文件探测**元数据

```typescript
for (const file of files) {
  const meta = await probe(file.path);
  const time = await resolveCaptureTime(file.path, meta);
  // 构建 IKtepAsset
}
```

4. **构建资产对象**

每个文件 → 一个 `IKtepAsset`：

```typescript
const asset: IKtepAsset = {
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
};
```

5. **存储**

```typescript
await writeJson(join(projectRoot, 'store/assets.json'), assets);
```

## 产出

| 文件 | 格式 | 内容 |
|------|------|------|
| `store/assets.json` | `IKtepAsset[]` | 所有识别到的媒体资产 |

## 决策点

- **时区**：不同设备/相机的时区可能不同。如果用户告知拍摄地时区，传入 `defaultTimezone` 参数
- **过滤**：扫描后可以让用户确认是否排除某些文件（临时素材、导出文件等）
- **命名**：`displayName` 默认用文件名，agent 可以根据文件夹结构赋予更有意义的名称
