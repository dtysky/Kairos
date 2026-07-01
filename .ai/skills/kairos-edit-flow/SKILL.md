---
name: kairos-edit-flow
description: >-
  Edit-rule-driven atomic capability flow after Chronology. Use when selecting
  edit rules, initializing edit units, reviewing Codex-maintained Flow Plans,
  running material recall, assembling rough cuts, locking Resolve rough cuts,
  or producing post-lock subtitles/narration.
---

# Kairos Edit Flow

Chronology 之后的正式剪辑入口是 `/edit`。Edit Flow 由用户维护的剪辑规则、confirmed Flow Plan 和各 capability 的合同共同驱动，不是固定 `Script -> Timeline` 阶段链。

## Core Rules

- `config/edit-rules/*.md` 是用户维护的剪辑规则源；Codex Agent 不得为适配 Flow Plan、skill、schema 或测试自动改写规则内容。
- 规则与系统合同冲突时，只能标记产物 stale、阻塞，或请求用户确认规则变更。
- `edits/<editId>/config/edit-unit.json` 是 Edit Unit 初始化真相，保存 `editId / editRuleCategory / styleCategory`。
- `edits/<editId>/planning/flow-plan.json` 是唯一可执行计划；必须 confirmed，且使用当前 `plannerPolicyVersion / materialIdPolicyVersion / materialTimePolicyVersion`。
- 只执行 confirmed Flow Plan 中声明的 `capabilityId / inputRefs / outputRefs / gate / runner / execution / notes`。
- 不要从剪辑规则 markdown 关键词解析隐藏阶段、默认时长、默认素材权重、默认章节或额外筛选规则；Codex Agent 只在生成 Flow Plan 时解释规则。
- `/edit` 只做 Edit Unit 初始化和只读展示；Supervisor 没有 `edit-flow` job，也不负责确认、运行或推进 step。
- Agent/SubAgent step 由 Codex Agent 直接执行。`sharded-agent` 必须使用 confirmed Flow Plan 的分片字段，并只给 subagent 有界 step/shard 上下文。
- 不得为了控制输出长度、审查便利或执行便利，向 Agent/SubAgent 额外添加剪辑规则没有写明的数量上限、代表抽样、段落预算或隐性删除条件。
- 剪辑规则中适用于某个 capability 的人工规则，必须进入对应 Flow Plan step 的 `notes`，并随 step context 进入 Agent/SubAgent packet；不得只留在原始 markdown，也不得把项目特定规则硬编码进 skill。
- 优先级顺序：系统/协议安全合同 > confirmed Flow Plan step notes > skill 通用 capability 合同 > agent 启发式。
- 正式 run truth 是 `edits/<editId>/runs/current.json`。

## Standard Flow

1. 确认 `/chronology` 已有 confirmed Chronology V2。
2. 在 `/edit` 初始化 Edit Unit。
3. Codex Agent 读取 Edit Unit、剪辑规则、项目事实和 capability registry，生成或更新 Flow Plan。
4. 只按 confirmed Flow Plan 运行 step；human gate 未确认时，不推进依赖 step。
5. 每个 step 写 declared outputs，并更新 `runs/current.json`。
6. Export 只消费 confirmed Flow Plan 产物中的正式时间线、字幕或 NLE 目标。

## Capabilities

Capability registry 是原子能力库，不是必经阶段链。当前常见 capability：

- `trip.event_table`
- `material.archive`
- `edit.framework`
- `material.recall`
- `script.generate`
- `resolve.media_sync`
- `timeline.generate`
- `resolve.lock_rough_cut`
- `postlock.subtitle_narration`

只选择剪辑规则明确要求或后续执行必需的最小 capability 集合。

## Resolve Volc Voiceover Plugin

