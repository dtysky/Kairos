# Color Agent 分类正式管线

2026-11-09 用户确认：正式调色以 `gpt-6.1-sol / high` subagent 综合已有素材分析和原片技术指标，替换 scene-v7 的语义正则；同时将低照度并入夜景，保持九类。本设计取代旧设计中“无新增 Agent、描述正则决定分类”的口径。Analyze 的模型路由、提示词、采样、ASR、原报告与原素材 type 不变。

## 分工与分类合同

代码负责 raw 独立 probe、LOG 解释、太阳计算、曝光/噪点/反差测量、签名、增量缓存和输出校验。subagent 负责综合语义及技术证据给出最终主类；不得用关键词或正则推断人物是否讲话、视角、室内外、日夜、低照度和片内场景变化。新阶段不调用 Analyze 的 OpenAI adapter，不要求新的 API key；由 Codex 宿主正式 subagent 执行，通过持久化 packet / handoff / submission 接入。

九类为竖屏、出镜口播、大面积过曝、明显噪点、逆光／大光比、清晨／黄昏、夜景／低照度、白天前挡行车、常规日景。内部沿用 `night` 和 `day-drive-cast` 键，后者不意味着已检测偏色。

- 原片有效竖屏独占；方向不能取 Analyze target，也不因此重跑 Analyze。
- 出镜口播结合 type、画面描述、原报告定时语音，包含他人拍摄和车内讲述；人物与声音并存、speaker 字眼和 type 均不能单独定类。摘要不享有覆盖全片的捷径，不设置旧 80% 口播覆盖规则。
- 人物/竖屏优先；过曝、噪点必须有原片技术支持；噪点没有低照度前提。技术未知不能写成阴性，也不能无条件阻塞其它有证据的类别。
- 实际夜景排除大光比。低照度室内与室外夜景共用主类，但保留独立场景事实；合并组名不扩大夜景排除到所有非夜间大光比室内。混合照明须明确实际夜景上下文，不能从组名反推。
- 大光比沿用已确认的统一区域测量、连续命中及严格超过一半时长，少数/各半保留基础主类和附加区间。过曝保留实际持续区间，不声称全片或源端不可恢复剪切。
- 室内低照度结合描述、技术亮度和用户明确澄清；太阳正午不能证明室内正常照明。暗物体、局部阴影、剪影不自动成为整体低照度。
- 白天前挡行车结合实际视角与 type；夜间行车共用夜景组，航拍跟车不等于前挡行车。没有证明偏色也可归行车。
- 以已有时间范围保留片内变化，不能虚构转场边界或比例。待复核仍是状态，不增第十组；分类不生成曝光、白平衡、降噪、美肤或频闪修正参数。

## Prepare、提交和导出

1. Prepare 校验整个请求范围的当前 raw/target 登记、报告与 RCM 输入，再计算或复用原片技术测量。旧 scene-v7 assessment 仅作为经完整签名校验的技术缓存来源，其语义决定不能继续消费。
2. 为缺少有效 Agent 决定的素材生成独立输入包：现有 `color-inputs` 事实、原报告 summary / windows / timed transcript、raw probe/色彩、太阳数据、技术状态/数值/区间、版本与来源签名。不把旧正则 scene / lighting / category 传给 Agent。全量逐帧技术数据可用签名引用读取，输入不能只保留模型技术标签。
3. root 范围形成不可混用的 batch，包含 packet fingerprints、策略版本和指定模型/推理级别。所有缺失项准备完毕后写 handoff，root 标记 `pending-agent`；任务结束、不是活跃等待进程，不把 root 报成 ready，不进入 Prepare 的 Resolve 写入步骤。Prepare All 分别保留各 root 待 Agent 状态，不误报全部 ready。
4. subagent 输出每个 assetId 的最终 category/status、语义事实、原文或数值证据引用、附加问题、具体局限和 packet fingerprint。输出必须由 subagent 判断，主 Agent 不把旧分类机械转换为新结果。支持用户明确澄清的独立上下文，不能改写原报告。
5. 正式提交入口验证当前来源、batch/packet/policy、完整唯一覆盖、模型标识、证据引用和物理技术约束；先全量验证再写接受结果，错误/缺项/过期不得部分应用。语义充分性属于 Agent 判断，验证器不重新编写语义正则。接受结果按 assetId 持久化到 store，含 Agent 决定、来源签名及审计。
6. 再运行同一 Prepare：仅增量处理变化素材；当前 Agent 决定合成正式 assessment，按真实 Color Group 落地。提交本身不写 Resolve。导出只验证已接受且当前的决定与技术缓存，不测量、不调用 Agent、不写新决定。
7. `/color` 展示待分类数量、指定模型、handoff 和继续操作；沿用仓库其它 Agent 阶段的复制任务入口。缺失/过期决定不能静默回退为旧语义规则。

