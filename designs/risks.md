# Kairos — 技术风险与难点

> 注：本文讨论的是“正式流程 + 当前实现”共同面对的风险。
> 当前正式主链仍以 `Pharos` 为主输入；当前实现仍是临时承载版本；`DaVinci color` 是与主链解耦的独立增强链路。
> 因此，涉及 Resolve / 调色的风险应优先理解为“独立链路风险”，而不是所有项目主链都会被强制阻塞的单点风险。

## R1. DaVinci Resolve 集成

**风险等级**：高

| 维度 | 说明 |
|------|------|
| 问题 | DaVinci Resolve Scripting API 仅提供 Python/Lua 绑定，无原生 Node.js SDK |
| 影响 | Resolve 侧调色链路、Resolve 时间线导入、PowerGrade 生成 |
| 难点 | 需要 MCP Server 作为中间层，增加部署复杂度 |
| 风险 | Resolve API 文档不完善，部分功能未公开；不同版本 API 行为可能不一致；免费版与 Studio 版 API 权限不同 |
| 缓解 | MCP 优先，子进程调用 Python 作为 fallback |
| 反馈 | 能否走MCP，如果不能，就走子进程吧 |
| 调研 | **MCP 方案可行✅**。GitHub 已有成熟项目 [samuelgursky/davinci-resolve-mcp](https://github.com/samuelgursky/davinci-resolve-mcp)（v2.1.0, 2026-03-16），覆盖 Resolve Scripting API 全部 324 个方法（100%），支持 macOS/Windows/Linux。包含 Graph 对象（节点操作、LUT、调色）、Timeline（轨道/片段/导出）、Gallery（PowerGrade/静帧）等 13 个 API 对象类。**前提：需 DaVinci Resolve Studio 版（≥18.5），免费版不支持外部脚本。** 依赖 Python 3.10-3.12。方案：Kairos 作为 MCP Client 直接调用该 Server，无需自己写 Python 桥接层。子进程方案作为 fallback 保留。这条风险主要影响 Resolve 相关独立链路与 Resolve 导出路径，不应阻塞无 Resolve / 无调色场景下的正式主链。 |

## R2. AI 调色参数生成

**风险等级**：高

| 维度 | 说明 |
|------|------|
| 问题 | 目前没有成熟的开源模型能直接从画面生成达芬奇节点参数 |
| 影响 | 独立调色链路的可用性与调色结果质量 |
| 难点 | 调色是高度主观的创作行为，"正确"没有客观标准；S-Log3/D-Log M 的色彩科学复杂，错误转换会导致色彩断裂 |
| 风险 | 可能需要大量实拍素材做微调训练集，数据获取成本高 |
| 缓解 | 初期采用规则引擎（CST + 基础曲线调整）兜底，AI 仅做风格建议；积累用户反馈后逐步迭代模型 |
| 反馈 | 是否能固定插入节点，做一些固定的操作，然后二级调色为波形图达到某种规则 |
| 调研 | **固定节点模板可行✅**。Resolve Scripting API 的 Graph 对象支持 AddSerialNode / AddParallelNode / AddLayerNode / SetNodeLUT / SetCDL / ResetAllGrades / SetNodeEnabled 等操作（nodeIndex 为 1 基索引，v16.2.0+）。可以程序化构建固定节点树，例如：Node1=CST（S-Log3→Rec.709）→ Node2=曝光校正 → Node3=风格 LUT → Node4=二级微调。**波形图规则驱动方案需分两条路径**：① Resolve API 本身**不暴露波形图/示波器数据**（无 GetScopeData 类 API），无法直接从 Resolve 读取波形数值。② **替代方案：用 FFmpeg `signalstats` filter** 在 Resolve 外部分析视频帧的 YMIN/YMAX/YAVG/UAVG/VAVG 等信号统计数据，或用 OpenCV 计算直方图，根据目标亮度范围（如 YAVG→IRE 40-70）计算 Lift/Gamma/Gain 调整量，再通过 API 写入节点参数。这是一条完全可行的自动化路径：FFmpeg 分析→规则计算→API 写入。 |

## R3. 视频内容理解的精度与速度

**风险等级**：高

| 维度 | 说明 |
|------|------|
| 问题 | 数百条 4K 素材逐帧送入多模态模型，推理耗时和成本极高 |
| 影响 | 场景检测、素材评分、内容描述均依赖视觉理解，是全管线的基础 |
| 难点 | 需在精度和速度间找平衡——抽帧太稀疏丢信息，太密集耗时爆炸 |
| 风险 | 本地 CLIP 模型（ONNX Runtime）在不同平台上推理性能需实测验证 |
| 缓解 | 分层策略：先用轻量 CLIP 做粗筛和聚类，仅对关键帧调用多模态大模型做精细理解；充分利用代理文件降低分辨率 |
| 反馈 | 上一步在调色后，导出时同时导出低分辨率代理文件，包括图片也可以，缓存到一个目录，进行分析 |
| 调研 | **完全可行✅，且能显著降低分析成本**。具体方案：① Kairos 用 FFmpeg 生成低分辨率代理（720p H.264），同时抽取关键帧截图（FFmpeg `select='eq(pict_type,I)'` 或按时间间隔抽帧 `fps=1/5` 得到每 5 秒一张图片）。② CLIP 模型（ViT-B/16）输入分辨率固定为 224×224，**即使原始素材是 4K，送入前也会被 resize**，因此使用 720p 代理甚至缩略图不会损失 CLIP 精度。③ 场景描述由 Agent LLM 基于 CLIP 聚类结果 + 关键帧描述生成，无需本地多模态大模型。④ 分析调色后的代理而非原始 Log 素材，AI 看到的是最终色彩意图，内容理解更准确。⑤ 缓存目录按 `cache/proxy/{clip_id}.mp4` 和 `cache/keyframes/{clip_id}/` 组织。 |

## R4. GPS 时间戳与素材时间对齐

**风险等级**：中

| 维度 | 说明 |
|------|------|
| 问题 | 相机内部时钟与 GPS 轨迹记录设备的时间可能存在偏移 |
| 影响 | 时间错位会导致地点匹配错误，连锁影响脚本叙事的地理准确性 |
| 难点 | 不同设备（Sony/DJI/手机）时区处理不一致；部分相机不写入 GPS 信息到 EXIF |
| 缓解 | 提供手动时间偏移校准；利用无人机素材（自带精确 GPS）做锚点交叉验证 |
| 反馈 | 这个应该不是问题 |
| 调研 | **同意降级为低风险**。Sony A7R5/A7R3/ZV-E1 的 EXIF 写入 DateTimeOriginal 精度到秒，DJI Mavic 4 Pro 的 SRT/GPX 轨迹自带高精度 GPS 时间戳。两者时间基准均可溯源到 UTC。实际使用中，只要相机时间设置正确（拍摄前同步手机时间），偏移通常在 1-2 秒以内，对地点匹配影响可忽略。保留手动偏移校准作为兜底即可。**GPS 记录方案已确定**：① **主力：GPSLogger for Android**（[github.com/mendhak/gpslogger](https://github.com/mendhak/gpslogger)，4.8k+ stars，开源免费）——设置"Start on bootup"开机自启，后台前台服务常驻记录，输出标准 GPX 文件，支持自定义 HTTP POST 推送到 Kairos 本地端点。记录间隔建议 1-2 分钟或基于 100m 距离变化，日耗电约 5-10%。② **备份：车载 OBD GPS 记录仪**——坦克500 Hi4-T 有标准 OBD-II 接口（方向盘下方左侧），插入后点火自动记录、熄火自动保存，零操作覆盖驾驶段。③ DJI Mavic 4 Pro 飞行段自带 SRT/GPX 高精度轨迹。Kairos 侧设计：接收多源轨迹数据（GPX 文件导入 + HTTP 推送），按时间戳合并去重后匹配素材 EXIF 时间。 |

## R5. 跨平台 FFmpeg 与本地模型部署

**风险等级**：中

| 维度 | 说明 |
|------|------|
| 问题 | FFmpeg 编解码器支持、硬件加速方式在 macOS (VideoToolbox) 和 Windows (NVENC/QSV) 上差异大 |
| 影响 | 代理生成、缩略图提取的性能和兼容性因平台而异 |
| 难点 | ONNX Runtime 在 macOS 走 CoreML，Windows 走 DirectML/CUDA，配置和性能表现不同；whisper.cpp 在 macOS 走 Metal，Windows 走 CUDA |
| 缓解 | 封装平台检测层，自动选择最佳硬件加速后端；CI 中加入双平台测试 |
| 反馈 | 这个实际尝试吧 |
| 调研 | **风险可控，Phase 1 实测验证**。FFmpeg 方面：macOS VideoToolbox 和 Windows NVENC 的命令行参数差异已有成熟封装方案（fluent-ffmpeg 的 `.outputOptions()` 按平台分支即可）。ONNX Runtime 方面：macOS 和 Windows 均有官方 Node.js 绑定（onnxruntime-node），CLIP 模型推理结果由权重决定，与后端无关。**主要差异点**：① 代理生成速度（VideoToolbox vs NVENC），② Whisper 推理速度（whisper.cpp Metal vs CUDA），③ CLIP 特征提取速度（CoreML vs DirectML）。建议 Phase 1 在两台机器上分别 benchmark 以上三项，记录耗时基准线。 |

## R6. OTIO / FCPXML 时间线格式兼容性

**风险等级**：中

| 维度 | 说明 |
|------|------|
| 问题 | OpenTimelineIO (OTIO) 的 Node.js 绑定不成熟，社区维护状态不明 |
| 影响 | 粗剪输出是管线末端的关键交付物，格式不兼容直接导致无法使用 |
| 难点 | FCPXML 版本间有差异（FCP X vs DaVinci 解析行为不同）；EDL 格式古老，不支持复杂时间线 |
| 缓解 | MCP 方案下由 Resolve 自身处理格式兼容；子进程 fallback 时用 xmlbuilder2 拼 FCPXML 1.11 |
| 反馈 | 这个依赖于风险1，风险1解决了应该就行 |
| 调研 | **确认与 R1 强绑定✅**。若走 MCP 方案，davinci-resolve-mcp 的 Timeline 对象已支持 ExportToFile（FCPXML/EDL/AAF 等格式）、ImportToTimeline、SetTrack 等操作，**时间线格式兼容问题由 Resolve 自身处理**，Kairos 无需自己拼 FCPXML。若 R1 走 MCP，R6 自动解决。若走子进程 fallback，仍需自行拼 FCPXML，但 FCPXML 1.11 的 XML Schema 公开，Node.js 用 xmlbuilder2 库生成即可，复杂度可控。 |

## R7. 素材规模与 JSON 存储性能

**风险等级**：低-中

| 维度 | 说明 |
|------|------|
| 问题 | 单次旅行可能产生 500-1000 条素材，`index.json` 可能膨胀到数 MB |
| 影响 | 大 JSON 文件的读写、查询性能退化，尤其在频繁交互场景下 |
| 难点 | JSON 不支持部分读写，每次修改需全量序列化/反序列化 |
| 缓解 | 初期 1000 条以内 JSON 完全够用（~2-5MB）；若后续规模增长，可透明迁移到 SQLite，上层接口不变 |
| 反馈 | 这个设计一下索引，应该还好 |
| 调研 | **同意，低风险✅**。1000 条素材的 index.json 约 2-3MB，Node.js `JSON.parse()` 耗时 <50ms（实测 V8 引擎解析 5MB JSON ~30ms）。设计要点：① 使用 `Map<clipId, MediaInfo>` 结构，clipId 为文件内容 hash 前 12 位，保证唯一性。② 按需加载：启动时只读索引摘要（路径+时间+时长），详细元数据延迟加载。③ 增量写入：使用 write-file-atomic 保证写入原子性，避免断电损坏。④ 若后续超过 5000 条，可无缝切换到 better-sqlite3（Node.js 最成熟的 SQLite 绑定），接口层做 Repository 抽象即可。 |

## R8. 脚本生成的叙事质量

**风险等级**：中

| 维度 | 说明 |
|------|------|
| 问题 | LLM 生成的旅行脚本容易"模板化"、缺乏个人风格和情感深度 |
| 影响 | 脚本质量直接决定用户对工具的信任度和使用意愿 |
| 难点 | 需要将视觉内容描述、GPS 地理信息、用户笔记多源融合，上下文窗口压力大 |
| 缓解 | 提供 few-shot 示例注入（用户可上传自己过往作品作为风格参考）；分段生成降低单次上下文长度；交互编辑让用户保持主导权 |
| 反馈 | 我可以提供过往的作品供分析学习 |
| 调研 | **Few-shot 风格学习可行✅，且是最实用的提升路径**。方案：① **风格档案库**：导入过往成片的字幕/脚本文本，提取叙事结构、用词偏好、节奏模式，存为 `style-profile.json`。② **Few-shot 注入**：每次生成脚本时，在 system prompt 中注入 2-3 个过往脚本片段作为风格示例，LLM（GPT-4o/Claude/Qwen）能有效模仿个人语调和叙事节奏（GPT-3 论文已验证 few-shot 的泛化能力，后续模型更强）。③ **结构化模板**：分析过往作品的段落结构（开场→转场→高潮→收尾），提取为叙事框架模板，约束 LLM 输出结构。④ **迭代优化**：每次用户编辑脚本后，保存编辑 diff 作为偏好反馈，逐步微调 prompt。不需要模型微调，纯 prompt engineering 即可达到不错效果。 |

## R9. Node.js 处理大量媒体文件的 I/O 压力

**风险等级**：低

| 维度 | 说明 |
|------|------|
| 问题 | 扫描数百 GB 素材目录、批量调用 ffprobe 提取元数据时，文件 I/O 和子进程开销大 |
| 影响 | Ingest 阶段耗时过长影响用户体验 |
| 缓解 | Node.js 异步 I/O 天然适合并发文件操作；使用工作池（worker_threads 或 p-limit）控制并发度；增量扫描（仅处理新增/变更文件） |
| 反馈 | 可以在我睡觉的时候进行预处理，用中间格式交换 |
| 调研 | **后台预处理完全可行✅**。方案：① **任务队列**：使用 p-queue（轻量级 Promise 队列，无 Redis 依赖）管理预处理任务，配合 JSON 文件持久化任务状态（`cache/preprocess/jobs.json`），支持中断恢复。② **夜间批处理流程**：用户导入素材后，标记为"待预处理"→ 睡觉前启动 batch job → p-queue Worker 依次执行：ffprobe 元数据提取 → 代理文件生成 → 缩略图/关键帧导出 → CLIP 特征提取 → 场景检测分组。③ **中间格式**：预处理结果写入 `cache/preprocess/{clip_id}.json`（元数据+CLIP embedding+场景标签），次日启动时直接读取，无需重复计算。④ **进度持久化**：每个 Job 完成后立即写入 jobs.json，进程重启时读取并跳过已完成任务。⑤ **资源控制**：通过 p-queue concurrency 参数限制 FFmpeg 并发数（建议 CPU 核心数 × 50%），避免打满系统资源。 |

## R10. `path-timezones` 退出后的时间链路收口

**风险等级**：中

| 维度 | 说明 |
|------|------|
| 问题 | 当前 ingest / analyze 仍显式依赖 `path-timezones` 和 timezone metadata，直接删除可能导致时间解析、人工行程匹配和文档约定脱节 |
| 影响 | Ingest / Analyze / 协议字段 / 设计文档 |
| 难点 | 需要把“素材时间真值”和“空间推断”彻底拆开，避免仍有代码把 timezone 当作素材侧输入 |
| 风险 | 删除不彻底会留下死字段、误导性文档或隐式 fallback，后续行为变得不可预测 |
| 缓解 | 统一改为 `create_time(UTC) -> filename -> filesystem`；删除 `path-timezones` 读取链；让 `manual-itinerary` 不再承担素材时间解释职责 |
| 反馈 | 用户明确要求：`path-timezones` 不再需要；素材时间直接读取文件 `create_time`，它已经是 UTC；`manual-itinerary` 本来就不应该写 timezone |
| 调研 | **方案可行✅**。现有 `resolveCaptureTime()` 已经把 `creation_time` 作为最高优先级，只需移除 timezone 入参与相关 metadata 写入即可；仓库中 `path-timezones` 的消费点集中在 `project-ingest.ts`、`project-analyze.ts`、`spatial-context.ts`、`store/index.ts`，影响范围清晰且可控。 |

## R11. `manual-itinerary` 从“时间修正”重定义为“GPS 推断”

**风险等级**：中

| 维度 | 说明 |
|------|------|
| 问题 | 当前 `manual-itinerary` 仍以 timezone/date/time window 为匹配中心，产物只有 `gpsSummary/placeHints` 文本，尚未形成结构化坐标 |
| 影响 | Analyze 粗扫报告、chronology 证据、后续空间叙事与素材分析 |
| 难点 | 需要把文本地点解析为单条最终坐标，并明确它属于“分析结果”而不是素材主数据 |
| 风险 | 若仍沿用字符串摘要，后续模块难以消费结构化 GPS；若把推断坐标直接写回 asset，又会污染素材真值层 |
| 缓解 | 新增 `IAssetCoarseReport` 上的结构化 inferred GPS 字段；每个 asset 只保留一条最终推断坐标；地点文本到坐标通过地图服务解析 |
| 反馈 | 用户明确要求：如果提供了 GPX 文件，则优先使用 GPX；`manual-itinerary` 只在没有 GPX 或 GPX 无法匹配时，推断 GPS 为后续素材分析流程做准备；存储粒度为“每个 asset 一条最终推断 GPS”；不需要兼容旧格式 |
| 调研 | **主方案可行✅**。仓库当前尚无结构化坐标写入逻辑，但已有 `gpsSummary/placeHints` 分析层挂载点，适合扩展；同时已验证高德地图 MCP 的 `maps_geo` / `maps_text_search` 能从地点文本返回经纬度，例如“北京市天安门”可稳定返回 `116.397463,39.909187`，足以支撑文本地点到单点坐标的推断链。 |

## R12. Node 16 下的测试基建兼容性

**风险等级**：低-中

| 维度 | 说明 |
|------|------|
| 问题 | 当前仓库运行时为 Node `v16.20.2`，最新版 `vitest` 无法启动，导致 TDD 回路在测试框架层面中断 |
| 影响 | 本次实现的测试与验证流程 |
| 难点 | 需要在“不升级项目最低 Node 版本”的前提下，选择兼容的测试运行器版本 |
| 风险 | 若继续使用最新版测试框架，红测失败原因将不是业务逻辑而是运行时 API 缺失 |
| 缓解 | 使用明确兼容 Node 16 的测试框架版本，并把该约束写入计划和脚本 |
| 反馈 | 当前用户未要求升级 Node 版本，因此默认保持 Node 16 兼容 |
| 调研 | **可行✅**。已确认当前运行时为 Node `v16.20.2`；`vitest@4.1.2` 要求 Node `^20 || ^22 || >=24`，`vitest@1.6.1` 要求 Node `^18 || >=20`。最终落地选择为 `vitest@0.32.0 + vite@4.5.5`：两者都明确兼容 Node 16，并且能避开 `vite@5` 在 Node 16 上的 `crypto.getRandomValues` 启动问题。 |

## R13. 内嵌 GPS / GPX / manual 的来源优先级边界

**风险等级**：中

| 维度 | 说明 |
|------|------|
| 问题 | 当前 analyze 代码需要同时处理素材内嵌 GPS、外部 GPX 和 `manual-itinerary` 三类来源，必须明确真值优先级与 fallback 边界 |
| 影响 | Analyze 粗扫报告、chronology 证据、空间上下文来源优先级 |
| 难点 | DJI/QuickTime 内嵌 GPS 字段命名存在变体；GPX 仍需要时间匹配容差；同时要避免让 `manual-itinerary` 覆盖素材同源真值 |
| 风险 | 可能出现：错误解析内嵌 GPS；或者内嵌 GPS 缺失时，GPX / `manual-itinerary` fallback 不稳定，导致空间上下文丢失或被误覆盖 |
| 缓解 | 统一来源优先级为 `embedded GPS > GPX > manual-itinerary`；本轮只实现最小内嵌字段集和最小 GPX 匹配；测试锁住三者优先级与 chronology 来源表达 |
| 反馈 | 用户明确要求：大疆无人机拍摄的视频里，已经有非常丰富的 GPS 数据 |
| 调研 | **最小方案可行✅**。当前 ingest 已把 `ffprobe` 提取到的 `rawTags` 落到 `asset.metadata.rawTags`，因此可以先从素材 metadata 中解析同源 GPS；已验证的最小字段集包括 QuickTime/DJI 常见 `location` / `com.apple.quicktime.location.iso6709` 以及标准化 `gpslatitude/gpslongitude`。在此基础上，再回落到现有 GPX 最近点匹配和 `manual-itinerary` fallback，能以最小改动打通 `embedded > GPX > manual-itinerary`。 |

## R14. 派生素材版本的关键元信息保真

**风险等级**：高

| 维度 | 说明 |
|------|------|
| 问题 | 调色、转码、导出或其他独立链路产出的派生素材版本，可能丢失媒体创建时间、`create_time`、GPS 等关键元信息 |
| 影响 | Ingest / Analyze / Chronology / Pharos 对齐 / 空间推断 |
| 难点 | 不同工具对容器 metadata、EXIF、QuickTime tags 的保留策略不一致；有些链路会重写文件但不自动继承原始字段 |
| 风险 | 一旦主链消费的是元信息缺失的派生素材版本，chronology 排序、Pharos 匹配、GPS 推断与后续审查都会失真，且原始素材可能已被清理，难以补救 |
| 缓解 | 将“关键元信息保真”提升为跨链路硬约束；任何进入正式主链的派生素材版本都必须保留至少媒体创建时间、`create_time`、GPS / 空间相关元信息，以及后续匹配所需的其他核心字段；若工具默认不保真，则需要补写 metadata 或增加导出后校验步骤 |
| 反馈 | 用户明确要求：素材的转换导出一定要保留元信息，包括媒体创建时间、`create_time`、GPS 等等，并写入正式文档 |
| 调研 | **方案可行✅，且必须作为正式约束执行**。对视频 / 容器类素材，可通过保留或补写容器 metadata（如 `creation_time` / QuickTime location tags）保证时间与空间语义连续；对照片类素材，可通过保留或补写 EXIF 保证 `DateTimeOriginal` / GPS 字段不丢失。设计上更重要的是：Kairos 必须把“派生素材进入主链前的元信息校验”当作正式边界条件，而不是假设外部工具会自动保真。 |

## R15. 设计文档、rules、skills 与正式入口漂移

**风险等级**：中

| 维度 | 说明 |
|------|------|
| 问题 | 需求和实现已经变化，但 README、设计文档、rules、skills 或正式入口说明仍停留在旧口径 |
| 影响 | Agent 执行路径、用户操作路径、监控入口、工作流解释和后续需求实现 |
| 难点 | 这类漂移不一定会直接让代码报错，但会持续误导后续实现与用户操作 |
| 风险 | 可能把兼容脚本或历史静态页误当成正式入口，也可能出现“代码已变、skill 还按旧流程执行”的持续错配 |
| 缓解 | 把变更纪律提升为硬规则：任何需求、行为、接口、工作流、正式入口或用户路径变更，都必须先 `Plan`，先更设计文档，再实现，最后回查并同步设计文档、rules 和 skills；对正式入口变更还要同步 `README.md`、`designs/current-solution-summary.md`、`designs/architecture.md` |
| 反馈 | 用户明确要求：每次需求变更，都要先进入 Plan 模式，确定后先更新设计文档，然后实现，实现后复查设计文档和 skill |
| 调研 | **必须制度化✅**。这类问题已经在监控入口与 skill 口径上实际出现过：设计口径已切到 `Supervisor + React console`，但 skill / 兼容脚本仍在引导旧静态页。解决方式不是“下次记住”，而是把流程固化到 rules、skills 与主文档中。 |

---

## 风险矩阵总览

| ID | 风险项 | 等级 | 阶段影响 | 缓解难度 |
|----|--------|------|----------|----------|
| R1 | DaVinci Resolve 集成 | 高 | Color / Cut | 中 |
| R2 | AI 调色参数生成 | 高 | Color | 高 |
| R3 | 视频内容理解精度与速度 | 高 | Ingest / Script / Cut | 中 |
| R4 | GPS 时间戳对齐 | 中 | Ingest / Script | 低 |
| R5 | 跨平台部署差异 | 中 | 全局 | 中 |
| R6 | 时间线格式兼容 | 中 | Cut | 低 |
| R7 | JSON 存储性能 | 低-中 | 全局 | 低 |
| R8 | 脚本叙事质量 | 中 | Script | 中 |
| R9 | Node.js 媒体 I/O | 低 | Ingest | 低 |
| R10 | `path-timezones` 退出后的时间链路收口 | 中 | Ingest / Analyze | 低 |
| R11 | `manual-itinerary` 从“时间修正”重定义为“GPS 推断” | 中 | Analyze / Script | 中 |
| R12 | Node 16 下的测试基建兼容性 | 低-中 | 测试 / 验证 | 低 |
| R13 | 内嵌 GPS / GPX / manual 的来源优先级边界 | 中 | Analyze / Chronology | 中 |
| R14 | 派生素材版本的关键元信息保真 | 高 | Color / Ingest / Analyze / Chronology | 中 |
| R15 | 设计文档、rules、skills 与正式入口漂移 | 中 | 全局 | 低 |
