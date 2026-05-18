# 素材事实归档：material.archive

## 生成说明

- 来源：confirmed Flow Plan `edit-flow-main-travel-documentary-20260518` 的第二步 `material-archive`。
- 项目 / Edit：`bingchacha-genie-south-zimeiyakou` / `main`。
- 执行方式：`capabilityId=material.archive`，`runner=agent`，`execution.mode=single-agent`。
- 输入范围：`edits/main/planning/event-table.md`、`store/spans.json`、`analysis/asset-reports/*.json`、`media/chronology.json`；只读 `config/edit-rules/travel-documentary.md` 与 `flow-plan.json` 确认规则和 step 边界。
- 前序依赖：以本轮重新生成的 event-table 为事件组织输入；素材级判断只在本文件中进入。
- 审查状态：本归档产物等待人工审查；不生成 timeline、segment-plan、material-slots、字幕或旁白。

## 全局素材事实摘要

- Chronology：249 个 chronology events，其中 event=158, route=90, gap=1；event-table 已覆盖 249/249。
- Chronology spanRefs：6611；Store material spans：6626。
- Asset reports：2253 个；keep=2247, drop=6。
- Material spans 类型分布：drive=5261, aerial=271, broll=539, talking-head=127, photo=422, timelapse=6。
- Span semanticKind：speech=3717, visual=1677, none=1232。
- 口播 / 人声：span 层 有口播语音=3717, 无口播语音=2909；report 层有 transcript 的资产为 1361。
- Asset report `clipTypeGuess` 分布：drive=994, aerial=271, broll=863, talking-head=119, timelapse=6。
- GPS / Pharos 覆盖：reports 中 2122 个带 Pharos 归属，2117 个带 GPS / inferred GPS 信息。
- 视觉描述完整性：store spans 缺失 `visualObservation` 数量 0。

## 关键污染修复校验

### event-pharos-44fccdaeb0be

- 当前 chronology：2026-04-27 08:55:08-08:58 CST，title=抚仙湖住宿，location=抚仙湖住宿，spanRefs=10。
- 素材事实：10 spans / 2 assets；类型 drive=10；声音 有口播语音=6, 无口播语音=4。
- 高频模式：第一人称行车(10)、有口播语音(6)、黄色车辆(5)、山路(4)、山路行驶(4)、无口播语音(4)、天气光线不明(4)、阴天(3)。
- 召回口径：只作为抚仙湖退房、上车、今日进怒江口播的短锚点；后续 4/27 长距离行车应从 `route-f7fddeba6ee5`、`route-7e17e52de9f7`、`route-80152945a92e` 等 route 中召回。
- 该事件只保留短出发锚点身份。

### event-pharos-a0707a8cfd99

- 当前 chronology：2026-05-01 17:06:37-17:27 CST，title=巴塘县城，location=巴塘县城，spanRefs=39。
- 素材事实：39 spans / 12 assets；类型 drive=31, broll=4, talking-head=2, photo=2；声音 有口播语音=22, 无口播语音=17。
- 高频模式：第一人称行车(31)、天气光线不明(27)、有口播语音(22)、无口播语音(17)、城市街道(16)、黄色车辆(7)、车辆行驶(6)、路边停车等待(6)。
- 召回口径：作为巴塘到达、正式回到四川、县城街道和今日总结的中型事件；巴塘晚间/次日出发另由 `event-pharos-6729d2481588`、`event-pharos-c76b957d5129` 等事件承载。
- 该事件只保留巴塘到达/总结身份。

## 按旅行日归档

