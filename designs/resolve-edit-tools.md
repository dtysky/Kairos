# Resolve 21.1.2 非音频／非调色维护

2026-10-29 实测版本为 DaVinci Resolve Studio **21.1.2.10**。本轮沿用 vendored Python host，不改变音频、配音或调色工作流。入口为 `scripts/resolve-edit-tools.py`，host JSON operation 为 `edit_tools`。它是 Agent 维护工具，不新增 Console 按钮、Supervisor API 或 Flow Plan capability。

## 读取版本、原生选区和画面

macOS / Linux 使用：

```sh
vendor/resolve-color-host/.venv/bin/python scripts/resolve-edit-tools.py capabilities
vendor/resolve-color-host/.venv/bin/python scripts/resolve-edit-tools.py inspect \
  --project '准确的工程名 [Edit]' --timeline '准确的时间线名 [editId]'
vendor/resolve-color-host/.venv/bin/python scripts/resolve-edit-tools.py frame \
  --project '准确的工程名 [Edit]' --timeline '准确的时间线名 [editId]' \
  --frame 0 --format jpg --max-dimension 1280
```

Windows 使用 `vendor/resolve-color-host/.venv/Scripts/python.exe`。`--help` 提供全部参数。

- `capabilities` 无工程副作用，返回安装版本、实际存在的文档路径及各接口最低版本。`documentedForVersion` 是文档支持判断，`executionVerified=false` 表示这次查询未调用写接口；不能将它当作实机执行成功。
- `inspect` 核对当前工程，在其中按末尾稳定 `[editId]` 唯一匹配时间线；返回 timeline id、video/audio/subtitle item id、轨道、实际帧位、正文/名称及原生 selected 标记。选区来自 **Timeline** 的 `GetSelectedClips()`，不是 Media Pool 选区。必须当前时间线匹配，不自动切换工程或时间线。非空选区及字幕多选仍待实测，空选区不能扩大为全选。
- `frame --frame N` 使用相对于时间线起点的零基帧偏移；不会移动播放头。默认返回 base64 JSON；`--output /absolute/new-preview.jpg` 只写全新文件，父目录须已存在，扩展名必须匹配 format，排除已有文件和符号链接，最后以独占创建防止覆盖。Agent 必须先向用户说明真实导出路径及其存在状态。

## 明确目标的视频维护

先 inspect，再从结果中选择明确的 timeline id 与 item id。以下命令默认只返回 dry-run 计划；添加 `--apply` 执行已获用户授权的具体维护，无需因工具提供 apply 开关而重复请求批准。

```sh
vendor/resolve-color-host/.venv/bin/python scripts/resolve-edit-tools.py fades \
  --project '准确的工程名 [Edit]' --timeline '准确的时间线名 [editId]' \
  --timeline-id '<inspect.timelineId>' --item-id '<明确的视频 item id>' \
  --fade-in 6 --fade-out 6

vendor/resolve-color-host/.venv/bin/python scripts/resolve-edit-tools.py transition \
  --project '准确的工程名 [Edit]' --timeline '准确的时间线名 [editId]' \
  --timeline-id '<inspect.timelineId>' --item-id '<明确的视频 item id>' \
  --position start --duration 6

vendor/resolve-color-host/.venv/bin/python scripts/resolve-edit-tools.py copy-video-attributes \
  --project '准确的工程名 [Edit]' --timeline '准确的时间线名 [editId]' \
  --timeline-id '<inspect.timelineId>' --source-id '<来源视频 item id>' \
  --item-id '<目标视频 item id>' --attribute opacity --attribute scaleX
```

`--item-id` 可以重复传入多个明确目标；不默认使用当前选区、不默认整条时间线。

