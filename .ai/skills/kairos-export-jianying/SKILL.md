---
name: kairos-export-jianying
description: >-
  Export a Kairos KTEP timeline to Jianying using the vendored
  `pyJianYingDraft` backend, and optionally emit SRT/VTT subtitles. Use when the user
  wants a Jianying draft, a Jianying smoke test, or subtitles from the final timeline.
---

# Kairos: Export To Jianying

将 `timeline/current.json` 导出到剪映。

## 变更工作流规则

只要本轮任务涉及需求、行为、接口、工作流、正式入口或用户路径变更，必须遵守下面顺序：

1. 先进入 `Plan` 模式；如果宿主没有显式 `Plan mode`，先给出结构化计划并得到确认。
2. 计划确认后，先更新相关设计文档，再开始实现。
3. 实现完成后，必须回查并同步受影响的设计文档、rules 和 skills，再结束本轮。
4. 如果变更影响正式入口、监控页、工作流主路径或用户操作方式，还要同步更新 `README.md`、`designs/current-solution-summary.md` 和 `designs/architecture.md`。

## 前置条件

- `timeline/current.json` 存在且通过 KTEP 校验
- 仓库内 `vendor/pyJianYingDraft` 存在
- `vendor/pyJianYingDraft/.venv` 可用，或 `config/runtime.json` 已显式配置 `jianyingPythonPath`
- 剪映已安装在目标机器上
- 目标机器可以访问时间线中引用的素材路径
- 项目内 staging 草稿目录与最终剪映草稿目录都必须是新的具体目录，不能是已有目录，更不能直接把剪映草稿根目录当成草稿本身

## 输入

- `timeline/current.json`
- 可选导出参数：
  - 草稿名称
  - 字幕位置
  - 字幕大小
  - 是否同时导出 `SRT / VTT`

## 执行原则

- 在 skill 层编排导出，但直接调用 `Kairos Core` 提供的本地 Jianying backend
- 不再依赖外部 `jianying` MCP server
- 允许复用仓库中的 `KTEP` 校验和字幕导出逻辑
- 草稿分辨率 / 帧率应直接继承 `timeline/current.json` 的正式规格；若项目未显式配置，则当前默认规格是 `3840x2160 @ 30fps`
- 如果时间线 clip 带有“静音原音”意图，导出到剪映时应把对应视频片段写成静音
- 默认导出链路是：
  - 先在 `projects/<projectId>/adapters/jianying-staging/<draftName>` 生成 staging draft
  - staging 成功后，再复制到真实 `jianyingDraftRoot/<draftName>`
- 若时间线含有显式变速片段，Jianying 导出适配层可以做 backend compatibility normalization，但这种修正不能回写正式 `timeline/current.json`

## 强规则：导出路径安全

- 导出前必须同时解析出：
  - 项目内 **staging 草稿目录**
  - 真实剪映草稿根目录下的 **最终草稿目录**
- 不能只拿 `draftRoot` 或剪映草稿库根目录就直接写。
- 必须检查 staging 草稿目录和最终草稿目录是否已存在；只要任一已存在，就阻塞并让用户改用新的目录名。
- 禁止覆盖、清空、删除、重建已有草稿目录；不要依赖 `allow_replace`、删目录重建之类的底层行为。
- 如果用户只给了草稿根目录，默认应在其下生成新的具体子目录，建议使用时间戳或版本号。
- 如果本阶段还会导出 `SRT / VTT` 到本地文件，同样先检查字幕目标路径；已有文件或非空目录都不能直接覆盖。

## 强规则：修改已有草稿前先核对目标

- 如果任务不是“新建草稿导出”，而是要检查、修复、补写、继续编辑某个**已有剪映草稿**，必须先核对目标草稿身份。
- 至少核对：草稿目录路径、目录名、草稿库根目录，以及可读到的 `draft_meta_info.json` / `draft_info.json` 里的 `draft_name` 等元数据。
- 如果存在多个相似草稿名、多个版本目录、或元数据和路径不一致，必须停下列出候选，让用户明确确认。
- 在真正修改前，必须先向用户复述：“将修改哪个具体草稿目录，以及依据哪些字段确认它是对的”。
- 未完成核对前，不允许对任何已有草稿目录写入。

## 建议流程

1. 读取并校验 `timeline/current.json`
2. 判断这次是“新建导出”还是“修改已有草稿”
3. 若是新建导出：解析项目内 staging 草稿目录和最终草稿目录，并确认最终目录不是草稿根目录本身
4. 若是新建导出：检查 staging 草稿目录和最终草稿目录；只要任一已存在就阻塞并改用新的目录名
5. 若是修改已有草稿：先核对目标草稿路径、目录名和元数据，确认修改对象无误
6. 先在安全的 staging 目录生成剪映草稿
7. staging 成功后，再复制到最终草稿目录
8. 按 `KTEP` 轨道创建剪映轨道
9. 按 `KTEP` 片段摆放视频 / 图片 / 音频素材
10. 按 `KTEP` 字幕创建文本轨或同时导出 `SRT / VTT`
11. 返回 staging 路径、最终草稿路径和字幕路径

## 推荐产出

- 项目内 staging 草稿路径
- 最终剪映草稿路径
- `subtitles/output.srt`
- `subtitles/output.vtt`
- 导出日志与失败诊断

## 失败时优先检查

- `vendor/pyJianYingDraft` 是否存在且路径未被改坏
- `vendor/pyJianYingDraft/.venv` 是否存在，或 `jianyingPythonPath` 是否指向可执行 Python
- 该 Python 环境中 `pymediainfo` / `imageio`（Windows 还包括 `uiautomation>=2`）是否可导入
- 素材路径是否是目标机器可访问的 Windows 路径
- 项目内 staging 目录是否可写
- 最终草稿目录是否误指向现有目录或草稿根目录
- 若是在改已有草稿，目标草稿是否已经按路径 + 名称 + 元数据核对过

## 说明

- `vendor/pyJianYingDraft` 是当前直接 vendored 的上游库
- 当前 backend 通过 `pyJianYingDraft` 直写 `draft_info.json` / `draft_meta_info.json`
- 对于需要静音的视频片段，当前 backend 会通过 `pyJianYingDraft` 的音量参数把片段音量压到静音
- 这个 skill 是 Phase 5 的剪映目标实现
- 默认安全策略是“项目内 staging + 新目录复制”，不是“覆盖旧草稿”
