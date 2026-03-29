---
name: kairos-export-jianying
description: >-
  Export a Kairos KTEP timeline to Jianying using an externally configured
  Jianying MCP server, and optionally emit SRT/VTT subtitles. Use when the user
  wants a Jianying draft, a Jianying smoke test, or subtitles from the final timeline.
---

# Kairos: Export To Jianying

将 `timeline/current.json` 导出到剪映。

## 前置条件

- `timeline/current.json` 存在且通过 KTEP 校验
- 宿主环境已配置名为 `jianying` 的外部 MCP server
- 剪映已安装在目标机器上
- 目标机器可以访问时间线中引用的素材路径

## 输入

- `timeline/current.json`
- 可选导出参数：
  - 草稿名称
  - 字幕位置
  - 字幕大小
  - 是否同时导出 `SRT / VTT`

## 执行原则

- 在 skill 层编排导出，不把宿主相关 MCP bridge 写回 `Kairos Core`
- 优先直接使用宿主提供的 `jianying` MCP 工具
- 允许复用仓库中的 `KTEP` 校验和字幕导出逻辑

## 建议流程

1. 读取并校验 `timeline/current.json`
2. 用时间线中的项目名或用户指定名称创建剪映草稿
3. 按 `KTEP` 轨道创建剪映轨道
4. 按 `KTEP` 片段摆放视频 / 图片 / 音频素材
5. 按 `KTEP` 字幕创建文本轨或同时导出 `SRT / VTT`
6. 导出草稿并返回草稿路径

## 推荐产出

- 剪映草稿路径
- `subtitles/output.srt`
- `subtitles/output.vtt`
- 导出日志与失败诊断

## 失败时优先检查

- `jianying` MCP 是否可用
- 素材路径是否是目标机器可访问的 Windows 路径
- `SAVE_PATH` / `OUTPUT_PATH` 是否存在
- 剪映草稿目录是否可写

## 说明

- `vendor/jianying-mcp` 可以继续保留在仓库内
- 但它应被宿主环境作为外部 MCP server 使用
- 这个 skill 是 Phase 5 的剪映目标实现
