# Kairos — Phase 1 实现计划（历史里程碑计划）

> 本文档记录的是早期的 Phase 1 里程碑计划，主要用于保留当时的实施顺序、范围切分和历史背景。
> 它不是当前正式方案的主入口，也不应被理解为当前实现状态清单。
>
> 当前正式口径应以 [`current-solution-summary.md`](./current-solution-summary.md)、[`requirements.md`](./requirements.md)、[`architecture.md`](./architecture.md) 与 [`project-structure.md`](./project-structure.md) 为准。
>
> 需要特别注意的当前口径：
> - 正式主链是 `Pharos-first`
> - 当前实现仍是临时承载版本，只覆盖了正式流程中的多个阶段
> - `DaVinci color` 是与主链解耦的独立增强链路，不是主链中的固定顺序步骤
> - 主链消费的是项目当前采用的素材版本；若来自调色 / 转换 / 导出链路，则必须保留媒体创建时间、`create_time`、GPS 等关键元信息

## 0. 里程碑总览

| # | 里程碑 | 核心交付 | 预计周期 | 前置 |
|---|--------|----------|----------|------|
| M0 | 工程骨架 | 项目结构、构建链路、类型系统、配置框架 | 1 周 | — |
| M1 | 素材导入 | 扫描→元数据→GPS→代理→索引持久化 | 2 周 | M0 |
| M2 | 场景检测 | CLIP 特征提取→聚类→LLM 场景描述 | 1.5 周 | M1 |
| M3 | 调色辅助 | MCP 连接→CST/LUT 批量应用→初级校色 | 2 周 | M1 |
| M4 | 脚本生成 | 风格档案→叙事骨架→LLM 脚本→交互编辑 | 2.5 周 | M2 |
| M5 | 粗剪编排 | 脚本→时间线→MCP 创建达芬奇项目 | 2 周 | M3, M4 |
| M6 | Skill 集成 | Agent Skill 工作流封装 + 端到端验证 | 1.5 周 | M5 |

**总预计：~12.5 周**（可并行 M2/M3 节约 ~1.5 周 → 实际 ~11 周）

补充说明：

- 这里的里程碑依赖关系反映的是早期实施组织方式
- 按当前正式口径理解，`M3 调色辅助` 更接近独立增强链路，而不是正式主链中的固定前置步骤
- `Pharos` 在本计划中仍带有“接口预留”痕迹，但当前正式文档已经把它定义为主流程的主输入来源

```
Week:  1    2    3    4    5    6    7    8    9   10   11
       ├─M0─┤
            ├────M1────┤
                       ├──M2──┤
                       ├────M3────┤
                              ├────M4─────┤
                                          ├────M5────┤
                                                     ├──M6──┤
```

---

## M0. 工程骨架（1 周）

**目标**：搭建完整的项目结构和基础设施，后续里程碑可直接在此基础上开发。

### M0.1 项目结构与构建

- 按架构文档第 7 节创建目录结构：`src/infra/`、`src/modules/`、`src/skill/`、`src/types/`
- 配置 TypeScript（strict mode, ESM, path aliases）
- 配置 vitest、eslint
- pnpm workspace 配置（如有需要）

### M0.2 共享类型系统

- `src/types/media.ts` — MediaClip、MediaType
- `src/types/scene.ts` — Scene
- `src/types/script.ts` — ScriptSegment、Script
- `src/types/style.ts` — StyleProfile
- `src/types/grade.ts` — GradePlan
- `src/types/project.ts` — ProjectConfig、ProjectStage

所有类型同时提供 Zod schema（运行时校验）和 TypeScript interface（编译时类型）。

### M0.3 基础设施骨架

| 模块 | 文件 | 初始实现 |
|------|------|----------|
| `infra/logger` | `index.ts` | pino 封装，支持项目级和全局日志 |
| `infra/config` | `index.ts` | 配置读写（JSON 文件 + Zod 校验 + write-file-atomic） |
| `infra/project` | `index.ts` | 项目创建（目录初始化）、加载、阶段状态机 |
| `infra/task-queue` | `index.ts` | p-queue 封装 + jobs.json 持久化（断点恢复） |