持久化位置：`store/color-measurements/<assetId>.json` 保存独立技术缓存，`store/color-agent/packets/<packetFingerprint>.json` 保存不可覆盖的完整输入包，`store/color-agent/batches/<batchFingerprint>/` 保存合同、批次、handoff 和 submission。正式接受结果集中在 `store/color-classifications.json`，按 assetId 索引；同项目提交由跨进程锁串行执行，整批校验后一次原子写入，避免不同 root 同时提交丢失记录。`store/color-assessments/<assetId>.json` 只合成当前技术结果与已接受的 Agent 决定。

正式提交命令为 `node scripts/color-agent-classify.mjs submit <projectId> <rootId> <submissionFile>`。用户明确补充的事实单独保存到 `config/color-agent-context.json`（`schemaVersion: 1`，`assets[assetId]` 内含 `source: "user" / statement / recordedAt`），参与来源签名，不改写 Analyze 报告。报告文字/语音时间、原片、输入色彩、上下文、测量或分类合同发生变化，均须重新取得当前决定；stat-only 变化不使事实过期。

## Agent 默认阅读视图

2026-11-09 输入精简：完整 packet 继续作为签名、来源校验及精确证据真值；subagent 默认只读批次的 `agent-input-v2.json`。分类规则、九类名称、输出结构和输入列说明在批次中各提供一次，素材、字幕时间片段、画面窗口、噪点样本及太阳样本用共享列的行数组表达。只保留素材 id/packet 签名、校正拍摄时间、原报告类型/摘要/语音/画面窗口、用户澄清、raw probe、色彩 profile、技术诊断/覆盖/数值和太阳上下文。移除重复 colorInput 语义投影、媒体版本/校验 hash、本机源路径、解码器日志、fine-scan 计划关联信息；噪点样本保留数值和有效性，逐项 patch 拒绝计数留在完整包按需查。窗口状态、范围、语音归属及不同原文保持不变，不做语义概括或关键词筛选。

完全相同且重复的长文本在 `texts` 表中只出现一次，通过 `$text` 引用；不同描述不合并。原报告 transcript 与定时片段也不猜测等价，只有精确相同文本才共用引用。逐帧曝光/反差数组默认不展开；曝光概览提供首/中/末及显示亮度极值对应的原始样本数值和索引，这些样本不用于推定时间占比或转场。持续区间、诊断理由、噪点样本、反差占比和未覆盖信息仍可见；完整数组按 packet 路径按需读取。投影视图中的局部对象只作阅读，证据引用仍指向原 packet 的具体字段、原值与原区间。

视图格式版本与分类策略签名独立；格式压缩不改变 packet、accepted records、assessment、Analyze 或 Resolve。`node scripts/color-agent-classify.mjs input <projectId> <rootId> <batchFingerprint>` 可为既有批次补建阅读视图及更新 handoff，不重新分类、不更新正式接受结果。新增 Prepare 自动生成相同视图。默认阅读不再要求分别完整加载 contract、batch 和全部 packet。

## Console 操作流程

`/color` 使用项目级五阶段链：检查与检测 → Agent 分类 → 应用到 Resolve → 人工调色与导出 → 结果校验。主操作作用于所有启用的调色素材源，沿用 `prepare_all_roots / export_all_roots`；Agent 任务一次复制全部待分类批次，各批仍按原签名合同独立提交，提交后统一准备。操作按项目统一，设置仍按目录独立。复制任务只是交接入口，不表示已启动 subagent。

