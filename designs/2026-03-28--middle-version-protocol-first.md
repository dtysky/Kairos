# Kairos — 中间版本设计（Protocol First）

> 日期：2026-03-28
> 定位：介于“全链路 AI 后期平台”和“只做脚本助手”之间的中间版本
> 核心目标：先把可复用的中台能力做对，再通过独立的 NLE Server / 适配层落地到剪映，并为后续达芬奇/其他 NLE 复用

## 1. 背景

当前总设计覆盖了素材导入、GPS、调色、脚本生成、达芬奇时间线、MCP 集成等完整链路，但对首个真实项目来说跨度过大。

与此同时，若只退化成“文案助手”，又会失去后续最有复用价值的能力沉淀：

- 视频 / 图片内容切片与识别
- 脚本生成与结构化编辑
- 时间线交换协议
- 时间线生成
- 字幕生成与添加
- 面向不同 NLE 的自动化落地

因此需要一个中间版本：

- 不强依赖 GPS、Pharos、调色和达芬奇
- 但保留未来可复用的核心中台
- 以剪映作为第一个落地 NLE，并将其自动化能力剥离为独立 Server
- 后续可平移到达芬奇 MCP 或导出协议

## 2. 设计目标

### 2.1 必须满足

1. **协议先行**：正式时间线交换格式必须严谨、版本化、可校验，而不是依赖临时文本标记语法。
2. **编辑器解耦**：剪映、达芬奇、未来其他 NLE 都只能依赖统一中间协议，不允许直接把业务逻辑写死在某个 MCP 上。
3. **切片优先**：视频/图片内容理解的基础单位不是“整条素材”，而是 `slice`。
4. **脚本与时间线分层**：脚本负责叙事，时间线负责编排；两者有关联，但不是同一个对象。
5. **字幕一等公民**：字幕不应是脚本的副产物，而应是协议中的正式对象。
6. **无 GPS 可工作**：地点、路线、场景信息允许缺失，用“证据系统”补位。

### 2.2 可接受的限制

- 不在中间版本内做调色自动化
- 不在中间版本内实现完整 GUI
- 不要求首版支持双向编辑器同步
- 不要求首版自动生成 100% 可直接交付的最终时间线

## 3. 产品定位

中间版本的 Kairos 不是“剪辑器”，而是一个 **叙事编排引擎**：

- 吃进去：素材、切片、识别结果、风格档案、人工备注、脚本意图
- 产出来：结构化脚本、结构化时间线、结构化字幕、面向 NLE 的执行计划

这个定位决定了它的核心不是某个 MCP，而是：

- `内容理解层`
- `脚本层`
- `时间线协议层`
- `NLE 适配层`

## 4. 中间版本范围

### 4.1 本版本纳入

- 媒体资产导入
- 视频镜头切片 / 图片资产切片
- 切片级内容识别
- 风格档案
- 脚本生成与编辑
- 统一时间线交换协议
- 时间线生成
- 字幕生成
- NLE 适配器抽象
- 剪映 Server 客户端与导出任务协议

### 4.2 延后

- GPS 自动匹配
- Pharos 数据集成
- 调色辅助
- 达芬奇专属高级能力
- 双向回读 NLE 时间线
- Tauri UI

## 5. 核心设计决策

### D1. 正式协议采用版本化 JSON，而不是临时文本语法

你当前使用的 `（）【】{}《》` 这类文本标记可以保留为 **临时导入器** 或 **人工草稿格式**，但**绝不能成为正式协议**。

正式协议需要满足：

- 明确的对象类型
- 稳定 ID
- 毫秒级时间基准
- 可附加证据与置信度
- 可由 Zod / JSON Schema 校验
- 可被不同编辑器适配器复用

### D2. “切片”是全系统共享中间层，但不是所有素材的第一层分析结果

`slice` 是连接内容理解、脚本生成、时间线生成的关键对象，但不意味着每条素材一上来都必须被切成镜头级对象。

- 对视频：一个 `slice` 可以是镜头段、延时片段、口播段、航拍段、驾驶段、空镜段
- 对图片：一个 `slice` 可以是单张照片或照片集合中的单元

中间版本应分两层：

- **粗扫层**：先形成资产级 `asset report`
- **细扫层**：只对高价值素材或高价值时间窗生成 `slice`

后续脚本引用 `slice`，时间线编排也引用 `slice`，而不是直接引用原始素材文件；但 `slice` 的生成应建立在“自动判定值得细扫”的前提上。

### D3. 时间线协议必须编辑器无关

协议中只描述：

- 有哪些轨道
- 放了哪些片段
- 每个片段用哪个 `slice`
- 在源素材中取哪一段
- 在时间线上摆到哪里
- 有哪些字幕、转场、基础运动参数

协议中不直接包含“剪映怎么点”“达芬奇哪个 API 名称”这类实现细节。

### D4. NLE 自动化全部收口到适配器层

中间版本只定义统一接口：

- 剪映通过 `JianyingServerClient` 对接独立 `Jianying Server`
- 达芬奇 MCP 是 `ResolveAdapter`
- 将来导出 FCPXML/OTIO 也只是另一种适配器或导出器

业务模块不能直接调用任何一个具体 NLE 的 MCP 方法，也不能直接拉起平台敏感的 NLE 自动化进程。

### D5. 空间上下文支持双主模式：GPS 增强模式 + 无 GPS 证据模式

中间版本不把 GPS 设为唯一前提，而是明确支持两种主模式：

- **GPS 增强模式**：有 GPS / Pharos / 无人机轨迹时，优先利用时间和空间信息增强地点识别、路线叙事和素材召回
- **无 GPS 证据模式**：没有 GPS 时，仍可依赖多模态证据构建地点线索和叙事骨架

也就是说：

- 有 GPS 更好，空间排序和地点置信度更强
- 没有 GPS 也不是降级到“不可用”，而是另一种正式支持的工作模式

无 GPS 模式下，地点和叙事线索可以来自：

- 文件夹名
- 文件名
- OCR 识别出的地名
- ASR 提取的口播内容
- 图像识别出的地标
- 用户手动标签
- 未来的 GPS / Pharos 数据

两种模式最终都统一进入 `evidence[]`，区别只在于证据强弱和可用能力不同，而不是协议分叉。

建议定义：

```typescript
type SpatialContextMode = 'gps-enhanced' | 'evidence-only';
```

模式差异：

- `gps-enhanced`：更适合路线叙事、地点确认、跨设备素材对齐
- `evidence-only`：更适合旧项目复盘、无轨迹历史素材、剪映中途接管项目

协议中不把 GPS 写死成唯一真相源，但当 GPS 存在时，应把它视为高置信度证据。

### D6. 本地多模态是主分析链路，云端 LLM 只做高价值生成

中间版本的内容理解默认走 **本地多模态**：

- `FFmpeg / shot detection` 做切片和关键帧抽取
- `Whisper` 做 ASR
- `OCR` 做文本证据提取
- `CLIP/BLIP` 做快速索引、聚类和粗标签
- 本地 `VLM` 做高质量画面理解

云端 LLM 的职责收缩为：

- 脚本生成
- 段落归纳
- 风格重写
- 镜头选择建议

这意味着系统不再把“把整段视频送进云端多模态模型”当成默认路径。

### D7. 采样策略采用“时长 + 信息密度”双规则

媒体分析不能只按固定 FPS 抽样，也不能只按时长一刀切。

建议使用双规则：

- **时长规则**：长视频默认稀采样，短视频默认密采样
- **信息密度规则**：镜头切换率、光流变化、OCR 命中、VAD/口播、亮度变化、图像语义突变，会触发局部提密

目标不是分析“整条视频的每一帧”，而是尽快找到：

- 值得进入脚本的片段
- 可能是转场 / 航拍 / 延时 / 口播 / 驾驶段的片段
- 值得进入高成本 VLM 细分析的 `interestingWindows[]`

这里的“信息密度”必须明确包含语音信号，而不只是视觉信号：

- `ASR transcript segments`
- `speechCoverage`
- 由明显口播命中的 `speech windows`

因此 `interestingWindows[]` 的正式来源应是多路合流：

- shot / 视觉变化触发的窗口
- OCR / 地名 / 标签触发的窗口
- 语音覆盖高、且可能直接进入正片的口播窗口

对于旅拍纪录片工作流，带人声的视频片段不只是“辅助证据”，本身也可能直接成为可用 cut。

### D7a. 字幕必须正式支持“旁白路径”和“原声路径”

中间版本不能只假设字幕永远来自脚本旁白。正式设计需要同时支持：

- **旁白路径**：字幕来自 `beat.text`
- **原声路径**：字幕直接来自所选 `slice.transcriptSegments`

因此需要把下面这组语义明确成协议设计的一部分：

- `preserveNatSound`：显式要求这拍优先保留原声
- `muteSource`：显式要求这拍即使素材里有人声，也应静音换成旁白
- 当脚本没有显式标注时，时间线层允许根据 `speechCoverage`、`beat.text` 与 transcript 的匹配度、以及段落角色自动推论