| 日期 | 规模 | 素材类型 | 声音事实 | 关键叙事功能 / 召回提示 |
|---|---:|---|---|---|
| 2026-04-24 | 4 events / 132 spanRefs / 35 assets | drive=129, broll=1, talking-head=1, photo=1 | 有口播语音=75, 无口播语音=57 | 开场启动；drive/口播优先，服务区只作短连接。 |
| 2026-04-25 | 22 events / 408 spanRefs / 191 assets | drive=272, aerial=34, broll=49, talking-head=9, photo=44 | 有口播语音=184, 无口播语音=224 | 田园与玉皇顶；航拍/照片可成组，八卦田 gap 需审查。 |
| 2026-04-26 | 26 events / 493 spanRefs / 163 assets | drive=377, aerial=24, broll=62, talking-head=9, photo=20, timelapse=1 | 有口播语音=286, 无口播语音=207 | 玉皇顶清晨与抚仙湖日落；保护少量日落事件，route 压缩。 |
| 2026-04-27 | 19 events / 452 spanRefs / 154 assets | drive=372, aerial=26, broll=25, talking-head=5, photo=24 | 有口播语音=253, 无口播语音=199 | 进怒江长途日；抚仙湖出发事件很短，长途素材主要在 route 中做去重。 |
| 2026-04-28 | 23 events / 549 spanRefs / 227 assets | drive=372, aerial=35, broll=86, talking-head=8, photo=47, timelapse=1 | 有口播语音=287, 无口播语音=262 | 怒江峡谷/知子罗/丙中洛；人文 broll 与峡谷 route 交替。 |
| 2026-04-29 | 38 events / 1002 spanRefs / 299 assets | drive=851, aerial=35, broll=42, talking-head=21, photo=52, timelapse=1 | 有口播语音=591, 无口播语音=411 | 丙察察主穿越；强去重，保留危险路况、桥梁、垭口、航拍跟车。 |
| 2026-04-30 | 23 events / 735 spanRefs / 249 assets | drive=598, aerial=38, broll=42, talking-head=7, photo=50 | 有口播语音=407, 无口播语音=328 | 察隅到然乌/72拐；高海拔 route 密集，适合压缩推进。 |
| 2026-05-01 | 22 events / 501 spanRefs / 169 assets | drive=399, aerial=13, broll=53, talking-head=11, photo=25 | 有口播语音=280, 无口播语音=221 | 入川与巴塘；金沙江大桥是仪式点，巴塘县城是中型到达总结。 |
| 2026-05-02 | 26 events / 861 spanRefs / 257 assets | drive=698, aerial=16, broll=60, talking-head=19, photo=68 | 有口播语音=513, 无口播语音=348 | 格聂南线大雪/烂路；天气路况是核心事实。 |
| 2026-05-03 | 19 events / 658 spanRefs / 192 assets | drive=553, aerial=26, broll=46, talking-head=10, photo=23 | 有口播语音=392, 无口播语音=266 | 格聂之眼到贡嘎方向；保留清晨成果和雪地经验口播。 |
| 2026-05-04 | 15 events / 560 spanRefs / 214 assets | drive=407, aerial=24, broll=63, talking-head=12, photo=51, timelapse=3 | 有口播语音=295, 无口播语音=265 | 子梅垭口核心；航拍、等待、炸机找回和独自折返分层召回。 |
| 2026-05-05 | 12 events / 260 spanRefs / 82 assets | drive=233, broll=10, talking-head=15, photo=2 | 有口播语音=154, 无口播语音=106 | 返程压缩；新都桥到成都 route 只留代表窗口，机场短收尾。 |

## 高密度候选段索引

| id | kind | 时间(CST) | spanRefs | 召回风险 |
|---|---|---|---:|---|
| `route-ac9bb623fc5b` | route | 2026-05-05 11:57-18:17 | 182 | 长 route，必须按路况/口播/航拍跟车去重，不整体铺开。 |
| `route-918a3d2f990a` | route | 2026-04-29 10:36-11:35 | 166 | 长 route，必须按路况/口播/航拍跟车去重，不整体铺开。 |
| `route-80152945a92e` | route | 2026-04-27 15:39-18:01 | 158 | 长 route，必须按路况/口播/航拍跟车去重，不整体铺开。 |
| `event-pharos-16ca86951a00` | event | 2026-05-04 04:51-05:55 | 141 | 高密度 event，按内部动作和素材类型分组召回。 |
| `route-caf6ee3d91ec` | route | 2026-04-30 15:16-16:56 | 135 | 长 route，必须按路况/口播/航拍跟车去重，不整体铺开。 |
| `route-39b65d2ffd59` | route | 2026-05-03 12:34-16:32 | 126 | 长 route，必须按路况/口播/航拍跟车去重，不整体铺开。 |
| `route-0a8ff630f94b` | route | 2026-04-29 07:55-09:06 | 120 | 长 route，必须按路况/口播/航拍跟车去重，不整体铺开。 |
| `route-ce14f461e76b` | route | 2026-04-28 15:15-17:17 | 111 | 长 route，必须按路况/口播/航拍跟车去重，不整体铺开。 |
| `route-929f0c164678` | route | 2026-04-30 18:34-19:42 | 108 | 长 route，必须按路况/口播/航拍跟车去重，不整体铺开。 |
| `route-6253b433fc89` | route | 2026-04-25 14:33-16:30 | 101 | 长 route，必须按路况/口播/航拍跟车去重，不整体铺开。 |
| `event-pharos-148bdc64b334` | event | 2026-05-04 06:38-07:57 | 97 | 高密度 event，按内部动作和素材类型分组召回。 |
| `route-7751a3748bb7` | route | 2026-05-03 16:36-18:12 | 95 | 长 route，必须按路况/口播/航拍跟车去重，不整体铺开。 |

