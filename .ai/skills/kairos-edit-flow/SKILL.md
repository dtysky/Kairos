---
name: kairos-edit-flow
description: >-
  Edit-rule-driven atomic capability flow after Chronology. Use when selecting
  edit rules, initializing edit units, reviewing Codex-maintained Flow Plans,
  assembling rough cuts, locking Resolve rough cuts, or producing post-lock
  subtitles/narration.
---

# Kairos: Edit Flow

Chronology 之后的正式剪辑入口是 `/edit`，不是固定的 `Script -> Timeline`。

核心合同：

- `config/edit-rules/*.md` 是自然语言剪辑流程定义。
- `edits/<editId>/config/edit-unit.json` 是每个 edit unit 的初始化真相，保存 `editId / editRuleCategory / styleCategory`。
- `edits/<editId>/planning/flow-plan.json` 是 Codex Agent 维护的可执行计划；当前计划必须使用 `plannerPolicyVersion=codex-agent-v1`、`materialIdPolicyVersion=human-source-v1` 和 `materialTimePolicyVersion=normalized-captured-at-v1`。
- capability registry 是可执行原子库，不是固定阶段链；Codex Agent 只选择剪辑规则明确要求或后续执行必需的最小 capability 集合。
- 代码只执行 confirmed Flow Plan 中声明的 `capabilityId / inputRefs / outputRefs / gate / runner / execution`。
- `/edit` 只保存 Edit Unit 初始化并只读展示 Flow Plan / planning artifacts / material-slots / run records；不得通过 UI 或 Supervisor 生成 Flow、确认 Flow、运行 step、运行下一步或确认 gate。
- Supervisor 不再有 `edit-flow` job；Agent/SubAgent work 必须由 Codex Agent 直接在仓库内完成。
- 剪辑规则可以用自然语言要求 `SubAgent`、切分粒度和阈值打包；Codex Agent 负责写入 `step.execution` / `shardPacking`，运行时代码不得直接解析规则 markdown。
- 所有 Edit Flow `sharded-agent` 都必须声明 `codexSubagentProfile={reasoningEffort:"high", forkContext:false, speed:"standard"}`；执行 Codex SubAgent 时直接依据 confirmed Flow Plan step 启动，只传有界 step/shard 上下文，不 fork 当前长上下文。
- `trip.event_table` 只读取 confirmed `media/chronology.json`；不要把 `store/spans.json` 或 `analysis/asset-reports/*.json` 塞进事件组织阶段。
- `trip.event_table` / `material.archive` 是可选 planning capability；只有剪辑规则明确要求独立事件表、行程表、素材档案、素材库文档或单独人工审查产物时才生成。
- `edit.framework` 可直接声明 chronology / spans / assets 作为输入；读取编年史或覆盖素材描述不等于必须拆出 `trip.event_table` / `material.archive`。
- `edit.framework` 是剪辑 handoff，不是证据索引：`全片章节` 只做宏观概览；`分段操作稿` 是唯一可执行 FW beat 边界，每行必须有稳定 FW beat id；不得输出 `beat 边界索引`；主表和 `给 material.recall 的执行索引` 都不得出现 chronology/event/route/gap/span/asset id；`spans` 列必须写类型数量和视频语音拆分，例如 `共28段：行车13（有语音5/无语音8）、航拍7、普通视频4（有语音2/无语音2）、照片4`；`叙事`列只写客观画面/声音总结，不写“保留 / 优先 / 插入 / 加速 / 静音”等后续剪辑指导。
- 正式 run truth 是 `edits/<editId>/runs/current.json`；每个 step record 记录 `stepId / capabilityId / status / inputSnapshot / outputPaths / review / error`，不再默认创建 `runs/<runId>/record.json` 子目录。
- 不要关键词解析剪辑规则 markdown，也不要把 style profile 的观察自动提升成硬规则。
- 不要引入必选 `beat`、`script/current.json` 或其它全局中间稿；中间产物由每个 capability 的 `outputRefs` 声明。
- `script.generate` 只是可选能力：只有剪辑规则明确要求前置文本稿、beat 稿或旁白草稿时才出现。
- `material.recall` 只输出 `edits/<editId>/script/material-slots.json`；不生成、不消费 `segment-plan.json`。固定输入应是 `edit-framework.md + store/spans.json + store/assets.json`，用已修正的 `asset.capturedAt + span.sourceInMs/sourceOutMs` 计算真实时间；不要喂完整 chronology 或 `analysis/asset-reports/*.json`。
- `material-slots.json` 是召回和粗剪建议的唯一正式结构化产物。每个 `chosenSpanId` 必须写 `treatments[spanId]={audio:number,speed:number}`；`audio` 是 dB，默认 `0`，静音 `-100`；`speed` 是倍速，默认 `1`。被选中的非照片 span 只要有 transcript、transcriptSegments、`semanticKind=speech/mixed` 或 `materialPatterns=有口播语音`，就不得写 `audio<=-100`，且未选入的 speech-backed 非照片 span 必须由 `coverageAudit` 暴露；这覆盖 `drive / broll / aerial / timelapse / talking-head`。不要把未选入的 speech-backed span 盲目追加进主粗剪时间线；扩召回应回到 `material.recall` 的选择和人工审查。不要把 `mixed`、`audio:*`、`speed:*` 或自然语言解析式建议写入正式字段。
- `resolve.media_sync` 是 deterministic runner，负责把 confirmed chronology 对应素材同步进达芬奇 Media Pool；chronology 在这里仅用于 Resolve Media Pool bin 组织和工程归档，Media Pool 本身是素材归档真相，不新增 `media-archive.json`。
- `timeline.generate` 是 deterministic runner，读取 `edit-framework.md + material-slots.json + store/spans.json + store/assets.json + media/chronology.json`，并必须通过 Resolve host 从已同步 Media Pool 按 `material-slots` 顺序创建/更新粗剪 timeline；chronology 只用于 Resolve path/bin/context 映射，不得改变 `material-slots` 的选择和顺序；不得要求 `edits/<editId>/script/current.json` 或 `segment-plan.json`。
- Resolve 粗剪素材同步必须按 chronology event title 组织项目全局 `Kairos Project Media` media pool bin，这是工程归档组织，不是召回语义接口；不要按 `editId` 建素材 namespace，也不要把正式审查素材按 spanId/assetId 作为一级分组。Resolve timeline 固定放在 `Kairos Timelines` bin。同步单张照片时必须使用并校验单文件 MediaPoolItem，不能让 Resolve 把连续编号 JPG 折叠成 image sequence。当前正式落片只走 Resolve 原生 `AppendToTimeline` API；`speed>1` 暂不应用到 Resolve 粗剪，必须在 host summary 里记为 ignored/pending。静音视频保留 linked audio item 并禁用 audio item，照片可无 audio item。
- `.tmp/edit-flow/<editId>/timeline/current.json` 只是本机临时 KTEP/manifest 审计文件；Resolve 不可用时 `timeline.generate` 必须阻塞，不能把 KTEP-only 写成成功。正式可审查对象是 Resolve `Kairos Timelines` bin 里的 timeline，锁定后才写 `edits/<editId>/timeline/locked-rough-cut.json`。