自动推论应偏保守：

- `intro / transition / outro` 不应因为素材里有语音就默认保留原声
- `talking-head`、强口播窗口、beat 文本明显贴近原话时，才更倾向走原声路径

### D8. 拍摄时间采用 metadata-first 归一化策略

素材的拍摄时间不能依赖文件名规则，因为相机、无人机、手机、剪映导出素材的命名都可能与真实拍摄时间无关。

中间版本必须采用：

- **优先读取元信息**
- **统一归一化时间格式**
- **记录时间来源与置信度**

建议的时间提取优先级：

1. 照片 EXIF：`DateTimeOriginal` / 相关原始拍摄时间字段
2. 视频容器元信息：QuickTime / MP4 / MOV 中的创建时间字段
3. `ffprobe` 可读标签中的 creation time / recording time
4. 文件名中的可解析时间
5. 文件系统时间
6. 用户手动修正

系统需要同时保存：

- `capturedAt`
- `captureTimeSource`
- `captureTimeConfidence`

并允许后续批量修正时区或偏移。

但中间版本不应只保存“时间”，还应把每个素材的**时间与描述信息整合**成统一的时序索引，用于：

- 按拍摄时间排序浏览素材
- 为脚本生成提供“按时间推进”的叙事底稿
- 让用户对时间和描述一起修正

建议引入 `MediaChronology` 作为中间层：

- 每个素材一条或多条时序条目
- 条目同时包含时间、摘要、标签、地点线索、证据来源
- 默认按 `capturedAt` 排序
- 若时间存在修正，则按修正后的排序键重排

### D9. 素材输入采用“项目内逻辑素材源 + 设备本地路径映射”

中间版本不能把某台机器上的绝对路径直接写死进项目数据里，否则跨设备同步会立刻失效。

因此需要拆成两层：

- **项目内逻辑素材源**
  - 保存在项目内，可随项目一起同步
  - 描述“这类素材是什么”，而不是“这台机器上它在哪”
- **设备本地路径映射**
  - 保存在当前设备本地
  - 描述“这个逻辑素材源在这台机器上映射到哪个目录”

逻辑素材源需要支持：

- 一个项目配置多个素材目录
- 每个目录都有自然语言说明
- 目录说明作为弱先验证据，而不是硬语义约束

目录级注解的作用不是替代识别，而是作为 LLM / 规则系统的先验上下文，例如：

- `“主机位，风景、步行、口播都有”`
- `“无人机，全景、海岸线、地貌为主”`
- `“手机素材，路上随手拍和车内口播混合”`

这些注解应进入证据系统，但来源标记为 `manual-root-note`，不能与画面识别结果混淆。

同时必须承认：**一个目录往往并不只有一个纯语义**。用户通常按设备分目录，也可能完全不分，因此目录注解只能作为弱证据。

### D10. 剪映自动化必须剥离为独立 Server，而不是由 Kairos Core 直接通过 stdio 驱动

剪映导出涉及明显的平台边界：

- 剪映本体运行在 Windows
- 素材路径需要 Windows 语义
- 字幕与草稿写入依赖本地文件系统和剪映草稿目录
- 后续 CUDA / 本地模型也可能运行在 Windows 侧

因此，Kairos Core 不应继续：

- vendoring `jianying-mcp`
- 在 WSL 里直接 `uv run server.py`
- 直接承担草稿目录、路径映射、Windows 进程管理

建议改为双进程边界：

- **Kairos Core**：负责 `KTEP`、导出计划、任务状态、日志汇总
- **Jianying Server**：负责 Windows 路径映射、草稿创建、素材导入、字幕写入、导出结果落盘

`jianying-mcp` 可以继续作为 `Jianying Server` 的内部实现基础，但不再作为 Kairos Core 的内嵌依赖暴露。

这意味着：

- Kairos 的正式接口从“直接调用剪映 MCP 工具”升级为“向剪映服务提交导出任务”
- 剪映侧问题被限制在单独部署单元内，不再污染 Core 的协议与工作流
- 将来替换 `jianying-mcp` 实现时，不需要改动 Core 侧的脚本、时间线和 store

### D11. 项目数据放在 Kairos 工程内的 `projects/`，而不是散落在素材目录中

中间版本应支持把项目数据直接纳入 Kairos 工程，以便：

- 云端同步
- 多设备共享
- 与代码、设计、风格档案统一管理

因此建议采用：

- Kairos 工程内的 `projects/<projectId>/` 保存项目内容
- 用户原始素材目录继续留在工程外部
- 通过“逻辑素材源 + 本地路径映射”连接两者

这样系统在用户说“开始剪辑”时，可以直接列出 `projects/` 下已有项目，让用户选择，而不必再扫描任意磁盘位置猜测项目在哪。

项目选择建议：

- 若当前上下文已绑定项目，直接继续
- 若 `projects/` 下只有一个项目，默认进入该项目
- 若存在多个项目，按 `store/project.json` 中的名称、更新时间、阶段状态提示用户选择

### D12. 素材分析采用“视觉粗扫 + 音频分析 + 自动细扫”默认流程，而不是默认镜头级分析

风格分析可以接受镜头级慢流程，但剪辑素材分析不能默认照搬，否则会被长行车、长口播、低变化视频拖垮。

因此素材分析默认应拆成三个逻辑步骤：

- **视觉粗扫**
  - 面向全部素材
  - 目标是“收集低成本视觉信号”，而不是在这一步就下最终语义类型结论
- **音频分析**
  - 位于视觉粗扫之后、细扫决策之前
  - 对象应是**所有带音轨的视频**，而不是只对被视觉粗扫判成某些类型的素材开放
  - 目标是补入口播/原声相关信号，而不是等到细扫后才处理
- **统一分析与细扫决策**
  - 位于视觉粗扫和音频分析都结束之后
  - 由统一分析器综合视觉与音频信号，先推测语义类型，再决定是否进入细扫以及如何细扫
- **细扫执行**
  - 只对系统判定高价值的素材或时间窗执行
  - 目标是生成真正可进入脚本和时间线的 `slice`

视觉粗扫优先利用：

- 时长
- 元信息
- 均匀采样帧
- GPS / 轨迹（若存在）
- 少量 OCR / 低成本 VLM

音频分析负责补充：

- ASR transcript
- speech coverage（这里默认指**人声覆盖**，不是背景音乐覆盖）
- speech windows
- 口播/原声相关证据
- 人声是否构成强语义线索
- 背景音乐是否只是弱上下文而非有效叙事证据

这里需要明确一个中间版本口径：

- 视觉粗扫先产出 `visualSignals`
- 音频分析再产出 `audioSignals`
- `visualSignals` 与 `audioSignals` 都属于证据输入，在这两个阶段都不直接输出最终 `type`
- 细扫决策不是“视觉先决定，音频再补丁”，而是一个**统一分析器 / 融合决策器**同时消费这两路信号
- 音频分析的前置条件应是“视频存在可用音轨”，而不是“视觉粗扫已经认为它像 talking-head / drive / broll”
- `budget` 参与的是最终细扫决策，不应作为是否执行音频分析的前置门槛
- 强音频信号默认指**可转写的人声**，例如口播、对话、现场讲话；背景音乐本身不应被视作强细扫触发器
- 最终 `type` 应在统一分析阶段输出，并与 `shouldFineScan / fineScanMode / windows` 一起形成同一次决策结果

系统而不是用户来决定是否细扫。细扫触发信号来自视觉粗扫与音频分析的合并结果，包括：

- 高信息密度
- GPS 轨迹变化明显
- OCR / ASR 命中地点或事件线索
- 画面变化显著
- 不确定性高
- 被脚本生成或时间线阶段回溯请求

这里的合并原则应是：

- 两路信号都弱，才允许 `skip`
- 任一路信号给出可信窗口，就至少进入 `windowed`
- 只有在素材较短且高价值，或视觉/音频双信号都强时，才升级到 `full`
- 对无音轨视频，`audioSignals` 可以为空，但这不影响视觉粗扫独立推动细扫决策
- 对长行车视频，单纯存在背景音乐、发动机声、路噪，不应单独把音频信号判成“强”

### D13. 素材浏览与剪辑候选默认按拍摄时间组织，而不是只按文件夹或导入顺序

对于纪录片和旅行类项目，拍摄时间顺序本身就是重要叙事骨架。

因此中间版本应默认提供：

- **按拍摄时间排序的素材浏览**
- **按拍摄时间组织的粗剪候选**
- **允许偏离时间顺序的叙事编排**

也就是说：

- 时间顺序是默认工作底稿
- 不是时间线输出的唯一约束
- 但系统在“找素材、做粗剪、选候选片段”时应优先尊重 `sortCapturedAt`

对于用户来说，最直观的体验应是：

- 先看到“一天内从早到晚拍了什么”
- 再在这个时序底稿上做重组，而不是一开始就在杂乱文件夹里找镜头