### M0.4 验证标准

- [x] `pnpm build` 零错误
- [x] `pnpm test` 骨架测试通过（项目创建→加载→目录校验）
- [x] 创建项目后生成完整目录结构（对照 project-structure.md）

---

## M1. 素材导入（2 周）

**目标**：从项目目录扫描素材，提取元数据，匹配 GPS，生成代理文件，写入持久化索引。

### 依赖

- M0（项目结构、配置框架、任务队列）

### M1.1 FFmpeg 封装（`infra/ffmpeg`）

- ffprobe 元数据提取（duration, resolution, fps, codec, capturedAt）
- 硬件加速检测（macOS VideoToolbox / Windows NVENC）
- 代理文件生成（720p H.264，保留原始音轨）
- 关键帧抽取（每 5 秒 1 帧 → `cache/keyframes/{clipId}/`）
- 缩略图生成（1 张/素材 → `cache/thumbnails/`）
- p-limit 并发控制

### M1.2 素材索引（`infra/media-index`）

- `index.json` CRUD：增删改查 MediaClip
- 按 clipId / 时间范围 / 场景 / 标签查询
- 增量更新：只处理新增/变更文件（基于文件路径 + mtime）
- write-file-atomic 原子写入

### M1.3 文件扫描器（`modules/ingest/scanner`）

- globby 递归扫描媒体文件（视频: mp4/mov/mxf, 照片: jpg/arw/dng, 音频: wav/aac/mp3）
- 文件去重（路径 hash）
- 支持多个素材目录（`mediaDirs` 配置）

### M1.4 元数据提取（`modules/ingest/metadata`）

- 视频：ffprobe → MediaClip.metadata
- 照片：ExifReader → EXIF（Make/Model/DateTimeOriginal/GPS）
- 设备识别：EXIF Make/Model → deviceId 映射

### M1.5 GPS 处理（`infra/gps`）

- GPX 解析（gpx-parser-builder）
- 多源轨迹合并（Pharos GPX + DJI SRT/GPX）
- 时间匹配：素材 capturedAt ↔ 轨迹时间点 → 最近邻插值
- 逆地理编码：GPS → 地名（HTTP API，结果缓存到 `geocode-cache.json`）

### M1.6 照片 GPS 写入（`modules/ingest/gps-writer`）

- piexifjs 读取/写入 EXIF GPS 标签
- 仅对缺少 GPS 的照片写入（不覆盖已有 GPS）
- 写入前备份原始 EXIF（或配置跳过写入）

### M1.7 代理文件生成（`modules/ingest/proxy-generator`）

- 通过任务队列后台生成
- 跳过已存在的代理文件
- 进度上报（已完成/总数）

### M1.8 Ingest 编排（`modules/ingest/index`）

- 编排完整流程：扫描 → 元数据 → GPS → 代理 → 索引写入
- 支持增量导入（跳过已处理素材）
- 导入完成后更新项目阶段状态

### M1.9 验证标准

- [x] 扫描 100+ 混合素材（视频/照片），元数据提取准确
- [x] GPX 轨迹匹配，GPS 坐标写入照片 EXIF
- [x] 代理文件生成（720p），关键帧/缩略图导出
- [x] `index.json` 内容完整，Schema 校验通过
- [x] 增量导入：二次扫描只处理新文件

---

## M2. 场景检测（1.5 周）

**目标**：基于 CLIP 视觉特征对素材聚类分组，由 LLM 生成场景描述。

### 依赖

- M1（代理文件、关键帧、素材索引）

### M2.1 本地模型管理（`infra/local-models`）

- ONNX Runtime 初始化（onnxruntime-node）
- CLIP ViT-B/16 模型加载（`models/clip-vit-b-16/`）
- 图像预处理管线：读取 JPEG → resize 224×224 → normalize → tensor
- `clipEmbed(imagePaths)` 批量特征提取接口
- 模型下载/校验脚本（首次运行自动下载）

### M2.2 场景检测器（`modules/ingest/scene-detector`）

- 对每条素材的关键帧提取 CLIP embedding
- 素材级特征 = 关键帧特征均值
- 相似度聚类：余弦相似度 + 时间连续性约束
  - 同一时间窗口（如 30min）内相似度 > 阈值 → 同场景
  - 阈值可配置（默认 0.75）
