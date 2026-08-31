# Kairos Console UI Visual Review v2

- Status: `awaiting-user-review`
- Generated: 2026-08-31
- Format: 1672 × 941 PNG, 16:9 desktop
- Visual language: professional dark Ant Design 6, compact density, restrained copper-orange accent
- Implementation gate: React refactor remains blocked until these visual directions are approved

## Feedback addressed

1. The overview was reduced from a dense dashboard mosaic to three quiet zones: project next action, workflow line, and active jobs.
2. Every major subfunction now has an independent visual draft instead of being compressed into a single overview.
3. Chronology sample data was corrected to the actual “33 岁生日旅行” itinerary context while preserving its virtual-table and Drawer layout.
4. Image text and sample values remain visual references; implementation semantics must follow Kairos docs, routes, APIs, and project data.

## Assets

- 总览 v2: `02-shell-overview-v2.png`
- 导入与 GPS v1: `04-ingest-gps-v1.png`
- 达芬奇调色 v1: `05-color-v1.png`
- 素材分析 v1: `06-analyze-v1.png`
- 编年史 v2: `07-chronology-v2.png`
- 风格分析 v1: `08-style-v1.png`
- 剪辑流 v1: `09-edit-flow-v1.png`
- 时间线与导出 v1: `10-timeline-export-v1.png`
- 项目与服务 v1: `11-project-services-v1.png`

## Generation prompts

### 总览 v2

Output: `02-shell-overview-v2.png`

```text
Use case: ui-mockup
Asset type: high-fidelity desktop web-app screenshot for Kairos Console overview v2
Primary request: create a calm, elegant, low-complexity project overview for a local video post-production workstation; correct the previous version that felt too dense and card-heavy
Scene/backdrop: full-bleed 16:9 desktop viewport, no browser chrome, no device frame
Shell: narrow fixed dark sidebar about 200px, slim top bar, full-width main area; sidebar grouped by 工作台 / 素材准备 / 素材理解 / 创作 / 系统 with 总览 selected
Main composition: only three clear content zones: (1) a quiet page header for project "33岁生日旅行" with one focused "下一步" action, (2) one simple horizontal workflow line, (3) one restrained lower panel for active tasks; service health and Review count stay as small top-bar text, not cards
Style/medium: realistic shippable product UI inspired by Ant Design 6 compact mode; understated editorial elegance; not concept art
Layout: generous breathing room, strong alignment, thin borders, flat surfaces, very little shadow, no more than three major panels in the entire main area
Color palette: graphite black and charcoal, cool gray text, copper-orange used only for selected navigation and one primary action, green/red tiny status dots
Text (verbatim): "Kairos Console", "总览", "33岁生日旅行", "项目总览", "下一步", "运行 Ingest", "工作流", "导入", "分析", "编年史", "剪辑", "导出", "暂无活跃任务", "Supervisor 运行中", "ML 已停止", "0 条 Review"
Constraints: readable simplified Chinese; no metric-card grid; no storage card; no separate project card; no separate Review card; no fake charts; no oversized hero; no large empty decorative area; no logo; no watermark; practical desktop layout
Avoid: dashboard card mosaic, excessive labels, repeated statuses, gradients, glassmorphism, huge headings, marketing layout
```

### 导入与 GPS v1

Output: `04-ingest-gps-v1.png`

```text
Use case: ui-mockup
Asset type: high-fidelity desktop page for Kairos Console "导入与 GPS"
Primary request: design an elegant, task-focused ingest configuration page that replaces a 135-field eleven-thousand-pixel page with progressive disclosure
Scene/backdrop: full-bleed 16:9 desktop viewport with the same narrow dark Kairos sidebar and slim top bar as the approved shell
Navigation: "导入与 GPS" selected under "素材准备"
Page composition: compact header with job truth and two actions; directly below it, four tabs; main area split into a narrow Root list and one selected Root editor; only one Root editor is open; a slim sticky save bar stays visible
Top actions: primary "运行 Ingest", secondary "刷新 GPS 缓存", status "尚未运行"
Tabs (verbatim): "素材源", "行程与 GPS", "时间校正", "Review"; active tab "素材源"
Root list: "zve1", "a7r6", "drone", each with a small green "路径可读" status; "zve1" selected
Selected editor: clearly grouped fields "Root 代号", "当前素材路径", "原始素材路径", "备选路径", "拍摄时间规则"; use compact inputs and one small path summary, not a long form
Style/medium: realistic shippable Ant Design 6 dark compact interface, calm and precise
Color palette: graphite surfaces, copper-orange only for selected tab/Root and primary action, muted green for readable paths
Text (verbatim): "Kairos Console", "导入与 GPS", "尚未运行", "运行 Ingest", "刷新 GPS 缓存", "素材源", "行程与 GPS", "时间校正", "Review", "zve1", "a7r6", "drone", "路径可读", "Root 代号", "当前素材路径", "原始素材路径", "备选路径", "拍摄时间规则", "保存更改"
Constraints: readable simplified Chinese; do not show every root form at once; no giant instruction paragraphs; no more than two nested panel levels; no fake charts; no logo; no watermark
Avoid: long scrolling form, accordion wall, card mosaic, large empty hero, excessive pills, bright orange surfaces
```