### D14. 无 GPS 项目允许通过人工行程文件推断低置信度近似轨迹

并非所有历史项目都有真实 GPS 轨迹，但很多项目都能回忆出：

- 某天某个时间段大致从哪里到哪里
- 中间经过哪些地点
- 大概是什么交通方式

因此中间版本应支持一个**人工可填写、自然语言友好的行程文件**，用来生成低置信度近似轨迹。

这个文件的目标不是取代真实 GPS，而是：

- 补足时间顺序与空间顺序之间的联系
- 为长行车、长步行、跨地点素材提供弱空间上下文
- 帮助系统做粗扫召回、地点提示和候选片段聚类

### D15. `slice` 只是候选时间窗，真正进入编排的是 `selection`

中间版本必须明确区分三层时间单位：

- **asset**：原始素材
- **slice**：素材分析后得到的候选时间窗
- **selection**：脚本 / 时间线真正选中的子区间

这意味着：

- `slice` 并不承诺“整段都会被用到”
- `selection` 允许只截取 `slice` 内的一小段
- 时间线轨道上的 clip 应引用 `selection` 的 `sourceInMs/sourceOutMs`，而不是默认吃满整个 `slice`

对创作流程而言：

- `slice` 负责“这段值得考虑”
- `selection` 负责“最后到底用这段里的哪几秒”

### D16. 脚本应以 `beat` 为最小编排单元，而不是事后从整段旁白切字幕

中间版本不应把“整段 narration 写完，再切成字幕 cue”当成正式方案。

更符合真实剪辑流程的结构是：

- 先规划 `segment`
- 在 `segment` 内生成若干 `beat`
- 每个 `beat` 绑定一个或多个 `selection`
- `beat.text` 直接成为字幕和时间线节奏的上游来源

也就是说：

- `segment` 描述这段在全片中的作用、情绪、目标时长
- `beat` 描述这一小拍要表达什么，以及配哪段画面
- `subtitle cue` 默认来自 `beat.text`
- `segment.narration` 若存在，应视为 `beat` 的聚合预览或配音底稿，而不是时间线摆放的唯一真源

### D17. 段落规划必须经过用户审查闸门，不能直接从切片自动滑到脚本

对于一个视频项目，段落规划是创作灵魂，不能默认完全自动决定。

更合理的主流程应是：

1. 先基于 `asset reports + chronology + slices` 生成 **全量素材归纳**
2. 系统提出 `1-3` 套 **segment plan drafts**
3. 用户审查、修改、合并或选择其中一套
4. 只有冻结为 **approved segment plan** 之后，才进入候选素材召回、beat 规划和脚本试写

因此中间版本应显式引入三层中间对象：

- **ProjectMaterialDigest**
  - 全量素材印象、时间顺序、地点线索、主要母题、节奏判断
- **SegmentPlanDraft**
  - 系统自动提出的段落方案，可有 A/B/C 多版
- **ApprovedSegmentPlan**
  - 用户确认后的正式段落规划，是后续召回和 beat 编排的唯一上游

这意味着：

- `outline` 不应直接从全部 `slice` 反推出最终段落
- `candidate recall` 必须以 `ApprovedSegmentPlan` 为输入
- `rough cut proposal` 也必须建立在已确认的段落规划之上

### D18. `script-brief` 应扩展为贯穿全流程的分层 brief 系统

中间版本不应只保留一份单一的 `script-brief`。  
更符合真实创作流程的做法，是让 brief 随阶段下沉：

- **Project Brief**
  - 全片目标、风格来源、受众、总时长、禁区
- **Segment-Plan Brief**
  - 这一轮段落规划想回答什么问题
  - 更偏时间顺序、地点顺序还是情绪顺序
  - 哪些章节必须存在
- **Segment Brief**
  - 某一章节的作用、目标时长、情绪、原声策略、是否允许实验性剪法
- **Beat Polish Brief**
  - 对某一小拍的文案、切点、速度和字幕策略做微调

这些 brief 都应保持 **自然语言友好**，而不是要求用户手写 JSON。

它们在流程中的作用是：

1. `Project Brief` 驱动 `ProjectMaterialDigest` 和 `SegmentPlanDraft[]`
2. `Segment-Plan Brief` 驱动段落方案审查与冻结
3. `Segment Brief` 驱动候选素材召回和 beat 试写
4. `Beat Polish Brief` 驱动局部精修和粗剪迭代

## 6. 系统架构

```text
素材文件 / 图片 / 音频 / 人工备注 / 风格档案
                 │
                 ▼
        Media Understanding
  (切片、识别、转写、标签、证据汇总)
                 │
                 ▼
         Canonical Project Store
   (assets / slices / script / timeline / subtitles)
                 │
        ┌────────┴────────┐
        ▼                 ▼
  Script Engine      Timeline Engine
 (叙事结构生成)       (轨道与片段编排)
        │                 │
        └────────┬────────┘
                 ▼
      Kairos Timeline Exchange Protocol
                 │
      ┌──────────┼──────────────┐
      ▼          ▼              ▼
 Jianying    Resolve        Exporters
  Server     Adapter        (SRT/FCPXML/OTIO...)
    │
    ▼
 剪映草稿 / Windows 日志 / 素材路径映射
```

## 7. 模块划分

### 7.1 `src/modules/media/`

负责媒体切片与识别。

建议子模块：

- `asset-ingest.ts`
- `asset-report-builder.ts`
- `shot-slicer.ts`
- `image-slicer.ts`
- `speech-transcriber.ts`
- `ocr-runner.ts`
- `capture-time-resolver.ts`
- `chronology-builder.ts`
- `frame-sampler.ts`
- `density-analyzer.ts`
- `sampling-planner.ts`
- `content-recognizer.ts`
- `vlm-runner.ts`
- `evidence-merger.ts`

职责：

- 识别媒体文件
- 读取输入目录配置与目录级注解
- 视频按镜头/规则切片
- 图片生成单图切片
- 提取并归一化拍摄时间
- 提取关键帧
- ASR 转写
- OCR 文本提取
- 估算信息密度并生成采样计划
- OCR / 图像标签 / 场景说明
- 路由到本地 VLM 做重点分析
- 先生成资产级 `asset report`
- 再对重点素材或窗口生成可复用的 `slice`

### 7.1.1 输入目录配置

建议定义：

```typescript
interface MediaRootDefinition {
  id: string;
  label: string;
  enabled: boolean;
  category?: 'camera' | 'drone' | 'phone' | 'audio' | 'exports' | 'mixed';
  priority?: number;
  description?: string;
  notes?: string[];
  tags?: string[];
  defaultTimezone?: string;
}
```

规则：

- 一个项目可配置多个 `media root`
- 项目内保存的是逻辑素材源定义，而不是本机绝对路径
- `description` / `notes` 作为目录级弱语义注解进入分析上下文
- `tags` 用于规则筛选和脚本召回
- `defaultTimezone` 用于元信息缺失时的时间归一化

自然语言输入建议：

```text
路径：F:\NZ\A7R5
说明：主机位，风景、步行、口播都有

路径：F:\NZ\Drone
说明：无人机，全景和地貌为主
```

系统职责：

- 先接受这种自然语言输入
- 自动生成稳定的 `rootId`
- 把“说明”写入项目内的 `ingest-roots.json`
- 同时把当前设备上的真实路径写入本地路径映射

### 7.1.2 设备本地路径映射

建议在项目外、设备本地保存：

```typescript
interface DeviceMediaRootMap {
  projectId: string;
  roots: Array<{
    rootId: string;
    localPath: string;
    exists?: boolean;
    lastCheckedAt?: string;
  }>;
}
```

建议位置：

- Windows: `C:/Users/<user>/.kairos/device-media-maps.json`
- macOS / Linux: `~/.kairos/device-media-maps.json`

规则：

- 不纳入项目同步
- 允许不同设备把同一个 `rootId` 映射到不同磁盘目录
- Kairos 在开始剪辑或分析前，必须先检查映射是否存在且路径是否有效

### 7.1.3 拍摄时间归一化

建议定义：

```typescript
interface CaptureTimeInfo {
  capturedAt?: string; // UTC ISO 8601
  originalValue?: string;
  originalTimezone?: string;
  source:
    | 'exif'
    | 'quicktime'
    | 'container'
    | 'ffprobe-tag'
    | 'filename'
    | 'filesystem'
    | 'manual';
  confidence: number; // 0-1
}
```

要求：

- 内部统一使用 UTC ISO 时间
- 保留原始字段和原始时区信息
- 文件名时间只能作为 fallback
- 允许后续做项目级时间偏移修正

### 7.1.4 素材时序视图

建议定义：

