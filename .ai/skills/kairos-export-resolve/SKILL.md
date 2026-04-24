---
name: kairos-export-resolve
description: >-
  Export a Kairos KTEP timeline to DaVinci Resolve using the same-machine
  vendored Resolve backend when available. Use when the user wants a
  Resolve timeline from the same KTEP document or asks for DaVinci/Resolve export.
---

# Kairos: Export To Resolve

将 `timeline/current.json` 导出到 DaVinci Resolve。

## 变更工作流规则

只要本轮任务涉及需求、行为、接口、工作流、正式入口或用户路径变更，必须遵守下面顺序：

1. 先进入 `Plan` 模式；如果宿主没有显式 `Plan mode`，先给出结构化计划并得到确认。
2. 计划确认后，先更新相关设计文档，再开始实现。
3. 实现完成后，必须回查并同步受影响的设计文档、rules 和 skills，再结束本轮。
4. 如果变更影响正式入口、监控页、工作流主路径或用户操作方式，还要同步更新 `README.md`、`designs/current-solution-summary.md` 和 `designs/architecture.md`。

## 前置条件

- 如果本轮涉及任何 DaVinci Resolve scripting API、Resolve export、DRX/DRT、LUT、render job、Group、node graph 或 vendored Resolve host 行为，先读 `.ai/knowledge/davinci-resolve-scripting.md`，再按安装版 Resolve `README.txt` 校验版本敏感方法。
- `timeline/current.json` 存在且通过 KTEP 校验
- 宿主环境已具备同机 vendored Resolve backend 条件
  - `vendor/resolve-color-host/.venv` 可调用
  - Resolve Studio
  - 可访问默认 Resolve Scripting API 位置
  - 如本轮 Resolve 操作依赖 workspace-managed LUT，`config/color-transform-presets.json` 的 `profile -> { deviceFamily/default -> Resolve LUT path }` 映射，以及 `config/luts/` 中可选的同路径 `.cube` 文件已按当前 root 需求准备好
- 目标机器上可访问时间线引用的素材路径
- Resolve 端具备对应脚本 / Scripting API 能力

## 输入

- `timeline/current.json`
- 可选导出参数：
  - 项目名称
  - 时间线名称
  - 是否创建字幕轨
  - 是否仅导出中间格式（如 `SRT`）

## 执行原则

- 复用 `KTEP` 作为唯一交换协议
- 在 skill 层编排 Resolve 导出，不把宿主相关 bridge 细节写回 `Kairos Core`
- 若当前仓库的 Resolve 落地能力尚未实现，应明确报告缺失点，而不是假装成功

## 强规则：本地导出路径安全

- 如果本阶段会写本地字幕文件、AAF/XML、中间包或其他落地文件，必须先解析出最终输出路径。
- 只要最终路径已存在，就阻塞并让用户改用新的目录名或文件名；禁止覆盖、删除、清空旧输出。
- 如果用户只给了一个导出根目录，不能直接把根目录当成单个导出目标；必须生成新的具体子路径。

## 强规则：修改已有工程前先核对目标

- 如果任务是修改已有 Resolve 项目 / 时间线，而不是新建导出，必须先核对目标项目名、时间线名和宿主侧可见标识。
- 如果存在多个同名或近似候选，必须停下让用户确认，不能默认操作“最新的那个”。

## 建议流程

1. 读取并校验 `timeline/current.json`
2. 检查 vendored Resolve backend 是否已就绪并可调用
3. 若本轮会依赖默认技术 LUT，先确认 workspace LUT 资产与当前设备 Resolve 默认 LUT 目录同步状态
4. 创建或选择 Resolve 项目与时间线
  - Color 路径默认使用 `${projectBrief.name} [Color]`
  - root grading timeline 默认使用 root `label` 派生的人类可读命名
5. 导入素材并按 `KTEP` 片段摆放
6. 视目标环境决定是否创建字幕轨或导出 `SRT`
7. 返回 Resolve 项目 / 时间线信息和日志

## 推荐产出

- Resolve 项目名
- 时间线名
- 如有需要，`subtitles/output.srt`
- 导出日志与失败诊断

## 失败时优先检查

- vendored Resolve backend 是否已就绪
- workspace `config/luts/` 与 Resolve 默认 LUT 目录是否已完成缺失补齐
- 目标素材路径是否可访问
- 当前宿主是否真的具备 Resolve 自动化能力

## 说明

- 这个 skill 是 Phase 5 的 Resolve 目标实现
- 如果当前设备尚未准备好 vendored Resolve backend，本 skill 应明确指出阻塞条件