- 淡入淡出单位为帧，非负且总长不得超过片段。
- 首批转场限定 **Cross Dissolve**，必须明确 start/end 与帧长；start/right、end/left 将转场限制在目标边缘内，不提供跨两片段居中的自动批量转场。
- 复制只允许指定 Inspector 属性：位置、缩放、旋转、锚点、透明度、pitch/yaw、翻转、裁切。禁止 audio、colorCorrection、plugins、Fusion、retimeEffect 和 allVideoAttributes。回读属性不匹配会报告失败；带关键帧的复制可能需要人工检查，不能凭 API 的 True 宣称视觉一致。
- 写入必须核对当前工程和 timeline id、所有目标/source 为视频项且轨道未锁定。预检全部目标后创建唯一 `Kairos recovery …` 时间线并保存。21.1.2 的 `DuplicateTimeline` 会选择新副本，因此工具只在当前对象仍是它自己创建的副本时恢复到原目标，不能覆盖用户中途的切换。
- 写入后验证具体属性、转场参数以及原有所有轨道项目的 id/位置，验证保存成功才返回 applied。新转场作为独立项目计入轨道，允许且仅允许本批实际返回的转场新增项。
- **恢复副本在成功和失败时都保留**，返回其名字与 id。失败可能留下部分修改，必须明确报告；工具不会删除/重建原时间线或假称事务回滚。用户或 Agent 核验后再清理明确的恢复副本。

## 粗剪原生恒速变速

`timeline.generate` 从已确认的 material-slots 读取整数 `speed=1..5`，继续限制加速为既有 `drive / aerial` 类型，照片保持 1 倍。不自行决定哪些素材需要加速，不重写人工时间线。

有倍速请求时，在清空/续建前检查 Resolve >=21.1。每个片段只 append 一次，然后调用 `SetSpeed({Percentage: speed*100, RippleTimeline: true})` 一次；保留原有 pitch correction 状态，linked audio 由 Resolve 同步变速，音量/响度策略不变。验证 `GetSpeed()`、源起点、源终点、实际时长及 linked item 帧位，下一片段使用实际结束帧。源尾允许一输出帧对应的变速取整误差；原始 append 的 source-frame 容差仍独立校验。失败阻塞，不再静默 ignored。

KTEP 保存倍速，Resolve 回传 `actualSpeed`、源帧区间审计 `actualSourceRanges` 与实际帧位；reconciliation 必须拒绝缺少或不匹配的非 1 倍速回执。source-speech SRT 按这些实际片段边界和倍速映射，原有源头尾各 250ms 只加一次。SRT 仍单独生成，不声称自动导入字幕轨。

## 字幕 API 的实测边界

在正式工程的可丢弃副本上验证，测试结束删除所有测试副本，并核验原时间线项目 id/名称/帧位未变：

| 操作 | 21.1.2.10 结果 |
| --- | --- |
| 枚举字幕轨、读正文/起止帧 | 成功，正文来自 `TimelineItem.GetName()` |
| `GetPosition / SetPosition` 移动已有字幕 | 成功，测试位移 1 帧 |
| `SetName` 修改字幕正文 | 返回 False，正文未变 |
| 字幕 `GetLeftOffset / GetRightOffset` | 返回 None，不能套用普通视频片段裁切逻辑 |
| 任意正文直接创建字幕 / 自动导入 SRT | 没有已验证的公共路径，本轮不接入 |
| `MediaPoolItem.SetTranscription` | 修改素材转录数据，与字幕轨正文不是同一对象 |

`CreateSubtitlesFromAudio` 是另一条 Resolve 自动识别/生成字幕流程，不代表可把 Kairos 已审查文本直接写入字幕项。本轮不改变字幕内容真值或 ASR。

## 验证记录

- 本机官方 `README.md + DaVinciResolveScript.pyi + CHANGELOG.md` 核对签名和最低版本。
- 实机工程为 `中秋国庆闽赣自驾 [Edit]`，复制来源为 `山、村落与手艺 [ep2-mountains-villages-craft]`；入口验证使用临时 `Kairos Entry Probe 20261029-141021`，目标片段为 `clip-00009 泉州前往武夷山高速沿途 C4222`，复制属性来源为 `clip-00010 抵达武夷山、晚饭与餐后口述 C4223`。
- 临时副本实测：2/3/4/5 倍速、linked audio 同步、视频 fades、Cross Dissolve、opacity 复制、640px 编码帧导出；59.94fps 素材在 30fps 时间线的四段变速连续落位无 gap/overlap。所有测试副本及其恢复副本均已清理，正式时间线核验未变。
- 自动化覆盖版本阻塞、错误工程/id、锁轨、禁止属性、全新文件写入、dry run、恢复保存失败、写入失败回执、源窗口漂移、linked speed 不一致、KTEP 实际速度核对及加速字幕时间。
