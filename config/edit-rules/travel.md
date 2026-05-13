---
name: 旅行类默认剪辑规则
category: travel
---

# 旅行类默认剪辑规则

## 结构主轴

- primaryAxis: Pharos 行程印象优先
- chronology: enforce
- routeContinuity: strong
- roughCutStructure: day-key-time-drive-aerial-event

先用 Pharos 当前 `plan / record / gpx` 建构行程整体印象：这趟旅行从哪里开始、每天的空间推进、哪些计划点实际发生、哪些 record / GPX 说明了真实移动。

## 素材补漏

- materialPatchPriority: source-speech,gps,record,coverage-gap
- speechUse: preserve-usable-source-speech
- gpsUse: fill-missing-place-and-drive-context

Pharos 之后再读取素材分析结果补漏。重点结合口播、GPS、record、实际素材缺口和 chronology；不要从文案风格参考里反推结构。

生成完整事件表 review

## 初版剪辑框架

- frameworkShape: by-day,key-time,drive,aerial,key-event
- humanGate: review-framework-before-rough-cut

初版只生成剪辑框架文本，按天、重点时间、行车、航拍和关键事件组织。框架必须经过人工 review 与结构调整，通过后才能进入第一次粗剪。

行车需要按照已有视频素材，抽象出从哪里到哪里，尤其是无人机跟车素材和ZVE1，看怎么协作

## 粗剪规则

- firstRoughCutGate: reviewed-framework-required
- resolveInteraction: human-llm-around-timeline
- lockArtifact: edits/<editId>/timeline/locked-rough-cut.json

第一次粗剪生成后，人工与 LLM 围绕 Resolve timeline 交互式修改。第一次粗剪定稿后锁定 Resolve timeline，再进入字幕和旁白文本阶段。

## Post Lock

- postLockV1: source-speech-subtitles,single-narration-text
- notInV1: loudness-normalization,bgm,ducking,tts

锁定草稿后读取 Resolve timeline，生成源语音字幕和单篇旁白稿。v1 只正式化字幕与旁白文本；音量均一、BGM、ducking、TTS 不纳入本轮规则。

## 禁区

- 不要用 style profile 或参考成片自动生成剪辑结构。
- 不要在框架 review 前直接生成第一次粗剪。
- 不要把缺素材的计划点写成已经发生的事实。
- 不要为了套风格模板自动补总时长或段落预算。
