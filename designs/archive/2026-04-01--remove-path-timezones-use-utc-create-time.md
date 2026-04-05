## 2026-04-05 实施注记

本文“移除 `path-timezones`、不再要求 `manual-itinerary` 提供 timezone 输入”的方向仍然成立，但当前实现已经在原方案上进一步收口为：

- 视频等容器素材继续以 `create_time(UTC)` 为主时间来源；照片则改为优先读取 `EXIF DateTimeOriginal(+OffsetTimeOriginal) > EXIF CreateDate(+OffsetTimeDigitized/OffsetTime) > EXIF GPSDateTime > container > filename > filesystem`
- 正式空间优先级已收口为 `embedded GPS > project GPX > project-derived-track > none`
- `manual-itinerary` 正文会在 ingest 时编译进 `gps/derived.json`，不再作为 Analyze 的独立顶层 fallback
- `config/manual-itinerary.md` 末尾新增“素材时间校正”表格：ingest 发现弱时间源与项目时间线明显冲突时，必须把素材写入该表，并阻塞 Analyze；用户填写 `正确日期 / 正确时间 / 时区` 后 rerun ingest，才会生效
- 照片若自身 EXIF 带 GPS，会直接写成 `embeddedGps(metadata)` 真值；只有没有自身 GPS 时，才继续用修正后的拍摄时间匹配 project GPX / `project-derived-track`

## 背景

当前实现里，素材拍摄时间除了优先读取 `ffprobe creation_time`，还会：

- 在 ingest 阶段读取 `config/path-timezones.md`
- 用路径级时区覆盖或 `root.defaultTimezone` 去解释文件名时间戳
- 把 `effectiveTimezone` 等信息写入素材 metadata
- 在 analyze 阶段再次读取 `path-timezones` 参与人工行程匹配

新的约束是：

- 不再需要 `path-timezones`
- 视频等容器素材的 `create_time` 已经是 UTC，可作为主时间来源；照片则优先使用 EXIF 原始时间和时区
- 如果素材自身带有 GPS（例如 DJI 无人机视频），它是空间真值主来源
- 若无内嵌 GPS，再回落到项目级 GPX，再回落到 `project-derived-track`
- `manual-itinerary` 正文不负责直接修正素材时间，也不应该要求用户填写 timezone；真正的人工时间修正入口是同文件末尾的“素材时间校正”表格
- `manual-itinerary` 正文只负责在 ingest 时编译近似 GPS / 空间上下文，为后续素材分析准备结构化空间线索

## 目标

让素材时间链路移除 `path-timezones` 依赖，并收口为“视频等容器素材 `create_time(UTC)` 优先、照片 EXIF 原始时间优先”的实现；同时把 `manual-itinerary` 明确拆成“正文弱空间线索 + 末尾人工时间校正表”两层输入。

## 方案对比

### 推荐方案：移除 `path-timezones`，并采用 `embedded GPS > project GPX > project-derived-track` 的空间优先级

做法：

- ingest 不再读取 `config/path-timezones.md`
- `resolveCaptureTime()` 不再把 timezone 当作外部输入；视频等容器素材优先解析 `probeResult.creationTime`，照片优先读取 EXIF 原始时间和时区
- 若 `creation_time` 缺失，仍保留文件名 / 文件系统时间 fallback，但不再依赖路径级时区覆盖
- asset metadata 不再写入 `effectiveTimezone*` / `captureOriginalTimezone`
- analyze 不再读取 `path-timezones`
- analyze 的空间来源优先级改为：
  - 素材自身内嵌 GPS（如 DJI 视频 metadata / 照片 EXIF）
  - 已匹配的项目级 GPX 坐标
  - `project-derived-track`（包含 ingest 预编译的 `manual-itinerary` 弱空间结果）
  - 无空间结果
- `manual-itinerary` 正文不再接受 `timezone/defaultTimezone` 作为用户输入语义
- `manual-itinerary` 正文只在内嵌 GPS 缺失且项目级 GPX 也无法匹配时，根据：
  - 日期 / 时间窗
  - 地点文本
  - 路线描述（`from / to / via`）
  推断一条近似 GPS / 空间上下文，并在 ingest 时编译进 `gps/derived.json`
- `manual-itinerary` 末尾“素材时间校正”表格用于人工修正 capture time；修正结果会在 rerun ingest 后进入资产真值层
- 推断得到的空间结果作为分析层产物存储，不写回素材本体

优点：

- 改动最小，和“create_time 已是 UTC”的新前提一致
- 可清理掉一整条路径级时区配置链
- 素材原始事实和分析推断严格分层

代价：