### 达芬奇调色 v1

Output: `05-color-v1.png`

```text
Use case: ui-mockup
Asset type: high-fidelity desktop page for Kairos Console "达芬奇调色"
Primary request: design a clear operational Color workspace that preserves Kairos root truth and separates project actions, current-root actions, all-root configuration, Groups, and diagnostics
Scene/backdrop: full-bleed 16:9 desktop viewport with the same narrow dark Kairos sidebar and slim top bar
Navigation: "达芬奇调色" selected under "素材准备"
Page composition: compact page header; one slim project action row; one current-root hero with a five-step pipeline; below it a three-column all-root configuration grid where the editable preset controls for zve1, a7r6, and drone are simultaneously visible; a compact Groups table and a collapsed diagnostics row at the bottom
Project actions (verbatim): "Relink All Roots", "Prepare All Roots", "Export All Roots"
Current root: "zve1", status "Ready"; pipeline labels "Relink", "Prepare", "Sync Groups", "Execute", "Validate"
Root configuration cards: "zve1", "a7r6", "drone"; each visibly includes "格式", "编码", "码率", "音频" with compact controls; no root is hidden behind tabs or collapsed sections
Groups table: columns "Group", "状态", "片段"; only a few visible rows
Secondary controls: "覆盖最新", "归档快照"; diagnostics row "高级诊断与归档"
Style/medium: realistic shippable Ant Design 6 dark compact operations console, elegant rather than industrially cluttered
Color palette: graphite and charcoal, copper-orange selection/primary only, teal for ready state, amber for warnings
Text (verbatim): "Kairos Console", "达芬奇调色", "Relink All Roots", "Prepare All Roots", "Export All Roots", "当前 Root", "zve1", "a7r6", "drone", "Ready", "Relink", "Prepare", "Sync Groups", "Execute", "Validate", "所有 Root 配置", "格式", "编码", "码率", "音频", "Groups", "Group", "状态", "片段", "覆盖最新", "归档快照", "高级诊断与归档"
Constraints: all root editable controls must remain visibly present in the main page; readable labels; no oversized hero; no dense debug text; no fake charts; no logo; no watermark
Avoid: hiding roots in tabs, giant action button wall, overly colorful pipeline, glassmorphism, huge round cards
```

### 素材分析 v1

Output: `06-analyze-v1.png`

```text
Use case: ui-mockup
Asset type: high-fidelity desktop page for Kairos Console "素材分析"
Input images: the three most recent generated Kairos screens are style references only; inherit their graphite palette, thin borders, compact controls, restrained copper-orange, and narrow desktop sidebar; do not copy their page content
Primary request: design a calm operational monitor that clearly distinguishes a stopped live job from durable cached progress
Scene/backdrop: full-bleed 16:9 desktop viewport, same Kairos dark shell
Navigation: "素材分析" selected under "素材理解"
Page composition: compact header with one "启动 Analyze" action; one primary progress surface containing status, current stage, progress bar, current file and last update; below it one horizontal seven-stage overview; final lower row split between concise concurrency detail and completed outputs
Status semantics: show "已停止" and "缓存进度" together; do not imply a live job; show "15 / 2253" and "0.7%" as the durable example progress; service indicator "ML 已停止"
Current stage: "统一完成素材分析"; current file "day0/C0367.mp4"
Style/medium: realistic shippable Ant Design 6 dark compact monitor, quiet hierarchy, no dashboard mosaic
Text (verbatim): "Kairos Console", "素材分析", "已停止", "缓存进度", "启动 Analyze", "统一完成素材分析", "15 / 2253", "0.7%", "day0/C0367.mp4", "阶段总览", "准备", "粗扫", "音频", "统一分析", "预抽", "细扫", "完成", "并发详情", "完成产物", "ML 已停止"
Constraints: readable labels; live status and cached progress visually distinct; no more than four major surfaces; no giant card grid; no raw JSON; no logo; no watermark
Avoid: bright orange progress bar across the whole screen, fake charts, repeated metrics, huge title, overly technical debug wall
```

