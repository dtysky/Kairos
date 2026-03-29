---
name: kairos-export
description: >-
  Phase 5: Export KTEP timeline to NLE (Jianying) via MCP adapter and generate
  subtitle files. Use when exporting to Jianying, creating drafts, or the user
  mentions export, Jianying, or subtitle.
---

# Kairos: Phase 5 — Export

将 KTEP 时间线文档导出到剪映（通过 MCP 适配器），并生成字幕文件。

## 前置条件

- `timeline/current.json` 存在且通过 KTEP 校验
- vendored `jianying-mcp` 已就绪（`vendor/jianying-mcp`，已执行 `uv sync`）
- 剪映已安装在目标机器上

## 可用工具

```typescript
// 创建 MCP 连接
createJianyingMcpCaller(
  jianyingMcpRoot: string,  // 例如 './vendor/jianying-mcp'
  savePath: string,          // 中间数据目录
  outputPath: string,        // 剪映草稿目录
): StdioMcpCaller

// 剪映适配器
new JianyingAdapter(mcp: IMcpCaller, config?: Partial<IJianyingConfig>)
// IJianyingConfig: { outputPath?, subtitleY: -0.8, subtitleSize: 6.0 }

// 一键执行：validate → ensureProject → importAssets → createTimeline → placeClips → addSubtitles
executeAdapter(adapter: INleAdapter, doc: IKtepDoc): Promise<void>

// 导出草稿
adapter.exportDraft(): Promise<string | null>

// 字幕导出
exportSrt(cues: IKtepSubtitle[], outputPath: string): Promise<void>
exportVtt(cues: IKtepSubtitle[], outputPath: string): Promise<void>
```

## 工作流程

### Step 1: 加载 KTEP 文档

```typescript
const doc = await readJson('timeline/current.json', IKtepDoc);
```

### Step 2: 连接 jianying-mcp

```typescript
const mcp = createJianyingMcpCaller(
  './vendor/jianying-mcp',
  '/tmp/kairos-drafts',
  '/path/to/jianying/drafts',
);
await mcp.connect();
```

剪映草稿目录按平台：
- **macOS**: `~/Movies/JianyingPro/User Data/Projects/com.lveditor.draft/`
- **Windows**: `C:\Users\<USER>\AppData\Local\JianyingPro\User Data\Projects\com.lveditor.draft\`

### Step 3: 执行导出

```typescript
const adapter = new JianyingAdapter(mcp);
await executeAdapter(adapter, doc);
const draftPath = await adapter.exportDraft();
```

### Step 4: 导出字幕文件

```typescript
if (doc.subtitles?.length) {
  await exportSrt(doc.subtitles, 'subtitles/output.srt');
  await exportVtt(doc.subtitles, 'subtitles/output.vtt');
}
```

### Step 5: 关闭连接

```typescript
await mcp.close();
```

## 产出

| 文件 | 格式 | 内容 |
|------|------|------|
| 剪映草稿目录 | 剪映项目 | 可在剪映中直接打开编辑 |
| `subtitles/output.srt` | SRT | 字幕文件 |
| `subtitles/output.vtt` | WebVTT | 字幕文件 |

## 决策点

- **字幕位置**：`subtitleY` 默认 -0.8（画面下方），可以调整
- **字幕大小**：`subtitleSize` 默认 6.0，大屏可以调大
- **是否导出字幕文件**：如果不需要独立字幕文件可以跳过 SRT/VTT 导出

## 注意事项

- MCP 通过 stdio 通信，`createJianyingMcpCaller` 会自动用 `uv` 启动 Python 进程
- 确保 `savePath` 目录已创建（`mkdir -p /tmp/kairos-drafts`）
- 导出完成后在剪映中打开草稿，所有素材路径必须在目标机器上可访问
