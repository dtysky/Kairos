# 持续追加素材：复杂度与分期

2026-11-02。用户要求先推进容易、可独立验证的部分。

## 当前能力与工作量

| 工作 | 当前情况 | 复杂度与顺序 |
| --- | --- | --- |
| 并行导入、跳过未变化素材的元数据读取 | 已实现有界并发与未变化文件 probe 缓存 | 小，第一批完成 |
| Resolve 素材池批量导入 | 已按源路径复用已有 item；同目录缺失视频分批导入，照片逐张导入 | 小至中，第二批完成并实机验证 |
| 仅供手动剪辑的“额外素材”入口 | 已打通独立配置、扫描、Console、素材池导入与工程级重链，不依赖分析 | 中，第四批完成 |
| 新素材接入分析 | 未有 report 的资产可进入 Analyze；已变化文件的旧 report 尚无完整失效链 | 中，需要素材版本与 report 输入身份 |
| 保留人工成果的全流程增量 | Ingest 标记 spans/chronology stale；span rebuild 重建整批候选；Color 的目录分块也可能因追加而改变 | 大，需分别设计 review 续接、局部 chronology 合并及调色 chunk 稳定身份 |

手动补漏可以使用第四批的独立额外素材目录，也可在 Resolve 中手动导入已配置主/备选路径的素材。工程级重链递归处理整个 Media Pool，不依赖资产是否分析或所在 bin。

## 第四批：额外素材目录

用户明确要求实施独立的手动剪辑素材入口。配置沿用项目 `config/project-brief.json`，新增可选 `extraMedia {rootId, path, alternatePaths[], description}`，默认 rootId 为 `extra`。Console `/ingest-gps` 提供目录编辑与保存，以及独立“导入额外素材到 Resolve”按钮。仅修改 extraMedia 不使 spans/chronology 过期，不触发 Ingest。配置未保存时先保存再导入，避免扫描旧路径。

路径编辑与上方主素材 Root 统一：复用同一个结构化备选路径组件，按编号逐行编辑，支持新增、上移、下移、删除，折叠卡片显示备选数量；不再用多行文本框解析额外素材路径。额外素材只编辑媒体路径，不添加调色原始路径字段。沿用现有 `alternatePaths[]` 和选择顺序，保留已保存的 Windows/macOS 路径，不做配置迁移。

- Supervisor 新增 `resolve-extra-media-sync` job，扫描当前可读主/备选目录中的视频、图片和音频；并行读取文件属性，不运行媒体分析、元数据 probe、GPS、调色、Chronology、Edit Unit 或 Flow Plan。它不写 `store/assets.json`、spans、chronology 或分析产物。额外目录若嵌在普通素材 root 下，后续普通 Ingest 扫描排除该子树，避免新补漏素材又进入分析。
- 打开或创建项目匹配的 `[Edit]` Resolve 工程，在顶层“额外素材”bin 按相对目录组织新素材。先核对整个 Media Pool 的源路径，已有 item 直接复用且保留用户所在 bin；缺失视频/音频分批导入，照片逐张导入，部分响应回读核实。不中途重导已成功项，不删除素材或手动目录。恢复原选择的 bin，不选择、创建、清空或重建任何时间线。
- 独立进度 `.tmp/resolve-extra-media-sync/progress.json` 与 jobId 精确关联，显示扫描/导入阶段、当前文件、完成数和导入/复用计数；失败保留错误与已完成统计，重试从实际素材池继续。和其它 Resolve 素材池/调色/维护写操作互斥。
- 工程级重链加入 extraMedia 主/备选路径，和现有路径一样按最长匹配递归处理整个 Media Pool，包含手动导入、已移出“额外素材”bin 的素材。单独返回额外素材配置与重链统计。跨设备依赖这些目录中保留相同相对文件结构。
- 验证配置保存/重载/镜像、extra-only 保存保留审查事实、无 assets/spans/chronology 也可导入、目录扫描与嵌套排除、重复/追加/部分导入、整工程重链、无时间线改动、进度与并发互斥。根仓与 Console 分别构建，临时 Resolve 工程实测后恢复原工程并清理测试产物。

