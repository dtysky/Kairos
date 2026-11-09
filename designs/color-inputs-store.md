# 素材级调色输入持久化

2026-11-06 初始用户确认：摘取已有事实到 `store/color-inputs.json`，增量持久化、校验来源签名，并接入 Color。此次不增加模型判断、技术检测或分类规则，不修改分辨率策略。

后续授权扩展见 [调色判定第一阶段](color-assessment-v1.md)：投影升级为 asset-color-inputs-v2，增加报告 inferredGps 的坐标/来源/置信度/时区及资产 embedded GPS 代表点；曝光/噪声测量与分类另存 store/color-assessments/<assetId>.json。投影本身仍只摘取事实。

## 输入与职责

素材是分类单位，不依赖 `store/spans.json` 或 span-rebuild。原始事实仍在 `store/assets.json`、项目 root 配置、`analysis/asset-reports/<assetId>.json`；新文件是可重建的派生输入，不允许人工修改它代替源事实。报告缺失不能用旧技术字段或文本关键词补写。

文件由 `schemaVersion`、`projectionVersion`、`updatedAt` 和按 `assetId` 索引的 `assets` 构成。每条记录保存：

- `media`：素材种类、时长、已校正拍摄时间、编码/显示尺寸和旋转元数据；raw/target 路径、可用性、内容签名、原始 LOG/色域/Gamma及来源；root 显式输入色彩配置。尺寸仍注明来自 asset 元数据，不冒充 raw 独立 probe。缺失旋转不补成 0，缺失显示尺寸不猜测。
- `analysisInput`：当前语义分析选用的 raw/target 输入及 LUT/内容签名，和待调原片身份分开。`media` 中来自 asset 的尺寸仅保留来源事实；Color 的竖屏分类、90° 技术处理和模板选择使用待调 raw 的独立 probe，不与 target 方向作一致性约束，不反写 Analyze。
- `facts`：原 `clipTypeGuess`、`summary`、现有语音文本存在标记/语音时间段/coverage，以及 recognized fine-scan 窗口的原始视觉描述、区间、semanticKind 和窗口自身语音证据。保留文本原文，不调用模型归纳，不复制整份字幕或 aligned tokens，不从局部描述推出整片结论。语音时间段只复制已有 transcriptSegments 边界；无时间不能编造。
- `sources`：资产相关字段签名、报告相关事实签名、报告路径；条目整体 `fingerprint` 用于检测派生内容变化。
- `analysisStatus` 与 `reasons`：current / missing / stale / blocked / unversioned。没有当前版本签名的旧项目可以留审计事实，但不能绕过 Color 的版本检查。不可用或过期报告不暴露为可消费 facts。

`colorEvidence`、旧 `colorClassification`、materialPatterns、Pharos 原始记录、GPS 地点文本、旧技术分类器字段均不摘入。此文件不保存已确认的曝光/噪声/偏色/闪烁结论或调色参数，也不把缺检测表达成检测阴性。

## 写入与恢复

1. 正式 `writeAssetReport` 写入原报告后，更新该素材投影；同进程的项目写入串行化，文件沿用原子替换。原报告先落盘，派生写入失败显式报错；下次可重建，不回滚已成功的分析。
2. 正式 Ingest 写完资产索引后刷新投影：新增素材有 missing 状态，删除素材移除对应项，变更使条目刷新或 stale。mtime/ctime-only 不改变相关签名。raw 更新而 target 分析未变时，只更新媒体侧记录，保留当前语义事实。
3. Color 读取前刷新指定素材的投影并校验当前资产/报告签名。文件缺失、损坏或版本变化时从原事实重建；来源缺失/过期仍阻塞，不能把缓存自称 current 当证据。已完成报告只读复用，不重跑 Analyze/ASR。
4. 未变化条目保持原 updatedAt/fingerprint，整个内容未变则不重写文件。报告无关的 GPS 地点文本、审计时间及已撤回技术字段变化不造成调色事实失效。多进程异常中断或竞态后的修复以源事实为准，Color 入口始终重新验证所需条目。

## Color 消费

`bindColorAnalysis` 从当前投影读取素材级事实，并调用独立 assessment 层：prepare 计算/复用测量，export 仅验证缓存。原片实际文件/sidecar、RCM 输入及 LUT 校验仍保留。输入投影不混入测量或人工分类；测量/分类合同见 color-assessment-v1.md。

## 验证

覆盖实际字段摘取、缺失/过期/无签名、只复制窗口自身语音、旧技术字段忽略、并发报告逐项更新、追加/删除、stat-only/raw-only 更新、损坏/篡改重建和失败写入恢复。验证 Analyze / Ingest / Color 正式路径，根仓和 Console 均构建。对现有隔离项目补建文件并核对原报告哈希不变，不调用模型或写 Resolve。

## 验收结果

2026-11-06 完成：

- 91 项相关测试通过：新增 store 9 项，Color 绑定 4 项，Ingest 16 项，Analyze profile 15 项、Analyze 6 项、asset-report 3 项、Supervisor Color 38 项。包括身份/输入字段与签名不一致拒绝、缓存篡改/损坏恢复、并发写入及源报告成功后派生写入失败恢复。
- 根仓 `pnpm build` 与 Node 20 下 Console build 均通过。Console 保留已有大 bundle 提示。
- 隔离项目 `projects/tmp-color-pipeline-20261105` 已补建 `store/color-inputs.json`，103 条记录，6 current / 97 missing，192057 bytes。二次刷新内容与 mtime 未变；6 份源报告及资产索引共 7 个文件哈希未变。
- 6 份当前报告经正式 Color bind 从投影读取后，类型、临时分组和逐片 RCM 输入符合当前代码合同。未调用模型、未改 Resolve 工程。证据在该项目 `.tmp/color-inputs-verification.json`。

2026-11-09：正式 Color 分类与 Analyze 分离，由 gpt-6.1-sol/high subagent 综合已有分析和原片技术测量。Prepare 缺当前决定时输出签名任务包并进入 pending-agent；使用 `node scripts/color-agent-classify.mjs submit <projectId> <rootId> <submissionFile>` 完整校验并提交后再继续 Prepare。接受记录原子存入 `store/color-classifications.json`，技术缓存独立存入 `store/color-measurements/`；独立用户澄清位于 `config/color-agent-context.json`。夜景与低照度共用第九类表中的 night 键，显示“夜景／低照度”；真实夜景排除大光比。旧语义正则及旧分类只读历史，不能兜底。详见 `designs/color-agent-classification.md`。
