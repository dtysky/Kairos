# Kairos Console Redesign — Visual Gate v1

Status: `awaiting-user-review`

Generator: Codex built-in `image_gen`

Generated assets:

- `01-design-system-v1.png` — dark design-system board
- `02-shell-overview-v1.png` — global shell and overview
- `03-master-workflow-v1.png` — first workflow draft; retained for version history
- `03-master-workflow-v2.png` — corrected workflow; `Speech Review` and `人工确认` are inline gates

The raster images are visual and information-architecture references only. Kairos docs, APIs, schemas, and runtime truth remain authoritative. React implementation must not start until these gate assets are approved.

## Prompt: Design System v1

```text
Use case: ui-mockup
Asset type: high-fidelity desktop admin design-system board for the Kairos video post-production console
Primary request: create a shippable professional dark UI system board inspired by Ant Design 6 interaction density, showing the reusable visual language before implementation
Scene/backdrop: full-bleed 16:9 landscape canvas, near-black graphite background, no device frame
Subject: a disciplined grid containing a compact left navigation sample, top project bar, typography scale, restrained color swatches, status badges, buttons, text input, select, tabs, cards, a dense editable table row, progress indicator, alert, and a small drawer example
Style/medium: realistic product UI screenshot, clean enterprise workstation interface, not concept art, not a marketing slide
Composition/framing: generous but efficient spacing, 8px rhythm, compact 32px controls, subtle 1px borders, almost no shadow, clear hierarchy
Color palette: #0C1015 base, #121820 panels, #18212B raised surfaces, #29323D borders, #EDF2F7 primary text, #98A5B3 secondary text, copper-orange #E4773D used sparingly for selection and primary actions, muted green/amber/red/blue semantic states
Text (verbatim): "Kairos Console", "设计系统", "总览", "导入与 GPS", "素材分析", "编年史", "剪辑流", "运行中", "已完成", "已阻塞", "待审查", "运行 Ingest", "刷新 GPS 缓存", "保存"
Constraints: simplified Chinese labels must be readable and rendered exactly; no lorem ipsum; no fake charts; no brand logo; no watermark; no glossy gradients; no oversized rounded cards; copper-orange must occupy less than 10% of the canvas; practical components that can be reproduced with Ant Design 6
Avoid: neon cyberpunk, glassmorphism, 3D perspective, device mockup, decorative illustration, excessive whitespace
```

## Prompt: Shell / Overview v1

```text
Use case: ui-mockup
Asset type: high-fidelity desktop web-app screenshot for the Kairos Console overview and global shell
Primary request: redesign the Kairos local video post-production console as a professional dark desktop workstation that makes workflow status and the next useful destination obvious
Scene/backdrop: full-bleed 16:9 desktop viewport, no browser chrome, no device frame
Subject: fixed compact left sidebar about 220px wide, slim top bar with project selector and service health, dense main dashboard with project health summary, live task area, review count, and a horizontal workflow status rail; no duplicated navigation card grid
Style/medium: realistic shippable enterprise product UI inspired by Ant Design 6 compact mode, not concept art
Composition/framing: left sidebar grouped by workflow phase; top bar stays low-height; main content uses the full desktop width with a balanced 12-column grid; primary information visible above the fold
Color palette: deep graphite surfaces, restrained copper-orange active state, cool gray text, green/amber/red semantic status accents
Text (verbatim): "Kairos Console", "工作台", "总览", "素材准备", "导入与 GPS", "达芬奇调色", "素材理解", "素材分析", "编年史", "创作", "风格分析", "剪辑流", "时间线与导出", "系统", "项目与服务", "33岁生日旅行", "Supervisor 运行中", "ML 已停止", "0 条 Review", "项目总览", "工作流状态", "Ingest", "Analyze", "Chronology", "Edit", "Export", "暂无活跃任务"
Constraints: simplified Chinese labels must be readable and rendered exactly; selected route is "总览"; show professional moderate density; no large empty hero; no fake analytics charts; no stock images; no brand logo; no watermark; no glassmorphism; use copper-orange only for the selected navigation item and the primary next action
Avoid: top horizontal navigation, repeated route cards, huge title typography, excessive pills, excessive shadows, marketing landing-page layout
```

