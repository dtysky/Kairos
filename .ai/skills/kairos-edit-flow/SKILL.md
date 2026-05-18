---
name: kairos-edit-flow
description: >-
  Edit-rule-driven atomic capability flow after Chronology. Use when selecting
  edit rules, generating or confirming Flow Plans, running edit capabilities,
  assembling rough cuts, locking Resolve rough cuts, or producing post-lock
  subtitles/narration.
---

# Kairos: Edit Flow

Chronology 之后的正式剪辑入口是 `/edit`，不是固定的 `Script -> Timeline`。

核心合同：

- `config/edit-rules/*.md` 是自然语言剪辑流程定义。
- `edits/<editId>/planning/flow-plan.json` 是每个 edit unit 的可执行计划。
- capability registry 是可执行原子库；代码只执行 confirmed Flow Plan 中声明的 `capabilityId / inputRefs / outputRefs / gate / runner / execution`。
- 剪辑规则可以用自然语言要求 `SubAgent`、切分粒度和阈值打包；Flow Planner 负责写入 `step.execution` / `shardPacking`，运行时代码不得直接解析规则 markdown。
- 所有 Edit Flow `sharded-agent` 都必须声明 `codexSubagentProfile={reasoningEffort:"high", forkContext:false, speed:"standard"}`；执行 Codex SubAgent 时只传 packet path/task，不 fork 当前长上下文。
- `trip.event_table` 只读取 confirmed `media/chronology.json`；不要把 `store/spans.json` 或 `analysis/asset-reports/*.json` 塞进事件组织阶段。
- handoff、agent packets、shard outputs 属于临时运行文件，写入 ignored `projects/<projectId>/.tmp/edit-flow/<editId>/runs/<runId>/`；正式 `edits/<editId>/runs/` 只保留轻量 record。
- 不要关键词解析剪辑规则 markdown，也不要把 style profile 的观察自动提升成硬规则。
- 不要引入必选 `beat`、`script/current.json` 或其它全局中间稿；中间产物由每个 capability 的 `outputRefs` 声明。
- `script.generate` 只是可选能力：只有剪辑规则明确要求前置文本稿、beat 稿或旁白草稿时才出现。
- `timeline.generate` 读取 Flow Plan 声明的前序 outputs；不得要求 `edits/<editId>/script/current.json`。
- `timeline/current.json` 可以作为 KTEP 时间线输出文件名，但它不是固定 Timeline 阶段的证据。

## 正式顺序

1. 确认 `/chronology` 已确认 Chronology V2；fresh spans 只在后续 step 的 `inputRefs` 明确要求时才阻塞。
2. 用户在 `/edit` 选择 `editRuleCategory`，可选选择 `styleCategory`。
3. 运行 Flow Planner，读取剪辑规则、项目上下文、可用素材事实和 capability registry，生成 `flow-plan.json`。
4. 用户人工确认 Flow Plan。
5. 按 Flow Plan step 运行能力：
   - 解析 `inputRefs`
   - 选择 runner：`deterministic / agent / script / manual`
   - 如果没有 host packet runner，按 `step.execution` 写入 single 或 sharded handoff 并停在 `awaiting_agent`，由当前 Agent 对话消费 `.tmp/edit-flow/...` packet 后写 declared output
   - 写 declared outputs
   - 写 `edits/<editId>/runs/<runId>/record.json`
   - 如果 `gate=human`，停在 `awaiting_review` 等待用户确认
6. Export 只消费 confirmed Flow Plan 产物中的正式时间线 / 字幕 / NLE 目标。

## Capability 口径

当前能力库至少包含：

- `trip.event_table`
- `material.archive`
- `edit.framework`
- `material.recall`
- `script.generate`
- `timeline.generate`
- `resolve.lock_rough_cut`
- `postlock.subtitle_narration`

能力可以由确定性函数、Agent packet、独立脚本或人工导入执行。选择逻辑属于 capability runner，不属于固定 phase。

## 阻塞规则

- 缺 confirmed Chronology V2：回到 `/chronology`。
- 缺 fresh spans / asset reports：只阻塞声明了这些 `inputRefs` 的素材级 step；`trip.event_table` 不因此阻塞。
- 缺剪辑规则：回到 `/edit` 选择规则。
- Flow Plan 缺失、未确认或 hash stale：重跑并确认 Flow Planner。
- step 的 `inputRefs` 缺失：阻塞该 step 并显示缺失路径/引用。
- human gate 未确认：后续依赖 step 不可继续。
- styleUsage 需要风格层但没有可用 `layered-v1` profile：阻塞 Flow Plan 确认或 step 执行。

## 旧阶段资料

`kairos-script` 和 `kairos-timeline` 只作为具体 capability 的实现参考。当 Flow Plan 明确选择 `script.generate` 或 `timeline.generate` 时，可以读取对应 skill；不要把它们重新解释成用户侧必经阶段。