第四批验证（2026-11-02）：后端相关 83 项、Console 13 项测试通过，根仓和 Console 构建通过。Resolve Studio 21.1.2.10 临时工程 `Kairos 额外素材验证 40c5df88 [Edit]` 首次导入视频、两张编号图片及音频共 4 个，照片保持独立 Still；手动移走一个 item 并建立时间线后追加 1 个，仅 `imported=1/reused=4/moved=0`。迁移测试媒体路径后工程级重链成功 5 个、旧路径与不可读计数为 0；再次导入及浏览器按钮导入均为 `imported=0/reused=5`。普通 Ingest 集成测试确认通过备选路径解析的嵌套额外目录不会被 probe 或写入资产索引。原有测试时间线 ID、片段 ID/起止帧和用户整理的 bin 均不变；API 保存额外配置保留有效 `pending-speech-review` 元数据且不创建 assets。原 `中秋国庆闽赣自驾 [Edit]` / `回程进入山野 [ep3-return-to-wild]` 已恢复，测试工程、媒体、项目与 4 次任务已清理，审计和截图留在 `.tmp/extra-media-smoke/`。


## 第一批：Ingest 实现合同

1. 保留当前 Ingest 入口和资产身份。目录中的文件属性读取与媒体元数据 probe 使用有界并发，结果按原扫描顺序汇合，不因任务完成先后改变资产顺序或冲突 ID 分配。
2. 元数据缓存只保存原始 probe 结果，放在项目 `.tmp/ingest/metadata/`。按本机、绝对路径、文件大小、mtime/ctime、工具路径与缓存版本判断复用。新增或变化文件才重新 probe；首次运行建立缓存。每项成功后原子落盘，异常中断后可复用已完成项。失败、损坏/旧版本缓存、读取期间变化的文件不得留下可命中的成功缓存；失败沿用现有 ingest 降级并在下次重试。
3. 同名保护音轨也使用这套缓存；它仍是视频绑定，不变成通用独立音频资产。结果统计区分本轮 probe、复用、失败，统计包含保护音轨，与 `merge.duplicateCount`（资产合并数量）分开。
4. 拍摄时间每轮从 raw metadata 重新解析，仍应用当前 root offset / manual override；不缓存这些派生结果。Sidecar、FlightRecord、GPS/行程绑定继续刷新。共享 GPS 索引仍按顺序提交，避免并行读改写丢条目。
5. 成功扫描 root 的删除同步、missing root 保留、stale 标记与后续流程保持现状。本轮“跳过”指避免重复媒体 probe，不代表零变化 Ingest 已能保留所有下游 fresh 状态，也不代表 Resolve 导入或全流程增量已经完成。
6. 无新增用户选项、文件格式限制或分析要求；不操作用户现有 Resolve 时间线。

## 验证

- 并发确实发生且有上界，输出顺序稳定。
- 第二次运行复用；新增/修改/替换文件重读；工具路径变化失效；坏缓存与 probe 失败可恢复。
- 未变化视频旁新增/修改保护音轨或 GPS sidecar，仍刷新绑定；时间修正仍生效；多条 GPS 索引不丢失。
- 现有 Ingest 回归、根仓与 Console 构建。

第一批验证：`test/media/ingest-probe-cache.test.ts` 与 `test/media/project-ingest.test.ts` 共 24 项通过；`pnpm build`、`npm --prefix apps/kairos-console run build` 通过。另用临时生成的真实 MP4 验证首轮 probe 1 次、次轮复用 1 次且元数据完全一致。未操作实际项目素材或 Resolve 工程。

## 第二批：Resolve 素材池批量导入

用户确认继续推进下一批。保留 `/edit` 的项目级 `resolve-media-sync` 入口、现有前置条件及 imported / moved / reused 摘要。

1. 先读取整个 Media Pool，按规范化源路径复用已有 item。目标目录一致就跳过，分类变化时仅移动已有 item，保持原 item 身份和已有时间线引用。
2. 对连续同目标目录的缺失视频，使用 `MediaPool.ImportMedia` 分批提交，每批最多 50 项（内部调用分块，不限制项目素材数量）。照片逐张调用：21.1.2 实测一次提交相邻编号 JPEG 会合成额外序列 item，即使随后补导单张也会污染素材池。Resolve 的当前目录是全局状态，因此 API 调用保持顺序，不并行切换目录。批量导入只启用于剪辑素材池准备；调色 prepare 的既有单文件路径保持不变。
3. 新批量路径使用 `ImportMedia([paths])`，按返回 item 的实际 `File Path` 匹配，不依赖返回顺序。安装版 21.1.2 文档推荐的 `ImportMedia([{FilePath}])` 在本机简单文件实测中返回空且未导入，不能据此声称批量可用；沿用现有路径列表形式。返回为空、部分返回或抛错后，先回读目标目录，找回已经导入但未返回的 item，再只补导缺失文件。
4. 批量未完成项单独重试 `ImportMedia`；仍缺失时使用原有 MediaStorage 兼容路径，但只针对该文件。照片必须保持逐文件身份，不能把 numbered JPEG 的序列 item 当作某一张照片的成功结果。最终缺失项明确失败，并报告本批已成功/未完成路径，禁止整批盲目重导。
5. 保持 prepared entries 的请求顺序、真实完成计数和 job 关联；导入失败后的再次运行从真实 Media Pool 重新核对，只补缺项。整个同步结束恢复仍存在的原选中 bin，覆盖 native AddSubFolder/MoveClips 对选择的影响；素材池同步不调用时间线创建、删除、切换或 append API。
6. 验证批量调用次数、重复运行零新增、跨目录复用、乱序/部分/空响应、异常后的已导入项回读、单项失败与续跑、照片身份和目录恢复。实机验证只使用明确标记的临时测试工程，记录实际范围；无法连接 Resolve 时必须区分单元测试通过与实机未验证。

