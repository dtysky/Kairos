# M1 — 协议与核心存储

> 日期：2026-03-29
> 状态：已实施
> 依赖：`designs/2026-03-28--middle-version-protocol-first.md`

## 目标

将中间版本设计中定义的 KTEP 协议落地为 Zod schema，实现协议校验器和项目存储层。

## 技术选型

| 维度 | 选择 |
|------|------|
| 运行时 | Node.js >= 18 |
| 包管理器 | pnpm |
| 模块系统 | ESM (`"type": "module"`) |
| Schema 校验 | Zod |
| 语言 | TypeScript (strict) |

## 命名规范

| 类别 | 前缀 | 示例 |
|------|------|------|
| Enum | `E` | `EAssetKind` |
| Interface / Type | `I` | `IKtepAsset` |
| Constant | `C` | `CPROTOCOL` |

Zod schema 和 TypeScript 类型共用同名：

```typescript
export const IKtepAsset = z.object({ ... });
export type IKtepAsset = z.infer<typeof IKtepAsset>;
```

## 文件结构

```
src/
├── protocol/
│   ├── schema.ts       # Zod schema + 类型 + 枚举 + 常量
│   ├── validator.ts    # 协议不变量校验
│   └── index.ts
├── store/
│   ├── writer.ts       # 原子 JSON 读写
│   ├── project.ts      # 项目初始化 + 加载
│   └── index.ts
└── index.ts
```

## Schema 清单

### 常量
- `CPROTOCOL` = `'kairos.timeline'`
- `CVERSION` = `'1.0'`

### 枚举
- `EAssetKind`, `ESliceType`, `EEvidenceSource`, `EScriptRole`
- `ETrackKind`, `ETrackRole`, `ETransitionType`
- `ECaptureTimeSource`, `EMediaRootCategory`

### 接口
- `IKtepDoc` — 顶层文档
- `IKtepProject` — 项目元信息
- `IKtepAsset` — 资产
- `IKtepSlice` — 切片
- `IKtepEvidence` — 证据
- `IKtepScript` — 脚本段落
- `IKtepTimeline` — 时间线
- `IKtepTrack` — 轨道
- `IKtepClip` — 片段摆放
- `IKtepTransition` — 转场
- `IKtepTransform` — 变换
- `IKtepKenBurns` — Ken Burns 参数
- `IKtepSubtitle` — 字幕
- `IMediaRoot` — 输入目录配置
- `ICaptureTime` — 拍摄时间信息
- `IStoreManifest` — 存储清单

## 校验器

实现设计文档 9.7 节定义的 8 条协议不变量：

1. 所有时间统一使用毫秒 — 由 schema 类型保证
2. `timelineOutMs > timelineInMs` — 运行时校验
3. `sourceOutMs > sourceInMs`（若存在） — 运行时校验（clip + slice）
4. `clip.trackId` 引用存在的轨道 — 运行时校验
5. `clip.assetId` 引用存在的资产 — 运行时校验
6. `clip.sliceId` 若存在，引用存在的切片 — 运行时校验
7. 字幕时间范围不得为负 — 运行时校验
8. 编辑器私有字段不进入核心 — 由 schema 结构保证（`adapterHints`）

## Store 层

- `writeJson()`: 写入临时文件 → `fs.rename` 原子替换
- `readJson()`: 读取 + Zod 校验
- `initProject()`: 创建完整目录结构 + 初始 manifest
- `loadManifest()` / `loadIngestRoots()`: 读取项目状态

## 延后项

- Revision 追踪（JSONL）
- 文档级快照
- 项目级备份
- Schema migration