### 编年史 v2

Output: `07-chronology-v2.png`

```text
Use case: ui-mockup
Asset type: high-fidelity desktop page for Kairos Console "编年史"
Input images: the three most recent generated Kairos screens are style references only; inherit their graphite palette, thin borders, compact controls, restrained copper-orange, and narrow desktop sidebar
Primary request: design an elegant high-volume Chronology V2 review interface that handles 250 events without mounting thousands of form controls
Scene/backdrop: full-bleed 16:9 desktop viewport, same Kairos dark shell
Navigation: "编年史" selected under "素材理解"
Page composition: compact page header; one slim generation/action bar; a fixed-height virtual table occupying the main center-left area with only about eight visible rows; a single event-edit Drawer open on the right; filters stay in a sticky toolbar above the table
Generation actions (verbatim): "生成候选素材片段与模式", "生成/刷新编年史", "刷新时空真相"
Toolbar: "全部日期", "全部类型", "全部状态", search input "搜索标题或地点", selection action "合并", primary action "确认全部"
Table columns: "时间", "类型", "标题", "地点", "状态", "Spans"; show compact event/route/gap rows, selection checkboxes, and status dots
Drawer: title "编辑事件"; fields "标题", "摘要", "开始时间", "结束时间", "地点", "路线"; actions "保存", "确认", "驳回", "拆分"
Style/medium: realistic shippable Ant Design 6 dark compact data workspace, virtualized table with fixed viewport, clean and highly legible
Text (verbatim): "Kairos Console", "编年史", "250 events", "生成候选素材片段与模式", "生成/刷新编年史", "刷新时空真相", "全部日期", "全部类型", "全部状态", "搜索标题或地点", "合并", "确认全部", "时间", "类型", "标题", "地点", "状态", "Spans", "编辑事件", "摘要", "开始时间", "结束时间", "路线", "保存", "确认", "驳回", "拆分"
Constraints: only the Drawer contains editable inputs; table rows are summaries, not forms; right Drawer about 360px; readable text; no full-page scrolling list; no logo; no watermark
Avoid: one card per event, textarea in every row, huge generation panel, dense paragraphs, excessive status pills

Correction pass:
Precise UI mockup edit. Preserve the source image's entire 16:9 composition, dark Ant Design 6 visual style, narrow sidebar, copper-orange accent, toolbar, virtualized table geometry, right-side event editor Drawer, spacing, typography hierarchy, borders, buttons, icons, and all control positions. Change ONLY the example business data inside the chronology table and the selected event Drawer. Remove every Italy, Florence, Vinci, Renaissance, and 1989 reference.

Use these eight Chinese table rows, in this order:
1. 2026-08-19 13:08 | 事件 | 行前准备与出发记录 | 深圳宝安西乡 | 已确认
2. 2026-08-19 16:44 | 路线 | 深圳宝安至黄村服务区 | 深圳 → 河源 | 已确认
3. 2026-08-19 23:43 | 事件 | 麻布岗服务区检查胎压 | 麻布岗服务区 | 已确认
4. 2026-08-19 23:55 | 路线 | 夜间前往野猪嶂 | 麻布岗 → 野猪嶂 | 已确认
5. 2026-08-20 02:05 | 事件 | 银河星空转日出 | 野猪嶂山顶 | 待确认
6. 2026-08-20 07:25 | 事件 | 山顶生日蛋糕与航拍 | 野猪嶂山顶 | 待确认
7. 2026-08-20 09:34 | 路线 | 野猪嶂下山 | 野猪嶂 → 山下道路 | 已确认
8. 2026-08-20 12:36 | 事件 | 天九镇修车 | 天九镇 | 待确认

Make row 6 selected. In the right Drawer use:
标题：山顶生日蛋糕与航拍
摘要：云海遗憾后天气放晴，在山顶吃33岁生日蛋糕并航拍
开始：2026-08-20 07:25
结束：2026-08-20 09:25
地点：野猪嶂山顶
状态：待确认

Keep all other existing Chinese interface labels unchanged. Do not add logos, watermarks, fake charts, maps, or extra panels. Output one polished desktop UI mockup only.
```

