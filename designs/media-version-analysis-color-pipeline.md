# 素材版本、先分析后调色与渐进导入

状态：已实现，2026-11-05 完成下述范围验收。Resolve 使用 [RCM 输入统一](resolve-rcm-scene-pipeline.md)，取代第一轮 User1 LUT 方案。用户已确认先查目标、再找原片；本设计取代早期调色试验中“调色阶段独立重新理解画面”的临时方案。

## 正式顺序与身份

Ingest → Analyze → 调色分类/基础节点 → 目标输出到位后再次 Ingest。Chronology 与 Edit Flow 仍消费经过审阅的 spans，不由调色写入语义事实。

同一 root 内，相同目录、文件主名与媒体种类代表一个逻辑素材；扩展名大小写和 raw/target 编码扩展名差异不新增素材。每个角色内重名冲突必须报错，不猜配对。保留现有 human-source-v1 ID、rootCode、校正后的 capturedAt。每个素材只登记 `mediaVersions.raw` / `mediaVersions.target`，内部帧缓存、更新回滚文件不属于版本。

每个版本保存相对路径、文件大小/时间、内容 SHA-256。stat 未变复用哈希；stat 变了重算内容，不能把 mtime 变化当内容更新。散列前后 stat 不一致必须失败，避免登记复制中的素材。对可扫描目录做实际增删同步；离线目录保留既有登记，不把暂时离线当删除。只在实际分析/空间依赖变化时使下游 stale。

## 分析输入与恢复

逐素材优先可用 target，没有 target 才使用 raw。存在但解码失败的 target 报错，不静默回退。原片技术信息独立保留：Sony sidecar 的明确 Rec.709/LOG 优先于 root 默认；无法确定技术转换时阻塞该原片分析，不猜 LUT。target 不套原片 LUT；raw LOG 的 coarse/fine 帧在送入 VLM 前使用对应 LUT；raw Rec.709 直接分析。

报告记录所用版本、内容指纹、技术转换与输入签名。报告、prepared/audio/fine-scan checkpoint 和代表帧必须使用同一输入签名；输入改变时仅该素材缓存失效。target 未变时 raw 更新不会重新运行 target 分析；raw→target 切换会重新分析。旧报告无输入签名时不得冒充新管线的有效结果。原始 ASR/旧报告可留审计，但不能被下游当当前事实。

## 调色

2026-11-06 增补：Color 按素材消费 `store/color-inputs.json` 的当前投影，见 [持久化合同](color-inputs-store.md)。类型来自素材报告 clipTypeGuess，summary 和 recognized window 描述原样摘取；媒体方向、raw/target 色彩信息分别保留来源。报告写入后增量更新，Ingest 刷新版本/删除，Color 读前核对或补建；不依赖正式 spans，也不增加模型或技术判断。

2026-11-06 纠正：撤回此前让 VLM 输出技术 `colorEvidence` 并驱动 scene-v1 的实现。新 Analyze 只产出原语义报告，不写调色技术结论或预计算分类。Color 忽略历史 colorEvidence / colorClassification，后续采用 scene-v5 与独立曝光/噪声/大光比测量（[首阶段合同](color-assessment-v1.md)），复核为状态而非调色组。不把旧模型结论、描述关键词或缺失检测当技术事实。逆光/大光比正式合同见 color-high-contrast-v1.md；偏色幅度及频闪不在本轮范围，详见 [职责边界与后续讨论](color-technical-analysis-boundary.md)。下方旧分类验收仅为历史记录。

原始 LOG/色域是技术输入维度，不因视觉分类消失。Resolve 需使用真实 Group，并保持既有 `Gyro → Dehaze → User1 → User2 → NR` 标准节点模板；不能用单节点 CDL 替代。技术 LUT 和视觉类别不能互相覆盖；同组不同 LOG 的技术转换必须逐片正确。重跑只补新增或明确失效输入，不重置用户已经完成的节点。

新管线逐片明确 MediaPoolItem Input Color Space，由 RCM 在 Group Pre 前统一到 DWG/Intermediate，输出 Rec.709 Gamma 2.4；保留标准五节点，User1/User2 留给手调。Scene Group 不写技术 LUT，竖屏、夜景等不与 LOG 交叉。旧版 LOG/orientation Group、非 RCM 或旧 User1 技术 LUT 工程不自动迁移；改用隔离的新调色工程或另行确认迁移。既有标准节点和手调保留。尚未经实际动态验证的美肤、NR、Dehaze 参数不由分类器猜值。

