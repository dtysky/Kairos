---
name: kairos-export-jianying
description: >-
  Export a Kairos KTEP timeline to Jianying using the vendored
  `pyJianYingDraft` backend, and optionally emit SRT/VTT subtitles. Use when the user
  wants a Jianying draft, a Jianying smoke test, or subtitles from the final timeline.
---

# Kairos: Export To Jianying

将 `timeline/current.json` 导出到剪映。

## 前置条件

- `timeline/current.json` 存在且通过 KTEP 校验
- 仓库内 `vendor/pyJianYingDraft` 存在
- 本机可用 `python` 或 `uv`
- 剪映已安装在目标机器上
- 目标机器可以访问时间线中引用的素材路径
- 最终导出路径必须是一个新的具体草稿目录，不能是已有目录，更不能直接是剪映草稿根目录

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

## 强规则：导出路径安全

- 导出前必须先解析出**最终草稿目录**，不能只拿 `draftRoot` 或剪映草稿库根目录就直接写。
- 必须检查最终草稿目录是否已存在；只要已存在，就阻塞并让用户改用新的目录名。
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
3. 若是新建导出：解析最终草稿目录，并确认它不是草稿根目录
4. 若是新建导出：检查该目录是否已存在、是否为空；如果已存在则阻塞并改用新的目录名
5. 若是修改已有草稿：先核对目标草稿路径、目录名和元数据，确认修改对象无误
6. 用安全的新目录创建剪映草稿，或在已核对的目标草稿上执行后续动作
7. 按 `KTEP` 轨道创建剪映轨道
8. 按 `KTEP` 片段摆放视频 / 图片 / 音频素材
9. 按 `KTEP` 字幕创建文本轨或同时导出 `SRT / VTT`
10. 导出草稿并返回草稿路径

## 推荐产出

- 剪映草稿路径
- `subtitles/output.srt`
- `subtitles/output.vtt`
- 导出日志与失败诊断

## 失败时优先检查

- `vendor/pyJianYingDraft` 是否存在且路径未被改坏
- `python` / `uv` 是否可用，以及 `pymediainfo` / `imageio` 依赖能否解析
- 素材路径是否是目标机器可访问的 Windows 路径
- 剪映草稿目录是否可写
- 最终草稿目录是否误指向现有目录或草稿根目录
- 若是在改已有草稿，目标草稿是否已经按路径 + 名称 + 元数据核对过

## 说明

- `vendor/pyJianYingDraft` 是当前直接 vendored 的上游库
- 当前 backend 通过 `pyJianYingDraft` 直写 `draft_info.json` / `draft_meta_info.json`
- 这个 skill 是 Phase 5 的剪映目标实现
- 默认安全策略是“新目录导出”，不是“覆盖旧草稿”
