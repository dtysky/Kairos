# 2026-04-05 Supervisor、Console 与 Project Workspace

## Summary

- Kairos 新增统一 `Supervisor`，作为本地运行时与任务编排入口。
- 新增 `Project Workspace` 配置工作台，统一维护：
  - `project-brief`
  - `manual-itinerary`
  - `script-brief`
  - `style-sources`
  - `review-queue`
- `Markdown` 保留为项目内可读产物，但正式 UI 编辑入口改为结构化 JSON 配置。
- `style-analysis` 与 `script` 继续被建模为 `agent-backed jobs`；UI 不替代高智能生成，只负责配置、审批、监控与结果承载。

## Runtime

- 新入口：
  - `node dist/supervisor/cli.js <action>`
  - `scripts/kairos-supervisor.ps1`
  - `scripts/kairos-supervisor.sh`
- 运行态落在：
  - `.tmp/run/supervisor/services/*`
  - `.tmp/run/supervisor/jobs/*`
- 当前受支持的可执行 job：
  - `project-init`
  - `ingest`
  - `gps-refresh`
  - `analyze`
  - `script`
- 当前已建模但 runner 仍返回明确 blocker 的 job：
  - `style-analysis`
  - `timeline`
  - `export-jianying`
  - `export-resolve`

## Config Workspace

- 新结构化配置：
  - `projects/<projectId>/config/project-brief.json`
  - `projects/<projectId>/config/manual-itinerary.json`
  - `projects/<projectId>/script/script-brief.json`
  - `projects/<projectId>/config/style-sources.json`
  - `projects/<projectId>/config/review-queue.json`
- UI 保存时会同步派生产物：
  - `config/project-brief.md`
  - `config/manual-itinerary.md`
  - `script/script-brief.md`
  - `config/styles/catalog.json`
  - 已存在 style profile 的 front-matter

## Review Queue

- `素材时间校正` 已从纯 Markdown 末尾表升级为：
  - `manual-itinerary.json.captureTimeOverrides`
  - `review-queue.json` 中的 `capture-time-correction`
  - 继续同步渲染回 `manual-itinerary.md`
- 旧项目在首次通过 Supervisor API 读取 review 时，会自动把现有的 capture-time overrides 同步进 `review-queue.json`。

## Console

- 新控制台位于 `apps/kairos-console/`，使用：
  - `react@16`
  - `hana-ui`
  - `vite`
- 顶层信息架构已从“单页工作台”改为“工作流优先路由”：
  - `/` `总览`
  - `/ingest-gps`
  - `/analyze`
  - `/style`
  - `/script`
  - `/timeline-export`
  - `/project`
- 顶部导航采用 `hana-ui Menu + MenuItem` 作为横向 tab 风格导航；不再把所有配置和监控堆在一页里。
- 配置页归属固定为：
  - `project-brief`、`manual-itinerary`、`capture-time overrides` -> `导入与 GPS`
  - `style-sources` -> `风格分析`
  - `script-brief` -> `脚本`
  - 全量 `review queue` -> `项目`
- 监控页已迁成专属路由，不再继续使用旧静态 HTML：
  - `/analyze/monitor`
  - `/style/monitor/:categoryId?`
- 监控页保持旧版监控页的信息层级：
  - intro header
  - hero progress monitor
  - `流程步骤`
  - `完成产物`
  - `原始进度数据`
- 为监控页新增 Supervisor 聚合接口：
  - `GET /api/projects/:projectId/monitor/analyze`
  - `GET /api/projects/:projectId/monitor/style-analysis`
- Supervisor 的 `GET /api/status` 现在会附带 job 的 `progress` 快照，便于总览页直接消费。
- 静态资源默认由 Supervisor 在 `127.0.0.1:8940` 统一服务。
