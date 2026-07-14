# ASR Speech Window 固定偏差交接

项目：`hebei-dragon-boat-first-taihang`
Resolve 工程：`端午河北之旅：此生初次入太行 [Edit]`
Timeline：`Main [main]`
日期：2026-07-14

## 结论

当前粗剪 timeline 里的 source-speech clips 显示：ASR transcript segment 的时间戳存在稳定的整体提前偏差。

`timeline.generate` 对正常可听 speech clip 的既有规则是：

- 前 handle：`240ms`
- 后 handle：`720ms`

所以如果 ASR 时间戳准确，真实语音波形通常应该出现在 Resolve clip 内约 `240ms` 附近。但实际抽样里，真实波形起点通常落在 `600-800ms`。

这说明问题不像是每条 clip 随机边界误差，更像是当前 ASR 路径对这批素材存在约 `450-500ms` 的固定 early bias。

## 抽样方法

从当前 Resolve timeline 可见的 `clip-00058` 附近开始，向后抽取 30 条 audible speech clip。

每条样本的测量流程：

1. 通过现有 Resolve host 只读动作导出当前 timeline item metadata。
2. 用 `material-slots.json` 的生成顺序把 Resolve `clip-xxxxx` 对回 Kairos span。
3. 使用 Resolve 当前实际 source range 作为音频截取窗口。
4. 用本地 `ffmpeg` 抽取音频并计算 RMS envelope，估算 generated clip 内第一个持续明显波形起点。
5. 将波形起点与理论 ASR 边界在 generated clip 内的位置比较。

本次只把波形能量检测作为统计手段，不建议把 VAD 作为这次问题的第一优先生产修复。

## 统计结果

抽样数量：`30` 条 audible speech clips。

全部样本：

- 真实波形起点中位数：`660ms`
- 真实波形起点均值：`653ms`
- 多出来的前空中位数：`500ms`
- 多出来的前空均值：`453ms`

正常非 clamp 样本，也就是能完整加到 `240ms` 前 handle 的样本：

- 数量：`25`
- 多出来的前空中位数：`430ms`
- 多出来的前空均值：`410ms`
- 去掉两条开头即检测到波形的反例后，中心更接近 `480-500ms`

被素材开头 clamp 的样本，也就是 ASR window 从源素材 `0ms` 开始、无法完整加前 handle 的样本：

- 数量：`5`
- 多出来的前空中位数：`620ms`
- 多出来的前空均值：`668ms`
- 这类样本会放大观感问题，不能直接用于估计固定偏差，但支持“ASR 起点偏早”的判断。

## 代表样本

| Clip | Asset | 理论 ASR 起点在 clip 内位置 | 实测波形起点 | 多出来的前空 |
| --- | --- | ---: | ---: | ---: |
| `clip-00058` | `C2025` | `240ms` | `590ms` | `350ms` |
| `clip-00061` | `C2028` | `240ms` | `780ms` | `540ms` |
| `clip-00062` | `C2029` | `240ms` | `670ms` | `430ms` |
| `clip-00070` | `C2036` | `240ms` | `560ms` | `320ms` |
| `clip-00100` | `C2045` | `240ms` | `630ms` | `390ms` |
| `clip-00103` | `C2048` | `240ms` | `810ms` | `570ms` |
| `clip-00111` | `C2052` | `240ms` | `760ms` | `520ms` |
| `clip-00119` | `C2057` | `240ms` | `900ms` | `660ms` |

之前单独核对过的样本：

- `clip-00056 / C2023`：Resolve 实际 clip 时长约 `3733ms`
- 理论 ASR 起点在 clip 内位置：`240ms`
- 截图与音频检测的真实波形起点：约 `680-700ms`
- 多出来的前空：约 `440-460ms`

## 现象解释

当前可见的不对称现象是：

- 虽然配置上前 handle 只有 `240ms`
- 后 handle 有 `720ms`
- 但实际观感里前面空余反而比尾部多

原因是 ASR 时间戳整体偏早：

```text
当前真实前空 ≈ 240ms + ASR early bias
当前真实尾部 ≈ 720ms - ASR early bias
```

如果 early bias 约 `450ms`，那么实际会变成：

```text
前空 ≈ 690ms
尾部 ≈ 270ms
```

这和当前 Resolve timeline 里的波形观感一致。

## 推荐的一次性修复方向

对端午河北这个项目，建议先做项目级 ASR timestamp bias correction，不要优先引入 VAD。

在 `timeline.generate` 扩展 source-speech handles 前，先把 speech window 整体向后平移约 `450ms`：

```text
correctedSpeechStartMs = speechStartMs + 450ms
correctedSpeechEndMs   = speechEndMs   + 450ms
```

然后继续使用现有 handle：

```text
sourceIn  = correctedSpeechStartMs - 240ms
sourceOut = correctedSpeechEndMs   + 720ms
```

最后照常 clamp 到源素材边界。

预期效果：

- 真实语音起点从当前常见的 `600-800ms` 回到 `200-350ms`
- 尾部空余随之恢复
- clip 总长度基本不变，只是 source range 整体后移

## 不建议的第一方案

不建议把 VAD 作为这次问题的第一修复。

理由：

- 30 条样本显示偏差比较稳定，更像 ASR 时间戳固定 early bias。
- VAD 会引入每条素材的阈值判断，车噪、环境声、尾音和弱语气词都可能造成新误差。
- 当前目标是修正粗剪手感，固定偏移的 dirty fix 更可控。

VAD 可以作为后续增强，但不应先替代这个固定偏差校正。

## 实现注意

建议不要改写 `analysis/asset-reports/*.json` 或 `store/spans.json` 里的原始 ASR truth。

更安全的落点是：

- 作为端午项目 / edit-level runtime override；
- 或只在 `timeline.generate` 生成 Resolve source range 时应用；
- 并在 `.tmp/edit-flow/<editId>/timeline/current.json` 或相邻审计输出里记录 applied bias。

这样可以保留原始分析事实，同时让当前 `[Edit]` timeline 重新生成时获得正确 source handles。