## Prompt: Master Workflow v1

```text
Use case: infographic-diagram
Asset type: Kairos master workflow diagram for product and engineering review
Primary request: create a precise dark 16:9 horizontal workflow diagram showing the official Kairos console journey, its optional Color branch, Workspace Style input, and human/Resolve gates
Scene/backdrop: clean near-black graphite canvas with subtle grid, no device frame
Subject: one strong left-to-right main flow with six large nodes and three clearly separated supporting branches; use thin orthogonal arrows, small gate diamonds, and distinct semantic colors
Style/medium: polished vector-like systems diagram, enterprise product architecture visual, readable at presentation size
Composition/framing: centered horizontal main flow; optional Color branch directly below material preparation; Workspace Style branch above Edit; Speech Review and human confirmation shown as gates around Chronology; Resolve shown as a gate between Edit and export
Text (verbatim): "Kairos 主流程", "主线", "项目配置", "导入与 GPS", "素材分析", "编年史", "剪辑流", "时间线与导出", "可选增强", "达芬奇调色", "Workspace 输入", "风格分析", "Speech Review", "人工确认", "Resolve"
Relationships: main flow is 项目配置 → 导入与 GPS → 素材分析 → 编年史 → 剪辑流 → 时间线与导出; 达芬奇调色 is a dashed optional enhancement branch under 导入与 GPS that rejoins before 素材分析; 风格分析 is a Workspace-level input feeding 剪辑流; Speech Review and 人工确认 are explicit gates associated with 编年史; Resolve is an explicit gate between 剪辑流 and 时间线与导出
Color palette: graphite background, cool-gray main nodes, copper-orange main-flow accents, teal optional branch, violet Workspace branch, amber human gates
Constraints: all labels must be readable and rendered exactly; no extra nodes; no lorem ipsum; no paragraphs; no logo; no watermark; strong alignment; generous whitespace; arrows must not cross
Avoid: circular flow, decorative icons, 3D blocks, glossy gradients, tiny text, busy background
```

## Prompt: Master Workflow v2 correction

```text
Use case: precise-object-edit
Asset type: corrected Kairos master workflow diagram
Input images: Image 1: edit target, the previously generated dark Kairos workflow diagram
Primary request: correct only the central workflow routing so Speech Review and 人工确认 are mandatory inline gates, not a dead-end branch
Required main flow (verbatim and exact): "项目配置" → "导入与 GPS" → "素材分析" → "编年史" → "Speech Review" → "人工确认" → "剪辑流" → "Resolve" → "时间线与导出"
Required branches: keep "达芬奇调色" as the dashed teal "可选增强" branch from "导入与 GPS" that rejoins before "素材分析"; keep "风格分析" as the violet "Workspace 输入" branch feeding "剪辑流"
Composition: keep the same 16:9 dark graphite systems-diagram visual, but place the Speech Review and 人工确认 diamonds directly in the main orange path between 编年史 and 剪辑流; resize and redistribute nodes to fit cleanly; arrows must be continuous and must not cross
Text (verbatim): "Kairos 主流程", "主线", "项目配置", "导入与 GPS", "素材分析", "编年史", "Speech Review", "人工确认", "剪辑流", "Resolve", "时间线与导出", "可选增强", "达芬奇调色", "Workspace 输入", "风格分析"
Constraints: change only the flow routing and node placement required for correctness; preserve palette, typography, dark grid background, border treatment, and branch colors; all labels readable and exact; no extra nodes; no watermark
Avoid: any disconnected gate, any dead-end branch, crossed arrows, tiny text
```

## Review checklist

- Sidebar width and grouping
- Overall density and above-the-fold hierarchy
- Copper-orange usage level
- Panel contrast, borders, and typography
- Main workflow semantics and gate placement
