---
name: kairos-export
description: >-
  Phase 5: Export router for Kairos. Chooses the target NLE export skill from
  the same KTEP timeline, such as Jianying or DaVinci Resolve. Use when the user
  mentions export, render to NLE, Jianying, Resolve, or final delivery target.
---

# Kairos: Phase 5 — Export Router

本 skill 不直接执行某个 NLE 的导出，而是负责根据目标环境选择子 skill。

## 变更工作流规则

只要本轮任务涉及需求、行为、接口、工作流、正式入口或用户路径变更，必须遵守下面顺序：

1. 先进入 `Plan` 模式；如果宿主没有显式 `Plan mode`，先给出结构化计划并得到确认。
2. 计划确认后，先更新相关设计文档，再开始实现。
3. 实现完成后，必须回查并同步受影响的设计文档、rules 和 skills，再结束本轮。
4. 如果变更影响正式入口、监控页、工作流主路径或用户操作方式，还要同步更新 `README.md`、`designs/current-solution-summary.md` 和 `designs/architecture.md`。

核心原则：

- `Kairos Core` 只产出 `KTEP`
- 导出到剪映 / 达芬奇由上层 skill 编排
- 外部 MCP 的宿主配置属于 skill 运行环境，不属于 Core 模块
- 同一个 `timeline/current.json` 可以面向不同 NLE 重复导出

## 强规则：导出路径安全

- 任何会落地到本地文件系统的导出，都必须先解析出**最终导出路径**，不能只拿一个根目录就直接写入。
- 在真正导出前，必须检查最终路径是否已存在、目录内是否已有内容。
- 只要最终路径已存在，就必须阻塞并提示用户改用新的目录名；禁止覆盖、删除、清空、重建旧导出目录。
- 如果用户只给了导出根目录 / 草稿库根目录，必须在其下生成新的具体子目录，不能把根目录当成单个导出目标。
- 如果底层导出器带有 `allow_replace`、覆盖旧稿、删目录重建等默认行为，必须显式关闭；无法关闭时必须停下并说明风险。

## 强规则：修改已有草稿前先核对目标

- 如果本阶段要操作的不是“新建导出”，而是继续编辑、修复、覆盖式更新某个已有草稿 / 工程 / 时间线，必须先核对目标身份。
- 必须优先拿到明确路径；再结合目录名、项目名、时间线名、可读元数据等信息做交叉核对。
- 如果有多个近似候选，或用户只说“刚才那个”“最新的那个”，必须停下列出候选让用户确认。
- 在未确认目标对象之前，不允许把请求直接路由给下游导出 / 修改 skill 去写入现有结果。

## 路由规则

### 目标是剪映

使用子 skill：
- [kairos-export-jianying](../kairos-export-jianying/SKILL.md)

适用场景：
- 用户明确说“导出到剪映”
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
- 宿主环境中已具备对应目标的实际导出能力
  - 剪映：vendored `pyJianYingDraft` 本地后端 + 可用 Python 环境
  - Resolve：对应的 Resolve MCP server
- 目标机器上已安装对应的 NLE（若该 NLE 必需）
- 若本阶段会写本地草稿 / 字幕 / 中间文件，最终输出路径已解析为具体目录或文件名，且不会触发现有内容覆盖

## 编排建议

`kairos-workflow` 在 Phase 5 应这样调用：

1. 读取 `timeline/current.json`
2. 判断目标 NLE
3. 如果是新建导出，先解析最终输出路径，并完成路径安全检查
4. 如果是修改现有结果，先完成目标草稿 / 工程身份核对
5. 跳转到对应导出 skill
6. 汇总草稿路径、字幕路径和错误日志

## 注意事项

- 不要把宿主环境的 MCP bridge 逻辑塞回 `src/modules/nle`
- 导出 skill 可以复用 `KTEP`，但不应该反向污染 `timeline-core`
- 若目标 NLE 的 MCP 未配置，应在本阶段明确报缺失，而不是回退去改 Core
- 如果输出路径已存在，默认做法是生成新版本目录，而不是覆盖旧目录