- 输出 scenes.json

### M2.3 场景描述生成（Skill 层 LLM 调用）

- 准备 prompt 数据：场景内关键帧列表 + GPS 地名 + 时间范围
- Skill prompt 模板：要求 LLM 为每个场景生成 description + mood
- 解析 LLM 输出，写入 scenes.json

### M2.4 验证标准

- [x] CLIP 模型加载成功，单张图片推理 <200ms（M4 Pro）
- [x] 100 条素材聚类为合理的场景分组（目测验证）
- [x] 场景描述文本自然、准确

---

## M3. 调色辅助（2 周）

**目标**：通过 MCP 连接达芬奇，实现 CST/LUT 批量应用和初级校色。

### 依赖

- M1（素材索引、设备识别）
- 外部依赖：DaVinci Resolve Studio ≥18.5 + davinci-resolve-mcp Server 运行

### M3.1 MCP 客户端（`infra/mcp-client`，非架构文档已列但需补充）

- @modelcontextprotocol/sdk 封装
- 连接管理：连接/断开/重连/超时
- 错误处理：连接失败提示、操作超时重试（3 次，递增间隔）
- Resolve 版本检测

### M3.2 色彩空间解析（`modules/color/log-resolver`）

- 读取 ColorConfig（设备级配置 + 单素材覆盖 + fallback）
- 按素材 EXIF Make/Model 自动关联设备 → 色彩空间
- 输出每条素材的 colorSpace

### M3.3 CST/LUT 映射（`modules/color/cst-mapper`）

- 色彩空间 → CST 参数映射规则
  - S-Log3 → Rec.709: `{from: "S-Gamut3.Cine/S-Log3", to: "Rec.709"}`
  - D-Log M → Rec.709: `{from: "DJI D-Log M", to: "Rec.709"}`
- LUT 文件路径配置（用户可自定义）

### M3.4 曝光分析（`modules/color/exposure-analyzer`）

- FFmpeg signalstats 提取关键帧的 YMIN/YMAX/YAVG/UAVG/VAVG
- 计算 Lift/Gamma/Gain 校正量（目标：YAVG 归一化到 IRE 40-70）
- 输出 correction 节点参数

### M3.5 调色方案生成（`modules/color/grade-planner`）

- 生成节点树方案：Node1=CST → Node2=曝光校正 → Node3=可选 LUT
- 输出 GradePlan，持久化到 `color/grades.json`

### M3.6 MCP 调色执行（`modules/color/resolve-executor`）

- 通过 MCP 在达芬奇中：
  - 创建/打开项目
  - 导入素材到 Media Pool
  - 为每条素材创建节点树（AddSerialNode）
  - 写入 CST 参数（SetCDL / 自定义参数）
  - 应用 LUT（SetNodeLUT）
  - 写入曝光校正参数

### M3.7 验证标准

- [x] MCP 连接达芬奇成功
- [x] S-Log3 素材正确应用 CST → Rec.709
- [x] D-Log M 素材正确应用 CST → Rec.709
- [x] 曝光校正后 YAVG 落在 IRE 40-70 范围
- [x] 批量 20 条素材调色 <2 分钟

---

## M4. 脚本生成（2.5 周）

**目标**：基于素材、场景、GPS、风格档案，由 LLM 生成结构化剪辑脚本，支持交互编辑。

### 依赖

- M2（场景检测 + 场景描述）
- M0（项目管理、配置）

### M4.1 Whisper 集成（`infra/local-models` 扩展）

- whisper.cpp 子进程管理
- `whisperTranscribe(audioPath, options)` 接口
- 音频预处理：FFmpeg 提取音轨 → 16kHz WAV
- 结果缓存到 `cache/whisper/{clipId}.json`

### M4.2 风格档案分析（`modules/script/style-analyzer`）

- 导入成片 MP4
- FFmpeg 场景切换检测 → 提取叙事结构（段落数/时长分布/片头片尾占比）
- Whisper 转写旁白文本
- 准备 prompt 数据 → LLM 分析语言风格（人称/语气/信息密度）
- 输出 StyleProfile，持久化到 `style/profile.json`