```typescript
interface MediaChronologyEntry {
  id: string;
  assetId: string;
  ingestRootId?: string;
  capturedAt?: string; // UTC ISO 8601
  sortCapturedAt?: string; // 修正后用于排序的时间
  captureTimeSource?: CaptureTimeInfo['source'];
  captureTimeConfidence?: number;
  summary?: string;
  labels: string[];
  placeHints: string[];
  evidence: Array<{
    source:
      | 'vision'
      | 'asr'
      | 'ocr'
      | 'filename'
      | 'folder'
      | 'manual-root-note'
      | 'manual'
      | 'gps'
      | 'pharos';
    value: string;
    confidence?: number;
  }>;
  correction?: {
    capturedAtOverride?: string;
    summaryOverride?: string;
    labelsAdd?: string[];
    labelsRemove?: string[];
    reason?: string;
    updatedAt: string;
  };
}
```

规则：

- `capturedAt` 保存系统解析出的原始归一化时间
- `sortCapturedAt` 保存修正后的排序时间；若无修正，则等于 `capturedAt`
- `summary` 默认来自媒体分析层
- `summaryOverride` 允许用户对素材描述进行纠正
- 时间修正和描述修正都应保留原值，不直接覆盖底层分析结果
- `MediaChronologyEntry[]` 是脚本生成按时间组织素材的首要输入之一
- 在素材浏览、候选片段检索、粗剪预排时，`sortCapturedAt` 应作为默认排序键
- 时间线生成可以打破时间顺序，但必须能回溯到“默认按时间组织”的素材视图

### 7.1.4.1 人工行程文件（无 GPS 项目的临时空间输入）

建议允许用户填写一个自然语言友好的可编辑文件，例如：

```text
日期：2025-01-05
时间：07:30 - 10:00
从：兰州
到：青海湖东岸
途经：西宁
交通方式：自驾
备注：上午主要是出发和路上空镜

日期：2025-01-05
时间：15:00 - 18:30
从：青海湖东岸
到：茶卡
交通方式：自驾
备注：下午多是公路、停车拍摄、风景和口播
```

建议文件位置：

- `projects/<project_id>/config/manual-itinerary.md`

系统职责：

- 允许用户用自然语言维护这份文件
- 解析为结构化的 `manual itinerary segments`
- 将地点名 geocode 成近似经纬度
- 在给定时间段内做低置信度路径插值
- 生成“近似 GPS / 路线证据”，但明确标记来源不是实测轨迹

建议中间结构：

```typescript
interface ManualItinerarySegment {
  id: string;
  date: string; // YYYY-MM-DD
  startLocalTime: string; // HH:mm
  endLocalTime: string; // HH:mm
  from: string;
  to: string;
  via?: string[];
  transport?: 'drive' | 'walk' | 'train' | 'flight' | 'boat' | 'mixed';
  notes?: string;
}

interface ApproximateRoutePoint {
  at: string; // ISO 8601
  lat: number;
  lng: number;
  source: 'manual-itinerary';
  confidence: number; // 低于真实 GPS
}
```

规则：

- 这类轨迹只能作为弱空间证据
- 置信度应显著低于真实 GPS / Pharos
- 可用于粗扫召回、地点提示、长行车素材排序与聚类
- 不应伪装成真实采样轨迹

### 7.1.5 素材分析的双路信号与统一决策产物

建议在中间版本里显式区分三类对象：视觉粗扫信号、音频分析信号、统一分析后的决策产物。

```typescript
interface VisualCoarseSignals {
  assetId: string;
  densityScore: number;
  summary?: string;
  labels: string[];
  placeHints: string[];
  sampleFrames: Array<{
    timeMs: number;
    path?: string;
    summary?: string;
  }>;
  interestingWindows: Array<{
    startMs: number;
    endMs: number;
    reason: string;
  }>;
}

interface AudioAnalysisSignals {
  assetId: string;
  hasAudioTrack: boolean;
  transcript?: string;
  transcriptSegments?: Array<{
    startMs: number;
    endMs: number;
    text: string;
  }>;
  speechCoverage?: number; // 人声覆盖，而不是背景音乐覆盖
  hasMeaningfulSpeech?: boolean;
  backgroundMusicOnly?: boolean;
  interestingWindows: Array<{
    startMs: number;
    endMs: number;
    reason: string;
  }>;
}

interface FineScanDecision {
  assetId: string;
  clipType: 'drive' | 'talking-head' | 'aerial' | 'timelapse' | 'broll' | 'unknown';
  shouldFineScan: boolean;
  mode: 'skip' | 'windowed' | 'full';
  windows: Array<{
    startMs: number;
    endMs: number;
    reason: string;
    sources: Array<'visual' | 'audio'>;
  }>;
  decisionReasons: string[];
}

interface AssetCoarseReport {
  assetId: string;
  ingestRootId?: string;
  durationMs?: number;
  clipTypeGuess: 'drive' | 'talking-head' | 'aerial' | 'timelapse' | 'broll' | 'unknown';
  densityScore: number;
  gpsSummary?: string;
  summary?: string;
  labels: string[];
  placeHints: string[];
  sampleFrames: Array<{
    timeMs: number;
    path?: string;
    summary?: string;
  }>;
  transcript?: string;
  transcriptSegments?: Array<{
    startMs: number;
    endMs: number;
    text: string;
  }>;
  speechCoverage?: number;
  interestingWindows: Array<{
    startMs: number;
    endMs: number;
    reason: string;
  }>;
  shouldFineScan: boolean;
  fineScanMode: 'skip' | 'windowed' | 'full';
  fineScanReasons: string[];
}
```

规则：

- `VisualCoarseSignals` 与 `AudioAnalysisSignals` 是并列输入，不互相充当前置门槛
- 音频分析默认覆盖所有带音轨视频；无音轨时才允许 `AudioAnalysisSignals.hasAudioTrack = false`
- `AudioAnalysisSignals` 的“强信号”默认以人声为中心，而不是以背景音乐为中心
- `FineScanDecision` 是统一分析结果，应由同一次推理同时给出 `clipType + shouldFineScan + mode + windows`
- 中间版本不建议在视觉粗扫阶段就写死最终 `clipType`
- `AssetCoarseReport` 是正式落盘产物，承载融合后的最终判断
- `FineScanDecision.mode = 'full'`
  - 适用于短视频、高价值素材、或视觉/音频双信号都很强的资产
- `FineScanDecision.mode = 'windowed'`
  - 适用于长视频、单路信号明确命中时间窗、或虽然整体不适合全量细扫但局部值得深挖的资产
- `FineScanDecision.mode = 'skip'`
  - 仅适用于视觉与音频两路信号都弱，或预算档位在融合层明确压制细扫的情况

### 7.2 `src/modules/script/`

负责风格、叙事、脚本。

建议子模块：

- `material-digest.ts`
- `segment-planner.ts`
- `segment-review-store.ts`
- `candidate-recall.ts`
- `brief-loader.ts`
- `style-analyzer.ts`
- `outline-builder.ts`
- `beat-planner.ts`
- `script-generator.ts`
- `script-editor.ts`
- `script-store.ts`

职责：

- 分析历史成片，生成风格档案
- 基于 `asset reports + chronology + slices` 生成 `ProjectMaterialDigest`
- 读取并解释多层 `brief`
- 基于全量素材归纳生成 `1-3` 套 `SegmentPlanDraft`
- 支持用户审查并冻结为 `ApprovedSegmentPlan`
- 基于 `ApprovedSegmentPlan` 召回候选 `slice`
- 在候选 `slice` 之上生成叙事骨架
- 在每个 `segment` 下生成 `beat`
- 为每个 `beat` 生成文本、行为和 `selection`
- 支持段落级与 beat 级编辑和重排

### 7.3 `src/modules/timeline-core/`

负责把 `segment + beat + selection` 落成可执行时间线。

建议子模块：

- `placement.ts`
- `transition-planner.ts`
- `timeline-builder.ts`
- `subtitle-planner.ts`
- `timeline-validator.ts`

职责：

- 基于 `beat.selection` 摆放 clip，而不是默认整段吃满 `slice`
- 自动生成轨道、转场和字幕
- 让字幕默认来自 `beat.text`
- 保证时间线协议可校验

负责与 NLE 无关的时间线能力。

建议子模块：

- `protocol.ts`
- `timeline-builder.ts`
- `placement-engine.ts`
- `transition-planner.ts`
- `subtitle-planner.ts`
- `timeline-validator.ts`

职责：

- 定义正式协议
- 从脚本和切片生成时间线
- 计算轨道分配和时间摆放
- 生成字幕 cue
- 校验时间线合法性

### 7.4 `src/modules/nle/`

负责具体编辑器适配与外部 NLE Server 客户端。

建议子模块：

- `adapter.ts`
- `export-job.ts`
- `jianying-server-client.ts`
- `resolve-mcp-adapter.ts`
- `export-srt.ts`
- `export-fcpxml.ts`（后续）

职责：

- 将正式协议翻译为具体编辑器任务
- 维护外部素材 ID / 轨道 ID / 项目 ID / job ID 映射
- 对不同编辑器能力差异做降级
- 将平台敏感操作下沉到独立 Server