### 风格分析 v1

Output: `08-style-v1.png`

```text
Use case: ui-mockup
Asset type: high-fidelity desktop page for Kairos Console "风格分析"
Input images: the three most recent generated Kairos screens are style references only; inherit their graphite palette, thin borders, compact controls, restrained copper-orange, and narrow desktop sidebar
Primary request: design a Workspace-scoped style-library and single-category monitor that never mixes project state or another category's progress
Scene/backdrop: full-bleed 16:9 desktop viewport, same Kairos dark shell
Navigation: "风格分析" selected under "创作"
Top scope: replace project selector with a clear "Workspace 风格库" scope chip
Page composition: compact header with category name and one "分析当前风格" action; main split layout with a narrow category list on the left and the selected category monitor on the right; below the monitor, one concise source configuration section for the selected category only
Selected category: "国内长途自驾纪录片正片"; status "等待 Agent"; source count "1 个来源"
Monitor: one progress surface, one nine-stage compact step strip, one small current-stage detail and outputs list
Category list may show several names but only one selected; do not display configuration for all categories at once
Style/medium: realistic shippable Ant Design 6 dark compact Workspace tool, calm and editorial
Text (verbatim): "Kairos Console", "风格分析", "Workspace 风格库", "国内长途自驾纪录片正片", "等待 Agent", "1 个来源", "分析当前风格", "分类", "阶段总览", "当前阶段", "完成产物", "来源配置", "保存"
Constraints: exactly one active category truth in the main view; no project progress; readable Chinese; no more than four major surfaces; no logo; no watermark
Avoid: category card grid, all category forms at once, duplicate monitor headers, fake charts, large empty hero
```

### 剪辑流 v1

Output: `09-edit-flow-v1.png`

```text
Use case: ui-mockup
Asset type: high-fidelity desktop page for Kairos Console "剪辑流"
Input images: the three most recent generated Kairos screens are style references only; inherit their graphite palette, thin borders, compact controls, restrained copper-orange, and narrow desktop sidebar
Primary request: design a calm Edit Flow command center that puts readiness, Edit initialization, Resolve maintenance, and a readable Flow Plan above giant step cards
Scene/backdrop: full-bleed 16:9 desktop viewport, same Kairos dark shell
Navigation: "剪辑流" selected under "创作"
Page composition: compact header; one thin readiness strip; upper two-column area with "Edit 初始化" on the left and "Resolve 工程维护" on the right; lower main split layout with a compact nine-step Flow Plan list on the left and details for only the selected/current step on the right
Readiness strip: "Edit Unit 已保存", "Spans Fresh", "Chronology 已确认", "Flow Plan Stale"
Edit initialization fields: "Edit ID", "剪辑规则", "风格档案"; action "保存 Edit 初始化"
Resolve maintenance actions: "安装/更新插件与效果", "重链素材路径", "覆盖最新", "归档快照"
Flow list: numbered concise rows with status dots; selected row "生成剪辑框架 handoff"; other visible rows include "召回素材", "同步 Resolve", "生成粗剪", "人工锁定", "字幕与旁白"
Selected detail: show small sections "状态", "输入", "输出", "运行记录"; do not dump long notes
Style/medium: realistic shippable Ant Design 6 dark compact workflow console, readable editorial hierarchy
Text (verbatim): "Kairos Console", "剪辑流", "Edit Unit 已保存", "Spans Fresh", "Chronology 已确认", "Flow Plan Stale", "Edit 初始化", "Edit ID", "剪辑规则", "风格档案", "保存 Edit 初始化", "Resolve 工程维护", "安装/更新插件与效果", "重链素材路径", "覆盖最新", "归档快照", "Flow Plan", "生成剪辑框架 handoff", "召回素材", "同步 Resolve", "生成粗剪", "人工锁定", "字幕与旁白", "状态", "输入", "输出", "运行记录"
Constraints: no one-card-per-step wall; only one step detail expanded; readable Chinese; no more than five major surfaces; no logo; no watermark
Avoid: nine giant cards, long paragraphs, raw JSON, huge status pills, bright orange background blocks
```

