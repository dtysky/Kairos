# Visual Material Semantics And Style Todo

## Goal

单独记录一组和画面素材语义、窗口可用性、风格档案镜头语法有关的后续优化事项，避免它们散落在 Analyze、Script、Style Analysis 各处之后被遗忘。

当前先合并为 3 条相关专项：

- Analyze 阶段的 `timelapse` 语义修正与窗口处理
- 无人机素材在 Analyze 阶段的窗口优化
- Style Analysis 对节奏、素材编排和运镜语言的进一步强化

## Why Now

- 当前项目里已经出现明显的晚霞、银河、星轨、日转夜和高价值航拍素材，但它们在正式脚本链路里的可见度和使用率还不稳定。
- 一部分问题发生在 Analyze：素材被误判、窗口不足、summary 太弱、下游难以召回。
- 另一部分问题发生在 Style Analysis：风格档案虽然描述了节奏和素材关系，但对后续 Script / recall / outline 的约束力还不够强。

## 1. Timelapse 语义与窗口

- [ ] 重新审视 `timelapse` 的 clip-type 判定标准，避免把城市晚霞、银河、星轨、日转夜误打成 `unknown / broll / drive`。
- [ ] 明确 `timelapse` 在 Analyze 中的正式语义：它是“节奏型素材”“建场素材”“时间推进素材”还是三者兼具。
- [ ] 为 `timelapse` 单独定义窗口策略，避免继续套用普通 `broll` 或 `drive` 的窗口抽取方式。
- [ ] 评估是否需要对整条延时素材默认保留一个“全段可用窗口”，而不是只依赖局部热点。
- [ ] 核对 `timelapse` 的 summary / labels / placeHints 输出，确保后续召回时能体现“天光变化 / 城市动势 / 星空 / 云层 / 日夜转换”等语义。
- [ ] 检查 `timelapse` 是否应显式向下游暴露更强的节奏提示，而不是只给普通 scenic 标签。
- [ ] 为 Script / Timeline 明确 `timelapse` 的消费预期：更适合 intro、transition、地理重置、时间推进还是情绪收束。

### Risks

- 如果 `timelapse` 判定过宽，普通固定机位空镜可能被错误吸进延时路径。
- 如果窗口策略只保留整段，不做任何裁剪，后续节奏可能会变钝。
- 如果仍然只产出弱 summary，不补足结构化语义，后续 recall 还是会继续忽略这类素材。

### Done Criteria

- 同类晚霞 / 银河 / 星轨 / 日转夜素材能更稳定落到 `timelapse` 或明确的延时相关语义。
- `timelapse` 素材默认能产出对 Script 真正可见、可召回的窗口或 slices。
- Script 阶段能够在不写特殊人工补丁的前提下，稳定召回至少一部分 `timelapse` 候选进入 intro / montage。

## 2. 无人机窗口优化

- [ ] 重新审视无人机素材的 `interestingWindows` 生成策略，区分“地理建立”“路线展示”“奇观抬升”“收束释放”几类用途。
- [ ] 为 `aerial` 定义更适合的 edit-friendly bounds，避免窗口过碎或只剩局部动作。
- [ ] 明确无人机素材是否需要更高的默认 scenic score / establish score，而不是和普通 `broll` 一起竞争。
- [ ] 检查是否需要对航拍素材保留“开场建场窗口”和“段落收束窗口”这类显式下游友好语义。
- [ ] 评估无人机素材在 Script recall 中是否需要根目录偏置，避免高价值 drone roots 被口播 / drive 大根淹没。
- [ ] 核对航拍的 summary / labels / placeHints 是否足够表达地理尺度、路径结构、天气和空间层次。
- [ ] 评估是否要给部分航拍窗口补“适合作为 intro / transition / invitation / escalation”的结构化提示。

### Risks

- 如果航拍权重提得过高，可能会反过来把有必要保留的现实摩擦、口播和路感证据压掉。
- 如果窗口设计过于偏 scenic montage，可能让无人机素材只剩“好看”而缺乏叙事功能。
- 如果 edit bounds 过宽，时间线层可能又会变慢；过窄则会失去尺度感。

### Done Criteria

- `aerial` 素材能更稳定地产出适合 intro / escalation / transition 的候选窗口。
- 后续 Script 在不人工硬塞的情况下，能更自然地使用独立无人机根中的高价值片段。
- 航拍素材进入成稿时，不再只是零散点缀，而能承担地理重置、尺度抬升和段落收束功能。

## 3. Style Analysis 的节奏、素材与运镜强化

- [ ] 强化风格分析对节奏模式的抽取，不只写“前快中稳后抬”，还要尽量补出更可消费的阶段特征。
- [ ] 进一步细化素材编排语法：`aerial / timelapse / drive / talking-head / broll / nat sound` 的角色和插入时机。
- [ ] 补充运镜 / 镜头语言维度：推进、拉远、横移、俯冲、跟车、固定机位延时、高位建场等是否属于该风格的高频手法。
- [ ] 明确哪些镜头语法只适合“开场建场”，哪些适合“地理重置”，哪些适合“情绪释放”。
- [ ] 评估是否需要把部分 style analysis 结果结构化成参数，而不是只保留在长文本 section 里。
- [ ] 让风格分析结果能更直接服务 Script / recall / outline，而不是依赖 LLM 自己从长文里再次推断。
- [ ] 单独整理“风格禁区”里的素材和镜头禁区，例如“不要让航拍只承担好看”“不要让延时沦为随机填空”。

### Risks

- 如果 style analysis 只增加文案密度，不增加结构化可消费信息，下游收益会很有限。
- 如果过度结构化，可能反而把风格压扁成模板，削弱 agent 创作空间。
- 如果不区分“观测到的高频手法”和“应该强制复用的规则”，可能会把参考风格误写成硬性约束。

### Done Criteria

- 风格档案在节奏、素材编排和运镜语言上，比现在更具体、更能指导下游。
- Script 阶段能从 style profile 里直接获得更明确的镜头组织偏好，而不是只拿到泛化的叙事语气。
- 后续 intro / montage 类脚本在镜头节奏和素材选择上，更稳定贴合风格参考。

## Current Judgment

- 这 3 项虽然分属 Analyze 和 Style Analysis，但它们最终共同影响的是“高价值视觉素材能不能被正确识别、正确窗口化、再被正确写进脚本”。
- 后续推进时最好仍按专项分别开工，但文档层面合并记录更适合统一追踪。
