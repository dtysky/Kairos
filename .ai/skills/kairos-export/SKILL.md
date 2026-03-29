---
name: kairos-export
description: >-
  Phase 5: Export router for Kairos. Chooses the target NLE export skill from
  the same KTEP timeline, such as Jianying or DaVinci Resolve. Use when the user
  mentions export, render to NLE, Jianying, Resolve, or final delivery target.
---

# Kairos: Phase 5 — Export Router

本 skill 不直接执行某个 NLE 的导出，而是负责根据目标环境选择子 skill。

核心原则：

- `Kairos Core` 只产出 `KTEP`
- 导出到剪映 / 达芬奇由上层 skill 编排
- 外部 MCP 的宿主配置属于 skill 运行环境，不属于 Core 模块
- 同一个 `timeline/current.json` 可以面向不同 NLE 重复导出

## 路由规则

### 目标是剪映

使用子 skill：
- [kairos-export-jianying](../kairos-export-jianying/SKILL.md)

适用场景：
- 用户明确说“导出到剪映”
- 当前宿主已配置 `jianying` MCP server
- 需要生成剪映草稿、SRT、VTT

### 目标是达芬奇 / Resolve

使用子 skill：
- [kairos-export-resolve](../kairos-export-resolve/SKILL.md)

适用场景：
- 用户明确说“导出到达芬奇 / Resolve”
- 当前宿主已配置对应的 Resolve MCP server
- 需要在 Resolve 中创建时间线或导入 KTEP 素材编排

### 目标未指定

先确认导出目标：
- `jianying`
- `resolve`
- 仅导出字幕文件

## 统一前置条件

- `timeline/current.json` 存在且通过 KTEP 校验
- 宿主环境中已配置对应的外部 MCP server
- 目标机器上已安装对应的 NLE（若该 NLE 必需）

## 编排建议

`kairos-workflow` 在 Phase 5 应这样调用：

1. 读取 `timeline/current.json`
2. 判断目标 NLE
3. 跳转到对应导出 skill
4. 汇总草稿路径、字幕路径和错误日志

## 注意事项

- 不要把宿主环境的 MCP bridge 逻辑塞回 `src/modules/nle`
- 导出 skill 可以复用 `KTEP`，但不应该反向污染 `timeline-core`
- 若目标 NLE 的 MCP 未配置，应在本阶段明确报缺失，而不是回退去改 Core