准备签名使用 rcm-dwg-v1，覆盖原片内容、输入色域/Gamma 对应的 RCM 输入空间和当前分析分类，即使分析来自 target 也不遗漏 raw 技术变化。原片色彩元数据或 root profile 改变须先 Ingest；导出前复核签名及实际项目、timeline、逐素材输入设置，变化或缺少准备证据时阻塞。Analyze 原片显示代理仍校验 LUT 内容，target 分析不依赖 Resolve 技术 LUT。渐进 prepare 仅追加缺失片段，保留已有时间线项、Inspector 和节点状态；同路径原片内容更新通过 ReplaceClip 刷新并回读验证。

## 验收

使用被 git 忽略的 `projects/tmp-color-pipeline-20261105` v2 fixtures：保留 73 个设备/天覆盖单元，完整长口播、连续行车及光线变化；基线 103 素材（其中 3 raw-only），追加 4、target 到位、target 内容更新、raw 内容更新、仅 mtime 更新、追加 3，最终 110。检查稳定 ID、每素材至多两版本、实际内容更新、选择与缓存失效范围、Pharos 外部目录复用。不要把 fixture 的旧 target-only 100 素材断言当新验收标准。

必须跑针对版本配对/缺失/冲突、输入签名及调色规则的测试，以及根仓 `pnpm build` 和 React console 单独 build。耗时的完整 ML 分析与 Resolve 写入分别记录实际完成范围，不以准备成功代替端到端成功。

长素材验收发现 MLX 分支丢弃 ForcedAligner 返回的零时长字符，而 Windows 分支已保留。这些字符仍是对齐器的权威输出：MLX 应同样保留 `end == start` 项，不伪造时长；全无有效时长仍拒绝，TypeScript 的字符覆盖与时间顺序校验保持不变。修复后用完整 C4443（386 秒）复验，不能通过裁短素材或关闭校验回避。

### 第一轮验收记录与后续 RCM 更新

下列六片 User1 LUT 工程与 487 项测试属于第一轮历史验收。当前 RCM 工程、Group Pre 混合设备实测及最新测试记录见 [RCM 实测结论](resolve-rcm-scene-pipeline.md#本轮实测结论)。

- 正式 Ingest 全阶段复跑通过：103 → 107 → 110；原 ID / corrected capturedAt 稳定。目标到位只改变 3 份对应分析输入，目标内容替换只改变 1 份；原片单独更新与 mtime-only 不使未变目标分析失效。旧报告文件字节始终保留。最终复位 103 份，六份报告仍是当前输入。
- 六份全长 Analyze 实际完成，覆盖 raw Rec.709 / S-Log3 / D-Log、完整长口播、386 秒行车与车库光线变化。道路航拍误判 drive 在通用相机视角约束中修正后重跑，结果为 aerial；没有按文件名覆写分类。
- 新 Resolve 工程 `调色管线测试 20261105 [Color]` 共两个 root 时间线、六片、三个真实视觉 Group；普通白天组同时包含 Sony 和 DJI。五节点 / User1 LUT / Rec.709 bypass / Group Pre-Clip 无 LUT 均由原生 API 回读。再次 prepare 后片段 ID、范围、Inspector、Group、LUT 不变。六张 ExportFrame 已查看。
- 根仓相关 487 项、ASR Python 7 项、Console 2 项测试通过；根仓与 Console 构建通过，Supervisor 已加载新代码，ML stopped。
- Pharos 外部目录仍只读复用；协议组合哈希 `2f1b4a996f068df4cdd71670ee07d46d04480ecfd8d1cd8742d7d8946981b2ba` 与 baseline 匹配。
- Git 忽略项目下 `.fixtures/v2-20261105/production-report.html` 为实片与审计入口，`production-exercise-results.json` 为阶段结果，`resolve-live-20261105/repeat-validation.json` 为重跑结果。

本次实片只覆盖九类中的三类，剩余 97 份尚未运行新 Analyze。闪烁只有疑似风险提示，未实现连续帧的完整闪烁测量。美肤、NR、Dehaze 参数未自动调整。没有覆盖目标视频的整片渲染；同路径原片更新的 ReplaceClip 路径经过宿主单测，真实更新场景验证到 Ingest。当前 Computer Use 无权限，因此桌面菜单/节点面板没有截图验收；以原生 API 和 ExportFrame 为实机证据。人工 spans 审查和 Chronology 仍按既有显式重建/提交流程处理。