### 7.5 `jianying-server/`（独立部署单元，建议独立仓库）

负责剪映落地执行。

建议子模块：

- `server.ts` / `main.py`
- `job-router.ts`
- `draft-service.ts`
- `path-normalizer.ts`
- `subtitle-service.ts`
- `asset-import-service.ts`
- `task-log.ts`

职责：

- 暴露平台本地可访问的服务接口（HTTP / JSON-RPC / MCP over HTTP 均可）
- 接收 `KTEP` 或 `export job`
- 在 Windows 上处理草稿目录和素材路径
- 调用 `jianying-mcp` 或后续替代实现
- 返回导出结果、日志和错误诊断

## 8. 本地多模态与自适应采样

### 8.1 分层执行策略

媒体分析建议分三层执行：

#### Layer A — 低成本粗扫

- 元信息与拍摄时间读取
- GPS / 轨迹对齐（若存在）
- 按时长做少量均匀采样
- 低成本 ASR / OCR / CLIP/BLIP 粗标签
- 生成 `AssetCoarseReport`

特点：

- 默认本地执行
- 不依赖云端 token
- 不要求一上来就做全量镜头切分
- 目的是生成 `MediaAnalysisPlan` 和是否细扫的自动决策

#### Layer B — 本地 VLM 精扫

只对高价值窗口执行：

- `interestingWindows[]`
- 口播与画面冲突片段
- 航拍 / 延时 / 复杂事件片段
- 可能进入 `intro / climax / transition` 的候选片段

特点：

- 由本地 `VLM` 执行
- 以小窗口或细扫后的 `slice` 为单位
- 输出高质量结构化描述，而不是自由文本堆砌

#### Layer C — 生成层

这一层才进入脚本和叙事：

- 脚本生成
- 旁白润色
- 段落重写
- 镜头选择建议

原则：

- 优先喂结构化 `evidence`
- 不把原始长视频直接送进大模型

这三层的核心边界是：

- `AssetCoarseReport` 面向全部素材
- `slice` 面向值得进入脚本和时间线的重点片段
- 并不是所有素材都必须进入 `slice`

### 8.2 本地 VLM 角色

对于使用 `RTX 4090` 的本地环境，中间版本应把本地 VLM 视为**主分析器**而不是“实验性增强”。

推荐角色分工：

- `CLIP/BLIP`：快速索引、去重、粗聚类、初筛
- `本地 VLM`：场景理解、镜头作用判断、地标/事件/氛围识别
- `Whisper + OCR`：文本证据补全

这样做的好处是：

- 不烧云端 API token
- 结构化证据可持久化复用
- 后续脚本生成不必重复看画面

### 8.3 自适应采样规则

先分别计算：

- `visualSignals`
- `audioSignals`

再统一分析得到：

- `clipType`
- `densityScore`
- `interestingWindows[]`
- `shouldFineScan`
- `fineScanMode`
- `decisionReasons[]`

建议定义：

```typescript
interface MediaAnalysisPlan {
  assetId: string;
  clipType: 'drive' | 'talking-head' | 'aerial' | 'timelapse' | 'broll' | 'unknown';
  densityScore: number; // 0-1
  samplingProfile: 'dense' | 'balanced' | 'sparse';
  baseSampleIntervalMs: number;
  interestingWindows: Array<{
    startMs: number;
    endMs: number;
    reason: string;
  }>;
  vlmMode: 'none' | 'multi-image' | 'video';
  targetBudget: 'coarse' | 'standard' | 'deep';
  hasAudioTrack?: boolean;
  speechCoverage?: number; // 人声覆盖
  shouldFineScan: boolean;
  fineScanMode: 'skip' | 'windowed' | 'full';
  decisionReasons: string[];
}
```

说明：

- `MediaAnalysisPlan` 是统一分析后的决策对象，不是纯视觉计划
- `targetBudget` 作用于融合层，不应用来提前阻断音频分析
- 音频信号至少应通过 `hasAudioTrack / speechCoverage / transcriptSegments / speech windows` 进入这一步
- 其中 `speechCoverage` 与 `speech windows` 默认只统计可用人声，不把背景音乐时长误计为强语义音频信号
- `clipType` 也应在这一步统一给出，而不是由视觉粗扫阶段单独冻结

信息密度信号可来自：

- 视频时长
- 镜头切换率
- 光流变化
- OCR 命中频率
- VAD / 口播检测
- 亮度和色彩变化
- 图像语义突变
- GPS 轨迹变化
- 轨迹停靠 / 转向 / 地标接近
- 人工行程文件推断出的近似路线变化

### 8.4 粗扫采样预算

粗扫默认按素材时长决定**均匀采样次数**，而不是先做完整镜头切分。

- `< 1min`：`4-6` 次
- `1-5min`：`6-10` 次
- `5-20min`：`10-16` 次
- `20min+`：`16-24` 次

粗扫目标：

- 判断素材大致类别
- 估计信息密度
- 给出 `interestingWindows[]`
- 判断是否需要细扫

如果存在 GPS / 轨迹：

- 粗扫应优先结合路线变化、停靠点、地标接近、海拔变化等事件
- 对长行车视频，GPS 常比画面切镜更可靠

如果不存在真实 GPS，但存在人工行程文件：

- 使用 geocode 后的 `from / to / via` 做近似路线提示
- 将长时间段素材按该时间窗归入对应路线段
- 对“从 A 到 B 的长途段”优先生成 `drive` 候选，而不是强行做镜头级切分

### 8.5 细扫触发与预算

细扫由系统自动判断，而不是让用户手动指定。

建议触发条件：

- `densityScore` 高于阈值
- GPS 变化显著
- OCR / ASR 命中地点、事件或叙事信息
- 素材类型判断不确定
- 下游脚本 / 时间线阶段请求高精度切片

细扫模式：

- `full`
  - 对短视频或高价值素材做全片镜头级分析
- `windowed`
  - 对长视频只分析 `interestingWindows[]`
- `skip`
  - 当前保留粗扫报告，不生成 `slice`

#### 细扫按时长

- `0-15s`：高密度采样，近似全看
- `15-60s`：每 `1-2s` 抽样
- `1-5min`：每 `3-5s` 抽样
- `5-20min`：每 `8-12s` 抽样
- `20min+`：每 `15-30s` 抽样

#### 细扫按类型

- `talking-head`：画面稀采样，ASR 全量
- `drive`：默认稀采样，但对突变窗口局部提密
- `aerial`：中等密度，优先抓地貌和视角变化
- `timelapse`：提高采样密度，防止错过节奏变化
- `broll`：优先镜头边界抽样

#### 驾驶视频的提密触发器

- 识别到路牌、地名、限速牌
- 天光突变，例如日落、进出隧道、暴雨、耶稣光
- 出现桥梁、海岸线、城市天际线、山谷等结构性地貌
- 停车、下车、明显减速或场景切换
- 口播开始或结束

### 8.5 目标性能预算（RTX 4090）

中间版本建议以 `RTX 4090` 为主参考机型，先设定工程预算，而不是追求不切实际的“全量逐帧理解”。

建议目标：

- `coarse`：`<= 10s / 分钟素材`
- `standard`：`<= 30s / 分钟素材`
- `deep`：`<= 90s / 分钟素材`

性能预期：

- `ASR` 通常不是瓶颈
- `scene cut / keyframe` 也不是瓶颈
- 真正的瓶颈是本地 `VLM` 对采样帧的理解

因此首版优化重点应是：

- 少看无价值帧
- 多看 `interestingWindows[]`
- 尽量让 VLM 看多图小窗口，而不是整段长视频

### 8.6 输出要求

媒体分析层输出的不应只是自由文本，而应是结构化结果，例如：

- 片段类型
- 画面主体
- 叙事作用
- 情绪 / 氛围
- 地点线索
- 是否适合 `intro / transition / climax / broll`
- 证据来源和置信度

这样后续脚本和时间线模块可以复用结果，而不是重复推理。

## 9. 正式协议：Kairos Timeline Exchange Protocol

协议名称建议：

- `Kairos Timeline Exchange Protocol`
- 缩写：`KTEP`

这是中间版本最关键的设计产物。

### 9.1 顶层结构

```typescript
interface KtepDocument {
  protocol: 'kairos.timeline';
  version: '1.0';
  project: KtepProject;
  assets: KtepAsset[];
  slices: KtepSlice[];
  script?: KtepScriptSegment[];
  timeline: KtepTimeline;
  subtitles?: KtepSubtitleCue[];
  adapterHints?: Record<string, unknown>;
}
```

### 9.2 资产对象

```typescript
interface KtepAsset {
  id: string;
  kind: 'video' | 'photo' | 'audio';
  sourcePath: string;
  displayName: string;
  ingestRootId?: string;
  durationMs?: number;
  fps?: number;
  width?: number;
  height?: number;
  capturedAt?: string;
  captureTimeSource?:
    | 'exif'
    | 'quicktime'
    | 'container'
    | 'ffprobe-tag'
    | 'filename'
    | 'filesystem'
    | 'manual';
  captureTimeConfidence?: number;
  createdAt?: string;
  metadata?: Record<string, unknown>;
}
```