## 可复用 Material Bundles

### 1. 路途推进 / 长距离行车

- 事实锚点：drive=5261 spans；chronology 中长 route 主要集中在 4/27、4/29、4/30、5/3、5/5。
- 召回提示：按 day 内 route 顺序召回，优先保留地形变化、路况变化、车内有效口播、关键地名牌、桥梁/垭口/城市入口。
- 下一步注意：同一 asset 多 span 很多，长 route 只取代表窗口；有口播窗口不得默认静音或加速。

### 2. 丙察察 / 格聂南线穿越核心

- 事实锚点：4/29 有 1002 spanRefs，5/2 有 861 spanRefs，是两段素材密度峰值。
- 召回提示：丙察察优先 `route-0a8ff630f94b`、`route-918a3d2f990a`、`event-pharos-5fe82aa62aa0`；格聂南线优先 `event-pharos-93f7ab9210d8`、`route-eb0750fd6b9f`、`route-82c92537d3f0`、`route-7061567f7b6d`。
- 下一步注意：大量第一人称行车不可直接铺满，应按“路况变差 / 海拔上升 / 雪雨雾变化 / 车内反应”做索引。

### 3. 无人机建立镜头 / 跟车镜头

- 事实锚点：aerial=271 spans，默认按无口播素材处理。
- 召回提示：八卦田、老虎跳上空、怒江峡谷、丙察察桥梁/峡谷、德姆拉/然乌、格聂之眼、子梅垭口优先召回。
- 下一步注意：同事件航拍应聚集成组，再插入普通视频中；行车窗口内若有无人机跟车与普通无口播行车重复，优先无人机跟车。

### 4. 车内口播 / 人物关系

- 事实锚点：talking-head=127 spans；span 层有口播/人声 3717。
- 召回提示：出发、堵车、今日路线说明、困难路况、雪天反应、子梅垭口个人线优先；无信息量闲聊只作氛围补点。
- 下一步注意：先校验 transcript 是否可读，口播重叠窗口保留音频 truth，避免被静音或加速覆盖。

### 5. 边界 / 检查 / 桥梁 / 仪式点

- 事实锚点：金沙江大桥 `event-pharos-65b02a4649df`、让舍曲2号中桥 `event-pharos-5fe82aa62aa0`、怒江大桥/峡谷相关 route、东达山/德姆拉/益秀拉等垭口事件。
- 召回提示：适合作为章节转换、地理跨越和穿越完成感的硬锚点。
- 下一步注意：桥梁/垭口素材常与长 route 混在一起，recall 应保留 event id 和 source window，不只按视觉关键词捞。

### 6. 住宿 / 出发 / 收工 / 餐食补给

- 事实锚点：多日存在住宿、退房、服务区、午餐晚餐事件；餐食补给常见于 4/25、4/26、4/27、4/28 等。
- 召回提示：作为日切换和节奏缓冲，不宜过量；优先选有人物互动、环境变化、器材整理、出发声明的片段。
- 下一步注意：若素材只有 1-2 spans，只作为连接点，不承担完整叙事段落。