### M4.3 叙事骨架构建（`modules/script/narrative-builder`）

- 输入：场景数据 + GPS 轨迹 + Pharos 分镜（预留接口）
- 构建空间叙事骨架：按时间/地理顺序排列场景
- 确定叙事段落结构（intro → scenes → transitions → outro）
- 为每个段落标记可选素材引用

### M4.4 素材内容推导（`modules/script/content-deriver`）

- 分析素材索引 + 场景描述
- 推导非分镜驱动的段落：片头集锦、精彩回顾、花絮、航拍转场
- 选取代表性素材作为候选

### M4.5 脚本生成（`modules/script/script-generator`）

- 组装 prompt：system（风格档案）+ user（叙事骨架 + 场景描述 + 素材列表）
- 分段生成，每段输出结构化 ScriptSegment
- 校验输出 JSON schema（Zod）
- 持久化到 `script/current.json`

### M4.6 脚本编辑（`modules/script/script-editor`）

- 段落 CRUD：新增/删除/修改/重排
- 修改后 LLM 自动调整上下文衔接（前后段过渡语）
- 版本管理：每次保存生成快照到 `script/versions/`

### M4.7 Pharos 数据读取（`modules/ingest/pharos-reader`）

- 接口预留：定义 PharosShotData 类型
- stub 实现：从 JSON 文件读取（等 Pharos 协议确定后对接）

### M4.8 验证标准

- [x] 风格档案分析：导入一段成片，提取出合理的 StyleProfile
- [x] 脚本生成：基于真实素材生成 8 分钟旅拍脚本，旁白风格匹配档案
- [x] 交互编辑：修改一个段落后，前后段过渡自然
- [x] 版本管理：可回退到任意历史版本

---

## M5. 粗剪编排（2 周）

**目标**：将脚本转化为达芬奇时间线，通过 MCP 创建项目并排列素材。

### 依赖

- M3（MCP 客户端、达芬奇集成已验证）
- M4（脚本数据）

### M5.1 时间线构建（`modules/cut/timeline-builder`）

- 读取脚本 → 构建时间线数据结构
  - 轨道分配（V1=主画面，V2=B-Roll/照片，A1=原始音频，A2=旁白，Sub=字幕）
  - 片段入出点计算
  - 转场类型标记（默认交叉溶解）
- 输出 timeline.json

### M5.2 素材导入 MCP（`modules/cut/resolve-importer`）

- 创建 Media Pool 文件夹结构（按场景分组）
- 导入素材文件到对应文件夹
- 返回 Resolve 内部素材 ID 映射

### M5.3 时间线创建 MCP（`modules/cut/resolve-timeline`）

- 创建时间线（名称、帧率、分辨率）
- 添加轨道（视频 × 2 + 音频 × 2 + 字幕）
- 按 timeline.json 排列片段（SetClip + InPoint/OutPoint）
- 设置转场

### M5.4 字幕生成（`modules/cut/subtitle-generator`）

- 从脚本 narration 字段提取字幕文本
- 按段落时长分配字幕时间码
- 通过 MCP 添加字幕轨 或 导出 SRT 文件

### M5.5 照片静帧处理（`modules/cut/photo-handler`）

- 照片素材插入时间线（默认 5 秒）
- Ken Burns 效果参数：缩放起止 + 平移方向
- 通过 MCP 设置 Composite/Transform 参数

### M5.6 验证标准

- [x] 从脚本生成 timeline.json，结构正确
- [x] MCP 在达芬奇中创建时间线，素材按脚本顺序排列
- [x] 字幕轨道时间码与画面对应
- [x] 照片素材以 Ken Burns 效果出现
- [x] 端到端：脚本 → 达芬奇可播放时间线 <5 分钟（50 段脚本）

---

## M6. Skill 集成与端到端验证（1.5 周）

**目标**：将所有模块封装为 Agent Skill，用户通过对话驱动完整工作流。

### 依赖

- M5（全链路功能就绪）

### M6.1 Skill 入口（`src/skill/index.ts`）