规则：

- `sourcePath` 必须指向原始资产
- `id` 稳定，不因脚本修改而变化
- `durationMs` 对图片可为空
- `capturedAt` 优先来自元信息，不依赖文件名
- `ingestRootId` 用于追踪该素材来自哪个输入目录配置

建议在素材分析层另存一份面向叙事和浏览的时序索引，而不是只依赖 `KtepAsset` 的扁平字段。

### 9.3 切片对象

```typescript
interface KtepSlice {
  id: string;
  assetId: string;
  type:
    | 'shot'
    | 'timelapse'
    | 'photo'
    | 'aerial'
    | 'talking-head'
    | 'drive'
    | 'broll'
    | 'unknown';
  sourceInMs?: number;
  sourceOutMs?: number;
  summary?: string;
  labels: string[];
  placeHints: string[];
  confidence?: number;
}
```

说明：

- `slice` 只保留“可剪辑时间窗”的最小语义，不再复制完整证据包
- `placeHints` 用于保留脚本和时间线阶段最常消费的地点线索
- 更完整的 `evidence`、`rootNotes`、`interestingWindows`、GPS/行程信息，应保留在 `asset report`
- 没有 GPS 时，不影响协议成立
- 将来接入 GPS / Pharos，也优先进入素材分析层，而不是直接复制到每个 `slice`

### 9.4 脚本对象

```typescript
interface KtepScriptAction {
  speed?: number;
  preserveNatSound?: boolean;
  muteSource?: boolean;
  transitionHint?: 'cut' | 'cross-dissolve' | 'fade' | 'wipe';
  holdMs?: number;
}

interface KtepScriptSelection {
  assetId: string;
  sliceId?: string;
  sourceInMs?: number;
  sourceOutMs?: number;
  notes?: string;
}

interface KtepScriptBeat {
  id: string;
  text: string;
  targetDurationMs?: number;
  actions?: KtepScriptAction;
  selections: KtepScriptSelection[];
  linkedSliceIds: string[];
  notes?: string;
}

interface KtepScriptSegment {
  id: string;
  role: 'intro' | 'scene' | 'transition' | 'highlight' | 'outro';
  title?: string;
  narration?: string;
  targetDurationMs?: number;
  actions?: KtepScriptAction;
  selections?: KtepScriptSelection[];
  linkedSliceIds: string[];
  beats: KtepScriptBeat[];
  notes?: string;
}
```

说明：

- `segment` 描述这段在全片中的作用、目标时长和整体叙事意图
- `beat` 是真正的编排单元：一句文案 + 一组 `selection`
- `selection` 允许只使用 `slice` 内的一小段，不要求整段吃满
- `segment.narration` 若存在，应视为 beat 级文本的聚合预览，而不是轨道摆放的唯一真源
- `linkedSliceIds` 仍可作为兼容字段存在，但正式编排应优先依赖 `beat.selections`

### 9.5 时间线对象

```typescript
interface KtepTimeline {
  id: string;
  name: string;
  fps: number;
  resolution: { width: number; height: number };
  tracks: KtepTrack[];
  clips: KtepClipPlacement[];
}

interface KtepTrack {
  id: string;
  kind: 'video' | 'audio' | 'subtitle';
  role: 'primary' | 'broll' | 'voiceover' | 'nat' | 'music' | 'caption';
  index: number;
}

interface KtepClipPlacement {
  id: string;
  trackId: string;
  assetId: string;
  sliceId?: string;
  sourceInMs?: number;
  sourceOutMs?: number;
  timelineInMs: number;
  timelineOutMs: number;
  transitionIn?: KtepTransition;
  transitionOut?: KtepTransition;
  transform?: KtepTransform;
  linkedScriptSegmentId?: string;
  linkedScriptBeatId?: string;
}

interface KtepTransition {
  type: 'cut' | 'cross-dissolve' | 'fade' | 'wipe';
  durationMs?: number;
}

interface KtepTransform {
  scale?: number;
  positionX?: number;
  positionY?: number;
  rotation?: number;
  kenBurns?: {
    startScale: number;
    endScale: number;
    startX: number;
    startY: number;
    endX: number;
    endY: number;
  };
}
```

### 9.6 字幕对象

```typescript
interface KtepSubtitleCue {
  id: string;
  startMs: number;
  endMs: number;
  text: string;
  language?: string;
  speaker?: string;
  linkedScriptSegmentId?: string;
  linkedScriptBeatId?: string;
}
```

说明：

- 字幕默认来自 `beat.text`
- `linkedScriptBeatId` 应优先存在，便于后续逐拍微调
- 可以来自旁白脚本，也可以来自口播转写修订
- 可以直接导出 SRT，也可以通过适配器写入 NLE

### 9.7 协议不变量

`KTEP` 至少应保证以下约束：

1. 所有时间统一使用毫秒。
2. `timelineOutMs > timelineInMs`。
3. 视频/音频切片若存在 `sourceInMs/sourceOutMs`，则必须满足 `sourceOutMs > sourceInMs`。
4. `clip.trackId` 必须引用存在的轨道。
5. `clip.assetId` 必须引用存在的资产。
6. `clip.sliceId` 若存在，必须引用存在的切片。
7. 字幕时间范围不得为负。
8. 编辑器私有字段不得进入协议核心字段，只能放在 `adapterHints` 或适配器侧状态中。

## 10. 时间线生成流程

### 10.1 输入

- `assets`
- `slices`
- `script`
- 可选的人工偏好
  - 哪些片段必须出现
  - 哪些口播保留原声
  - 哪些段落优先航拍
  - 哪些图片需要 Ken Burns

### 10.2 生成步骤

1. 读取 `Project Brief`，形成全片约束。
2. 基于全量素材和 `Project Brief` 生成 `ProjectMaterialDigest`。
3. 结合 `Segment-Plan Brief` 提出 `SegmentPlanDraft[]`。
4. 用户选择或修改其中一套，冻结为 `ApprovedSegmentPlan`。
5. 对每个段落读取对应 `Segment Brief`。
6. 根据 `ApprovedSegmentPlan + Segment Brief` 为每个段落召回候选 `slice`。
7. 在每个段落中生成或确认若干 `beat`。
8. 对每个 `beat`，从候选 `slice` 中截取真正使用的 `selection` 子区间。
9. 必要时再应用 `Beat Polish Brief` 做局部微调。
10. 根据 `beat.selection` 生成主轨 `primary` 和辅轨 `broll` 的初始摆放。
11. 为照片和延时生成默认 transform。
12. 由 `beat.text` 直接生成字幕 cue；若存在更细的语音或口播对齐信息，再覆盖。
13. 生成 `KTEP.timeline`。
14. 用 `timeline-validator` 做一致性校验。

### 10.3 首版生成策略

首版不追求“完美剪辑决策”，而采用可解释规则：

- 优先使用被脚本直接引用的切片
- 优先使用 beat 已明确绑定的 `selection`
- 若用户没有明确要求打乱时间顺序，则优先维持相邻片段的拍摄时间连续性
- 单个 `selection` 默认最大使用时长可配置
- 航拍 / 延时优先放在段落开头或转场
- 图片默认走 `Ken Burns`
- 字幕默认直接来自 `beat.text`；若只有段落 narration，才允许回退到规则切分

## 11. 字幕添加策略

字幕能力拆成两层：

### 11.1 协议层

统一生成 `KtepSubtitleCue[]`，默认以 `beat` 为来源对象。

### 11.2 落地层

适配器按目标环境选择：

- 导出 `SRT`
- 导出 `WebVTT`
- 通过 `Jianying Server` 创建字幕轨
- 通过达芬奇 MCP 创建字幕轨

这样字幕算法本身不依赖任何具体 NLE。

## 12. NLE 适配层设计

### 12.1 统一接口

```typescript
interface NleAdapter {
  name: string;
  capabilities: NleCapabilities;

  validate(doc: KtepDocument): Promise<void>;
  ensureProject(projectName: string): Promise<void>;
  importAssets(assets: KtepAsset[]): Promise<void>;
  createTimeline(timeline: KtepTimeline): Promise<void>;
  placeClips(clips: KtepClipPlacement[]): Promise<void>;
  addSubtitles(cues: KtepSubtitleCue[]): Promise<void>;
}

interface NleCapabilities {
  subtitleTrack: boolean;
  transform: boolean;
  kenBurns: boolean;
  transition: boolean;
  nestedTimeline: boolean;
}
```

### 12.2 剪映适配器

`JianyingServerClient` 是中间版本的首个正式剪映适配器。

职责：

- 对接独立 `Jianying Server`
- 负责提交导出任务、轮询状态、拉取日志和结果
- 管理剪映内部对象 ID、草稿 ID 与 `KTEP` / `job` ID 的映射