### 时间线与导出 v1

Output: `10-timeline-export-v1.png`

```text
Use case: ui-mockup
Asset type: high-fidelity desktop page for Kairos Console "时间线与导出"
Input images: the three most recent generated Kairos screens are style references only; inherit their graphite palette, thin borders, compact controls, restrained copper-orange, and narrow desktop sidebar
Primary request: design an honest capability-and-blocker page for timeline/export without inventing new runners or pretending blocked actions are executable
Scene/backdrop: full-bleed 16:9 desktop viewport, same Kairos dark shell
Navigation: "时间线与导出" selected under "创作"
Page composition: quiet page header; one readiness summary line; main two-column capability list for "时间线" and "导出目标"; one lower blocker panel with clear links back to prerequisites; no empty marketing hero
Capability rows: "timeline.generate", "export-jianying", "export-resolve"; show execution modes "deterministic" or "agent" and status "Blocked" using subdued red/amber, not primary buttons
Readiness: "当前尚未满足导出条件"
Blocker panel: concise items "Chronology 未确认", "粗剪时间线未锁定", "Resolve 工程未就绪"; navigation actions "返回编年史", "返回剪辑流", "查看项目诊断"
Style/medium: realistic shippable Ant Design 6 dark compact capability surface, minimal and elegant
Text (verbatim): "Kairos Console", "时间线与导出", "当前尚未满足导出条件", "当前能力", "时间线", "导出目标", "timeline.generate", "export-jianying", "export-resolve", "deterministic", "agent", "Blocked", "前置条件", "Chronology 未确认", "粗剪时间线未锁定", "Resolve 工程未就绪", "返回编年史", "返回剪辑流", "查看项目诊断"
Constraints: no run/export primary button when blocked; no invented timeline editor; no fake charts; readable labels; no more than four major surfaces; no logo; no watermark
Avoid: celebratory empty state, disabled-button wall, large decorative illustration, fake render queue, bright red panels
```

### 项目与服务 v1

Output: `11-project-services-v1.png`

```text
Use case: ui-mockup
Asset type: high-fidelity desktop page for Kairos Console "项目与服务"
Input images: the three most recent generated Kairos screens are style references only; inherit their graphite palette, thin borders, compact controls, restrained copper-orange, and narrow desktop sidebar
Primary request: design an elegant project diagnostics page combining project identity, service truth, ML controls, and Review Queue without looking like a settings dump
Scene/backdrop: full-bleed 16:9 desktop viewport, same Kairos dark shell
Navigation: "项目与服务" selected under "系统"
Page composition: compact project header for "33岁生日旅行"; two tabs "服务" and "Review", active "服务"; main left area is a simple service table with one row for Supervisor and one for ML; right narrow project summary; lower concise Review Queue empty state
Service table columns: "服务", "状态", "地址", "PID", "操作"; Supervisor row "运行中"; ML row "已停止"; ML controls "启动 ML", "重启 ML", "停止 ML" shown in the operation cell with only start emphasized
Project summary: "Project ID", "thirty-third-birthday-trip", "项目路径", "Pharos 已接入"
Review section: "Review Queue", "0 条", "当前没有待处理 Review"
Style/medium: realistic shippable Ant Design 6 dark compact diagnostics workspace, calm and legible
Text (verbatim): "Kairos Console", "项目与服务", "33岁生日旅行", "服务", "Review", "服务", "状态", "地址", "PID", "操作", "Supervisor", "ML", "运行中", "已停止", "启动 ML", "重启 ML", "停止 ML", "项目摘要", "Project ID", "thirty-third-birthday-trip", "项目路径", "Pharos 已接入", "Review Queue", "0 条", "当前没有待处理 Review"
Constraints: service truth is table-based, not giant cards; no fake charts; only one prominent action; readable labels; no more than four major surfaces; no logo; no watermark
Avoid: settings form wall, many colored status cards, huge project title, destructive actions emphasized, decorative illustration
```