第二批验证：`resolve-media-sync-host` 28 项、`resolve-rough-cut-runner` 1 项、`resolve-color-host-layout` 29 项，共 58 项通过；根仓与 Console 构建通过。Studio 21.1.2.10 临时工程 `Kairos Media Batch Test 20261102 f46b22` 中，3 段视频一次导入、2 张编号照片分别作为 `Still` 导入；重复运行 `imported=0 / reused=5`，追加后 `imported=1 / reused=5`，分类移动 `imported=0 / moved=1 / reused=5`。原 item unique ids 保持一致，测试工程始终没有时间线，原选中 bin 得到恢复。测试工程和临时媒体均已清理；原 `中秋国庆闽赣自驾 [Edit]` 工程、`回程进入山野 [ep3-return-to-wild]` 时间线及播放头已恢复，未修改其时间线内容。实机审计留在忽略目录 `.tmp/resolve-media-batch-smoke/`。

## 第三批：Ingest 实时进度

用户要求在“导入与 GPS 刷新”操作区域直接看到 Ingest 进度。

- 沿用 Supervisor progress 合同，在项目 `.tmp/ingest/progress.json` 写入当前 jobId。阶段覆盖配置准备、行程上下文、同源 GPS 准备、扫描、元数据读取、时间/GPS 绑定、索引写入、空间缓存刷新、时间校验及完成。保留既有导入顺序，不为进度重新扫描或重跑工作。
- 根目录显示名称与 `第 n / N 个目录`。扫描显示已发现的素材数及当前目录；总数未知时不生成百分比。元数据读取和绑定显示当前根目录内的 `已完成 / 总数`、当前文件及阶段百分比，不冒充整体时间百分比。
- 每次进度包含累计发现数、已完成主素材数，以及 metadata 读取/复用/失败数量（含保护音轨）。完成时保留新增/删除/总资产数；失败保留当时阶段、文件、计数与错误。
- 并发 worker 的进度写入串行化并节流到约 250ms 一次，阶段切换与结束强制落盘，防止乱序覆盖与大量小文件写入拖慢缓存复用。
- 状态 API 只返回 jobId 精确匹配的进度。运行状态仍以 Supervisor job 为准；完成、失败、停止均显示历史快照，不能把磁盘上的 running 文本当成活跃任务。
- 操作区优先显示该项目的活跃任务，避免最近一次 GPS 刷新记录遮住仍在运行的 Ingest。只保留一处任务状态；结果文件路径移入诊断折叠区。没有上报进度的旧任务明确显示缺少进度，不伪造百分比。
- 验证扫描与逐文件阶段、并发计数、完成/失败、跨 job 缓存隔离、旧任务兼容及 UI 渲染；根仓和 Console 分别构建。部署前确认没有活动任务，不中断用户已经启动的 Ingest，也不自动重跑实际项目。

第三批验证：后端 Ingest/cache/progress/Supervisor 定向测试 35 项、Console 进度与运行状态测试 21 项通过；根仓与 Console 构建通过。Console 测试使用本机 Node 20.20.2（默认 Node 18 无法加载现有 Ant Design ESM 依赖）。正式 Supervisor 重启后，用临时项目真实导入 200 个 MP4，再追加 800 个：首轮读取 200；次轮读取 800、复用 200、失败 0，新增 800。状态 API 连续取得 63 次元数据阶段及 2 次绑定阶段运行快照，阶段计数单调推进；浏览器确认目录、当前文件、并行数、28% 阶段进度及读取/复用计数实际显示，完成摘要与 ML stopped 状态正确。临时项目、媒体和两次测试任务已清理，原项目视图已恢复；截图与 API 审计保留在忽略目录 `.tmp/ingest-progress-smoke/`。用户此前那轮 Ingest 在部署前已完成，未重跑实际项目。