- `apps/resolve-volc-voiceover-plugin/` 是独立 DaVinci Resolve 菜单插件，用于当前 timeline 中“选字幕 -> 火山合成/复刻 -> 插入配音”。
- 它不是 Edit Flow capability，不写 `runs/current.json`，不推进 Flow Plan gate，也不依赖 `/edit` Console 运行；合成音频时只调用本机 `127.0.0.1:8940` Supervisor TSV API，Supervisor 只合成/落盘音频并写 cache/manifest，不连接 Resolve。
- 第一版选择状态由插件面板维护：插件必须先指定一个旁白字幕轨道，只列出该轨字幕；可在插件字幕列表中多选，也可按当前播放头或 Mark In/Out 范围选中该轨字幕。Locate 只选中并滚动到插件列表行，不设置 Resolve In/Out，也不追求原生时间线选中。多字幕轨时间线不得默认全轨混扫，避免把 source-speech / 原声字幕误当旁白送去合成。Resolve 官方 scripting API 没有稳定的 timeline item 原生多选读取接口，agent 不得假设存在。
- 字幕正文只来自当前 Resolve subtitle item 暴露字段。若当前 Resolve 版本不暴露正文，插件必须阻塞并要求导入 SRT 或粘贴文本，不能从画面、文件名或历史产物猜字幕。
- 单选字幕时生成一条音频并导入 Media Pool bin `Kairos Voiceover / <timelineName>`，再插入 `Kairos VO` 音频轨；多选字幕时直接把所有选中字幕按 timeline 时间排序合并成一个 TTS 文本，生成一个 merged audio item，插入到第一条所选字幕起点，并在项目 `.tmp` debug manifest 记录 source subtitle ids/details。合并文本不得自动补 `。` 或 `.`，并需移除每行末尾已有 `。` / `.`；问号、叹号和句内标点保留。Resolve 面板只暴露 `Insert`，不提供只打开系统播放器的 Preview。默认不删除已有用户音频或旧配音。只有用户显式选择 replacement，并且旧 audio item 有插件写入的同一 `kairosVoiceoverUnitId` marker/customData 时，才可删除旧插件音频。
- 火山 `volcApiKey`、默认 voice profile 和 profiles 注册表写在 workspace 全局 `config/runtime.json.voiceover`。Resolve 插件面板只做 profile 下拉选择，不直接编辑 API key / speaker / resource / model / language。插件运行期不得走 `.cmd -> Python`、curl 或代理链；优先用 Lua TCP/HTTP 调本地 Supervisor，若 Resolve Lua 缺少 socket/TCP 能力，则改走 Supervisor 管理的 workspace 文件 IPC（`.tmp/resolve-volc-voiceover-plugin/ipc/requests|responses`），仍不得回退外部命令。
- 生成音频必须写到当前 Kairos 项目 `config/project-brief.json.voiceoverMedia` 解析出的可写候选路径下；该配置应在 `/ingest-gps` 项目配置 UI 中维护，并由 `/edit` 的 Resolve “重链素材路径”动作处理 `Kairos Voiceover` Media Pool bin。正式输出目录使用 `<voiceoverMediaRoot>/<safe Resolve project>/<safe timeline>/`，目录内只保存 Resolve 直接导入的 `vo_<unit>_<request>.mp3`。`voiceoverMedia.resolveProjectAliases[]` 可显式绑定临时 / debug Resolve 工程名。请求缓存、debug manifest 和插件日志写到匹配项目的 `.tmp/resolve-volc-voiceover-plugin/`。未配置或无法唯一匹配当前 Resolve 工程到 Kairos 项目时，插件应阻塞合成。

## Capability Contracts

### `edit.framework`

- 可读取 `media/chronology.json`，以及 Flow Plan 声明的 `spans/assets`。
- 输出是剪辑 handoff，不是证据索引。
- `全片章节` 只做宏观概览。
- `分段操作稿` 是唯一可执行 FW beat 边界，每行必须有稳定 FW beat id。
- 不得输出 `beat 边界索引`。
- 正文不得出现 chronology/event/route/gap/span/asset id。
- `spans` 列必须写可数类型统计和视频语音拆分。
- `叙事` 只写客观画面/声音总结，不写保留、优先、插入、加速、静音等后续处理指令。
- 是否输出额外 handoff 区块，只由用户维护的剪辑规则决定；skill 不规定固定素材召回提示章节。