它不再直接关心：

- `uv` 如何启动
- Windows 本地 Python 环境
- 草稿目录的最终写入方式
- `jianying-mcp` 的内部工具调用顺序

### 12.2.1 剪映导出任务接口

建议引入稳定的 job 协议：

```typescript
interface JianyingExportJob {
  jobId: string;
  projectId: string;
  timelinePath?: string;
  ktepDoc?: KtepDocument;
  outputDraftName: string;
  outputDraftRoot: string;
  windowsAssetRoots?: Array<{
    from: string;
    to: string;
  }>;
  options?: {
    subtitleY?: number;
    subtitleSize?: number;
    exportSrt?: boolean;
    exportVtt?: boolean;
  };
}

interface JianyingExportResult {
  jobId: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  draftPath?: string;
  srtPath?: string;
  vttPath?: string;
  logs: string[];
  diagnostics?: Array<{
    code: string;
    message: string;
  }>;
}
```

Core 侧只依赖这个稳定协议；服务端内部仍可继续沿用 `jianying-mcp` 或任何替代实现。

### 12.3 达芬奇适配器

`ResolveAdapter` 不再是系统中心，而是未来的第二个适配器。

这样达芬奇从“主目标架构”变为“可插拔落地端”，不会再绑死整体设计。

## 13. 人工草稿与正式协议的关系

正式协议是 `KTEP`。

人工草稿、临时文本、已有的时间线笔记，都只能作为：

- 导入器输入
- 提示词上下文
- 人工编辑界面内容

而不能直接充当正式时间线对象。

这意味着：

- 你现在已有的文本粗剪笔记仍然有用
- 但系统内部保存和交换时，必须转成 `KTEP`
- 将来无论接剪映、达芬奇还是导出文件，都只吃 `KTEP`

## 14. 项目数据结构调整

建议在现有 `project-structure` 基础上新增：

```text
<kairos_repo_root>/
├── projects/
│   └── <project_id>/
│       ├── config/
│       │   ├── ingest-roots.json
│       │   ├── manual-itinerary.md
│       │   ├── runtime.json
│       │   ├── script-brief.project.md
│       │   └── styles/
│       │       ├── catalog.json
│       │       └── <category>.md
│       ├── store/
│       │   ├── manifest.json
│       │   ├── revisions.jsonl
│       │   ├── assets.json
│       │   ├── slices.json
│       │   ├── snapshots/
│       │   │   ├── script/
│       │   │   ├── timeline/
│       │   │   ├── chronology/
│       │   │   └── subtitles/
│       │   └── backups/
│       │       ├── manifest.json
│       │       └── full/
│       ├── analysis/
│       │   ├── plans.json
│       │   ├── windows.json
│       │   ├── material-digest.json
│       │   ├── asset-reports/
│       │   │   └── <assetId>.json
│       │   ├── reference-transcripts/
│       │   │   └── <category>--<video>.txt
│       │   └── style-references/
│       │       └── <category>/
│       │           └── <video>.json
│       ├── media/
│       │   └── chronology.json
│       ├── script/
│       │   ├── segment-plan.review.md
│       │   ├── segment-plan.drafts.json
│       │   ├── segment-plan.approved.json
│       │   ├── segment-briefs/
│       │   │   └── <segmentId>.md
│       │   ├── beat-polish/
│       │   │   └── <segmentId>--<beatId>.md
│       │   ├── current.json
│       │   └── versions/
│       ├── timeline/
│       │   ├── current.ktep.json
│       │   └── versions/
│       ├── subtitles/
│       │   ├── current.srt
│       │   ├── current.vtt
│       │   └── current.json
│       ├── .tmp/
│       │   └── <pipeline>/
│       │       └── <scope>/
│       │           ├── progress.json
│       │           ├── summary.json
│       │           ├── keyframes/
│       │           ├── audio/
│       │           ├── proxies/
│       │           └── logs/
│       └── adapters/
│           ├── jianying/
│           │   └── state.json
│           └── resolve/
│               └── state.json
└── (code / skills / vendor / designs ...)
```

项目外、设备本地另存：

```text
~/.kairos/
└── device-media-maps.json
```

说明：

- `projects/<project_id>/` 是可同步的项目根目录
- `config/ingest-roots.json` 保存逻辑素材源定义、目录注解、默认时区等配置
- `config/manual-itinerary.md` 是无 GPS 项目可选的人工行程文件，用于推断低置信度近似路线
- `config/runtime.json` 保存项目级运行时配置，例如 Windows 原生 `ffmpeg/ffprobe` 路径、硬件解码策略、分析代理规格、ML Server 地址
- `config/styles/` 保存正式风格档案和分类目录；这是可迁移、可复用的长期产物
- `store/manifest.json` 保存项目级 schema 版本、当前 revision、最近备份信息
- `store/revisions.jsonl` 记录每次持久化变更的 revision 日志
- `store/assets.json` 保存素材主表
- `store/slices.json` 只保存细扫后、可进入脚本与时间线的切片
- `store/snapshots/` 保存可回退的文档级快照
- `store/backups/` 保存跨文档的项目级备份包
- `analysis/plans.json` 保存每条素材的分析计划、密度分数和采样策略
- `analysis/windows.json` 保存 `interestingWindows[]` 和命中原因
- `analysis/material-digest.json` 保存全量素材归纳结果
- `analysis/asset-reports/` 保存面向全部素材的粗扫报告
- `analysis/reference-transcripts/` 保存参考视频或分析素材的正式转写结果
- `analysis/style-references/` 保存逐视频落地的风格分析报告，再由上层综合成一个分类风格
- `media/chronology.json` 保存按拍摄时间排序的素材时序视图，并记录时间/描述修正
- `config/script-brief.project.md` 保存全片级自然语言 brief
- `script/segment-plan.review.md` 保存段落方案审查说明与选择记录
- `script/segment-plan.drafts.json` 保存系统提出的段落方案候选
- `script/segment-plan.approved.json` 保存用户确认后的正式段落规划
- `script/segment-briefs/*.md` 保存章节级自然语言 brief
- `script/beat-polish/*.md` 保存 beat 级局部精修 brief
- `current.ktep.json` 是编辑器无关的正式时间线
- `.tmp/` 保存流水线运行过程中的临时产物、关键帧、代理音频、调试日志和进度文件；默认可清理，不纳入 `Canonical Project Store`
- `adapters/*/state.json` 只保存适配器私有映射状态
- `~/.kairos/device-media-maps.json` 只保存当前设备上的本地素材目录映射，不纳入项目同步

建议的 `ingest-roots.json` 结构：

```json
{
  "roots": [
    {
      "id": "nz-a7r5-main",
      "label": "A7R5 主机位",
      "enabled": true,
      "category": "camera",
      "priority": 10,
      "defaultTimezone": "Pacific/Auckland",
      "description": "主机位，城市、步行、风光和部分机内口播混合",
      "notes": [
        "北岛前半段主机位",
        "题材混合，不要求目录只有单一语义"
      ],
      "tags": ["north-island", "main-camera"]
    },
    {
      "id": "nz-drone",
      "label": "无人机素材",
      "enabled": true,
      "category": "drone",
      "priority": 20,
      "defaultTimezone": "Pacific/Auckland",
      "description": "无人机，全景、海岸线、瀑布、地热、公路全景为主",
      "notes": [
        "优先关注海岸线、瀑布、地热、公路全景"
      ],
      "tags": ["north-island", "drone"]
    }
  ]
}
```

建议的 `device-media-maps.json`：

```json
{
  "projects": {
    "new-zealand-doc": {
      "roots": [
        {
          "rootId": "nz-a7r5-main",
          "localPath": "F:\\NZ\\A7R5"
        },
        {
          "rootId": "nz-drone",
          "localPath": "G:\\NZ\\Mavic"
        }
      ]
    }
  }
}
```

### 14.1 Canonical Project Store 存储原则

`Canonical Project Store` 不应理解成单个文件，而是一组**规范化、可校验、可回退**的项目文档集合。

建议分为三层：

- `current`：当前生效的项目状态，例如 `media/index.json`、`script/current.json`
- `versions`：面向日常工作回退的版本快照
- `backups`：面向损坏恢复、迁移失败、误操作的项目级备份

这三层职责不同：

- `current` 解决“系统现在用什么”
- `versions` 解决“我想回到上一个可编辑状态”
- `backups` 解决“项目坏了还能不能救回来”

### 14.1.1 运行时配置（Runtime Config）

中间版本不再依赖“环境变量碰巧存在”来寻找工具链。项目根目录中的
`config/runtime.json` 是**迁移、重放和跨设备部署**时必须优先带走的配置文件。

推荐结构：

```json
{
  "ffmpegPath": "C:\\Applications\\ffmpeg.exe",
  "ffprobePath": "C:\\Applications\\GamePP\\PCBenchmark\\ffprobe.exe",
  "ffmpegHwaccel": "d3d11va",
  "analysisProxyWidth": 1024,
  "analysisProxyPixelFormat": "yuv420p",
  "sceneDetectFps": 4,
  "mlServerUrl": "http://127.0.0.1:8910"
}
```

