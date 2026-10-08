---
name: kairos-speech-review
description: >-
  Review post-span-builder speech windows and spoken subtitles in Kairos.
  Use when store/spans.meta.json is pending-speech-review and the user wants
  Agent suggestions, the unified review report, or to submit reviewed choices.
---

# Kairos: 口播与字幕统一审查

这个阶段位于 `span-rebuild` 之后、`chronology-build` 之前。它只审查候选 speech/mixed spans，不重跑 ASR、VLM、fine-scan 或 span-builder。

## 输入与不变量

- 读取 `.tmp/chronology/speech-window-agent-handoff.md`、当前 candidate review artifact、`store/spans.json`、`store/spans.meta.json`、内置 `resources/transcript-glossaries/*.json`、工作区 `config/transcript-glossary.json`、`config/transcript-normalization.json` 和当前时间段行程上下文。
- `analysis/asset-reports/*.json`、raw ASR、segment 起止时间及 segment 边界不可修改。
- 字幕审查只能建议替换 `transcriptSegments[].text`；窗口审查只能保持、按现有 segment 边界连续裁切或取消。Agent 必须检查窗口内按时间排列的 segments：较早残句、卡顿或重新起句被后续完整表达覆盖，且去掉前后无效内容后仍能保留一个连续范围时，建议从完整表达的 segment 边界开始或结束。无法可靠提出窗口动作时保持原窗口并省略人工任务。
- 对 capture-time 顺序中连续、分别属于不同视频素材的 speech/mixed spans，Agent 可声明同一次机位介绍的 take group。只有一个版本明显完整时保留该版本并建议取消其余版本；多个版本都完整且没有明确优劣时必须输出组级 `needs-choice`，交给用户试听后单选。完整度看信息覆盖、表达是否完整、是否卡顿或重起；不得简单选择最长素材。无法确认主题等价时不得成组。
- 取消 speech window 时保留同范围的视觉召回和 `visualObservation`，不得删除、缩短或切碎已有 visual span。
- 跨素材重复组是独立审查项：只比较明确同功能且可互相替代的口播，默认采用 Agent 推荐的最佳 1 项，内容互补时最多 2 项，用户可改选或拒绝分组；接受后未选候选从正式 spans 索引删除，原始素材、asset reports、ASR 和审计保持不变。相邻同次录制的 take group 优先处理，其全部成员不得再进入 duplicate group，提交时验证两类分组互斥。
- effective glossary 合并只读内置领域词表和工作区个性词表，同名时工作区语境优先。每项只包含唯一 `canonical` 和必填 `context`。只有完整句子、相邻口播及当前时间段行程符合语境时，才能把词条用作修改依据；它不进入 ASR prompt。

## Agent 输出

- 为每个字幕候选给出结构化文字决定，为每个 speech/mixed span 给出结构化窗口决定，并对项目内全部可用 speech/mixed spans 做一次跨素材重复检查。
- 只有明显承担同一功能且内容可互相替代的 spans 才组成重复组；只提到相同地点但叙事目的不同的不成组。每组至少 2 项，默认推荐最佳 1 项，内容互补时最多 2 项；不确定时不生成分组，建议 cancel 的无效窗口不得进入重复组。
- 导航播报若包含明确地点、道路设施或方向锚点，就是可用的行程事实；不得仅因声音来自导航而建议取消。只有不含具体行程信息的通用转向/距离指令才可按低信息导航处理。
- 输入保持紧凑，输出只返回合同字段；不要累积素材案例、错误类型特例或项目专名到 prompt/skill。
- 无变化项不进入用户报告。
- 程序在 Agent 前自动应用确定性简体中文正字归一和工作区精确文字归一，并把命中项写入自动修正审计。Agent 必须继续审查归一后的句子。其余决定先调用 `stageProjectSpeechTranscriptReview` 生成审查产物，不直接修改正式 speech truth。

## 审查报告

正式事实写入 `analysis/speech-transcript-reviews/<inputsHash>.json`，Markdown 镜像写入 `.tmp/chronology/speech-transcript-review-<hash8>.md`。报告必须分成七个审查区：

1. `字幕｜已自动修正`
2. `字幕｜建议修正`
3. `字幕｜需人工听音`
4. `口播窗口｜建议裁切`
5. `口播窗口｜建议取消`
6. `口播版本｜待选择`
7. `口播｜重复候选`

窗口判断不再产生 `口播窗口｜需人工听音`：不能可靠裁切或取消时直接保持原窗口并省略记录。

跨素材重复组默认采用，推荐的 1–2 项默认勾选；用户可改选或拒绝整个分组。

“建议修正 / 建议裁切 / 建议取消”默认接受，用户只需手动取消不接受的项。字幕“需人工听音”和“口播版本｜待选择”默认未决；版本选择按组显示候选全文、范围和循环播放，只允许选择一个保留版本。未逐项完成前不得提交。听音表的状态列只显示单个“审查完成” Radio，不再用“接受修改 / 保留原文”表示完成状态，字幕结果直接读取可编辑最终文本。旧草稿的 rejected 字幕按原文迁移，已经编辑的 accepted 结果原样保留；旧窗口听音项按 keep 迁出且不改变 spans。正式报告仍不要输出保持原文、保持原窗口或建议保留现场声音的无动作行。

Console 的所有人工改动必须通过 draft API 自动保存到审查 artifact，并显示保存状态；刷新后必须恢复。draft 保存不得应用正式 spans。

字幕“需人工听音”行必须提供当前 `assetId + startMs/endMs` 的原音循环播放。试听范围在审查区间前后各增加 `1000ms` 并按素材边界截断，这段余量只帮助听清开头和收尾，不得写回正式时间。只使用 Supervisor 的审查音频端点，不向浏览器暴露或提交本地素材路径；切换播放行时停止上一段。

## 提交

- Console `/chronology` 是正式审查入口。
- 提交时调用 `commitProjectSpeechTranscriptReview`。服务端必须重新读取 baseline spans，并校验 inputs、effective glossary / normalization / trip hash、原文 hash、segment 时间、连续裁切边界、take group 成员相邻性与唯一性、组内单选值、重复引用、取消后的视觉保留、duplicate group 成员与 1–2 个保留项，以及 take / duplicate 分组成员互斥。
- 任一字幕听音或多完整版本选择未决、或任一校验失败，都保持 `pending-speech-review`，不得部分应用建议。
- 校验通过后一次写入 reviewed spans、审计 artifact 和 meta，最后将 meta 标记为 `fresh`，随后才可运行 `chronology-build`。
