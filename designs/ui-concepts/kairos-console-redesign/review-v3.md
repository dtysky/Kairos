# Kairos Console UI Visual Review v3

- Status: `approved-and-implemented`
- Generated: 2026-08-31
- Tool: built-in GPT Image / imagegen
- Scope: global Shell alignment only
- Implementation gate: approved; React refactor implemented and browser-verified on 2026-09-01

## Feedback addressed

The v2 concepts used different sidebar widths, labels, groups, indentation, row heights, and selected-item positions. The v3 pass establishes one canonical global navigation and applies it to the overview and every subfunction.

Canonical order:

1. 工作台
   - 总览
2. 素材准备
   - 导入与 GPS
   - 达芬奇调色
3. 素材理解
   - 素材分析
   - 编年史
4. 创作
   - 风格分析
   - 剪辑流
   - 时间线与导出
5. 系统
   - 项目

All pages now use the same group order, icon column, text column, row rhythm, restrained copper-orange selected treatment, and a single selected item. The main content of each page remains based on its previously reviewed concept.

## Assets

- Overview: `02-shell-overview-v3.png`
- Ingest / GPS: `04-ingest-gps-v2.png`
- Color: `05-color-v2.png`
- Analyze: `06-analyze-v3.png`
- Chronology: `07-chronology-v3.png`
- Style: `08-style-v2.png`
- Edit Flow: `09-edit-flow-v2.png`
- Timeline / Export: `10-timeline-export-v2.png`
- Project / Services: `11-project-services-v2.png`

## Canonical Shell prompt

```text
Use case: precise-object-edit
Asset type: Kairos Console global Shell canonical sidebar reference
Primary request: replace only the left navigation sidebar with one canonical, perfectly aligned navigation system. Keep all page content outside the sidebar unchanged.
Canonical labels and order: 工作台 / 总览; 素材准备 / 导入与 GPS / 达芬奇调色; 素材理解 / 素材分析 / 编年史; 创作 / 风格分析 / 剪辑流 / 时间线与导出; 系统 / 项目.
Geometry: one fixed sidebar width; one brand position; one group-heading column; one icon column; one text column; equal row heights; equal group spacing; no nested menus, chevrons, or extra entries.
Selection: use a subtle copper-brown selected row and copper-orange icon/text. Exactly one item is selected.
Constraints: professional graphite Ant Design 6 dark compact style; exact simplified Chinese; no watermark; no logo change; no extra panels.
```

## Per-page compositing prompt

```text
Use case: compositing
Input images: Image 1 is the canonical Shell and owns the complete sidebar and top-bar boundary. Image 2 supplies only the subfunction page content.
Primary request: keep Image 1's sidebar system and place Image 2's complete page content to its right without redesigning it.
Selected item: use the current subfunction route only; remove the selected state from 总览.
Invariants: keep the canonical labels and order exactly; every label appears once; no alternative or extra sidebar entries; do not import overview content; preserve the subfunction's data, actions, fields, tables, and page hierarchy.
```

Per-page selected item mapping:

- `/` → 总览
- `/ingest-gps` → 导入与 GPS
- `/color` → 达芬奇调色
- `/analyze` → 素材分析
- `/chronology` → 编年史
- `/style` → 风格分析
- `/edit` → 剪辑流
- `/timeline-export` → 时间线与导出
- `/project` → 项目

The Analyze page received one additional targeted Shell pass after visual QA because its first v3 candidate had a one-pixel canvas discrepancy and a visibly narrower sidebar.