说明：

- `ffmpegPath` / `ffprobePath`
  - 记录项目实际使用的原生工具链路径
  - Windows 平台优先写 Windows 原生路径，不依赖 `PATH` 或 WSL 内版本
- `ffmpegHwaccel`
  - 指定视频解码时优先使用的原生硬件编解码后端，例如 `d3d11va`
- `analysisProxyWidth` / `analysisProxyPixelFormat`
  - 指定媒体分析默认使用的代理规格
  - 当前建议默认值为 `1024w + yuv420p`
- `sceneDetectFps`
  - 指定长视频做镜头检测时的默认分析帧率
- `mlServerUrl`
  - 指向本地 ML Server，供 `ASR / OCR / VLM` 流水线调用

原则：

- `runtime.json` 是项目级约定，而不是机器全局环境变量快照
- 新设备部署时优先迁移此文件，再做本机路径校正
- 若不同平台路径不同，只修改 `runtime.json`，不改业务文档

### 14.1.2 临时工作区与进度报告

长时分析任务不应把所有中间产物塞进 `analysis/`，也不应把进度只留在终端里。

建议约定：

- `.tmp/` 是项目内的**临时工作区**
- 正式产物写入 `config/`、`analysis/`、`media/`、`script/`、`timeline/`
- 中间产物写入 `.tmp/<pipeline>/<scope>/`
- 任务完成后默认清理 `.tmp/` 中不再需要的内容；如用户需要排障，可保留对应目录

以风格分析为例：

```text
.tmp/
└── style-analysis/
    └── serious-travel-documentary-intro/
        ├── progress.json
        ├── summary.json
        ├── keyframes/
        ├── audio/
        ├── proxies/
        └── logs/
```

建议的 `progress.json`：

```typescript
interface WorkflowProgress {
  pipelineKey: string;
  pipelineLabel: string;
  phaseKey: string;
  phaseLabel: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  currentStep: number;
  totalSteps: number;
  currentFileIndex?: number;
  totalFiles?: number;
  currentFrameIndex?: number;
  totalFrames?: number;
  etaSeconds?: number;
  currentFile?: string;
  updatedAt: string;
  note?: string;
}
```

建议的呈现方式：

- 后台任务持续更新 `progress.json`
- 本地网页或桌面壳层定时轮询该文件，展示：
  - `第 N / M 步`
  - `第 N / M 帧`
  - `剩余时间倒计时`
  - 当前文件和最后更新时间

这样进度观测协议可以被风格分析、素材分析、时间线生成等多个流程复用，而不必为每个流程单独发明一套 UI 状态结构。

### 14.2 当前状态层（Current State）

当前状态层保存**唯一生效版本**，供系统读取和编辑。

建议纳入的 canonical 文档：

- `config/ingest-roots.json`
- `config/runtime.json`
- `store/assets.json`
- `store/slices.json`
- `media/chronology.json`
- `analysis/plans.json`
- `analysis/windows.json`
- `analysis/asset-reports/*`
- `analysis/reference-transcripts/*`
- `analysis/style-references/<category>/*`
- `script/current.json`
- `timeline/current.ktep.json`
- `subtitles/current.json`
- `adapters/*/state.json`

原则：

- 每份文档职责单一
- 通过稳定 ID 互相引用
- 写入必须走原子替换，不允许半写入状态
- `store/slices.json` 不是全量素材摘要，而是细扫后产生的高价值切片集合

### 14.3 版本层（Versions / Revisions）

版本层用于支持“回退到前一个脚本版本”“恢复昨天的时间线”“比较两次 chronology 修正差异”。

建议设计两部分：

- `store/revisions.jsonl`：轻量 revision 日志
- `store/snapshots/`：必要时存放文档级快照

建议的 revision 记录：

```typescript
interface StoreRevision {
  revisionId: string;
  createdAt: string;
  reason:
    | 'ingest'
    | 'analysis'
    | 'chronology-correction'
    | 'script-edit'
    | 'timeline-build'
    | 'subtitle-update'
    | 'adapter-sync'
    | 'migration'
    | 'manual';
  changedDocs: string[];
  note?: string;
}
```

建议的快照策略：

- `script/current.json` 每次保存都生成快照
- `timeline/current.ktep.json` 每次生成或手动确认都生成快照
- `media/chronology.json` 每次人工修正后生成快照
- `subtitles/current.json` 在字幕确认或批量调整后生成快照
- `analysis/*` 默认不高频快照，必要时由 revision 日志追踪

这样可以避免把所有分析中间产物都无限制版本化，导致体积膨胀。

### 14.4 备份层（Backups）

备份不是版本快照的别名，而是**项目级恢复机制**。

建议分两类：

- `自动备份`
  - schema migration 前
  - 批量写入 chronology 修正前
  - 大规模重跑 ingest / analysis 前
  - 首次执行 NLE 同步前
- `手动备份`
  - 用户准备做大改动前
  - 用户准备切换机器前
  - 用户准备清理缓存前

建议的备份形态：

- `full project backup`
  - 备份 canonical 文档和必要配置
  - 不默认打包原始媒体文件
- `metadata backup`
  - 只备份 JSON store、脚本、时间线、字幕、适配器状态

建议的备份元信息：

```typescript
interface ProjectBackup {
  backupId: string;
  createdAt: string;
  type: 'auto' | 'manual';
  scope: 'metadata-only' | 'full-store';
  reason?: string;
  includedPaths: string[];
}
```

建议默认不备份：

- 原始视频/照片文件
- 可重建的缓存代理
- 可重算的关键帧和 embedding

因为这些体积大，且不属于 `Canonical Project Store` 本身。

### 14.5 写入流程与恢复原则

建议所有写入走统一事务化流程：

1. 读取当前 manifest 和目标文档
2. 生成新文档内容
3. 写入临时文件
4. 原子替换目标文件
5. 追加一条 `revision`
6. 若命中备份策略，生成一份 backup
7. 更新 `store/manifest.json`

`store/manifest.json` 建议至少包含：

```typescript
interface StoreManifest {
  storeSchemaVersion: string;
  currentRevisionId: string;
  lastBackupId?: string;
  updatedAt: string;
}
```

恢复优先级建议：

1. 先尝试读取 current 文档
2. 若 current 文档损坏，回退到最近 revision 对应快照
3. 若快照也不可用，回退到最近 backup

这套机制保证：

- 日常编辑可回退
- 批量修正可追踪
- migration / 同步失败时有兜底
- 项目状态不会因为一次写坏而整体报废

## 15. 推荐实施顺序

### M1. 协议与核心存储

- 定义 `KTEP` Zod Schema
- 建立 `assets / slices / script / timeline / subtitles` 存储
- 完成协议校验器

### M2. 切片与识别

- 输入目录配置加载
- 拍摄时间提取与归一化
- 视频镜头切片
- 图片切片
- 关键帧抽取
- 信息密度估算
- 自适应采样计划
- 基础标签与摘要
- 本地 VLM 精分析
- 证据系统

### M3. 脚本到时间线

- 风格档案导入
- 脚本生成
- 时间线生成
- 字幕规划

### M4. 剪映适配器

- `Jianying Server` 原型
- `KTEP -> 导出任务` 执行器
- `Kairos Core -> Jianying Server` 客户端
- SRT 导出作为兜底

### M5. 达芬奇适配器

- 复用相同 `KTEP`
- 新增 `ResolveAdapter`
- 验证跨 NLE 可迁移性

## 16. 复用价值评估

这个中间版本沉淀下来的能力，后续都能复用：

| 能力 | 中间版本可用 | 完整版可复用 |
|------|--------------|--------------|
| 视频/图片切片 | 是 | 是 |
| 自适应采样与分析计划 | 是 | 是 |
| 证据系统 | 是 | 是 |
| 风格档案 | 是 | 是 |
| 脚本生成 | 是 | 是 |
| 正式时间线协议 | 是 | 是 |
| 字幕规划 | 是 | 是 |
| 剪映适配器 | 是 | 可并存 |
| 达芬奇适配器 | 后续 | 是 |
| GPS / Pharos | 双模式支持 | 可增强接入 |
| 调色辅助 | 否 | 后续独立接回 |

## 17. 结论

中间版本不应理解为“缩小版 Kairos”，而应理解为：

- **把真正可复用的核心抽出来**
- **把编辑器集成降到适配层**
- **把时间线先变成正式协议**
- **先让剪映跑起来，再让达芬奇复用**

这样做的收益是：

- 当前新西兰纪录片可以直接受益
- 不会把项目锁死在剪映或达芬奇
- 后续 GPS、Pharos、调色、Tauri 都能往这个核心上增量叠加

这会比“先做一个完整平台”更稳，也比“只做一次性脚本助手”更值。
