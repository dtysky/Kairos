---
name: kairos-export-resolve
description: >-
  Export a Kairos KTEP timeline to DaVinci Resolve using an externally configured
  Resolve MCP server. Use when the user wants a Resolve timeline from the same
  KTEP document or asks for DaVinci/Resolve export.
---

# Kairos: Export To Resolve

将 `timeline/current.json` 导出到 DaVinci Resolve。

## 前置条件

- `timeline/current.json` 存在且通过 KTEP 校验
- 宿主环境已配置外部 `Resolve` / `DaVinci` MCP server
- 目标机器上可访问时间线引用的素材路径
- Resolve 端具备对应脚本或 MCP 能力

## 输入

- `timeline/current.json`
- 可选导出参数：
  - 项目名称
  - 时间线名称
  - 是否创建字幕轨
  - 是否仅导出中间格式（如 `SRT`）

## 执行原则

- 复用 `KTEP` 作为唯一交换协议
- 在 skill 层编排 Resolve 导出，不把宿主相关 MCP bridge 写回 `Kairos Core`
- 若当前仓库的 Resolve 落地能力尚未实现，应明确报告缺失点，而不是假装成功

## 建议流程

1. 读取并校验 `timeline/current.json`
2. 检查 Resolve MCP 是否已连接
3. 创建或选择 Resolve 项目与时间线
4. 导入素材并按 `KTEP` 片段摆放
5. 视目标环境决定是否创建字幕轨或导出 `SRT`
6. 返回 Resolve 项目 / 时间线信息和日志

## 推荐产出

- Resolve 项目名
- 时间线名
- 如有需要，`subtitles/output.srt`
- 导出日志与失败诊断

## 失败时优先检查

- Resolve MCP 是否已配置
- 目标素材路径是否可访问
- 当前宿主是否真的具备 Resolve 自动化能力

## 说明

- 这个 skill 是 Phase 5 的 Resolve 目标实现
- 如果当前设备尚未配置 Resolve MCP，本 skill 应明确指出阻塞条件