- 如果某些素材没有 `creation_time`，文件名时间戳会按“无额外时区修正”处理
- `manual-itinerary` 内部如果需要 timezone，只能从地点文本或空间线索推断，不能再依赖用户显式填写

### 方案 B：停用 `path-timezones`，但保留旧 timezone 字段和空壳接口

做法：

- 代码里不再消费 `path-timezones`
- 但保留 store 接口、`manual-itinerary.timezone/defaultTimezone`、schema 元数据字段和文档占位

优点：

- 对外接口变化更小

代价：

- 会留下明显的死代码和误导性文档

### 方案 C：推断 GPS 直接写回素材主数据

做法：

- 在 ingest 或 analyze 后，把推断 GPS 直接写回 `IKtepAsset` 或 `asset.metadata`

优点：

- 后续读取方最简单

代价：

- 会把“原始事实”和“分析推断”混在一起
- 低置信度推断不容易被单独重算、覆盖或审查

## 推荐

采用“推荐方案”。

原因：

用户已经明确：

- 素材时间就是 UTC，和 GPS 无关
- `manual-itinerary` 不应该写 timezone
- 大疆无人机拍摄的视频里，已经有非常丰富的 GPS 数据
- 如果素材内嵌 GPS 不可用，且给出了 GPX 文件，则优先使用 GPX
- `manual-itinerary` 只作为无内嵌 GPS / 无 GPX / GPX 不匹配时的 fallback

因此最合理的分层是：

- `IKtepAsset`：只存 UTC 真值
- `IAssetCoarseReport`：存最终采用的 GPS / 空间上下文
- `manual-itinerary`：只负责 fallback 推断，不覆盖内嵌 GPS 或 GPX

## 影响范围

预计涉及：

- `src/modules/media/capture-time.ts`
- `src/modules/media/project-ingest.ts`
- `src/modules/media/project-analyze.ts`
- `src/store/spatial-context.ts`
- `src/store/index.ts`
- `src/protocol/schema.ts`
- `./2026-03-28--middle-version-protocol-first.md`
- `./2026-03-29--m1-protocol-and-store.md`
- `designs/project-structure.md`

## 存储建议

推荐新增一个分析层结构，例如：

```ts
type IInferredGps = {
  source: 'embedded' | 'gpx' | 'manual-itinerary';
  confidence: number;
  lat: number;
  lng: number;
  timezone?: string;
  matchedItinerarySegmentId?: string;
  locationText?: string;
  summary?: string;
};
```

并把它挂在 `IAssetCoarseReport` 上。

本轮按用户确认，粒度是：

- 每个 asset 一条最终推断 GPS

当前实现约定：

- `project-analyze` 会先尝试从 `asset.metadata.rawTags` / metadata 字段解析内嵌 GPS
- 当前内嵌 GPS 最小实现支持：
  - QuickTime / DJI 常见 `location` / `com.apple.quicktime.location.iso6709`
  - 已标准化的 `gpslatitude/gpslongitude`
- `project-analyze` 通过可选 `gpxPaths` 接收 1..N 个 GPX 文件路径
- GPX 解析当前只实现最小子集：读取带 `time` 的 `trkpt / rtept / wpt`
- 命中规则为：按 asset `capturedAt` 在默认容差内选择最近轨迹点
- 若内嵌 GPS 未命中，再尝试 GPX
- 若 GPX 未命中，再通过可选注入的 `resolveTimezoneFromLocation(location)` / `geocodeLocation(location)` 两个 resolver 走 `manual-itinerary` fallback
- 若宿主既未提供可用 GPX，也未提供 resolver，则跳过 `inferredGps` 生成，但不影响其余分析流程

## 错误处理

- 若 `creation_time` 存在但不可解析：退回现有 fallback
- 若 `creation_time` 缺失：继续允许 filename / filesystem fallback
- 若宿主未注入地点解析 resolver：跳过 `manual-itinerary` 的结构化 GPS 推断
- 若 `manual-itinerary` 的地点文本不足以推断出稳定空间结果：跳过该条的 GPS 推断
- 当前尚未开始使用，不需要考虑旧版 `manual-itinerary timezone` 字段兼容

## 测试策略

至少补这几类测试：

1. ingest 不再写入 `effectiveTimezone*` / `captureOriginalTimezone` 元数据
2. `manual-itinerary` 解析时忽略 `timezone/defaultTimezone` 字段
3. 内嵌 GPS 可优先于 GPX / `manual-itinerary` 成为最终空间结果
4. 在无内嵌 GPS 且注入 resolver 时，`manual-itinerary` 可为单个 asset 生成一条结构化推断 GPS
5. 无法推断地点，或宿主未提供 resolver 时，不生成 `inferredGps`
6. `IAssetCoarseReport` 可挂载结构化 `inferredGps`，而不是污染资产主数据