### `material.recall`

- 正式输出只有 `edits/<editId>/script/material-slots.json`。
- 不生成、不消费 `segment-plan.json`。
- 素材事实输入固定为 `edit-framework.md + store/spans.json + store/assets.json`；人工规则输入来自当前 Flow Plan step 的 `notes`。
- 真实 span 时间由已修正的 `asset.capturedAt + span.sourceInMs/sourceOutMs` 计算。
- 不把完整 chronology 或 asset reports 喂给 recall Agent/SubAgent 作为语义选择接口。
- packet 必须包含当前 `material.recall` step context，作为读取人工规则的正式入口；如果 packet 缺失该 artifact，必须阻塞并重建 packet/Flow Plan。
- `chosenSpanIds` 是选择真相；不得让后续 script 或 timeline 阶段改写召回选择。
- 选择边界必须来自剪辑规则、Flow Plan 或合同校验；不得自行发明每段数量上限、代表抽样、全局压缩比例或“看起来好审”的删除规则。
- 如果剪辑规则要求“尽可能添加有效片段”，则应保留所有符合规则与合同的有效候选；只剔除明确无效、重复、被规则排除、合同拒绝或人工确认删除的片段。
- 口播和纯视觉窗口重叠时，按剪辑规则决定；若规则要求优先口播，不得再同时保留同源同窗的重复视觉片段，除非规则或人工审查另有说明。
- 同一原始素材的无口播行车去重、静音、加速，只按剪辑规则和合同执行；不要把这条扩展成对所有素材类型的抽样上限。

### `material-slots.json`

- `treatments` 是稀疏覆盖表；缺少 `treatments[spanId]`、`audio` 或 `speed` 时按默认 `{audio:0,speed:1}` 读取。
- 新生成文件应省略默认 `audio:0` 和 `speed:1`；对象为空时省略该 span entry。
- 照片必须显式静音 `{audio:-100}`。
- 被选中的非照片 span 只要有 `transcript`、`transcriptSegments`、`semanticKind=speech/mixed` 或 `materialPatterns=有口播语音`，就不得写或解析出 `audio<=-100`。
- `speed` 只能是整数倍 `1..5`；新生成文件不得写小数倍速或超过 `5x`，`speed>1` 只允许用于 `drive / aerial`。
- `query` 和 `targetBundles` 只写人类可读语义，不写 `audio:*`、`speed:*`、`audio=`、`speed=` 或把处理建议藏进自然语言。
- 未选入的 speech-backed 非照片 span 必须由 `coverageAudit` 暴露；代码不得自动追加到主粗剪时间线。扩召回应回到 `material.recall` 和人工审查。

### `script.generate`

- 可选能力。只有 confirmed Flow Plan 明确包含 `script.generate` step 时才执行。
- 执行前读取 `kairos-script` skill。
- 不得把 `/script`、`script/current.json` 或旧脚本阶段解释成新流程必经入口。

### `resolve.media_sync`

- deterministic runner。
- 用 confirmed chronology 组织 Resolve Media Pool 工程归档。
- chronology 只用于 Resolve bin/path/context，不参与 `material.recall` 语义选择。
- 不新增 `media-archive.json`；达芬奇 Media Pool 是素材归档真相。
- 重复运行必须复用已有 MediaPoolItem：素材已在正确事件分类子目录时跳过；素材已存在但事件分类子目录变化时只移动到新目录，不重导入；同步结束后清理 `Kairos Project Media` 下的空事件目录。

### `/edit` Resolve 工程维护