## 正式顺序

1. 确认 `/chronology` 已确认 Chronology V2；fresh spans 只在后续 step 的 `inputRefs` 明确要求时才阻塞。
2. 用户在 `/edit` 初始化 Edit Unit：选择/创建 `editId`，选择 `editRuleCategory`，可选选择 `styleCategory`。
3. Codex Agent 读取 Edit Unit、剪辑规则、项目上下文、可用素材事实和 capability registry，生成/更新 `flow-plan.json`。
4. Codex Agent 按 Flow Plan step 直接执行或委派能力，必要时写出人工审查产物。
5. 每个能力执行仍遵守：
   - 解析 `inputRefs`
   - 选择 runner：`deterministic / agent / script / manual`
   - `agent` / `script` runner 必须由直接 Agent/SubAgent 执行器承接；缺少执行器时阻塞，不写正式输出
   - 写 declared outputs
   - 写/更新 `edits/<editId>/runs/current.json`
   - 如果 `gate=human`，停在待人工审查状态，但确认不是 Console 按钮动作
6. Export 只消费 confirmed Flow Plan 产物中的正式时间线 / 字幕 / NLE 目标。

## Capability 口径

当前能力库至少包含：

- `trip.event_table`
- `material.archive`
- `edit.framework`
- `material.recall`
- `script.generate`
- `resolve.media_sync`
- `timeline.generate`
- `resolve.lock_rough_cut`
- `postlock.subtitle_narration`

能力可以由确定性函数、Agent-backed stage、独立脚本或人工导入执行。选择逻辑属于 capability runner，不属于固定 phase。

## 阻塞规则

- 缺 confirmed Chronology V2：回到 `/chronology`。
- 缺 fresh spans / assets / asset reports：只阻塞声明了这些 `inputRefs` 的素材级 step；`trip.event_table` 不因此阻塞。
- 缺剪辑规则：回到 `/edit` 选择规则。
- Edit Unit 缺失或未选择剪辑规则：回到 `/edit` 初始化。
- Flow Plan 缺失、未确认或 hash stale：由 Codex Agent 重新生成或更新。
- Flow Plan 缺少当前 `plannerPolicyVersion=codex-agent-v1`：视为 policy stale，由 Codex Agent 重新生成。
- Flow Plan 缺少当前 `materialIdPolicyVersion=human-source-v1`：视为素材主键 policy stale，由 Codex Agent 重新生成。
- Flow Plan 缺少当前 `materialTimePolicyVersion=normalized-captured-at-v1`：视为素材时间 policy stale，由 Codex Agent 重新生成。
- step 的 `inputRefs` 缺失：阻塞该 step 并显示缺失路径/引用。
- human gate 未确认：后续依赖 step 不可继续。
- styleUsage 需要风格层但没有可用 `layered-v1` profile：阻塞 Flow Plan 确认或 step 执行。
- `timeline.generate` 时 Resolve host 不可用、Media Pool 缺素材、原生 append/静音失败、source range / still duration 回读校验失败，或非 0 dB clip gain 无法通过 live `TimelineItem.GetProperty()` 探测并稳定设置：阻塞，不写成功状态。当前 `speed > 1` 不阻塞，但也不应用。

## 旧阶段资料

`kairos-script` 和 `kairos-timeline` 只作为具体 capability 的实现参考。当 Flow Plan 明确选择 `script.generate` 或 `timeline.generate` 时，可以读取对应 skill；不要把它们重新解释成用户侧必经阶段。
