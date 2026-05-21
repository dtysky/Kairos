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
- `speed>1` 只允许用于 `drive / aerial`。
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

### `timeline.generate`

- deterministic runner。
- 读取 `edit-framework.md + material-slots.json + store/spans.json + store/assets.json + media/chronology.json`。
- 必须按 `material-slots` 的 segment/slot/chosenSpanIds 顺序落片。
- chronology 只用于 Resolve path/bin/context 映射，不得重排或替换 chosen spans。
- 不要求 `script/current.json` 或 `segment-plan.json`。
- Resolve 不可用、素材缺失、source range 校验失败、静音失败或必要 clip gain 无法稳定设置时阻塞，不写成功状态。
- 当前 `speed>1` 不阻塞，但 Resolve 粗剪可记为 pending/ignored，不得假装已应用。
- Resolve timeline 成功后应尝试保存项目级 `${projectBrief.name} [Edit]` DRP 快照；所有 editId 共用同一 Resolve `[Edit]` 工程与 `edits/resolve-project-map.json`。latest 文件名是 `${Resolve项目名}.drp`，不是 `latest.drp`。自动快照失败只写 warning，不回滚 timeline。

### `resolve.lock_rough_cut` / `postlock.subtitle_narration`

- 粗剪锁定必须由人工确认。
- 锁定后才进入字幕与旁白草稿。
- 风格层只使用 Flow Plan `styleUsage` 明确授权的层。

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