- `/edit` 可以提供 Resolve `[Edit]` 工程维护按钮，例如素材路径重链与 DRP 保存/登记。
- 素材路径重链不是 Flow Plan capability，不写 run record，不生成/确认/推进任何 step。
- `/edit` 的 Resolve 插件 / 效果库 / Fusion 模板安装也是工程维护动作，不是 Flow Plan capability。安装 truth 来自 workspace `config/resolve-assets/manifest.json`，当前包括 Resolve 旁白配音插件和 `Kairos Cinematic Matte` Fusion Edit Effect。旁白插件的 Resolve Scripts 菜单目录只安装 `KairosVolcVoiceover.lua`；工作区链接必须放在 `Fusion/Config/KairosVolcVoiceover/kairos_workspace.json`，安装器应清理 user/system 两边历史残留的同名脚本和 `KairosVolcVoiceoverLib` 目录，避免 Resolve 菜单出现重复入口。Console 必须显示安装状态并提供安装/刷新按钮。
- 素材路径重链必须把 Resolve assets installer 作为强制前置阶段：先按 manifest 安装/更新并校验本机 Resolve 用户目录资源；installer 失败时阻塞 relink，不得继续调用 Resolve `RelinkClips`；installer 成功时 relink 返回摘要必须包含安装结果。
- 重链必须先核对现有 `${projectBrief.name} [Edit]`、`Kairos Project Media` 和目标 edit timeline；不得创建新的 Resolve 项目来假装成功。
- 重链只从 `project-brief` root primary/alternate 候选映射到当前可读 root，调用 Resolve `RelinkClips` 后保存工程，并返回旧路径剩余、不可读、缺失目标、未映射、跳过非文件和 timeline 校验摘要。
- 若 `config/project-brief.json.voiceoverMedia` 或 `audioMedia` 已配置，重链同一动作还要分别处理 `Kairos Voiceover` 和 audio-only `Kairos Audio` Media Pool bin，并在摘要中独立显示 configured/skipped/warning 状态；`audioMedia` 是 BGM、SFX 和其它手工加音频共享的外部音频目录，不拆成 bgm/sfx 两个 relink 字段。
- Resolve compound/timeline 等非文件 item 没有稳定 `File Path`，必须跳过；缺失本机目标和未映射文件要作为 warning 暴露，不能阻塞其它可重链素材。
- 重链不自动导出 DRP；用户需要 DRP 时必须单独触发 `覆盖最新` 或 `归档快照`。

### `timeline.generate`

- deterministic runner。
- 读取 `edit-framework.md + material-slots.json + store/spans.json + store/assets.json + media/chronology.json`。
- 必须按 `material-slots` 的 segment/slot/chosenSpanIds 顺序落片。
- chronology 只用于 Resolve path/bin/context 映射，不得重排或替换 chosen spans。
- 不要求 `script/current.json` 或 `segment-plan.json`。
- Resolve 不可用、素材缺失、source range 校验失败、静音失败或必要 clip gain 无法稳定设置时阻塞，不写成功状态。
- 当前 `speed>1` 不阻塞，但 Resolve 粗剪可记为 pending/ignored，不得假装已应用。
- 照片静帧默认时长是 `1000ms`；只有剪辑规则 / confirmed Flow Plan 当前 step notes 或运行时 `timelineStillDurationMs` 明确声明时才覆盖。Resolve host 必须回读校验实际照片时长，不能默认使用旧 `5s`。
- Resolve rough cut 必须自动写入并回读校验 clip color 批处理标记：普通有声视频及其 linked audio item 为 `Orange`，照片 video item 为 `Blue`，延时 video item 为 `Purple`；有声延时的 video item 保持 `Purple`，linked audio item 使用 `Orange`，便于后续分别批量做音频归一、照片填充和延时处理。生成粗剪时还必须创建/复用 Resolve Color Groups `Kairos Photos` 与 `Kairos Timelapse`，并把照片/延时 video item 分别分配进去，供 Color 页 `Group Post-Clip` 批量效果使用。
- 每次 `timeline.generate` 成功时，必须同时从已选中、实际有声的 source-speech spans 生成 `.tmp/edit-flow/<editId>/timeline/current.srt`，供用户手动导入达芬奇；字幕时间按生成后的 timeline clip 时间映射，优先用 `transcriptSegments`，没有分段时才用整段 `transcript` 兜底。
- 任何自动生成的字幕、字幕审查稿、最终 SRT/VTT 和配音插件合并文本都不得自动补 `。` 或 `.`，并应移除行末已有 `。` / `.`；不要全局移除 `？`、`！` 或句内标点。
- `runs/current.json` 只能保存 step 级轻量摘要和输出路径；`timeline.generate` 不得把完整 KTEP、Resolve clip 明细、source subtitle text 或 `hostSummary.clips` 内联写入 run record，完整审计只写 `.tmp/edit-flow/<editId>/timeline/current.json`，字幕正文只写 `.tmp/edit-flow/<editId>/timeline/current.srt` 等 declared/temporary artifacts。
- Resolve timeline 成功后应尝试保存项目级 `${projectBrief.name} [Edit]` DRP 快照；所有 editId 共用同一 Resolve `[Edit]` 工程与 `edits/resolve-project-map.json`。latest 文件名是 `${Resolve项目名}.drp`，不是 `latest.drp`。自动快照失败只写 warning，不回滚 timeline。