- 注册 Skill 命令
- 项目上下文管理（当前项目路径/状态）

### M6.2 工作流封装

| 工作流 | 文件 | 用户交互 |
|--------|------|----------|
| 素材导入 | `skill/workflows/ingest.ts` | 指定素材目录 → 显示扫描进度 → 展示导入结果摘要 |
| 调色辅助 | `skill/workflows/color.ts` | 确认调色配置 → 执行调色 → 展示调色结果 |
| 脚本生成 | `skill/workflows/script.ts` | 选择风格 → 审阅脚本 → 编辑段落 → 确认定稿 |
| 粗剪 | `skill/workflows/cut.ts` | 确认脚本 → 创建时间线 → 展示粗剪结果 |

### M6.3 Prompt 模板

- `skill/prompts/system.ts` — Skill 系统提示词（身份/能力/约束）
- `skill/prompts/templates.ts` — 各类 LLM 任务的 prompt 模板
  - 场景描述生成
  - 风格档案分析
  - 脚本生成
  - 脚本编辑
  - 精剪建议（预留）

### M6.4 端到端验证

使用真实旅拍素材（冰岛/其他项目）跑通完整链路：

1. 创建项目 → 导入素材（50+ 条视频 + 照片）
2. GPS 匹配 + 照片 GPS 写入
3. 场景检测 + 描述生成
4. 调色辅助（连接达芬奇 MCP）
5. 导入成片 → 生成风格档案
6. 生成脚本 → 交互编辑
7. 粗剪 → 达芬奇时间线

### M6.5 验证标准

- [x] 用户在 Agent 中通过对话完成全链路操作
- [x] 每个工作流的中间结果可独立查看/重跑
- [x] 错误信息友好，提示用户下一步操作
- [x] 达芬奇输出的时间线可正常播放和编辑

---

## 开发顺序依赖图

```
M0 (工程骨架)
 │
 ├──▶ M1 (素材导入)
 │     │
 │     ├──▶ M2 (场景检测)──▶ M4 (脚本生成)──┐
 │     │                                     │
 │     └──▶ M3 (调色辅助)───────────────────▶ M5 (粗剪编排)
 │                                            │
 └────────────────────────────────────────────▶ M6 (Skill 集成)
```

**关键路径**：M0 → M1 → M2 → M4 → M5 → M6

**可并行**：
- M2（场景检测）和 M3（调色辅助）在 M1 完成后可并行启动
- M4.1（Whisper 集成）可与 M2 并行

---

## 技术债务控制

每个里程碑完成时评估并记录技术债务，避免累积：

| 类别 | 策略 |
|------|------|
| 测试覆盖 | 每个 infra 模块 ≥80% 覆盖率；modules 关键路径必须有集成测试 |
| 类型安全 | 严格模式，所有外部数据经过 Zod 校验后再进入系统 |
| 错误处理 | 统一错误类型层次（KairosError → ModuleError → SpecificError） |
| 日志 | 关键操作必须有结构化日志（clipId, operation, duration, result） |
| 文档 | 公开 API 的 JSDoc 注释必须完整；复杂算法附带设计说明 |

---

## 风险应对清单

| 风险 | 触发条件 | 应对方案 | 关联里程碑 |
|------|----------|----------|------------|
| MCP Server 不可用 | 达芬奇版本不支持 / MCP 连接失败 | 降级到 Python 子进程调用 Resolve API | M3, M5 |
| CLIP 模型精度不足 | 场景聚类结果混乱 | 调整聚类阈值；升级到 ViT-L/14；增加时间连续性权重 | M2 |
| Whisper 识别质量差 | 旁白语种混合/环境噪音 | 预处理音频（降噪）；指定语言；使用 medium 模型 | M4 |
| LLM 脚本质量差 | 生成结果模板化 | 迭代 prompt 模板；增加 few-shot 示例；分段生成降低复杂度 | M4 |
| 大规模素材性能瓶颈 | 500+ 素材导入/处理超时 | p-queue 并发调优；增量处理；夜间批处理模式 | M1 |
| 逆地理编码 API 限流 | 大量请求被拒 | 本地缓存 + 批量请求间隔 + 备选 API | M1 |
