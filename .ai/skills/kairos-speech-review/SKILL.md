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
- 字幕审查只能建议替换 `transcriptSegments[].text`；窗口审查只能保持、按现有 segment 边界连续裁切或取消。无法可靠提出窗口动作时保持原窗口并省略人工任务。
- 取消 speech window 时保留同范围的视觉召回和 `visualObservation`，不得删除、缩短或切碎已有 visual span。
- effective glossary 合并只读内置领域词表和工作区个性词表，同名时工作区语境优先。每项只包含唯一 `canonical` 和必填 `context`。只有完整句子、相邻口播及当前时间段行程符合语境时，才能把词条用作修改依据；它不进入 ASR prompt。

## Agent 输出

- 为每个字幕候选给出结构化文字决定，为每个 speech/mixed span 给出结构化窗口决定。
- 导航播报若包含明确地点、道路设施或方向锚点，就是可用的行程事实；不得仅因声音来自导航而建议取消。只有不含具体行程信息的通用转向/距离指令才可按低信息导航处理。
- 输入保持紧凑，输出只返回合同字段；不要累积素材案例、错误类型特例或项目专名到 prompt/skill。
- 无变化项不进入用户报告。
- 程序在 Agent 前自动应用确定性简体中文正字归一和工作区精确文字归一，并把命中项写入自动修正审计。Agent 必须继续审查归一后的句子。其余决定先调用 `stageProjectSpeechTranscriptReview` 生成审查产物，不直接修改正式 speech truth。

## 审查报告

正式事实写入 `analysis/speech-transcript-reviews/<inputsHash>.json`，Markdown 镜像写入 `.tmp/chronology/speech-transcript-review-<hash8>.md`。报告必须分成五张独立表：

1. `字幕｜已自动修正`
2. `字幕｜建议修正`
3. `字幕｜需人工听音`
4. `口播窗口｜建议裁切`
5. `口播窗口｜建议取消`

窗口判断不再产生 `口播窗口｜需人工听音`：不能可靠裁切或取消时直接保持原窗口并省略记录。

“建议修正 / 建议裁切 / 建议取消”默认接受，用户只需手动取消不接受的项。只有字幕“需人工听音”默认未决；未逐项完成前不得提交。听音表的状态列只显示单个“审查完成” Radio，不再用“接受修改 / 保留原文”表示完成状态，字幕结果直接读取可编辑最终文本。旧草稿的 rejected 字幕按原文迁移，已经编辑的 accepted 结果原样保留；旧窗口听音项按 keep 迁出且不改变 spans。正式报告仍不要输出保持原文、保持原窗口或建议保留现场声音的无动作行。

Console 的所有人工改动必须通过 draft API 自动保存到审查 artifact，并显示保存状态；刷新后必须恢复。draft 保存不得应用正式 spans。

字幕“需人工听音”行必须提供当前 `assetId + startMs/endMs` 的原音循环播放。试听范围在审查区间前后各增加 `1000ms` 并按素材边界截断，这段余量只帮助听清开头和收尾，不得写回正式时间。只使用 Supervisor 的审查音频端点，不向浏览器暴露或提交本地素材路径；切换播放行时停止上一段。

## 提交

- Console `/chronology` 是正式审查入口。
- 提交时调用 `commitProjectSpeechTranscriptReview`。服务端必须重新读取 baseline spans，并校验 inputs、effective glossary / normalization / trip hash、原文 hash、segment 时间、连续裁切边界、重复引用和取消后的视觉保留。
- 任一未决项或校验失败都保持 `pending-speech-review`，不得部分应用建议。
- 校验通过后一次写入 reviewed spans、审计 artifact 和 meta，最后将 meta 标记为 `fresh`，随后才可运行 `chronology-build`。