### `resolve.lock_rough_cut` / `postlock.subtitle_narration`

- 粗剪锁定必须由人工确认。
- 锁定后才进入字幕与旁白草稿。
- 风格层只使用 Flow Plan `styleUsage` 明确授权的层。
- 旁白框架阶段的当前 Resolve timeline 只提供 clip 边界、顺序、source range、MediaPool source 和 `clipId / assetId / spanId / eventId` 映射；Resolve item name、MediaPool folder name、rough-cut `hostSummary.clips[].eventTitle` 或从 Resolve 名称拆出的显示标签都只是 debug/display-only，不得作为地点、路线、事件标题、地貌、水文、植被或字幕写作事实来源。无字幕视觉事实只来自 `visualObservation`。生成器不得把 `materialPatterns` 当作画面事实、分类来源或兜底描述；`semanticKind=speech/mixed` 但当前 Resolve clip 无字幕时，先按同素材实际 source range 匹配最近 visual span 的 `visualObservation`，无合格 visual span 时才使用当前 speech/mixed span 自带 `visualObservation`。正文必须写成剪辑规则附录式的 Markdown pack-list：顶层是口播 / 行车 / 航拍 / 照片 / 延时叙事单元，`整体` 或 `摘要` 写 pack 级理解，`clips` 保留 leaf clip 描述；每个将进入旁白字幕生成的无字幕非照片 leaf 必须使用当前 clip 自己的 GPS / GPX / reverse-geocode 地理上下文，行车 leaf 按当前 clip 源时间中点取定位，航拍 leaf 可使用 confirmed chronology event 作为语境但仍要回到实际飞行位置/视域；正文只写可读地点、道路/村寨锚点和山体/江河湖泊/植被/地貌特征，不输出裸经纬度、GPS 来源、匹配误差、`GPX±Ns`、`机内GPS` 或 `GPS匹配`；道路、桥梁、隧道、互通、收费站、跨江/跨海通道等交通设施专名可以作为可读锚点，但项目部、管理中心、停车场、观赏点等 POI 全名不得进入正文；行车和航拍 pack 的子条目不得复制同一 pack 总结模板，也不得复用整段 route 作为 leaf 定位；pack 的整体句必须归纳子 clip 的地貌、水文、道路、植被、村镇和天气路况变化，不能只拼接首尾或前三条；多 clip 口播 pack 只写摘要和 clip 范围，不逐 clip 展开口播细节；clip-map 只写轻量 v2 指针表，`entries[]` 只存 `marker + clips`，`packs[]` 只存 `title + entries`，不得复制 packet 中可反查的 asset/span/summary 事实；不得输出 `雨后湿滑、高速路面、道路延伸、车流穿行` 这类标签串。遇到 `�` 或 GBK/UTF-8 mojibake 候选时必须丢弃并回退到 chronology/GPS，不能写入正式 packet 可消费字段或正文。
- 旁白框架定位文案必须去除同类重复：命名水体、峡谷崖壁、山口峰丛、桥隧道路或具体植被已经出现时，不再追加 `江河湖泊 / 峡谷崖壁 / 林带植被` 等泛类标签。`林带植被` 不得进入正式正文；应结合 GPS 地点、海拔带、季节与画面线索写成可辩护的具体植被，如 `干热河谷灌丛、云南松和针阔混交林`、`常绿阔叶林坡`、`高山针叶林、杜鹃灌丛和冷杉林线`、`湖岸草甸`，不能确认时省略。
- `postlock.subtitle_narration` 的具体格式、合并、跳过字幕、风格引用和审查表要求，必须来自当前剪辑规则与 confirmed Flow Plan step notes；skill 不硬编码项目级创作约束。
- 如果用户在当前字幕修稿任务中明确要求参考已改字幕、intro、已成片字幕或其它旁白样本，应先读取该样本，把它当作本轮修稿参考，而不是继续只按抽象风格词改写。普通素材的样本参考是当前任务的风格修正手段，不自动沉淀为后续项目的永久写作规则。
- 重写最终 `subtitle-review.md` 时，把任务理解为“给已经剪好的时间线写逐 clip 可落地字幕”，不是“解释素材”：字幕列优先写路线推进、天气 / 道路 / 动作 / 画面变化，少写意义、感悟、素材事实堆叠或地理审计。
- 普通非照片 clip 默认保留一条短 caption；只有延时摄影和延时序列允许突破一 clip 一句。延时字幕数量不设固定 2-3 条上限，应优先保证画面叙述完整，按天光、云雾、色温、车流 / 人流、山体显露、夜色或晨雾回升等可观察变化拆成足够清楚的多条短字幕。只有剪辑规则、confirmed Flow Plan notes 或用户明确允许时才合并相邻普通 clip，且不得超过允许的合并宽度；普通行车、航拍和视觉 clip 不因“较长”自动获得拆分例外。修订时尽量稳定表格身份列和事实概要列，只改写旁白字幕列；同一延时 clip 拆成多条字幕时必须保留 clip 标签 / 范围或子范围，最终 SRT 按真实 timeline 时间分配。
- 完成后必须用脚本或等价检查确认表格行数、三列格式、生成 / 不生成数量、每条生成字幕的 `clip N` 标签、合并跨度，以及字幕列没有 GPS / 坐标 / source path / confidence / mojibake / `江河湖泊` / `峡谷崖壁` / `林带植被` 等不应进入成片字幕的噪音，并把检查摘要写入对应 audit。

## Blocking

- 缺 confirmed Chronology V2：回到 `/chronology`。
- 缺 Edit Unit 或剪辑规则：回到 `/edit` 初始化或选择规则。
- Flow Plan 缺失、未确认、hash stale 或 policy stale：重新生成或更新 Flow Plan。
- step 的 declared inputs 缺失：阻塞该 step，并说明缺失路径。
- human gate 未确认：阻塞依赖 step。
- Agent/SubAgent 执行器不可用：阻塞 agent/script runner，不写正式输出。
- styleUsage 需要风格层但缺少可用 `layered-v1` profile：阻塞。
- material-slots 合同失败：阻塞；不得靠后续阶段静默修正。

## Legacy Skills

`kairos-script` 和 `kairos-timeline` 只作为 confirmed capability 的实现参考。只有 Flow Plan 明确选择 `script.generate` 或 `timeline.generate` 时，才读取对应 skill；不要把它们重新解释成用户侧必经阶段。
