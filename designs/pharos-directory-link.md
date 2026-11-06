# Pharos 工程目录直接关联

用户于 2026-11-05 授权在 Kairos 项目配置中关联已有 Pharos 工程目录，GPS、执行记录及已发布研究资料从该目录读取。本轮先实现直接关联，并创建独立测试项目。分析目标优先、原始/目标两个版本及逐素材更新机制继续按此次讨论收敛。

当前状态：目录关联及后续双版本管线均已实现；完整管线与最新验收以 [素材版本设计](media-version-analysis-color-pipeline.md) 和 [RCM 设计](resolve-rcm-scene-pipeline.md) 为准。以下首批选样、target-only 和“尚未实施”描述保留为当时阶段记录，不代表当前产品状态。

## 输入与读取

- `project-brief.json.pharos.sourcePath` 是可选的外部 Pharos 目录，支持单个含 `plan.json` 的 trip 目录，也支持包含多个 trip 子目录的集合目录。相对路径以 Kairos 项目目录为基准。空值沿用项目内 `pharos/`。`includedTripIds` 在两种目录结构中都生效。
- Console `/ingest-gps` 可编辑关联目录并显示实际解析路径和错误。显式外部路径不存在、不可读或 trip 身份冲突时返回失败，供用户修正。所有写入、缓存与审计位于 Kairos 项目内，源目录只读。
- 计划、执行事实和 GPS 继续消费 `plan.json`、`record.json`、`gpx/*.gpx`。fingerprint 包含实际输入目录、Trip 筛选及 canonical 文件状态，换目录或文件更新会刷新解析缓存。`record-import.json` 仍是 Pyxis 专用命令信封。
- Trip summary 保存实际 `sourcePath`，口播审查 handoff 从这个路径定位 `field-guide.json` 和相关研究资料。研究在审查时直接读取并沿用来源快照与 provenance 合同，canonical fingerprint 只负责执行事实与 GPS。
- 旧项目省略新字段即可沿用本地镜像。JSON 保存、Markdown 镜像、Markdown 恢复、Supervisor 状态和作业共用同一选源规则。

## 验证

覆盖单 Trip、Trip 集合、目录切换、外部文件变化、无效路径、包含 Trip 筛选、旧镜像、配置往返和源目录只读。运行相关回归、根仓构建及 React console 构建。测试项目采用 `projects/tmp-*` 命名，确认完整目录受 Git 忽略。

## 本轮实测结果

- Pharos / context / GPS / 配置往返 / span-builder 回归共 56 项通过，Console 表单回归 2 项通过。根仓和 React Console 构建均通过。
- 隔离测试项目 `projects/tmp-color-pipeline-20261105/` 已创建，完整目录受已有 Git ignore 规则保护。94 份媒体共 141 个版本文件；首批 90 份正式 Ingest 完成，零读取失败、零警告；4 份留作追加批次。原样重跑复用全部 90 份元数据，零新增、零重新读取。
- 首批覆盖全部 73 个实际设备/机型 × 日期组合，共 13 天。原始 ID、已校正拍摄时间与 root-relative sourcePath 均验证通过。
- 直接关联实际 Pharos Trip，解析 107 个 GPX 文件 / 93,881 个点；研究文件可从实际 sourcePath 读取。源文件内容与 mtime 均未变化，本地 pharos 镜像为空。
- 测试 README、逐版本 SHA-256、覆盖清单及后续增量/更新/回退验收场景保存在忽略的测试项目内。完整双版本媒体管线尚未实施。

## 上游协议复核

本次 Pharos 设计组合哈希为 `2f1b4a996f068df4cdd71670ee07d46d04480ecfd8d1cd8742d7d8946981b2ba`。`protocol.md`、Atlas 和 Pyxis 文档哈希与原基线相同，差异为 Argo 车辆尺寸研究修订以及新增旅行创作调研 skill 和入口说明。已复读当前 canonical 目录、field guide、record-import 和 GPX 合同及变化文档。上游差异本身无需 Kairos parser/schema 变更。此次路径配置与解析修改来自用户授权的直接关联需求。

## 后续测试素材补齐（2026-11-05）

首轮 94 份样本虽然覆盖设备日期，但按小文件优先选择导致缺少长素材。用户要求补齐后，在同一 Git 忽略测试项目内新增 16 份完整视频（约 41 分 51 秒），共 110 份；保留原 73 个设备/机型日期组合。初始阶段 103 份逻辑素材中有 3 份真实 raw-only，另外 7 份分 4＋3 两批追加。完整长口播、持续行车和门洞/车库/桥面光线变化已分时抽帧核对。

`.fixtures/v2-20261105/scenario.py` 已实际执行追加、目标到达、真实像素变化的 target/raw 版本替换、mtime-only 和复位；同阶段幂等、错误顺序与未知外部改动保护均检查通过。更新版为受控测试重编码，保留完整帧数、时长、拍摄时间与原音轨，源库只读。结束恢复 baseline。当前正式 Ingest 初始只索引 100 个目标文件；raw-only 发现、双版本登记及分析失效仍是待改造产品的验收项，测试驱动器不是正式实现。此轮不改变正式媒体管线或 Pharos 读取行为。

## 2026-11-06 协议复核

2026-11-06 复核上游组合哈希 `0be53ce819945b1dfb6e1dd34399cec31019e4205e085d991076b1314db0b7e5`：当前差异仅为 Argo 车辆规划与尺寸研究及 overview/requirements 对应说明；protocol.md、GPS、canonical record/plan 合同未变。已复核当前协议与差异文档，本轮无需 Kairos parser/schema 代码修改，原片及 Pharos 源目录保持只读。