项目设置按目录展示独立的封装、视频/音频编码和码率，修改只影响该目录；通过原 project-brief 一次保存所有目录草稿，保留项目切换保护。不得把项目级运行误解为参数跨目录同步，不提供自动统一覆盖。各目录 LOG/RCM/LUT 补充和路径归在各自的高级设置中，原片输入色彩仍优先自动识别。不新增配置协议或迁移已有数据，不改动未编辑字段、其它目录、禁用源或非调色源。

默认跨目录汇总同名分组和素材，逐片保留来源与实际时间线；展示聚合不合并 Resolve Group。目录筛选只影响列表，不能缩小项目主操作范围。维护区保留逐目录诊断、重试和历史，主区以全部素材源中最早尚未完成的阶段决定下一步；未准备源优先检查，全部准备出输入后复制所有待 Agent 任务，再统一应用。任一源未就绪或有阻塞时不能统一导出。

全局入口同步：侧栏将“达芬奇调色”从素材准备移到创作组首项，保留共用导航样式与单一选中态。总览将 Color 描述为已有素材分析之后的可选支线，不加入编年史/剪辑的必经步骤。

- `pending-agent` 是已结束的准备任务产生的待办，不是运行进度。正式接受后的 `classification.status=ready` 且仍有 `batchFingerprint` 表示尚未应用，旧时间线 ready 不能开放导出；成功 Prepare 清除该批次交接字段后才显示 Resolve 已准备。
- 只有当前项目的 queued/running Supervisor job 能显示运行态；根状态中的历史 activeStage、日志与最近导出不能证明仍在运行。项目主区展示完整活跃任务进度；目录列表筛选不能隐藏其它目录正在执行的批量任务。
- Ready 只表示 Resolve 准备完成，不能声称人工调色完成。界面给出确切工程/时间线，用户在 Resolve 调色，返回后主动导出；已有覆盖确认不变。最近导出/校验始终注明“最近一批”，不能证明新分类已经导出。
- 默认展示分组和素材，成员的分类理由与待复核原因可展开查看；正在等分类或应用时说明现有列表来自上次同步，不冒充本次结果。各目录独立参数放“项目设置”，逐源输入色彩补充默认折叠；重链、重新检测、分组同步、DRP、技术状态和历史放“维护与历史”。
- Console 只读投影必须保留分组快照已有的 `classificationStatus / classificationReasons / reviewFlags` 以及 `nativeGroup=false` 的未分组标记，不能在 workspace read model 丢弃；不另读或重算分类来替换已同步快照。
- 视图切换、展开与选中状态只保留在前端；不增加项目协议、分类调用或检测流程。前置检查失败保留具体原因，并提供导入、素材分析和设置入口。校验只检查已有导出，不隐式重做分类或调色。

验收覆盖首次准备、等待 Agent、已接受待应用、可人工调色、最近批次校验、阻塞和批量任务；分别构建根仓与 React console，并用测试工程验证页面，不为 UI 验收重写 Resolve 工程。

## Resolve 保存与验证

保留 RCM、标准五节点、Clip grade、Inspector 和渐进追加行为。`普通夜景` 升级为 `夜景／低照度` 时优先原位重命名同一个真实 Group，保护 Group Pre/Post grade；若新旧组并存且不能无损合并，不盲删或重置组。类别变更只修改明确分类涉及的成员关系，不重套已有五节点或清空手调。更新前核对准确项目/时间线 ID，保存备份，完成后 SaveProject 和 latest-only DRP。

若 Resolve 临时断线导致 DRP 导出失败，后续正式 Prepare 或备份动作真正保存成功后，应清除该次导出失败的历史 blocker，避免时间线已 ready 而 Console 仍误报阻塞；仅 preflight 成功不能清除尚未恢复的备份错误。

验收覆盖来源/策略失效、完整原子提交、非法技术阳性、竖屏独占、实际夜景排除、低照度合并、旧正则缓存拒绝、增量/重复 Prepare、导出只读门控及 Console 待 Agent 显示。必须分别运行根仓和 Console build。测试工程 41 条须从正式生成的输入包由指定 subagent 重新确认；原生回读实际 Group，并对比更新前后 item 身份、帧位、Inspector、RCM、Clip/Group 节点和调色数据。