### 7. 目的地成果 / 景观高点

- 事实锚点：玉皇顶、八卦田、抚仙湖日落、怒江峡谷、丙察察、然乌湖、格聂之眼、子梅垭口。
- 召回提示：每个成果点按“建立镜头 -> 人物/路况反应 -> 静态照片或细节补充”组织。
- 下一步注意：照片组放最后；航拍成组插入普通视频中，不要被拆散成零碎 b-roll。

### 8. 天气 / 路况变化

- 事实锚点：5/2 大雪、5/4 子梅垭口雪夜和放晴等待是天气叙事重点；雨、雪、雾、高海拔路况都应作为困难递进证据。
- 召回提示：用天气变化解释行程压力和节奏转折，尤其是夜晚、雨雪、雾中会车、湿滑山路。
- 下一步注意：`天气光线不明` 的素材如被选中，需看 `visualObservation` 再确认，不要只依赖标签。

### 9. 静态照片组

- 事实锚点：photo=422 spans。
- 召回提示：按事件内聚集，默认每张 1s；适合放在事件尾部做成果、人物合影、餐食、地标补证。
- 下一步注意：照片不能打断 route 主线；若同事件有视频和航拍，照片作为补充组，不作为主承重。

## material.recall 重点索引 / 校验事项

1. 时间连续性：所有召回必须沿 chronology 顺序；跨 day 或跨 route 回捞需要显式说明原因。
2. 重复素材：长 drive asset 与长 route 必须只保留代表窗口，避免同一路段多次出现。
3. 静音 / 加速候选：无口播 spans 2909、aerial 271 可作为候选；有 transcript 或 `有口播语音` 的 span 不应默认静音或加速。
4. 照片 1s 组：422 个 photo spans 应按事件集中召回，默认 1s，放在事件内最后。
5. 航拍聚集：同事件航拍先成组，再插入普通视频；不要把航拍随机打散。
6. 行车中无人机跟车优先：同一时间窗口内，若无人机跟车与非口播第一视角行车重复，优先无人机跟车，第一视角保留路况/声音/地名证据。
7. 口播校验：3717 个有口播/人声 spans 需要核查 transcript 可用性；不可读或设备指令类语音应在后续阶段过滤。
8. 高密度段落拆分：长 route 和子梅垭口/大雪等高密度事件需要内部拆节奏；`event-pharos-44fccdaeb0be`、`event-pharos-a0707a8cfd99` 不在此类清单中。
9. 天气标签核查：雨、雪、雾、高海拔路况是叙事关键；`天气光线不明` 的素材如被选中，需看 `visualObservation` 再确认。
10. dropped reports：6 个 dropped assets 默认不进入召回，除非人工明确恢复。

## 明确缺口 / 人工审查问题

- `gap-c53de20a6296` / 2026-04-25 / 八卦田延时摄影：0 span，需人工确认是否接受缺口，或是否有未入库素材可补。
- `event-pharos-223050a1a4a1` / 2026-04-24 / 深圳出发点：仅 1 span，开场若需要更强出发仪式，需从相邻 route 口播补强。
- `event-pharos-44fccdaeb0be` / 2026-04-27 / 抚仙湖住宿：10 spans，短出发锚点；后续进怒江素材从相邻 route 处理。
- `event-pharos-a0707a8cfd99` / 2026-05-01 / 巴塘县城：39 spans，中型到达/总结事件；巴塘后续活动由独立事件处理。
- `route-ac9bb623fc5b` / 2026-05-05 / 新都桥到成都机场方向：182 spans，返程应高度压缩。
- `audio` 独立素材：本输入未确认独立音频资产；后续只能依赖视频 transcript / source speech。
- dropped reports：`007b6c1d-b18b-48be-821b-97928cc470de`、`19191b56-40dc-4cae-8de0-a6b0e61752c3`、`1951b50c-8e86-472c-aa49-7a95e06c1c00`、`31f8ba83-b737-43c3-a3c3-823d1495955c`、`37adfb7b-fb25-402d-a057-da7a776fb6b4`、`b6b62ef9-a576-49ec-a2c3-1d7afecbb406`；默认不进入召回。
