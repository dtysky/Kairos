# 五一丙察察项目 Event Table

## 生成信息

- Project: 丙察察格聂南线子梅垭口穿越
- Project ID: `bingchacha-genie-south-zimeiyakou`
- Edit ID: `main`
- Flow Plan: `edit-flow-main-travel-documentary-20260518` / status `confirmed`
- Step: `event-table` / `trip.event_table` / runner `agent` / execution `sharded-agent`
- 正式输入：`media/chronology.json` only；本阶段不要求 `store/spans.json` 或 `analysis/asset-reports/*.json`。
- Chronology: schemaVersion `2.0` / status `confirmed` / generatedAt `2026-05-18T14:46:36.162Z` / confirmedAt `2026-05-18T14:51:54.033Z`
- 日期口径：按 Asia/Shanghai 旅行日归并；事件 id、顺序、时间窗、summary 和 spanIds 数量来自 confirmed chronology。
- 覆盖：249/249 chronology events；kind=event=158, route=90, gap=1；spanRefs=6611。
- 每日数量：2026-04-24 4 / 2026-04-25 22 / 2026-04-26 26 / 2026-04-27 19 / 2026-04-28 23 / 2026-04-29 38 / 2026-04-30 23 / 2026-05-01 22 / 2026-05-02 26 / 2026-05-03 19 / 2026-05-04 15 / 2026-05-05 12。

## 关键污染修复校验

- `event-pharos-44fccdaeb0be`: 2026-04-27 08:55:08-08:58 CST，10 span refs，title=抚仙湖住宿；这是抚仙湖退房/上车短事件。
- `event-pharos-a0707a8cfd99`: 2026-05-01 17:06:37-17:27 CST，39 span refs，title=巴塘县城；这是巴塘到达/总结中型事件。
- 4/27 的长距离行车由后续 route 承载，5/1 巴塘后续活动也拆在独立事件中。

## 分片归约

| 分片 | events | 叙事职责 | 合并口径 |
|---|---:|---|---|
| 2026-04-24..2026-04-27 | 71 | 深圳出发、广西/黔西南、抚仙湖、进怒江 | 4/27 已拆为短出发事件与多段 route；抚仙湖出发只作短锚点。 |
| 2026-04-28..2026-04-29 | 61 | 老姆登、知子罗、丙中洛、丙察察、大流沙、察隅 | 穿越第一高潮；route 密度最高，后续召回优先航拍跟车、危险路况和有效口播。 |
| 2026-04-30..2026-05-02 | 71 | 察隅、德姆拉、然乌、入川、巴塘、格聂南线大雪 | 5/1 巴塘县城已是 21 分钟中型事件，巴塘后续住宿/次日出发另有独立事件。 |
| 2026-05-03..2026-05-05 | 46 | 格聂之眼、理塘、新都桥、子梅垭口、返程成都 | 子梅垭口是后段情绪核心；返程 route 高度压缩，机场事件短收束。 |

## 总体剪辑骨架

1. 出发与西南递进：深圳出发，经广西、黔西南、抚仙湖进入怒江，建立人物、车辆和长途尺度。
2. 怒江峡谷与丙中洛：老姆登、知子罗、石月亮、怒江第一湾、雾里村形成雨雾峡谷段。
3. 丙察察穿越：丙中洛出发，大流沙、察瓦龙、怒江大桥、雄珠拉、益秀拉到察隅，是全片第一穿越高潮。
4. 川藏高海拔连续赶路：德姆拉、然乌、怒江72拐、东达山、金沙江大桥，把“穿越完成”推向“入川”。
5. 格聂南线挑战：扎瓦拉、格木村、大雪烂路、冷古寺、格聂之眼，形成第二穿越高潮。
6. 子梅垭口个人线：雪夜硬上、炸机找回、同伴离开、独自折返、再次等待贡嘎，是后段情绪核心。
7. 返程落地：新都桥到成都机场，压缩长 route，用机场短事件收尾。

## 按天组织建议

### 2026-04-24

- events=4；event:2, route:2, gap:0；spanRefs=132。
- 组织建议：开场短而明确：装车/出发、深圳堵车、赤坎服务区、夜行到广西，建立人物关系和长途尺度。

| 日期 | 时间(CST) | kind | 事件 id | 地点 / 标题 / chronology 摘要 | spanRefs |
|---|---|---|---|---|---:|
| 2026-04-24 | 17:14-17:15 | event | `event-pharos-223050a1a4a1` | 深圳出发点；装车过程、出发宣言，记录旅程起点 / 第一人称行车 / 车内 / 天气光线不明 / 无口播语音 / 山路行车 / 三人同行 / 戴口罩 / A group of three people are inside a moving car. ... | 1 |
| 2026-04-24 | 17:18-19:29 | route | `route-e838ee03a270` | 行车：广东省，深圳市，南山区，南头街道 · 神彩·彩联物流中心 → 广东省，江门市，开平市，赤坎镇 · 中兴；第一人称行车 / 拥堵路段 / 阴天 / 有口播语音 / 描述堵车 / 银色轿车 / 多车排队 / A silver sedan with license plate B DP7506 is driving on a wet road, ... | 57 |
| 2026-04-24 | 19:32-19:33 | event | `event-pharos-2eade750e23b` | 赤坎服务区(中阳高速阳春方向)；赤坎服务区吃饭 / 固定机位观察 / 停车场 / 夜晚 / 无口播语音 / 夜间停车 / 黄色皮卡 / 湿滑地面 / A yellow pickup truck is parked in a wet parking lot at nigh... | 2 |
| 2026-04-24 | 20:04-23:58 | route | `route-984684f8c8e1` | 行车：广东省，江门市，开平市，百合镇 · 罗汉山西水库 → 广西壮族自治区，钦州市，灵山县，三海街道 · 广西荔之情文化传媒有限公司；第一人称行车 / 高速公路 / 夜晚 / 有口播语音 / 夜间高速行车 / 白色轿车 / 绿色路牌 / A car drives on a highway at night, with a white car ahead and gree... | 72 |

### 2026-04-25

- events=22；event:16, route:5, gap:1；spanRefs=408。
- 组织建议：第一审美高点：灵山出发、纳灰村/八卦田/万峰林、玉皇顶住宿；八卦田 gap 保留人工审查。

| 日期 | 时间(CST) | kind | 事件 id | 地点 / 标题 / chronology 摘要 | spanRefs |
|---|---|---|---|---|---:|
| 2026-04-25 | 00:00-00:15 | event | `event-pharos-8204f5ee42f6` | 灵山县；固定机位观察 / 服务区停车场 / 夜晚 / 无口播语音 / 服务区停车 / A yellow SUV is parked in front of the illuminated Ya Shan Service Area at night... | 15 |
| 2026-04-25 | 08:54-08:55 | event | `event-pharos-a5f959b4c967` | 灵山县；从灵山县的酒店出发 / 车窗外观察 / 停车场 / 天气光线不明 / 无口播语音 / 停车场车辆停放 / 建筑 / A parking lot with several cars, including a white van and a ... | 1 |
| 2026-04-25 | 08:56-08:56 | event | `event-f17de2fd73e3` | 车内人员互动；广西壮族自治区，钦州市，灵山县，三海街道 · 广西荔之情文化传媒有限公司；车内自拍口播 / 车内空间 / 天气光线不明 / 有口播语音 / 车内人员互动 / 卷发男子 / 粉色衬衫 / A man with curly hair and glasses in a pink shirt sits in the f... | 2 |
| 2026-04-25 | 09:05-09:44 | route | `route-3abb1e1bf171` | 行车：广西壮族自治区，钦州市，灵山县，三海街道 · 十里铺村梁弘略祠 → 广西壮族自治区，南宁市，邕宁区，那楼镇 · 北投能源那楼上线服务区加油站；第一人称行车 / 林荫大道 / 天气光线不明 / 有口播语音 / 沿岛行驶 / 黄色车辆 / 远处建筑 / A yellow vehicle drives down a wide, tree-lined road with a tall ... | 43 |
| 2026-04-25 | 09:50-09:54 | event | `event-dee337482fea` | 航拍公路；广西壮族自治区，南宁市，邕宁区，那楼镇 · 北投能源那楼上线服务区加油站；航拍俯瞰 / 山路 / 晴天 / 无口播语音 / 航拍公路 / 高速公路 / 森林 / Aerial view of a multi-lane highway cutting through lush green forested hil... | 7 |
| 2026-04-25 | 10:23-12:30 | route | `route-92781eb9bf11` | 行车：广西壮族自治区，南宁市，良庆区，玉洞街道 · 22队消纳场 → 广西壮族自治区，百色市，田东县，平马镇 · 田东大桥；第一人称行车 / 高速公路 / 天气光线不明 / 有口播语音 / 区间测速提示 / A yellow vehicle travels on a highway with green guardrails and red flowers o... | 37 |
| 2026-04-25 | 12:31-13:04 | event | `event-pharos-86f4c13959b6` | 途中午餐；途中午餐，美食特写+用餐氛围。 / 车窗外观察 / 服务区停车场 / 天气光线不明 / 无口播语音 / 停车观察环境 / 白色面包车 / 红砖建筑旁 / A white minivan is parked in a lot near a ... | 15 |
| 2026-04-25 | 13:11-13:11 | event | `event-7f7ec603e35c` | 车内讨论行程；广西壮族自治区，百色市，右江区，四塘镇；车内自拍口播 / 车内 / 天气光线不明 / 有口播语音 / 车内讨论行程 / 卷发戴眼镜 / 红色上衣 / A person with curly hair and glasses sits in the front passenger... | 1 |
| 2026-04-25 | 13:35-14:15 | route | `route-8f34fc8c8230` | 行车：广西壮族自治区，百色市，右江区，汪甸瑶族乡 · 下塘出口(G69银百高速西北向) → 广西壮族自治区，百色市，田林县，乐里镇；第一人称行车 / 高速公路 / 阴天 / 无口播语音 / 高速出口指示 / 道路标志 / 绿树背景 / A view from a moving car on a highway, showing a clear road ahead w... | 6 |
| 2026-04-25 | 14:22-14:27 | event | `event-222630a458d1` | 蝴蝶停驻车漆；广西壮族自治区，百色市，田林县，潞城瑶族乡 · 桥头很好日杂；细节特写 / 车旁静止 / 天气光线不明 / 无口播语音 / 蝴蝶停驻车漆 / 棕色蝴蝶 / 黄色车漆 / A close-up shot of a brown butterfly resting on the glossy yellow... | 4 |
| 2026-04-25 | 14:33-16:30 | route | `route-6253b433fc89` | 行车：广西壮族自治区，百色市，田林县，潞城瑶族乡 · 岩龙站 → 贵州省，黔西南布依族苗族自治州，兴义市，丰都街道 · 富康四季花城观澜府；第一人称行车 / 高速公路 / 晴天 / 无口播语音 / 山路高速穿行 / 绿色植被 / 高架桥 / A point-of-view shot from inside a yellow car driving along a multi-... | 101 |
| 2026-04-25 | 16:33-17:03 | event | `event-pharos-4967cf573f2c` | 纳灰村；长焦压缩：村民劳作、炊烟升起、牛羊归家等人文细节。 / 第一人称行车 / 山路 / 晴天 / 无口播语音 / 山路行车 / 紫色花丛 / 树木成荫 / A view from a moving vehicle driving down a... | 39 |
| 2026-04-25 | 17:00-17:06 | event | `event-pharos-037da2538647` | 上纳灰村；航拍运动 / 山地环境 / 夜晚 / 无口播语音 / 雪山星空摄影 / 星空摄影 / 雪山前景 / Aerial footage of a lush green mountainous region with a village nest... | 7 |
| 2026-04-25 | 17:06-17:59 | event | `event-pharos-431b58ad6011` | 纳灰村/八卦田；走进纳灰村/八卦田，田园小路、水车、稻田，建立场景感。 / 车窗外观察 / 花海拍摄现场 / 天气光线不明 / 无口播语音 / 花海现场拍摄准备 / 绿色植被 / 白色花朵 / A row of lush green trees with... | 28 |
| 2026-04-25 | 18:00-19:00 | gap | `gap-c53de20a6296` | Missing: 八卦田；八卦田；八卦田延时摄影 | 0 |
| 2026-04-25 | 18:04-18:59 | event | `event-pharos-4ba9d1581db4` | 八卦田；环境远景 / 梯田花海 / 日出或日落 / 无口播语音 / 田园风光拍摄 / 移动视角 / 喀斯特地貌 / A serene rural landscape at sunrise or sunset featuring terraced ... | 39 |
| 2026-04-25 | 19:07-19:08 | event | `event-b1fa99a57fc8` | 拍摄花絮；贵州省，黔西南布依族苗族自治州，兴义市，万峰林街道 · 万峰林景区；手持自拍口播 / 户外田野 / 阴天 / 有口播语音 / 拍摄花絮 / 山区背景 / 自拍 / A man with curly hair and glasses takes a selfie in a field with mounta... | 1 |
| 2026-04-25 | 19:34-19:46 | route | `route-0160017b64a3` | 行车：贵州省，黔西南布依族苗族自治州，兴义市，万峰林街道 · 万峰林景区；贵州省，黔西南布依族苗族自治州，兴义市，万峰林街道 · 万峰林景区；第一人称行车 / 城市街道 / 夜晚 / 无口播语音 / 夜间行车 / 桥梁 / 暖光建筑 / A series of driving shots at dusk/night, starting from a parking area n... | 4 |
| 2026-04-25 | 19:48-19:48 | event | `event-095e47c8e5ec` | 餐厅外景记录；贵州省，黔西南布依族苗族自治州，兴义市，万峰林街道 · 万峰林景区；固定机位观察 / 餐厅停车场 / 夜晚 / 无口播语音 / 餐厅外景记录 / 白色轿车 / 招牌灯光 / A white car is parked in a dark area, and a restaurant with a lit ... | 1 |
| 2026-04-25 | 20:03-20:58 | event | `event-pharos-d205b52bdc83` | 玉皇顶景区附近；玉皇顶景区附近晚餐，收工补给，为次日清晨云海日出做准备。 / 车窗外观察 / 室内餐桌 / 室内灯光 / 无口播语音 / 食材准备特写 / 红油汤锅 / 生肉切片 / A black stone pot filled with red s... | 7 |
| 2026-04-25 | 21:03-21:55 | event | `event-pharos-54cb7aba8cb4` | 玉皇顶转场路上；日落收工后转场玉皇顶，夜路上山与抵达花絮，衔接第二天清晨机位。 / 第一人称行车 / 山路 / 夜晚 / 有口播语音 / 山路驾驶 / 夜间行车 / 电瓶车 / A white car drives past on a road at n... | 45 |
| 2026-04-25 | 22:01-22:05 | event | `event-pharos-0b585de85123` | 玉皇顶住宿；玉皇顶住宿，高位机位落脚，整理器材后早点休息。 / 固定机位观察 / 室内空间 / 夜晚 / 有口播语音 / 酒店外观 / 夜间建筑 / 茂密植被 / The video shows a dark night scene with a b... | 5 |

### 2026-04-26

- events=26；event:17, route:9, gap:0；spanRefs=493。
- 组织建议：玉皇顶清晨与抚仙湖日落形成两个视觉高点，中间兴义到抚仙湖的 route 压缩连接。

| 日期 | 时间(CST) | kind | 事件 id | 地点 / 标题 / chronology 摘要 | spanRefs |
|---|---|---|---|---|---:|
| 2026-04-26 | 05:43-06:41 | event | `event-pharos-3b6c75b31f33` | 玉皇顶高处观景平台；长焦压缩高位峰丛层次+云海翻涌+日出光线变化；若无海则主拍晨光扫峰林。；广角全景云海+峰丛+日出天空色彩变化，与A7R5长焦对切。；第三视角拍摄：摄影师在玉皇顶架设日出机位，介绍云海与峰丛层次。 / 固定机位观察 / 室内房间 / 夜晚 ... | 23 |
| 2026-04-26 | 09:18-09:18 | event | `event-95cfa006d184` | 猫咪活动；贵州省，黔西南布依族苗族自治州，兴义市，则戎镇 · 大山脚；手持自拍口播 / 室内地面 / 晴天 / 有口播语音 / 猫咪活动 / 室内拍摄 / 阳光充足 / A grey tabby cat is seen lying down and then walking on a tiled floor... | 4 |
| 2026-04-26 | 09:20-10:52 | event | `event-pharos-4fa704df818f` | 玉皇顶住宿；玉皇顶出发，退房上车，口播今日转场抚仙湖与傍晚日落安排。 / 车窗外观察 / 室内用餐环境 / 室内灯光 / 无口播语音 / 享用早餐 / 面条汤 / 吐司鸡蛋 / A meal set featuring a bowl of noodl... | 2 |
| 2026-04-26 | 10:56-10:58 | route | `route-99d351287bf1` | 行车：贵州省，黔西南布依族苗族自治州，兴义市，则戎镇 · 大山脚 → 贵州省，黔西南布依族苗族自治州，兴义市，则戎镇 · 枇杷树村；第一人称行车 / 蜿蜒山路 / 晴天 / 有口播语音 / 车内讨论舒适度 / A yellow vehicle travels along a winding road, passing parked cars, a dog, and l... | 18 |
| 2026-04-26 | 11:00-11:01 | event | `event-468d02bd412f` | 航拍山村全景；贵州省，黔西南布依族苗族自治州，兴义市，则戎镇 · 枇杷树村；航拍俯瞰 / 山区丘陵 / 阴天 / 无口播语音 / 情景不明 / 雾气弥漫 / 稀疏植被 / The frames show a misty mountain landscape with green hills, valleys, a... | 2 |
| 2026-04-26 | 11:01-11:54 | route | `route-9f320894ceee` | 行车：贵州省，黔西南布依族苗族自治州，兴义市，则戎镇 · 枇杷树村 → 贵州省，黔西南布依族苗族自治州，兴义市，下五屯街道 · 九华苑；航拍俯瞰 / 喀斯特地貌山路 / 晴天 / 无口播语音 / 独自行车穿越 / 黄色车辆 / 梯田景观 / An aerial view captures a solitary yellow vehicle traveling along ... | 84 |
| 2026-04-26 | 11:56-13:03 | event | `event-pharos-3008f55d5062` | 途中午餐；途中午餐，美食特写。 / 车窗外观察 / 街道 / 晴天 / 无口播语音 / 黄色皮卡停放 / 黄色皮卡 / 行人路过 / A yellow pickup truck with black decals is parked on a st... | 15 |
| 2026-04-26 | 13:08-13:35 | route | `route-72ea87011245` | 行车：贵州省，黔西南布依族苗族自治州，兴义市，下五屯街道 · 暖桐.沐曦观景度假民宿 → 贵州省，黔西南布依族苗族自治州，兴义市，乌沙镇 · 下分田；第一人称行车 / 城市街道 / 晴天 / 有口播语音 / 资金配置讨论 / 白色轿车 / 多车道道路 / A white sedan is driving on the left side of the road, while the c... | 45 |
| 2026-04-26 | 13:40-13:55 | event | `event-8214c18ebb9e` | 蜿蜒山路航拍；贵州省，黔西南布依族苗族自治州，兴义市，乌沙镇 · 坪寨；航拍运动 / 山区公路 / 晴天 / 无口播语音 / 蜿蜒山路航拍 / 梯田村落 / 绿色山丘 / Aerial footage of a highway winding through a lush, mountainous lands... | 19 |
| 2026-04-26 | 14:03-15:18 | route | `route-481e1aaaba39` | 行车：贵州省，黔西南布依族苗族自治州，兴义市，乌沙镇 · 乌沙镇岔江村卫生室 → 云南省，曲靖市，陆良县，马街镇 · 薛官堡村路口(公交站)；第一人称行车 / 高速公路 / 晴天 / 有口播语音 / 讨论音乐风格 / 山区路段 / 黄色车辆 / A yellow vehicle drives along a highway through a mountainous area ... | 28 |
| 2026-04-26 | 15:20-15:36 | event | `event-pharos-05380978456a` | 滇西的一个服务区；遇到中午，高速上云雾缭绕，航拍 / 第一人称行车 / 高速公路 / 阴天 / 有口播语音 / 讨论道路设计 / 黄色车辆 / 多车道 / A yellow vehicle drives on a multi-lane highway un... | 11 |
| 2026-04-26 | 15:49-16:41 | route | `route-b209cd83d5e9` | 行车：云南省，曲靖市，陆良县，大莫古镇 → 云南省，玉溪市，澄江市，右所镇 · 补益村；第一人称行车 / 高速公路 / 阴天 / 无口播语音 / 城市边缘 / 两侧建筑 / A yellow vehicle drives on a highway with green trees and buildings visible ... | 51 |
| 2026-04-26 | 16:41-16:45 | event | `event-19f3cbc6b872` | 航拍全景；云南省，玉溪市，澄江市，右所镇 · 补益村；航拍俯瞰 / 山谷小镇 / 天气光线不明 / 无口播语音 / 航拍全景 / 高速公路 / 温室大棚 / Aerial view of a small town nestled in a valley with mountains in t... | 7 |
| 2026-04-26 | 16:51-17:04 | route | `route-101f744aab43` | 行车：云南省，玉溪市，澄江市，右所镇 · 168乡道 → 云南省，玉溪市，澄江市，右所镇 · 抚仙湖公园；第一人称行车 / 城市道路 / 阴天 / 有口播语音 / 路况讨论 / A yellow vehicle drives down a multi-lane road lined with trees, passing a grey SUV... | 21 |
| 2026-04-26 | 17:05-17:05 | event | `event-7be72db9bffd` | 湖边停车；云南省，玉溪市，澄江市，右所镇 · 抚仙湖国家级旅游度假区；车窗外观察 / 湖边 / 天气光线不明 / 无口播语音 / 湖边停车 / 摩托车 / 行人 / Two frames show a lakeside scene with scooters and a white car parked n... | 1 |
| 2026-04-26 | 17:06-17:15 | route | `route-1232c192ac72` | 行车：云南省，玉溪市，澄江市，右所镇 · 抚仙湖国家级旅游度假区 → 云南省，玉溪市，澄江市，右所镇 · 抚仙湖公园；第一人称行车 / 热带街道 / 晴天 / 无口播语音 / 沿海公路 / 黄色轿车 / 棕榈树 / A yellow car drives along a tree-lined road with white buildings and p... | 35 |
| 2026-04-26 | 17:16-17:20 | event | `event-e123b48ce147` | 蜿蜒湖岸公路；云南省，玉溪市，澄江市，右所镇 · 抚仙湖公园；航拍俯瞰 / 沿海公路 / 晴天 / 无口播语音 / 蜿蜒湖岸公路 / 红土丘陵 / 停车场车辆 / Aerial view of a winding coastal road along a lake, with red soil hi... | 3 |
| 2026-04-26 | 17:29-17:29 | event | `event-31b3c7fe5b1c` | 公园道路风景；云南省，玉溪市，澄江市，右所镇 · 抚仙湖公园；固定机位观察 / 公园景观 / 阴天 / 无口播语音 / 公园道路风景 / 绿树成荫 / 水域背景 / A scenic view of a park with a winding road, lush green trees, and ... | 1 |
| 2026-04-26 | 17:36-18:01 | event | `event-pharos-e57c590a42cb` | 抚仙湖边；抚仙湖当地美食（铜锅鱼是招牌）。 / 车窗外观察 / 餐厅外观及室内 / 天气光线不明 / 无口播语音 / 餐厅环境展示 / 橙色立柱 / 木质装饰 / The frames show the exterior of a restaura... | 6 |
| 2026-04-26 | 18:26-18:33 | route | `route-e5b91401a100` | 行车：云南省，玉溪市，澄江市，右所镇 · 抚仙湖公园；云南省，玉溪市，澄江市，右所镇 · 抚仙湖公园；第一人称行车 / 山路 / 晴天 / 有口播语音 / 山路会车 / A yellow vehicle drives along a road with a mountain in the background, passing a gre... | 27 |
| 2026-04-26 | 18:35-18:56 | event | `event-pharos-45a99b0a57cf` | 抚仙湖湖边；第三视角拍摄：第一眼看到抚仙湖的反应。；湖边散步，水质清澈特写，建立场景。 / 车窗外观察 / 草地丘陵 / 晴天 / 无口播语音 / 乡间土路 / 蜿蜒小径 / 远山植被 / The frames show a dirt path wi... | 6 |
| 2026-04-26 | 19:02-19:11 | event | `event-pharos-81757e94164b` | 抚仙湖上空；航拍俯瞰 / 观景平台 / 日落 / 无口播语音 / 日落观景 / 水面 / 远山 / A serene sunset scene over a large body of water with mountains in the dist... | 6 |
| 2026-04-26 | 19:25-19:27 | event | `event-pharos-2eb82fed1da1` | 抚仙湖东岸；固定机位观察 / 湖面 / 日落 / 无口播语音 / 湖面日落剪影 / 远山轮廓 / 橙色余晖 / A serene sunset scene over a body of water with silhouetted mountains... | 5 |
| 2026-04-26 | 19:38-19:42 | event | `event-pharos-c5d6b00c7ff1` | 抚仙湖住宿/湖边；固定机位观察 / 高山草甸 / 阴天 / 无口播语音 / 花海拍摄现场 / 金色草浪 / 远景树木 / Tall golden grasses sway in the foreground, with trees and a cloudy... | 3 |
| 2026-04-26 | 19:54-20:47 | route | `route-07503a59be55` | 行车：云南省，玉溪市，澄江市，右所镇 · 抚仙湖国际度假小镇湖畔森林公园 → 云南省，玉溪市，江川区，江城镇 · 抚仙湖阳光半岛度假酒店；第一人称行车 / 城市街道 / 夜晚 / 有口播语音 / 路口等待 / 白色轿车 / 摩托车 / A white sedan and a motorcycle are stopped at a crosswalk at night, wi... | 68 |
| 2026-04-26 | 20:50-20:59 | event | `event-pharos-86dffbaf4835` | 抚仙湖住宿；抚仙湖住宿，收工后整理器材，早点休息等待次日日出。；夜间备卡、充电、查看天气与日出方位，准备次日清晨机位。 / 固定机位观察 / 环境不明 / 夜晚 / 无口播语音 / 店铺外景展示 / 黄色灯串 / 红灯笼 / A brightly l... | 2 |

### 2026-04-27

- events=19；event:12, route:7, gap:0；spanRefs=452。
- 组织建议：抚仙湖出发后进入怒江方向，叙事由“湖边结束”切到“长距离进山”；长途压力来自后续 route，不来自单个 Pharos event。

| 日期 | 时间(CST) | kind | 事件 id | 地点 / 标题 / chronology 摘要 | spanRefs |
|---|---|---|---|---|---:|
| 2026-04-27 | 08:16-08:21 | event | `event-9e9aedb39218` | 棕榈树；云南省，玉溪市，江川区，江城镇 · 抚仙湖阳光半岛度假酒店；环境远景 / 户外广场 / 晴天 / 无口播语音 / 棕榈树 / 米色建筑 / 消防栓箱 / The video shows a sunny outdoor plaza with palm trees, beige buildings, ... | 3 |
| 2026-04-27 | 08:53-08:54 | route | `route-d500066647a3` | 行车：云南省，玉溪市，江川区，江城镇 · 滇湖酒店 → 云南省，玉溪市，江川区，江城镇 · 抚仙湖云溪海岸酒店；第一人称行车 / 车内 / 天气光线不明 / 有口播语音 / 旅途开始 / A person with curly hair and glasses wearing a red jacket sits in the front passe... | 4 |
| 2026-04-27 | 08:55-08:58 | event | `event-pharos-44fccdaeb0be` | 抚仙湖住宿；抚仙湖出发，退房上车，口播今日行程（赶路进怒江）。 / 第一人称行车 / 山路 / 夜晚 / 有口播语音 / 山路行驶 / 黄色车辆 / 石拱门 / A yellow vehicle drives along a paved road t... | 10 |
| 2026-04-27 | 09:26-12:15 | route | `route-f7fddeba6ee5` | 行车：云南省，玉溪市，江川区，星云街道 → 云南省，楚雄彝族自治州，南华县，沙桥镇 · 096乡道；第一人称行车 / 高速公路上 / 阴天 / 有口播语音 / 驾车途中 / 黄色车辆 / 多车道 / A yellow vehicle drives on a multi-lane highway with white cars ahead... | 43 |
| 2026-04-27 | 12:38-12:59 | event | `event-pharos-26f4bbb87eba` | 途中午餐；途中午餐。 / 固定机位观察 / 停车场 / 天气光线不明 / 无口播语音 / 车辆停放观察 / 黄色 SUV / 红色垃圾桶 / A yellow SUV with black decals is parked next to a re... | 5 |
| 2026-04-27 | 13:16-14:12 | route | `route-7e17e52de9f7` | 行车：云南省，大理白族自治州，祥云县，云南驿镇 · 高官铺小学 → 云南省，大理白族自治州，漾濞彝族自治县，顺濞镇 · 国道岔河服务区汽车充电站；第一人称行车 / 高速公路 / 阴天 / 有口播语音 / 行车途中讨论 / 绿色丘陵 / 树木两侧 / A yellow vehicle drives on a highway with green hills and trees on ... | 52 |
| 2026-04-27 | 14:16-14:23 | event | `event-df97dfe4a530` | 车辆检查；云南省，大理白族自治州，漾濞彝族自治县，顺濞镇 · 大钢钢铁；第三人称跟拍 / 户外停车场 / 晴天 / 无口播语音 / 车辆检查 / 卷发男子 / 眼镜 / A man with curly hair and glasses stands in front of a yellow car with... | 4 |
| 2026-04-27 | 14:23-14:25 | event | `event-c0ccbbd9bc93` | 山谷公路航拍；云南省，大理白族自治州，漾濞彝族自治县，顺濞镇 · 大理大钢钢铁有限公司(南门)；航拍俯瞰 / 山谷公路 / 阴天 / 无口播语音 / 山谷公路航拍 / Aerial view of a winding highway cutting through a lush green valley with a muddy r... | 3 |
| 2026-04-27 | 14:47-15:25 | route | `route-0aa6922e682f` | 行车：云南省，大理白族自治州，永平县，龙街镇 → 云南省，大理白族自治州，永平县，博南镇 · 山王庙丫口；第一人称行车 / 高速公路 / 晴天 / 无口播语音 / 山路驾驶 / 黄色车辆 / 弯道行驶 / A yellow vehicle travels on a highway through a mountainous area, pas... | 37 |
| 2026-04-27 | 15:22-15:37 | event | `event-0535533fc04c` | 车内观察；云南省，大理白族自治州，永平县，博南镇 · 服务区(杭瑞高速瑞丽方向)；细节特写 / 车内 / 天气光线不明 / 无口播语音 / 车内观察 / 内饰细节 / 建筑外观 / The first frame shows a close-up of a car's interior door panel with ... | 23 |
| 2026-04-27 | 15:39-18:01 | route | `route-80152945a92e` | 行车：云南省，大理白族自治州，永平县，博南镇 · 服务区(杭瑞高速瑞丽方向) → 云南省，怒江傈僳族自治州，泸水市，古登乡 · 怒江大峡谷；环境远景 / 停车场 / 阴天 / 无口播语音 / 旅行开场 / 黄色 SUV / 湿润路面 / A yellow SUV with a green license plate is parked on a wet asphalt lot... | 158 |
| 2026-04-27 | 18:05-18:33 | event | `event-pharos-516e91fcb4ea` | 老虎跳（六库以北约30km）；老虎跳打卡：怒江最窄处，江心巨石激起白浪，峡谷气势磅礴。航拍+手持。 / 手持自拍口播 / 岩石边缘 / 阴天 / 有口播语音 / 河谷观景 / 红色外套 / 蓝色行人 / A person in a red coat stands on... | 9 |
| 2026-04-27 | 18:22-18:28 | event | `event-pharos-0f08832de711` | 老虎跳上空；航拍俯瞰 / 峡谷河流 / 晴天 / 无口播语音 / 悬索桥 / 宽阔河流 / 右侧公路 / Aerial view of a wide river flowing through a lush green mountain gorge ... | 7 |
| 2026-04-27 | 18:53-19:28 | event | `event-pharos-e22b9056f627` | 老虎跳；怒江晚餐，来不及去老姆登，临时改。 / 固定机位口播 / 室内商店 / 室内灯光 / 有口播语音 / 购物场景 / 冷藏柜 / 多人互动 / A man and a woman stand in front of refrigerated... | 9 |
| 2026-04-27 | 19:58-20:07 | route | `route-5891ba12e8d3` | 行车：云南省，怒江傈僳族自治州，泸水市，称杆乡 · 怒江大峡谷 → 云南省，怒江傈僳族自治州，泸水市，古登乡 · 怒江大峡谷；第一人称行车 / 蜿蜒山路 / 雾天 / 无口播语音 / 山路驾驶 / 雾气弥漫 / 森林山坡 / A vehicle drives along a wet, winding mountain road at dusk, with ste... | 13 |
| 2026-04-27 | 20:09-20:09 | event | `event-f9cd8295a8bc` | 山路夜景；云南省，怒江傈僳族自治州，泸水市，古登乡 · 怒江大峡谷；固定机位观察 / 山路 / 天气光线不明 / 有口播语音 / 山路夜景 / 桥梁 / 灯光 / A series of frames showing a mountainous landscape at dusk with scatter... | 1 |
| 2026-04-27 | 20:25-21:04 | route | `route-f5d49b59c3e1` | 行车：云南省，怒江傈僳族自治州，泸水市，洛本卓白族乡 · 怒江大峡谷 → 云南省，怒江傈僳族自治州，福贡县，匹河怒族乡 · 老姆登村景区；第一人称行车 / 湿滑山路 / 夜晚 / 有口播语音 / 夜间山路驾驶 / 车灯眩光 / 护栏旁 / A night-time driving sequence on a wet road, featuring bright headli... | 26 |
| 2026-04-27 | 21:04-21:29 | event | `event-pharos-293bc464d87a` | 老姆登村民宿；老姆登民宿入住，阳台/窗外皇冠峰夜景。 / 第一人称行车 / 建筑旁空地 / 夜晚 / 无口播语音 / 车辆停靠观察 / 夜间行车 / 建筑特写 / The first frame shows a brightly lit buildin... | 42 |
| 2026-04-27 | 21:29-21:32 | event | `event-186e3229ff30` | 夜间观景；云南省，怒江傈僳族自治州，福贡县，匹河怒族乡 · 老姆登村景区；固定机位观察 / 环境不明 / 夜晚 / 有口播语音 / 夜间观景 / 木质围栏 / 发光路牌 / A dark night scene with a wooden fence and a glowing sign reading 'G2... | 3 |

### 2026-04-28

- events=23；event:15, route:8, gap:0；spanRefs=549。
- 组织建议：老姆登、知子罗、怒江峡谷和丙中洛是人文/峡谷段，route 与景点事件交替推进。

| 日期 | 时间(CST) | kind | 事件 id | 地点 / 标题 / chronology 摘要 | spanRefs |
|---|---|---|---|---|---:|
| 2026-04-28 | 06:25-08:16 | event | `event-pharos-b72da4d0572b` | 老姆登村观景平台；广角拍老姆登村全景+怒江峡谷+天空，晨雾升腾过程，与A7R5长焦对切。；第三视角拍摄：摄影师在晨雾中架设备、介绍老姆登和皇冠峰。 / 第一人称行车 / 建筑外观 / 下雨 / 有口播语音 / 清晨雨雾弥漫 / 木质栏杆 / 建筑剪影 / ... | 7 |
| 2026-04-28 | 08:20-08:25 | event | `event-4e8d42e5d601` | 天气变化；云南省，怒江傈僳族自治州，福贡县，匹河怒族乡 · 老姆登村景区；延时记录 / 山村 / 雾天 / 无口播语音 / 天气变化 / 蓝天白云 / 雾气弥漫 / The scene transitions from a dramatic blue sky with clouds to a misty, fo... | 3 |
| 2026-04-28 | 08:27-09:06 | event | `event-pharos-b675e6ce9727` | 老姆登村上空；航拍运动 / 山谷村落 / 阴天 / 无口播语音 / 云雾缭绕山村 / 彩色房屋 / 梯田景观 / A series of aerial drone shots capturing a lush mountain village nest... | 29 |
| 2026-04-28 | 09:25-09:38 | event | `event-pharos-420e56ed9551` | 老姆登村景区；简单探索下老姆登村 / 车窗外观察 / 石阶花海 / 天气光线不明 / 无口播语音 / 拍摄准备 / 石阶 / 彩色轮胎 / The first frame shows a wet stone-paved area with colorf... | 32 |
| 2026-04-28 | 10:29-10:40 | route | `route-a3cf9e504ab1` | 行车：云南省，怒江傈僳族自治州，福贡县，匹河怒族乡 · 老姆登村景区；云南省，怒江傈僳族自治州，福贡县，匹河怒族乡 · 老姆登村景区；第一人称行车 / 车内 / 天气光线不明 / 有口播语音 / 车内讨论行程 / 卷发乘客 / A person with curly hair and glasses sits in the front passenger seat of... | 38 |
| 2026-04-28 | 10:41-10:45 | event | `event-pharos-cf9e178c465e` | 知子罗村民委员会；第一人称行车 / 铺装山路 / 阴天 / 无口播语音 / 山路行驶中 / 红色横幅 / 绿色山坡 / A yellow SUV drives along a paved road bordered by a concrete retain... | 4 |
| 2026-04-28 | 10:49-11:38 | event | `event-pharos-fbccd3fa334a` | 知子罗（海拔2023m）；第一人称行车 / 山路 / 下雨 / 有口播语音 / 抵达芝子罗 / 湿滑路面 / 黄色车辆 / A yellow vehicle drives along a wet road past white buildings and tree... | 62 |
| 2026-04-28 | 11:47-11:47 | event | `event-pharos-1591e77ec982` | 老姆登村；出发北上，口播今日行程（知子罗→石月亮→怒江第一湾→丙中洛）。 / 车内自拍口播 / 车内 / 下雨 / 无口播语音 / 车内休息 / 雨天 / 红夹克 / A man with curly hair and glasses wearin... | 2 |
| 2026-04-28 | 12:11-13:20 | route | `route-85759da76683` | 行车：云南省，怒江傈僳族自治州，福贡县，匹河怒族乡 · 老姆登村景区 → 云南省，怒江傈僳族自治州，福贡县，上帕镇 · 怒江大峡谷；第一人称行车 / 山路 / 下雨 / 有口播语音 / 山路行车 / 雨天下坡 / 黄色车辆 / A yellow vehicle drives along a wet, winding road with colorful center ... | 87 |
| 2026-04-28 | 13:19-13:47 | event | `event-pharos-83e8aac6016c` | 福贡县；午餐 / 第一人称行车 / 湿滑街道 / 下雨 / 有口播语音 / 街道穿行观察 / 绿色植被 / 黄色车顶 / The video shows a wet street scene with buildings and trees, f... | 13 |
| 2026-04-28 | 14:20-14:57 | route | `route-06f9d1a2bf6a` | 行车：云南省，怒江傈僳族自治州，福贡县，上帕镇 · 怒江大峡谷 → 云南省，怒江傈僳族自治州，福贡县，石月亮乡 · 怒江大峡谷；第一人称行车 / 湿滑山路 / 下雨 / 有口播语音 / 川藏线行车 / 红色卡车 / 大型广告牌 / A wet road with a red truck on the left, large billboards on the ri... | 35 |
| 2026-04-28 | 14:58-15:01 | event | `event-pharos-6ab79fb0cba5` | 石月亮观景台；第一人称行车 / 山路 / 下雨 / 有口播语音 / 山路行车 / 绿色山丘 / 雾气弥漫 / A yellow vehicle drives on a wet mountain road surrounded by green hill... | 10 |
| 2026-04-28 | 15:15-17:17 | route | `route-ce14f461e76b` | 行车：云南省，怒江傈僳族自治州，福贡县，石月亮乡 · 怒江大峡谷 → 云南省，怒江傈僳族自治州，贡山独龙族怒族自治县，丙中洛镇 · 怒江大峡谷；第一人称行车 / 泥泞山路 / 阴天 / 有口播语音 / 山泉冲水路面 / 黄色车辆 / 村庄房屋 / A yellow vehicle navigates a flooded, debris-filled road in a mount... | 111 |
| 2026-04-28 | 17:27-17:27 | event | `event-pharos-f8f31caea9bb` | 怒江第一湾观景台；长焦压缩怒江U型弯在侧逆光下的峡谷光影与低云流动；雨后转晴有则加分。；广角怒江第一湾全景，优先拍完整弯道与山体光影，若有低云翻涌则一并收入。；第三视角拍摄：摄影师在观景台架延时，判断低云与侧逆光条件，介绍怒江第一湾。 / 车窗外观察 / ... | 3 |
| 2026-04-28 | 17:28-17:28 | event | `event-687ae5533b73` | 自然景观展示；云南省，怒江傈僳族自治州，贡山独龙族怒族自治县，丙中洛镇 · 怒江第一湾；航拍俯瞰 / 深谷河流 / 晴天 / 无口播语音 / 深谷河流航拍 / 蜿蜒河流 / 茂密植被 / A serene aerial view of a winding river cutting through lush green mo... | 2 |
| 2026-04-28 | 17:34-17:45 | route | `route-972e15c6f712` | 行车：云南省，怒江傈僳族自治州，贡山独龙族怒族自治县，丙中洛镇 · 怒江大峡谷；云南省，怒江傈僳族自治州，贡山独龙族怒族自治县，丙中洛镇 · 怒江大峡谷；第一人称行车 / 隧道内 / 天气光线不明 / 有口播语音 / 车辆进入隧道 / 山路行车 / 隧道灯光 / A vehicle travels along a winding mountain road, passing through... | 10 |
| 2026-04-28 | 17:46-18:07 | event | `event-pharos-fb0f23756a37` | 雾里村；雾里村打卡：茶马古道遗存，田园风光，步行进入约20min。 / 固定机位观察 / 观景台 / 晴天 / 无口播语音 / 风景观赏 / 石砌护栏 / 河谷景观 / Two people stand on a stone-paved over... | 17 |
| 2026-04-28 | 18:26-18:30 | route | `route-c058f2a97675` | 行车：云南省，怒江傈僳族自治州，贡山独龙族怒族自治县，丙中洛镇 · 怒江大峡谷；云南省，怒江傈僳族自治州，贡山独龙族怒族自治县，丙中洛镇 · 怒江大峡谷；第一人称行车 / 山路 / 晴天 / 有口播语音 / 讨论骑行路线 / 黄色车辆 / 石墙植被 / A yellow vehicle drives along a paved road next to a stone retaining ... | 12 |
| 2026-04-28 | 18:31-18:34 | event | `event-2ee6cff22534` | 停车场环境观察；云南省，怒江傈僳族自治州，贡山独龙族怒族自治县，丙中洛镇 · 怒江大峡谷；固定机位观察 / 地下停车场 / 室内灯光 / 无口播语音 / 停车场环境观察 / 电动巴士 / 行人穿行 / A person walks through a parking garage lined with small electr... | 3 |
| 2026-04-28 | 18:40-18:40 | route | `route-6e2f12d3cee9` | 行车：云南省，怒江傈僳族自治州，贡山独龙族怒族自治县，丙中洛镇 · 怒江大峡谷；云南省，怒江傈僳族自治州，贡山独龙族怒族自治县，丙中洛镇 · 怒江大峡谷；第一人称行车 / 国道隧道 / 天气光线不明 / 有口播语音 / 大卡车倒车拥堵 / 黄色车辆跟随 / 红色卡车行驶 / A yellow vehicle follows a red truck along a winding road ... | 4 |
| 2026-04-28 | 18:54-19:35 | event | `event-pharos-516fa94347fb` | 丙中洛观景台（村口上方高机位）；车窗外观察 / 石质露台 / 夜晚 / 有口播语音 / 讨论查鱼封路绕行 / 摩托车手 / 山景背景 / Two motorcyclists in gear stand on a stone patio, with one pointin... | 17 |
| 2026-04-28 | 20:00-20:04 | route | `route-b84eff441087` | 行车：云南省，怒江傈僳族自治州，贡山独龙族怒族自治县，丙中洛镇 · 怒江大峡谷；云南省，怒江傈僳族自治州，贡山独龙族怒族自治县，丙中洛镇 · 怒江大峡谷；第一人称行车 / 盘山公路 / 天气光线不明 / 有口播语音 / 临时停车决策 / 限速标志 / 小型建筑 / A vehicle travels along a winding mountain road at dusk, passin... | 27 |
| 2026-04-28 | 20:04-21:29 | event | `event-pharos-ec9399e2153f` | 丙中洛；傍晚收工后入住丙中洛，人神共居的秘境。；丙中洛晚餐。 / 第一人称行车 / 狭窄林道 / 夜晚 / 有口播语音 / 讨论次日出发时间 / 黄色车辆 / 森林深处 / A yellow vehicle drives along a narr... | 21 |

### 2026-04-29

- events=38；event:22, route:16, gap:0；spanRefs=1002。
- 组织建议：丙察察主穿越日，route 密度最高；大流沙、怒江大桥、雄珠拉、益秀拉、察隅作为硬锚点。

| 日期 | 时间(CST) | kind | 事件 id | 地点 / 标题 / chronology 摘要 | spanRefs |
|---|---|---|---|---|---:|
| 2026-04-29 | 05:36-05:47 | event | `event-pharos-20a91223f952` | 丙中洛·贡当神山观景台；长焦压缩怒江峡谷晨雾+丙中洛全景。。06:30前必须收工赶路；广角丙中洛全景晨雾延时，与长焦对切。 / 车内自拍口播 / 车内 / 下雨 / 有口播语音 / 清晨出发看晨雾 / A person with curly hair and g... | 28 |
| 2026-04-29 | 06:33-06:41 | event | `event-82bf0cace85c` | 雨雾观景；云南省，怒江傈僳族自治州，贡山独龙族怒族自治县，丙中洛镇 · 怒江大峡谷；车窗外观察 / 石砌观景台 / 雨天 / 无口播语音 / 雨雾观景 / 木质栏杆 / 远处城镇灯光 / A misty, rainy scene at a stone-paved overlook with a wooden railin... | 3 |
| 2026-04-29 | 06:45-07:06 | event | `event-pharos-ee251c54652d` | 丙中洛上空；环境远景 / 山地环境 / 雾天 / 无口播语音 / 云雾山村俯瞰 / 石砌护栏 / 层叠山峦 / A person stands on a stone ledge overlooking a misty mountain village... | 22 |
| 2026-04-29 | 07:15-07:16 | event | `event-64804f391129` | 车内访谈；云南省，怒江傈僳族自治州，贡山独龙族怒族自治县，丙中洛镇 · 怒江大峡谷；第三人称跟拍 / 车内 / 晴天 / 无口播语音 / 车内访谈 / 卷发男子 / 红色夹克 / A man with curly hair and glasses sits in a car, wearing a red jacket o... | 1 |
| 2026-04-29 | 07:22-07:25 | event | `event-720492e17228` | 拍摄结束总结；云南省，怒江傈僳族自治州，贡山独龙族怒族自治县，丙中洛镇 · 怒江大峡谷；手持自拍口播 / 环境不明 / 雾天 / 有口播语音 / 拍摄结束总结 / 红色外套 / A man with curly hair and glasses wearing a red coat takes a selfie in a f... | 3 |
| 2026-04-29 | 07:34-07:35 | event | `event-pharos-a269d410f8d0` | 丙中洛；口播：今天穿越丙察察，全程270km非铺装路面。 / 第一人称行车 / 车内 / 下雨 / 有口播语音 / 穿越丙茶茶行程第五天 / 雨 / 山路 / A person with curly hair and glasses wearin... | 1 |
| 2026-04-29 | 07:36-07:51 | route | `route-4df80bcc3153` | 行车：云南省，怒江傈僳族自治州，贡山独龙族怒族自治县，丙中洛镇 · 怒江大峡谷；云南省，怒江傈僳族自治州，贡山独龙族怒族自治县，丙中洛镇 · 怒江大峡谷；第一人称行车 / 山村道路 / 雾天 / 有口播语音 / 山村湿滑行车 / 湿滑路面 / 绿色树木 / A vehicle drives on a wet road through a misty mountain village wit... | 9 |
| 2026-04-29 | 07:52-07:52 | event | `event-28780ac33fb7` | 车辆接受检查；云南省，怒江傈僳族自治州，贡山独龙族怒族自治县，丙中洛镇 · 怒江大峡谷；车窗外观察 / 检查站 / 晴天 / 有口播语音 / 车辆接受检查 / SUV 后备箱 / 移民管理局 / A dark SUV with its trunk open is stopped at a checkpoint, where ... | 1 |
| 2026-04-29 | 07:55-09:06 | route | `route-0a8ff630f94b` | 行车：云南省，怒江傈僳族自治州，贡山独龙族怒族自治县，丙中洛镇 · 怒江大峡谷 → 西藏自治区，林芝市，察隅县，察瓦龙乡 · 怒江大峡谷；第一人称行车 / 车内 / 天气光线不明 / 有口播语音 / 边境检查点 / 边界严格 / 持枪守卫 / A person with curly hair and glasses wearing a maroon jacket takes... | 120 |
| 2026-04-29 | 09:10-09:24 | event | `event-pharos-08e2666e4b2b` | 大流沙（丙察察标志性路段）；大流沙打卡：200m常年滑坡区，丙察察标志。⚠️快速通过，关窗勿久停。 / 第一人称行车 / 湿滑山路 / 天气光线不明 / 有口播语音 / 水泥车会车 / 大流沙路段 / 白色卡车 / A cement truck drives on ... | 21 |
| 2026-04-29 | 09:27-09:29 | route | `route-cd98fca37b29` | 行车：西藏自治区，林芝市，察隅县，察瓦龙乡 · 怒江大峡谷；西藏自治区，林芝市，察隅县，察瓦龙乡 · 怒江大峡谷；第一人称行车 / 山路 / 阴天 / 有口播语音 / 山路行驶讨论烂路 / 烂路 / A vehicle travels along a winding mountain road with steep rocky slopes, con... | 16 |
| 2026-04-29 | 09:32-10:24 | event | `event-pharos-7c0e7b7700ef` | 察瓦龙乡；察瓦龙午餐补给：中途最大补给站，加油+检查车况+午餐。 / 第一人称行车 / 山区入口 / 阴天 / 无口播语音 / 进山准备 / 雾气 / 电力设施 / A view from inside a vehicle approaching ... | 14 |
| 2026-04-29 | 10:26-10:32 | route | `route-72ab25f4c20a` | 行车：西藏自治区，林芝市，察隅县，察瓦龙乡 · 怒江大峡谷；西藏自治区，林芝市，察隅县，察瓦龙乡 · 怒江大峡谷；第一人称行车 / 城镇街道 / 晴天 / 有口播语音 / 正式出发准备 / 蓝色皮卡 / 城镇背景 / A blue pickup truck with license plate 川D·19A89 is parked on the ri... | 30 |
| 2026-04-29 | 10:33-10:35 | event | `event-57a7d9a0d84c` | 前方施工禁行；西藏自治区，林芝市，察隅县，察瓦龙乡 · 怒江大峡谷；固定机位观察 / 土路施工路段 / 晴天明亮 / 有口播语音 / 前方施工禁行 / 白色 SUV 停车 / 蓝色指示牌 / A white SUV is stopped on a dirt road in front of a blue ... | 3 |
| 2026-04-29 | 10:36-11:35 | route | `route-918a3d2f990a` | 行车：西藏自治区，林芝市，察隅县，察瓦龙乡 · 怒江大峡谷；西藏自治区，林芝市，察隅县，察瓦龙乡 · 怒江大峡谷；第一人称行车 / 山路 / 天气光线不明 / 有口播语音 / 山路行车 / 感谢铲车 / 铺平道路 / A man with curly hair and glasses wearing a red jacket drives a car... | 166 |
| 2026-04-29 | 11:35-11:45 | event | `event-pharos-cd288724799c` | 怒江大桥（怒江与玉曲河交汇处）；怒江与玉曲河交汇，泾渭分明，钢索吊桥。 / 第一人称行车 / 山路 / 天气光线不明 / 有口播语音 / 山路行车 / 悬索桥 / 土路 / A yellow vehicle drives across a suspension brid... | 10 |
| 2026-04-29 | 11:45-11:49 | route | `route-d5a859385a65` | 行车：西藏自治区，林芝市，察隅县，察瓦龙乡 · 怒江大峡谷；西藏自治区，林芝市，察隅县，察瓦龙乡 · 怒江大峡谷；第一人称行车 / 山路 / 天气光线不明 / 有口播语音 / 山路行车 / 跟车 / A yellow vehicle follows a large cement truck on a dusty mountain road with ... | 24 |
| 2026-04-29 | 11:51-12:38 | event | `event-pharos-5fe82aa62aa0` | 让舍曲2号中桥；连续发卡湾记录 / 第一人称行车 / 车内 / 天气光线不明 / 有口播语音 / 讨论路况颠簸 / 炮弹坑 / 多人同行 / Four men are riding in a car, with the driver wearing a ... | 69 |
| 2026-04-29 | 12:41-13:01 | route | `route-1d254c8c94d6` | 行车：西藏自治区，林芝市，察隅县，察瓦龙乡 · 怒江大峡谷 → 西藏自治区，林芝市，察隅县，察瓦龙乡；第一人称行车 / 山谷公路 / 天气光线不明 / 有口播语音 / 路况好转 / 绿色山坡 / 远云 / A yellow vehicle drives along a paved mountain road through a valle... | 14 |
| 2026-04-29 | 13:11-13:12 | event | `event-4d9f44bc359b` | 国道风光；西藏自治区，林芝市，察隅县，察瓦龙乡；第三人称介绍 / 车内前排 / 天气光线不明 / 有口播语音 / 国道风光 / 乘客交谈 / 红色外套 / A man with curly hair and glasses wearing a red jacket sits in th... | 1 |
| 2026-04-29 | 13:12-13:35 | route | `route-d829c4eaa23d` | 行车：西藏自治区，林芝市，察隅县，察瓦龙乡；西藏自治区，林芝市，察隅县，察瓦龙乡；第一人称行车 / 盘山公路 / 晴天 / 有口播语音 / 山路行车中 / 黄色车辆 / 悬崖路段 / A yellow vehicle drives along a winding mountain road carved into st... | 26 |
| 2026-04-29 | 13:34-13:35 | route | `route-8cd8e11b38fb` | 行车：西藏自治区，林芝市，察隅县，察瓦龙乡；西藏自治区，林芝市，察隅县，察瓦龙乡；第一人称行车 / 山路 / 晴天 / 有口播语音 / 雪山会车等待 / 碎石路 / 绿色围挡 / A vehicle travels on a gravel road through a mountain valley, flanked ... | 1 |
| 2026-04-29 | 13:35-14:21 | event | `event-pharos-cc7755182da1` | 察隅县；途中一段森林路段跟车 / 第一人称行车 / 山路 / 晴天 / 有口播语音 / 雪山会车等待 / 碎石路 / 绿色围挡 / A vehicle travels on a gravel road through a mountain val... | 50 |
| 2026-04-29 | 14:08-14:12 | event | `event-pharos-7c221cb8efe4` | 雄珠拉垭口上空；航拍运动 / 森林 / 晴天 / 无口播语音 / 雪山航拍 / 雪山峰顶 / 针叶林 / A sweeping aerial view of a rugged mountain range featuring snow-covered p... | 4 |
| 2026-04-29 | 14:30-14:54 | route | `route-26a6c3f5c8c6` | 行车：西藏自治区，林芝市，察隅县，察瓦龙乡 · 日巴曲 → 西藏自治区，林芝市，察隅县，察瓦龙乡 · 雄珠拉垭口；第一人称行车 / 山路 / 下雪 / 有口播语音 / 冰雹天气 / 碎石路面 / 雪山远景 / A vehicle travels on a gravel road through a mountainous region with st... | 37 |
| 2026-04-29 | 14:57-15:53 | event | `event-pharos-f521bec01e92` | 雄珠拉垭口（海拔4636m）；航拍俯瞰 / 山地环境 / 下雪 / 无口播语音 / 雪山山路行车 / 黄色 SUV / 蜿蜒土路 / Aerial footage of a yellow SUV driving along a winding dirt road th... | 29 |
| 2026-04-29 | 15:55-15:59 | route | `route-8ae85686683c` | 行车：西藏自治区，林芝市，察隅县，竹瓦根镇 · 雄珠拉垭口 → 西藏自治区，林芝市，察隅县，竹瓦根镇；第一人称行车 / 山路 / 下雪 / 有口播语音 / 雪山泥泞山路 / 积雪坡面 / 岩石峭壁 / A vehicle travels on a wet, muddy mountain road with snow-covered slo... | 18 |
| 2026-04-29 | 16:01-16:03 | event | `event-fb25ed31e5d5` | 路边停留；西藏自治区，林芝市，察隅县，竹瓦根镇；车窗外观察 / 山地环境 / 晴天 / 无口播语音 / 路边停留 / 黑色外套 / 雪山背景 / A person in a black jacket stands on a dirt road next to a snowbank, w... | 3 |
| 2026-04-29 | 16:02-16:13 | route | `route-0c740a16b5e9` | 行车：西藏自治区，林芝市，察隅县，竹瓦根镇；西藏自治区，林芝市，察隅县，竹瓦根镇；航拍俯瞰 / 山地环境 / 晴天 / 无口播语音 / 航拍蜿蜒公路 / 雪山地形 / 部分多云 / A breathtaking aerial view of a snow-covered mountain valley with a s... | 34 |
| 2026-04-29 | 16:12-16:12 | event | `event-9d1040c609d1` | 航拍山路全景；西藏自治区，林芝市，察隅县，竹瓦根镇；航拍运动 / 山路 / 雪天 / 无口播语音 / 航拍山路全景 / 黄色车辆 / 崎岖地形 / Aerial view of a winding mountain road cutting through snow-covered pea... | 1 |
| 2026-04-29 | 16:24-16:59 | route | `route-55845035a69f` | 行车：西藏自治区，林芝市，察隅县，竹瓦根镇 → 西藏自治区，林芝市，察隅县，竹瓦根镇 · 察隅途友饭店；第一人称行车 / 碎石山路 / 雪天 / 有口播语音 / 山路行车中 / 碎石路面 / 雪山背景 / A vehicle travels on a gravel road through a snow-covered mountain v... | 39 |
| 2026-04-29 | 16:59-17:32 | event | `event-pharos-e97ba3ccaff1` | 目若村·天边牧场（海拔3750m）；高山牧场风光：草原+河谷+远方雪山。 / 第一人称行车 / 山地环境 / 天气光线不明 / 有口播语音 / 简短回应确认 / 尘土路 / 雪山 / A yellow vehicle drives on a dirt road throug... | 19 |
| 2026-04-29 | 17:35-18:13 | route | `route-26d1f99615da` | 行车：西藏自治区，林芝市，察隅县，竹瓦根镇；西藏自治区，林芝市，察隅县，竹瓦根镇；第一人称行车 / 高山谷地 / 晴天 / 有口播语音 / 路边遇见牛羊 / 广角镜头 / 牦牛群 / A wide shot of a mountainous valley with grazing yaks, scattered hou... | 22 |
| 2026-04-29 | 18:13-18:14 | event | `event-8c590b684495` | 乘客微笑面对镜头；西藏自治区，林芝市，察隅县，竹瓦根镇；第三人称跟拍 / 车内 / 天气光线不明 / 无口播语音 / 乘客微笑面对镜头 / 卷发戴眼镜男子 / 红色夹克 / A man with curly hair and glasses wearing a red jacket sits ... | 1 |
| 2026-04-29 | 18:41-18:57 | route | `route-37cab981bc47` | 行车：西藏自治区，林芝市，察隅县，竹瓦根镇；西藏自治区，林芝市，察隅县，竹瓦根镇；第一人称行车 / 山路 / 阴天 / 有口播语音 / 介绍小村 / 土路停车 / 卡车聚集 / A view from a vehicle shows a dirt road with a red dump truck, a blue t... | 29 |
| 2026-04-29 | 18:56-19:44 | event | `event-pharos-643c7e95001d` | 益秀拉垭口（海拔4706m）；三大垭口之三，丙察察最高点，仪式感打卡。 / 第一人称行车 / 隧道口停车场 / 雪天 / 有口播语音 / 等待放行 / 隧道入口 / 白色 SUV / A white SUV is parked in front of a tunnel... | 42 |
| 2026-04-29 | 19:47-20:25 | route | `route-46ec5982306f` | 行车：西藏自治区，林芝市，察隅县，竹瓦根镇；西藏自治区，林芝市，察隅县，竹瓦根镇；第一人称行车 / 山地环境 / 阴天 / 有口播语音 / 雪山行车途中 / 碎石路 / 雪山 / A vehicle travels on a gravel road through a mountain valley with snow... | 39 |
| 2026-04-29 | 20:54-22:18 | event | `event-pharos-fab61834fcf8` | 察隅县城；丙察察穿越完成！口播总结今日全程。；察隅晚餐，庆祝丙察察穿越成功。 / 第一人称行车 / 公路 / 夜晚 / 有口播语音 / 夜间行车 / 边境派出所 / 竹瓦庚 / A car drives at night on a road, pa... | 52 |

### 2026-04-30

- events=23；event:13, route:10, gap:0；spanRefs=735。
- 组织建议：察隅到然乌、德姆拉和怒江72拐，属于高海拔连续赶路与地理尺度扩展。

| 日期 | 时间(CST) | kind | 事件 id | 地点 / 标题 / chronology 摘要 | spanRefs |
|---|---|---|---|---|---:|
| 2026-04-30 | 08:25-09:20 | event | `event-pharos-365f96925d5b` | 察隅县城；口播：赶路日，察隅翻德姆拉山经然乌到左贡460km。 / 第一人称行车 / 停车场 / 雾天 / 无口播语音 / 停车观察 / 白色宝马 / 红色 SUV / A parking lot with several cars, includ... | 15 |
| 2026-04-30 | 09:24-09:55 | route | `route-43af9c3e2ece` | 行车：西藏自治区，林芝市，察隅县，竹瓦根镇 · 桑曲 → 西藏自治区，林芝市，察隅县，古玉乡 · 察隅慈巴沟；第一人称行车 / 山路 / 阴天 / 有口播语音 / 山路行车 / A yellow vehicle drives along a winding mountain road surrounded by green hills and f... | 16 |
| 2026-04-30 | 10:23-10:23 | event | `event-pharos-a904c72f8eae` | 559国道；559标牌看桑曲 / 固定机位观察 / 观景台 / 晴天 / 无口播语音 / 路边观景 / 红色石刻 / 河流 / Travelers stop at a scenic roadside viewpoint featuring a lar... | 1 |
| 2026-04-30 | 10:25-12:06 | route | `route-b4cecb116e94` | 行车：西藏自治区，林芝市，察隅县，古玉乡；西藏自治区，林芝市，察隅县，古玉乡；环境远景 / 山谷河流 / 阴天 / 无口播语音 / 风景空镜 / 茂密森林 / 陡峭山坡 / A serene mountain river flows through a lush green forested valley, fla... | 91 |
| 2026-04-30 | 12:05-12:05 | route | `route-59efb1dfba70` | 行车：西藏自治区，林芝市，察隅县，古玉乡；西藏自治区，林芝市，察隅县，古玉乡；第一人称行车 / 山地环境 / 下雪 / 有口播语音 / 山路行车讨论 / 黄色车辆 / 蜿蜒山路 / A yellow vehicle travels along a winding asphalt road through a sno... | 1 |
| 2026-04-30 | 12:06-12:31 | event | `event-pharos-e4b1e65de3fa` | 德姆拉山口（海拔4900m）；G559最高点，360°雪山全景，林芝/昌都界山。 / 第三人称跟拍 / 环境不明 / 阴天 / 有口播语音 / 雪山朝圣路行走 / 红色外套 / 经幡 / A person in a red coat walks along a sno... | 38 |
| 2026-04-30 | 12:07-12:26 | event | `event-pharos-cf6e48ed0121` | 德姆拉山口上空；航拍雪山垭口+盘山公路全景，海拔4900m注意电池衰减 / 第一人称行车 / 山路 / 下雪 / 无口播语音 / 山路行车 / 白色 SUV / 黑色 SUV / A white SUV and a black SUV drive alo... | 4 |
| 2026-04-30 | 12:42-13:04 | route | `route-16520bc4e2de` | 行车：西藏自治区，林芝市，察隅县，古玉乡 → 西藏自治区，昌都市，八宿县，然乌镇；第一人称行车 / 公路 / 阴天 / 有口播语音 / 横排方案讨论 / 雪雾山路 / 横排方案 / A yellow vehicle travels down a foggy, snow-lined road with a yellow ... | 55 |
| 2026-04-30 | 13:05-13:29 | event | `event-pharos-2eb20683961d` | 然乌湖湖边；然乌湖快速打卡，湖边停车拍摄雪山+湖面。 / 固定机位观察 / 海岸湖边 / 雾天 / 无口播语音 / 风景空镜 / 雾气弥漫 / 岩石前景 / A misty mountain lake scene with snow-capped p... | 14 |
| 2026-04-30 | 13:09-13:26 | event | `event-pharos-920c09382a28` | 然乌湖上空；细节特写 / 湖泊公路 / 晴天 / 无口播语音 / 航拍湖泊公路 / 碧蓝湖泊 / 蜿蜒道路 / A sweeping aerial view of a turquoise lake nestled between rugged mou... | 14 |
| 2026-04-30 | 13:33-13:43 | route | `route-62d721d47792` | 行车：西藏自治区，昌都市，八宿县，然乌镇 · 仲巴村 → 西藏自治区，昌都市，八宿县，然乌镇 · 然乌湖景区；第一人称行车 / 蜿蜒山路 / 晴天 / 有口播语音 / 雪山湖泊 / 背景山峰 / 道路弯曲 / A yellow vehicle travels along a winding mountain road with snow-capp... | 31 |
| 2026-04-30 | 13:53-15:06 | event | `event-pharos-4ecae40b6d07` | 然乌镇；然乌镇加油+快速午餐补给。 / 第一人称行车 / 山城街道 / 晴天 / 无口播语音 / 山城穿行 / 传统建筑 / 雪山背景 / A view from a moving vehicle driving through a small ... | 30 |
| 2026-04-30 | 15:16-16:56 | route | `route-caf6ee3d91ec` | 行车：西藏自治区，昌都市，八宿县，然乌镇 → 西藏自治区，昌都市，八宿县，白玛镇 · 怒江72拐；第一人称行车 / 山路 / 雾天 / 无口播语音 / 车队缓慢通行 / 积雪路面 / 弯道行驶 / A point-of-view shot from a vehicle driving along a winding mountain ... | 135 |
| 2026-04-30 | 16:57-16:57 | event | `event-8997f9196313` | 西藏自治区，昌都市，八宿县，白玛镇 · 怒江72拐；第三人称跟拍 / 加油站 / 天气光线不明 / 无口播语音 / 情景不明 / A man with curly hair and glasses stands at a gas station next to a yellow SUV, ... | 1 |
| 2026-04-30 | 17:23-17:57 | route | `route-f121cc0eb4c4` | 行车：西藏自治区，昌都市，八宿县，拉根乡 · 怒江72拐 → 西藏自治区，昌都市，八宿县，帮达镇 · 怒江72拐；第一人称行车 / 山路 / 天气光线不明 / 无口播语音 / 山路行车 / 黄色车辆 / 黑色 SUV / A yellow vehicle drives along a mountain road, passing a black SU... | 81 |
| 2026-04-30 | 17:59-18:19 | event | `event-pharos-e8c33ac315fe` | 怒江72拐；八宿七十二拐入口。 / 第一人称行车 / 峡谷入口 / 晴天 / 有口播语音 / 寻找停车点 / 72 拐大峡谷 / 检查站 / The video shows a vehicle driving on a mountain road, ... | 24 |
| 2026-04-30 | 18:34-19:42 | route | `route-929f0c164678` | 行车：西藏自治区，昌都市，八宿县，帮达镇 · 怒江72拐；西藏自治区，昌都市，八宿县，帮达镇 · 怒江72拐；第一人称行车 / 山路 / 天气光线不明 / 有口播语音 / 挪车避让危险车辆 / 白色轿车 / 黄色车头可见 / A white car with license plate F DN2239 is stopped on a mount... | 108 |
| 2026-04-30 | 19:42-20:09 | event | `event-pharos-773651d74fce` | 业拉山；七十二拐后途中的一个高点，拍到了满月和日落。 / 第一人称行车 / 山路 / 天气光线不明 / 有口播语音 / 区间测速超速警告 / 雪山远景 / 弯道行驶 / A vehicle travels along a winding moun... | 22 |
| 2026-04-30 | 20:13-20:13 | event | `event-ee14efd1df12` | 雪山远景拍摄；西藏自治区，昌都市，八宿县，帮达镇 · 怒江72拐；环境远景 / 山地环境 / 阴天 / 无口播语音 / 雪山远景拍摄 / 云层遮挡 / 月亮可见 / A mountain range with snow-capped peaks under a cloudy sky with a bri... | 1 |
| 2026-04-30 | 20:13-20:31 | route | `route-c8f2ba06fed2` | 行车：西藏自治区，昌都市，八宿县，帮达镇 · 怒江72拐 → 西藏自治区，昌都市，八宿县，帮达镇 · 八宿元哥商务酒店；第一人称行车 / 山地环境 / 阴天 / 无口播语音 / 雪山驾驶 / 积雪山峰 / 弯月高悬 / A mountain range with snow-capped peaks under a cloudy sky with a bri... | 2 |
| 2026-04-30 | 20:31-20:55 | event | `event-pharos-3c8a954fb917` | 左贡县城；左贡晚餐记录。 / 第一人称行车 / 城市街道 / 夜晚 / 有口播语音 / 车内讨论 / 我以为是 / 酒店招牌 / A night scene at a street intersection with illuminated sig... | 9 |
| 2026-04-30 | 21:23-22:08 | route | `route-64a50d42efec` | 行车：西藏自治区，昌都市，八宿县，帮达镇 → 西藏自治区，昌都市，左贡县，田妥镇 · 德达村；第一人称行车 / 公路 / 夜晚 / 有口播语音 / 情景不明 / 夜间行车 / 路牌护栏 / A night-time driving scene on a road with a bright moon in the sky, ill... | 24 |
| 2026-04-30 | 22:27-23:25 | event | `event-pharos-ae77d85382b3` | 左贡县城；到达左贡，口播今日赶路总结。 / 第一人称行车 / 城市街道 / 夜晚 / 有口播语音 / 情景不明 / 夜间行车 / 路边停车 / Nighttime street view with illuminated signs, parked... | 18 |

### 2026-05-01

- events=22；event:14, route:8, gap:0；spanRefs=501。
- 组织建议：从芒康/金沙江到巴塘，重点是入川边界、金沙江大桥和巴塘到达总结；巴塘县城按中型到达事件处理。

| 日期 | 时间(CST) | kind | 事件 id | 地点 / 标题 / chronology 摘要 | spanRefs |
|---|---|---|---|---|---:|
| 2026-05-01 | 09:17-09:40 | event | `event-pharos-1ea0cd6b7e3a` | 左贡县城；口播：今天翻东达山5130m川藏最高垭口，经芒康过金沙江到巴塘。 / 第一人称行车 / 十字路口 / 晴天 / 有口播语音 / 情景不明 / 红绿灯 / 三轮车 / A white car and a red three-wheeled ... | 26 |
| 2026-05-01 | 09:52-10:24 | route | `route-d3b95eec95c5` | 行车：西藏自治区，昌都市，左贡县，旺达镇 · 卓林 → 西藏自治区，昌都市，左贡县，旺达镇；第一人称行车 / 山路环境 / 晴天 / 有口播语音 / 牛群过马路等待 / A red SUV drives on a mountain road, passing a herd of black cattle and a person... | 30 |
| 2026-05-01 | 10:30-10:40 | event | `event-pharos-306b2251beb8` | 东达山垭口上空；航拍运动 / 高速公路 / 晴天 / 无口播语音 / 雪山行车 / 蜿蜒高速 / 护栏 / Aerial view of a winding highway cutting through snow-covered mountains, ... | 4 |
| 2026-05-01 | 10:31-10:35 | event | `event-pharos-8a8bd36ecb18` | 澜沧江大桥/如美镇；跨越澜沧江，峡谷+大桥打卡。 / 第一人称行车 / 高速公路 / 阴天 / 无口播语音 / 高海拔山路驾驶 / 黄色皮卡 / 蜿蜒山路 / A yellow pickup truck drives along a winding moun... | 14 |
| 2026-05-01 | 10:35-10:41 | event | `event-pharos-2674261b964e` | 东达山垭口（海拔5130m）；川藏线最高垭口，高山草甸+雪山环绕+牦牛群。 / 第一人称行车 / 停车场 / 天气光线不明 / 无口播语音 / 停车场观察 / 多辆车 / 绿色垃圾桶 / A parking lot with several cars, a green... | 10 |
| 2026-05-01 | 11:01-11:50 | route | `route-e4fe2952e144` | 行车：西藏自治区，昌都市，芒康县，曲登乡；西藏自治区，昌都市，芒康县，曲登乡；第一人称行车 / 山路 / 晴天 / 无口播语音 / 雪山山路行车 / 黄色车辆 / 混凝土护栏 / A yellow vehicle drives along a winding mountain road with concrete ... | 59 |
| 2026-05-01 | 11:49-12:01 | event | `event-pharos-88e6edbe4dfe` | 觉巴山下澜沧江峡谷；觉巴山下望澜沧江峡谷，深切V型谷。 / 第一人称行车 / 隧道内 / 夜晚 / 无口播语音 / 情景不明 / 隧道行车 / 对向车灯 / A vehicle drives through a dark tunnel, passing a ... | 23 |
| 2026-05-01 | 12:05-12:17 | route | `route-e858d9e8d74a` | 行车：西藏自治区，昌都市，芒康县，如美镇 → 西藏自治区，昌都市，芒康县，如美镇 · 季枫酒店；第一人称行车 / 山路 / 晴天 / 无口播语音 / 白色卡车 / 蓝色路牌 / 蜿蜒道路 / A yellow vehicle drives along a winding mountain road, following a whit... | 23 |
| 2026-05-01 | 12:39-12:39 | event | `event-3ce3482ba256` | 餐桌食物特写；restaurant；固定机位观察 / 室内餐厅 / 天气光线不明 / 无口播语音 / 餐桌食物特写 / 红色桌面 / 豆腐菜肴 / A dining table with a red surface, featuring various dishes inc... | 1 |
| 2026-05-01 | 12:58-12:59 | event | `event-aace1b3513e1` | 用餐场景；西藏自治区，昌都市，芒康县，如美镇 · 季枫酒店；固定机位观察 / 室内餐厅 / 天气光线不明 / 无口播语音 / 用餐场景 / 圆桌 / 菜肴 / A round red table is set with various dishes, including a plate of gr... | 2 |
| 2026-05-01 | 13:02-13:06 | route | `route-81534c676fe2` | 行车：西藏自治区，昌都市，芒康县，如美镇 · 芒康县家常便饭饭店；西藏自治区，昌都市，芒康县，如美镇 · 芒康县家常便饭饭店；第一人称行车 / 山路 / 晴天 / 无口播语音 / 情景不明 / 白色围墙 / 铁丝网 / A road flanked by white walls topped with barbed wire, leading towards a... | 5 |
| 2026-05-01 | 13:05-13:05 | event | `event-8ebc9faf200a` | 介绍南桑江水质；西藏自治区，昌都市，芒康县，如美镇 · 芒康县家常便饭饭店；手持自拍口播 / 南桑江珠卡大桥 / 天气光线不明 / 有口播语音 / 介绍南桑江水质 / 横断山脉峡谷 / 黄水浑浊 / A person stands on a bridge with red and blue railings, o... | 1 |
| 2026-05-01 | 13:15-14:21 | route | `route-d499590550eb` | 行车：西藏自治区，昌都市，芒康县，如美镇 · 芒康县家常便饭饭店 → 西藏自治区，昌都市，芒康县，嘎托镇 · 芒康县雅鑫汽修汽车修理厂；第一人称行车 / 装饰山路 / 晴天 / 有口播语音 / 沿路行驶 / 心形装饰 / 白墙 / A yellow vehicle drives along a road flanked by white walls and heart-s... | 40 |
| 2026-05-01 | 14:23-14:29 | event | `event-pharos-fe48c5c3ca3c` | 芒康县城；芒康午餐补给，滇藏线与川藏线交汇点。 / 第一人称行车 / 县城街道 / 天气光线不明 / 有口播语音 / 路过县城 / 藏式建筑 / 向右行驶 / The video shows a vehicle driving down a str... | 13 |
| 2026-05-01 | 14:35-15:02 | route | `route-95882322d0ca` | 行车：西藏自治区，昌都市，芒康县，嘎托镇 → 西藏自治区，昌都市，芒康县，宗西乡；第一人称行车 / 山路 / 阴天 / 无口播语音 / 山路行车 / 红色卡车 / 牵引油罐车 / A red truck towing a white tanker truck drives on a winding road with ... | 23 |
| 2026-05-01 | 15:03-15:11 | event | `event-5b2052d03003` | 观察猴子；西藏自治区，昌都市，芒康县，宗西乡；车窗外观察 / 山路 / 晴天 / 有口播语音 / 观察猴子 / 岩石坡 / 路边 / Two monkeys are sitting on a rocky slope next to a paved road with yellow m... | 16 |
| 2026-05-01 | 15:11-16:05 | route | `route-96eff316b5e8` | 行车：西藏自治区，昌都市，芒康县，宗西乡 → 西藏自治区，昌都市，芒康县，朱巴龙乡 · 金沙江大桥；细节特写 / 户外岩石 / 天气光线不明 / 无口播语音 / 猴子静坐 / 猴子 / 特写 / A close-up of a monkey sitting calmly on a rocky surface in a natural o... | 66 |
| 2026-05-01 | 16:08-16:29 | event | `event-pharos-65b02a4649df` | 金沙江大桥（川藏界）；金沙江大桥打卡：跨过金沙江从西藏进入四川，仪式感。桥头拍摄。 / 固定机位口播 / 金沙江大拐弯 / 阴天 / 有口播语音 / 川藏交界处介绍 / 红色外套人物 / 金沙江大桥 / A person in a red jacket sta... | 33 |
| 2026-05-01 | 16:12-16:40 | event | `event-pharos-e620d1ef0652` | 金沙江大桥上空；航拍俯瞰 / 峡谷河流 / 阴天 / 无口播语音 / 峡谷航拍 / 河流 / 桥梁 / Aerial view of a turquoise river flowing through a mountain valley with a b... | 12 |
| 2026-05-01 | 16:41-17:03 | route | `route-12b1dd27158b` | 行车：四川省，甘孜藏族自治州，巴塘县，竹巴龙乡 → 四川省，甘孜藏族自治州，巴塘县，夏邛镇；第一人称行车 / 山路 / 天气光线不明 / 有口播语音 / 山路行车 / 土路 / 河流 / A yellow vehicle drives along a winding road beside a river, with steep... | 36 |
| 2026-05-01 | 17:06-17:27 | event | `event-pharos-a0707a8cfd99` | 巴塘县城；到达巴塘，口播今日总结，正式回到四川。 / 第一人称行车 / 十字路口 / 晴天 / 有口播语音 / 情景不明 / 红绿灯 / 三轮车 / A white car and a red three-wheeled vehicle are d... | 39 |
| 2026-05-01 | 18:55-20:15 | event | `event-pharos-6729d2481588` | 巴塘县城；巴塘晚餐，川菜回归。 / 车窗外观察 / 商业街巷 / 天气光线不明 / 无口播语音 / 白色 SUV 驶过 / 洗车店招牌 / 红色踏板车 / A street scene with a white SUV driving past s... | 25 |

### 2026-05-02

- events=26；event:14, route:12, gap:0；spanRefs=861。
- 组织建议：格聂南线铺垫，大雪、烂路、冷古寺、住宿补给构成第二穿越高潮前半。

| 日期 | 时间(CST) | kind | 事件 id | 地点 / 标题 / chronology 摘要 | spanRefs |
|---|---|---|---|---|---:|
| 2026-05-02 | 08:48-09:40 | event | `event-pharos-c76b957d5129` | 巴塘县城；口播：今天反穿格聂南线到格聂之眼，傍晚主拍格聂之眼日落→月光延时。 / 车窗外观察 / 餐厅 / 室内灯光 / 有口播语音 / 早餐 buffet / 自助餐 / 食物 / The buffet counter features stai... | 8 |
| 2026-05-02 | 09:46-09:59 | route | `route-3cfdad8dc03a` | 行车：四川省，甘孜藏族自治州，巴塘县，夏邛镇 · 巴塘圆梦酒店 → 四川省，甘孜藏族自治州，巴塘县，夏邛镇 · 巴久曲1号大桥；第一人称行车 / 城市街道 / 晴天 / 有口播语音 / 车辆观察 / 黑色 SUV / 贴标 / A black SUV drives down a tree-lined street with Chinese flags and bu... | 62 |
| 2026-05-02 | 10:01-10:01 | event | `event-ded4d72e30b5` | 四川省，甘孜藏族自治州，巴塘县，夏邛镇 · 巴久曲1号大桥；第三人称跟拍 / 车内 / 天气光线不明 / 无口播语音 / 情景不明 / A man with curly hair and glasses sits in the front passenger seat of a car, hold... | 1 |
| 2026-05-02 | 10:03-10:44 | route | `route-eb0750fd6b9f` | 行车：四川省，甘孜藏族自治州，巴塘县，夏邛镇 · 红军渠 → 四川省，甘孜藏族自治州，巴塘县，夏邛镇；第一人称行车 / 山路 / 天气光线不明 / 有口播语音 / 山路行车 / 白色车辆 / 蜿蜒山路 / A white car drives ahead on a winding mountain road flanked by stee... | 87 |
| 2026-05-02 | 10:45-11:01 | event | `event-pharos-2af6eab6a43c` | 扎瓦拉观景台；格聂南线出发不久，半山腰遇到小雪 / 第一人称行车 / 山路 / 雾天 / 有口播语音 / 山路行车 / 碎石坡 / 雾气 / A yellow vehicle travels along a winding mountain road ... | 34 |
| 2026-05-02 | 11:08-11:16 | route | `route-d6dcc9c7bd06` | 行车：四川省，甘孜藏族自治州，巴塘县，夏邛镇；四川省，甘孜藏族自治州，巴塘县，夏邛镇；第一人称行车 / 蜿蜒山路 / 阴天 / 有口播语音 / 山路驾驶 / 雪山背景 / 摩托车行驶 / A motorcycle travels on a winding mountain road with a large, snow-d... | 24 |
| 2026-05-02 | 11:17-11:29 | event | `event-pharos-3acd0d3a4e1d` | 扎瓦拉垭口上空；航拍雪山垭口全景+盘山公路，海拔5020m电池严重衰减 / 第一人称行车 / 山路 / 阴天 / 有口播语音 / 山路行车中 / 黄色车辆 / 湿滑路面 / A yellow vehicle drives on a wet mountai... | 4 |
| 2026-05-02 | 11:19-11:29 | event | `event-pharos-7de1386f3f45` | 扎瓦拉垭口（海拔5020m）；格聂南线最高垭口，360°雪山全景，垂直落差2500m起点。 / 第一人称行车 / 山路 / 阴天 / 有口播语音 / 山路打卡中 / 黄色车辆 / 停车打卡 / A yellow car drives along a mountain ... | 7 |
| 2026-05-02 | 11:30-11:33 | route | `route-8344d7c695f1` | 行车：四川省，甘孜藏族自治州，巴塘县，波密乡；四川省，甘孜藏族自治州，巴塘县，波密乡；环境远景 / 山地环境 / 晴天 / 无口播语音 / 登顶庆祝 / 越野车辆 / 岩石山坡 / A person celebrates triumphantly atop a yellow off-road vehicle parked ... | 2 |
| 2026-05-02 | 11:34-11:49 | event | `event-pharos-a0caf2fd5817` | 扎瓦拉观景台；航拍跟车驶入山谷 / 第三人称跟拍 / 悬崖山路 / 阴天 / 无口播语音 / 雪山行车 / 崎岖地形 / 积雪山峰 / A yellow SUV drives along a winding mountain road carved i... | 37 |
| 2026-05-02 | 11:49-12:24 | route | `route-7061567f7b6d` | 行车：四川省，甘孜藏族自治州，巴塘县，波密乡 → 四川省，甘孜藏族自治州，巴塘县，波密乡 · 达休阔；第一人称行车 / 山路 / 阴天 / 有口播语音 / 山路行车中 / 黄色车辆 / 蜿蜒山路 / A yellow vehicle drives along a winding mountain road with snow-capped... | 82 |
| 2026-05-02 | 12:25-13:28 | event | `event-pharos-2b2ca69d16fb` | 格木村（中国阿尔卑斯）；格木景区高山草甸+雪山，被称为中国阿尔卑斯。 / 第一人称行车 / 山地环境 / 阴天 / 有口播语音 / 寻找停车吃饭 / 土路 / 雪山背景 / A vehicle drives through a mountain village ... | 55 |
| 2026-05-02 | 13:31-13:32 | route | `route-c3995766d8ff` | 行车：四川省，甘孜藏族自治州，巴塘县，波密乡；四川省，甘孜藏族自治州，巴塘县，波密乡；第一人称行车 / 山路 / 下雪/雨夹雪 / 有口播语音 / 山路行车遇雪 / 黄色车辆 / 蜿蜒山路 / A yellow vehicle drives along a winding mountain road through a v... | 2 |
| 2026-05-02 | 13:31-13:31 | route | `route-7200fc49babf` | 行车：四川省，甘孜藏族自治州，巴塘县，波密乡；四川省，甘孜藏族自治州，巴塘县，波密乡；第一人称行车 / 山地环境 / 阴天多云 / 无口播语音 / 山路行车穿行 / 黄色车辆 / 绿色山坡 / A yellow vehicle drives along a paved road through a mountainous ... | 1 |
| 2026-05-02 | 13:32-13:59 | event | `event-pharos-e7256d61c40f` | 格木村上空；航拍高山牧场+雪山全景 / 第一人称行车 / 森林山谷公路 / 阴天多云 / 无口播语音 / 山路行车穿行 / 黄色车辆 / 森林覆盖 / A yellow vehicle drives along a paved road throug... | 40 |
| 2026-05-02 | 14:09-14:21 | route | `route-193070596f8e` | 行车：四川省，甘孜藏族自治州，巴塘县，波密乡；四川省，甘孜藏族自治州，巴塘县，波密乡；第一人称行车 / 盘山公路 / 晴天 / 有口播语音 / 情景不明 / 黄色护栏 / 森林山坡 / A vehicle travels along a winding mountain road with yellow center li... | 18 |
| 2026-05-02 | 14:31-14:59 | event | `event-pharos-93f7ab9210d8` | 格聂南线忽然遇到大雪；格聂南线途中偶遇大雪 / 第一人称行车 / 山路 / 下雪 / 无口播语音 / 山路行车 / A vehicle travels along a winding mountain road through a misty forest, ... | 79 |
| 2026-05-02 | 15:03-15:28 | route | `route-c8578e31d43a` | 行车：四川省，甘孜藏族自治州，巴塘县，波密乡；四川省，甘孜藏族自治州，巴塘县，波密乡；第一人称行车 / 山路 / 下雪 / 有口播语音 / 雪山行车 / 防滑模式 / 路边行人 / A car drives on a snowy mountain road with a person standing beside a s... | 48 |
| 2026-05-02 | 15:31-15:44 | event | `event-pharos-7bf05ab1c492` | 格聂南线大雪林中烂路；林中烂路，旁边河谷 / 第一人称行车 / 山路 / 阴天 / 有口播语音 / 冬季景色感叹 / 湿滑路面 / 溪流景观 / A vehicle travels on a wet mountain road through a snowy ... | 31 |
| 2026-05-02 | 15:48-15:48 | event | `event-9f521af56bc0` | 车内整理装备；四川省，甘孜藏族自治州，理塘县，格聂镇；车内自拍口播 / 车内 / 晴天 / 有口播语音 / 车内整理装备 / 红色外套 / 毛巾脱困板 / A person in a red jacket sits in a car, first looking at the camera,... | 1 |
| 2026-05-02 | 15:51-16:34 | route | `route-82c92537d3f0` | 行车：四川省，甘孜藏族自治州，理塘县，格聂镇；四川省，甘孜藏族自治州，理塘县，格聂镇；第一人称行车 / 山路 / 雾天 / 有口播语音 / 山路行车讨论路况 / 湿滑路面 / 积雪 / A vehicle travels along a wet, unpaved road through a rocky, mountain... | 84 |
| 2026-05-02 | 16:41-16:44 | event | `event-pharos-57d44f64f935` | 则通村前；则通村前跟车航拍 / 第一人称行车 / 泥泞山路 / 阴天 / 无口播语音 / 雾中山景 / 松林草地 / 越野驾驶 / A yellow SUV drives along a muddy, unpaved road through a ... | 2 |
| 2026-05-02 | 16:47-17:15 | route | `route-6a180e98f455` | 行车：四川省，甘孜藏族自治州，理塘县，格聂镇 · 格聂秘境民宿 → 四川省，甘孜藏族自治州，理塘县，格聂镇 · 呷朴马；第一人称行车 / 石砌村落 / 雨天 / 有口播语音 / 泽巴村隔离城山观景 / 湿滑路面 / 雪山背景 / A vehicle drives through a rural village with stone buildings, w... | 57 |
| 2026-05-02 | 17:20-17:31 | event | `event-pharos-614913118e8c` | 冷古寺；大雪中的冷古寺 / 第一人称行车 / 建筑外观 / 下雪 / 有口播语音 / 寺庙外观介绍 / 红色外套人物 / 黄色建筑 / A person in a red coat walks through a snowy landscape ... | 13 |
| 2026-05-02 | 17:59-18:39 | route | `route-e797107c3bad` | 行车：四川省，甘孜藏族自治州，理塘县，格聂镇 → 四川省，甘孜藏族自治州，理塘县，格聂镇 · 下则通村；第一人称行车 / 山路 / 雾天 / 有口播语音 / 山路行车 / 湿滑路面 / 雾气 / A wet road winds through a foggy mountain landscape with scattered rocks ... | 43 |
| 2026-05-02 | 18:40-20:01 | event | `event-pharos-9fdb2294b538` | 然日卡巴村村民委员会；然日卡村住宿，吃饭 / 第一人称行车 / 民宿庭院 / 雨天 / 有口播语音 / 牦牛包围住宿点 / 三层石楼 / 湿滑路面 / The video shows a wet road with vehicles and buildings... | 39 |

### 2026-05-03

- events=19；event:12, route:7, gap:0；spanRefs=658。
- 组织建议：格聂之眼日出、理塘补给、新都桥和贡嘎方向推进，强调雪地经验与人物疲劳。

| 日期 | 时间(CST) | kind | 事件 id | 地点 / 标题 / chronology 摘要 | spanRefs |
|---|---|---|---|---|---:|
| 2026-05-03 | 05:17-07:23 | event | `event-pharos-41eb297de11a` | 格聂之眼；日出前口播：先拍月落转日照金山，若风力合适再补一组格聂之眼清晨俯拍，然后赶路去子梅垭口。；第三视角拍摄：摄影师在清晨架设月落→日照金山机位，记录现场判断与转光过程。 / 固定机位观察 / 车内后座 / 夜晚 / 无口播语音 / 车内人物特... | 73 |
| 2026-05-03 | 06:29-07:09 | event | `event-pharos-2ec8f48d7045` | 格聂之眼上空；航拍运动 / 山地环境 / 阴天 / 无口播语音 / 高原公路全景 / 积雪覆盖 / 木质护栏 / A wide-angle view of a paved road stretching through a vast, snow-dus... | 25 |
| 2026-05-03 | 07:46-07:59 | event | `event-pharos-2ec5ed648f74` | 格聂之眼到然日卡村网红公路；环境远景 / 山路 / 阴天 / 无口播语音 / 山路行车场景 / 黄色皮卡 / 积雪山坡 / A yellow pickup truck drives along a serpentine mountain road flanked b... | 6 |
| 2026-05-03 | 08:00-08:00 | event | `event-2f25e0de384f` | 山村行车；四川省，甘孜藏族自治州，理塘县，格聂镇 · 理塘格聂云端凡奢民宿；航拍俯瞰 / 山路 / 晴天 / 无口播语音 / 山村行车 / 蜿蜒道路 / 雪山背景 / Aerial view of a winding road through a village with snow-capped mountain... | 1 |
| 2026-05-03 | 08:03-08:04 | route | `route-306c6ae856b1` | 行车：四川省，甘孜藏族自治州，理塘县，格聂镇 · 下则通村；四川省，甘孜藏族自治州，理塘县，格聂镇 · 下则通村；第一人称行车 / 村庄道路 / 阴天 / 有口播语音 / 路过马群 / 白色佛塔 / 雪山背景 / A yellow vehicle drives down a paved road through a village, passing ... | 2 |
| 2026-05-03 | 08:35-09:08 | event | `event-pharos-5947d46d04fb` | 然日卡巴村村民委员会；然日卡村吃饭，以及出发前口播 / 车内自拍口播 / 室内用餐环境 / 室内灯光 / 有口播语音 / 车内讨论用餐 / The frames show the interior of a room with orange paneled w... | 17 |
| 2026-05-03 | 09:10-09:49 | route | `route-7dc12e25fecd` | 行车：四川省，甘孜藏族自治州，理塘县，格聂镇 · 格聂高原民宿(格聂镇店) → 四川省，甘孜藏族自治州，理塘县，格聂镇；第一人称行车 / 山路 / 阴天 / 有口播语音 / 车内讨论路况 / 黄色车辆 / 雪山背景 / A yellow vehicle travels on a paved road through a mountainous landsc... | 37 |
| 2026-05-03 | 09:50-09:50 | event | `event-41b9881b4ad1` | 猴群互动；四川省，甘孜藏族自治州，理塘县，格聂镇；细节特写 / 石墙背景 / 阴天 / 无口播语音 / 猴群互动 / A mother monkey holding her baby sits on a stone wall with snow-covered rocks in the ... | 1 |
| 2026-05-03 | 09:58-10:08 | route | `route-e8a4ac167417` | 行车：四川省，甘孜藏族自治州，理塘县，格聂镇；四川省，甘孜藏族自治州，理塘县，格聂镇；第一人称行车 / 山地环境 / 阴天 / 无口播语音 / 雪山行车中 / 沥青路面 / 积雪覆盖 / A winding asphalt road curves through a snow-covered mountainous lan... | 18 |
| 2026-05-03 | 10:14-10:14 | event | `event-8b63cbcf2ab1` | 雪山湖泊景观；四川省，甘孜藏族自治州，理塘县，禾尼乡；环境远景 / 湖泊 / 天气光线不明 / 无口播语音 / 雪山湖泊景观 / 积雪覆盖 / 岩石水面 / A snow-covered mountain slopes down to a calm lake with visible roc... | 1 |
| 2026-05-03 | 10:19-10:20 | route | `route-efd8e3e8fa3f` | 行车：四川省，甘孜藏族自治州，理塘县，禾尼乡；四川省，甘孜藏族自治州，理塘县，禾尼乡；第一人称行车 / 公路 / 阴天 / 有口播语音 / 涉水行驶 / 积雪 / 岩石 / A yellow vehicle drives along a wet, two-lane road through a snowy, rocky l... | 7 |
| 2026-05-03 | 10:23-10:45 | event | `event-pharos-75ae6ba14c4b` | 格聂南线然日卡村到理塘下山；路面结冰，不断遇到趴窝的车等等事件，使用雪地模式，以及冰面行驶的无人机跟车 / 第一人称行车 / 山路 / 晴天 / 有口播语音 / 安装防滑链 / 车辆停靠 / 人员站立 / A snowy mountain road with a g... | 50 |
| 2026-05-03 | 11:08-11:19 | route | `route-c7b1d88ae091` | 行车：四川省，甘孜藏族自治州，理塘县，奔戈乡；四川省，甘孜藏族自治州，理塘县，奔戈乡；第一人称行车 / 车内 / 晴天 / 有口播语音 / 驾驶破晓首次 / 雪地模式 / 驾驶信心 / A person in a red jacket drives a car with two passengers in the back... | 26 |
| 2026-05-03 | 11:19-12:31 | event | `event-pharos-5f05219a3566` | 理塘县城；理塘午餐补给，世界高城打卡。 / 第一人称行车 / 石门前 / 阴天 / 有口播语音 / 离开阁涅 / 返船 / 石门 / A yellow vehicle drives along a paved road toward a stone... | 56 |
| 2026-05-03 | 12:34-16:32 | route | `route-39b65d2ffd59` | 行车：四川省，甘孜藏族自治州，理塘县，高城镇 → 四川省，甘孜藏族自治州，康定市，新都桥镇 · 贡嘎雪山观景台；第一人称行车 / 隧道 / 天气光线不明 / 有口播语音 / 隧道行车 / 礼堂隧道 / 黄色车辆 / A yellow vehicle drives through a tunnel with curved concrete walls... | 126 |
| 2026-05-03 | 16:34-16:35 | event | `event-pharos-4b3f44986c23` | 新都桥；驶入248国道前，一位同伴身体不适，提前下车 / 第一人称行车 / 山路 / 晚霞 / 有口播语音 / 车内休息讨论 / 夕阳酒店 / 朋友下车 / A person with curly hair and glasses wearing... | 6 |
| 2026-05-03 | 16:36-18:12 | route | `route-7751a3748bb7` | 行车：四川省，甘孜藏族自治州，康定市，新都桥镇 · 贡嘎雪山观景台 → 四川省，甘孜藏族自治州，康定市，贡嘎山镇；第一人称行车 / 乡村道路 / 阴天 / 无口播语音 / 乡村路段行驶 / 蓝色路牌 / 右侧停车 / The video shows a wet road with trees on both sides, a blue road si... | 95 |
| 2026-05-03 | 18:15-18:49 | event | `event-pharos-cc3d1261d447` | 贡嘎山镇003乡道；003乡道的非铺装路段，大雪，赶时间快速通过。 / 第一人称行车 / 车内 / 天气光线不明 / 有口播语音 / 行车途中 / 红色外套女性 / 车内乘客 / A woman in a red jacket drives a car wi... | 91 |
| 2026-05-03 | 18:50-20:33 | event | `event-pharos-01f217b6c116` | 贡噶山居(上木居村店)；上木居村住宿，吃饭 / 手持自拍口播 / 藏式建筑前 / 天气光线不明 / 无口播语音 / 自拍记录形象 / 卷发男子 / 红色外套 / A man with curly hair and glasses wearing a red ja... | 20 |

### 2026-05-04

- events=15；event:12, route:3, gap:0；spanRefs=560。
- 组织建议：子梅垭口戏剧核心：雪夜硬上、航拍跟车、找回无人机、送别同伴、独自折返、等待贡嘎。

| 日期 | 时间(CST) | kind | 事件 id | 地点 / 标题 / chronology 摘要 | spanRefs |
|---|---|---|---|---|---:|
| 2026-05-04 | 04:51-05:55 | event | `event-pharos-16ca86951a00` | 上木居村民宿到子梅垭口；早起出发子梅垭口，还在下雪，很冷，后半段没有车辙，硬着头皮压着积雪上去。 / 车窗外观察 / 建筑外观 / 夜晚 / 无口播语音 / 雪地车辆停放 / 黄色 SUV / 积雪覆盖 / A yellow SUV covered in sno... | 141 |
| 2026-05-04 | 06:00-06:33 | event | `event-pharos-2a0e39b75f72` | 子梅垭口（海拔4500m）；第一人称行车 / 公路 / 下雪 / 无口播语音 / 夜间雪地行车 / 雪夜行车 / 车灯照亮 / A dark, snowy night scene captured from a moving vehicle, showing ill... | 29 |
| 2026-05-04 | 06:24-06:25 | event | `event-pharos-88a0d23a18d0` | 子梅垭口上空；航拍俯瞰 / 环境不明 / 阴天 / 无口播语音 / 孤独人物远观 / 雪景 / 路标 / A person in a long coat stands alone in a vast, snow-covered landscape un... | 2 |
| 2026-05-04 | 06:38-07:57 | event | `event-pharos-148bdc64b334` | 子梅垭口；航拍跟车下山，堵车，天气忽然放晴，炸机找本地人捡回。 / 第一人称行车 / 山地环境 / 晴天 / 无口播语音 / 雪地驾驶 / 黄色 SUV / 高海拔 / A yellow SUV drives along a snow-covere... | 97 |
| 2026-05-04 | 08:36-08:37 | event | `event-3d6d180e3403` | 准备出发前往新都桥；四川省，甘孜藏族自治州，康定市，贡嘎山镇 · 朔布村；手持自拍口播 / 民宿前广场 / 晴天 / 有口播语音 / 准备出发前往新都桥 / 传统建筑 / 黄色 SUV / A person with curly hair and glasses stands in front of a yel... | 1 |
| 2026-05-04 | 08:41-09:39 | route | `route-e761ac2689c3` | 行车：四川省，甘孜藏族自治州，康定市，贡嘎山镇 · 朔布村 → 四川省，甘孜藏族自治州，康定市，贡嘎山镇 · 色乌绒村；第一人称行车 / 车内驾驶舱 / 晴天 / 有口播语音 / 电量焦虑 / 数字仪表盘 / 导航屏幕 / The images show a car's digital dashboard and navigation screen dis... | 55 |
| 2026-05-04 | 09:41-09:41 | event | `event-672253207e01` | 翻车机位记录；四川省，甘孜藏族自治州，康定市，贡嘎山镇 · 拉擦；手持自拍口播 / 车内 / 晴天 / 有口播语音 / 翻车机位记录 / 新多桥 / 放晴 / A person with curly hair and glasses sits in a car, wearing a maroon jac... | 1 |
| 2026-05-04 | 11:16-12:48 | event | `event-pharos-4f12f626a59b` | 新都桥；天气放晴，决定独自改签折返子梅垭口，送别同伴。 / 手持自拍口播 / 户外建筑前 / 天气光线不明 / 有口播语音 / 情景不明 / 卷发戴眼镜 / 红色外套 / A person with curly hair and glasses ... | 11 |
| 2026-05-04 | 12:59-15:41 | route | `route-d31dfa1e207f` | 行车：四川省，甘孜藏族自治州，康定市，新都桥镇 · 营关养护管理站 → 四川省，甘孜藏族自治州，康定市，贡嘎山镇 · 朔布村；第一人称行车 / 山路 / 雨天 / 有口播语音 / 山路行车 / 雪山背景 / 绿色丘陵 / A yellow vehicle drives along a paved road through a mountainous region... | 71 |
| 2026-05-04 | 15:46-15:47 | event | `event-e939d92bade5` | 室内静物；四川省，甘孜藏族自治州，康定市，贡嘎山镇 · 朔布村；固定机位观察 / 室内场景 / 天气光线不明 / 无口播语音 / 室内静物 / 橘猫 / 动物头骨 / An orange cat sits on a red stone ledge next to a potted plant, wit... | 2 |
| 2026-05-04 | 16:06-16:06 | event | `event-89dfcd01aa23` | 民宿入住出发；四川省，甘孜藏族自治州，康定市，贡嘎山镇 · 朔布村；手持自拍口播 / 车内 / 晴天 / 有口播语音 / 民宿入住出发 / 卷发男子 / 保温杯 / A person with curly hair and glasses sits in a car, holding up a black... | 1 |
| 2026-05-04 | 16:10-16:49 | route | `route-232d27f7e8d6` | 行车：四川省，甘孜藏族自治州，康定市，贡嘎山镇 · 仰佩林民宿 → 四川省，甘孜藏族自治州，康定市，贡嘎山镇 · 子梅垭口；第一人称行车 / 山村入口 / 天气光线不明 / 有口播语音 / 正式出发 / 石砌建筑 / 木门窗 / A yellow vehicle drives past a stone building with wooden doors an... | 24 |
| 2026-05-04 | 16:49-23:22 | event | `event-pharos-9f61d74632a8` | 子梅垭口；折返子梅垭口，独自拍摄 / 第一人称行车 / 山地环境 / 晴天 / 无口播语音 / 雪山路段停车等待 / 泥泞路面 / 多车停放 / A muddy road with several cars parked on both sides... | 94 |
| 2026-05-04 | 19:05-23:25 | event | `event-pharos-c30fa429a148` | 子梅垭口；环境远景 / 车内 / 雪景 / 无口播语音 / 雪山拍摄准备 / 豪华车内 / 双机位架设 / A view from inside a luxury car looking out at a serene snowy mountain... | 28 |
| 2026-05-04 | 23:52-23:53 | event | `event-b6f95bcf1b96` | 晴朗雪山云海；四川省，甘孜藏族自治州，康定市，贡嘎山镇 · 子梅垭口；延时记录 / 山地环境 / 晴天 / 无口播语音 / 晴朗雪山云海 / 蓝天白云 / 山峰积雪 / Snow-covered mountain peaks under a clear blue sky with scattered clo... | 3 |

### 2026-05-05

- events=12；event:9, route:3, gap:0；spanRefs=260。
- 组织建议：返程收束：上木居出发、新都桥、长距离回成都、机场短事件落地。

| 日期 | 时间(CST) | kind | 事件 id | 地点 / 标题 / chronology 摘要 | spanRefs |
|---|---|---|---|---|---:|
| 2026-05-05 | 00:02-00:50 | event | `event-pharos-3aa08efc7583` | 子梅垭口到上木居村；深夜从子梅垭口下山，返回上木居村住宿。 / 车内自拍口播 / 车内空间 / 夜晚 / 无口播语音 / 车内静坐 / 戴眼镜男子 / 穿着外套 / A person wearing glasses and a coat is seated ... | 18 |
| 2026-05-05 | 08:39-08:42 | event | `event-pharos-b2e6ec3a47ab` | 上木居村；正式出发返程 / 车窗外观察 / 山村 / 晴天 / 无口播语音 / 营地标识 / 雪山 / 村庄 / The frames show a mountainous landscape with a village, a snow-capp... | 3 |
| 2026-05-05 | 09:02-11:09 | route | `route-ccb22fa0a3dc` | 行车：四川省，甘孜藏族自治州，康定市，贡嘎山镇 · 贡噶星空民宿 → 四川省，甘孜藏族自治州，康定市，新都桥镇 · 印象木雅酒店(新都桥店)；第一人称行车 / 山谷公路 / 晴天 / 有口播语音 / 车内讨论路况 / 雪山远景 / 铺装路面 / A vehicle travels along a paved road through a mountain valley with... | 35 |
| 2026-05-05 | 11:13-11:54 | event | `event-pharos-676cf9de7f02` | 新都桥；环境远景 / 建筑前 / 晴天 / 无口播语音 / 车辆停靠拍摄 / 黄色 SUV / 雪山壁画 / A yellow SUV is parked in front of a building with a large mural of ... | 7 |
| 2026-05-05 | 11:57-18:17 | route | `route-ac9bb623fc5b` | 行车：四川省，甘孜藏族自治州，康定市，新都桥镇 · 贡嘎雪山观景台 → 四川省，成都市，简阳市，芦葭镇 · 空港立交出口(西南向)；第一人称行车 / 城镇街道 / 晴天 / 无口播语音 / 城镇穿行 / 传统建筑 / 蓝天 / A yellow vehicle drives along a paved road through a town with traditio... | 182 |
| 2026-05-05 | 18:20-18:33 | event | `event-pharos-caa41667d0a3` | 成都；环境远景 / 服务区 / 晴天 / 无口播语音 / 驶入服务区 / 黄色皮卡 / 传统建筑 / A yellow pickup truck drives through the entrance of Mei Shan Service A... | 6 |
| 2026-05-05 | 18:35-18:35 | event | `event-0d3acdb15fbb` | 车辆停放观察；四川省，成都市，简阳市，石板凳街道 · 成都天府国际机场1号航站楼；车窗外观察 / 停车场 / 天气光线不明 / 无口播语音 / 车辆停放观察 / 黑色 SUV / 石球旁 / A black SUV with yellow decals is parked in a lot, with a man si... | 1 |
| 2026-05-05 | 18:35-18:36 | route | `route-e25433901190` | 行车：四川省，成都市，简阳市，石板凳街道 · 成都天府国际机场1号航站楼；四川省，成都市，简阳市，石板凳街道 · 成都天府国际机场1号航站楼；第一人称行车 / 山区公路 / 天气光线不明 / 无口播语音 / 车队行驶 / A black SUV with a spare tire on the back is driving on a road, surrounded by o... | 3 |
| 2026-05-05 | 18:56-18:56 | event | `event-c69dfcde9d73` | 机场候机；airport terminal；固定机位观察 / 机场大厅 / 晴天 / 有口播语音 / 机场候机 / 丁达尔效应 / 旅客剪影 / Sunlight streams through large windows into an airport terminal, cas... | 1 |
| 2026-05-05 | 18:58-18:59 | event | `event-81635e23ac8f` | 机场取票；airport；环境远景 / 机场航站楼 / 晴天 / 无口播语音 / 机场候机 / 阳光充足 / 旅客 / A wide-angle view of a sunlit airport terminal with travelers waiting ne... | 2 |
| 2026-05-05 | 18:59-18:59 | event | `event-8752406730df` | 准备登机前观察；airport；细节特写 / 机场候机厅 / 天气光线不明 / 无口播语音 / 准备登机前观察 / 腿部特写 / 登机牌 / The frames show a person's legs on a speckled floor and a close-... | 1 |
| 2026-05-05 | 19:00-19:00 | event | `event-66669c3bc338` | 查看安全须知；airport；车窗外观察 / 飞机客舱 / 室内灯光 / 无口播语音 / 查看安全须知 / 橙色卡片 / 四川航空 / A person holds an orange exit seat notification card from Sichuan ... | 1 |

## 全局剪辑规则落点

- 行车部分按时间顺序保留连续性；重复窗口中，若后续素材召回发现无人机跟车与无口播第一视角重复，优先使用无人机跟车，第一视角只做路况/口播/连接。
- 行车之外，同一事件中不同类型的视频，航拍要聚在一起排列插入在普通视频之中，照片要聚在一起排列在最后，默认每张约 1s。
- 单 span 短事件优先作为转场、节奏钉点或信息点，不单独撑成段落，除非后续素材级事实证明有关键口播或关键画面。
- 本表只组织事件级 chronology truth；静音、加速、具体取舍交给 `material.archive` / `material.recall`。

## 缺口与人工审查点

- `gap-c53de20a6296`：八卦田延时摄影缺口，需人工确认是素材缺失、未分析命中，还是用普通八卦田素材替代。
- `event-pharos-44fccdaeb0be`：当前 confirmed truth 为 2026-04-27 08:55-08:58、10 span refs 的抚仙湖退房/上车短事件；后续进怒江素材从相邻 route 处理。
- `event-pharos-a0707a8cfd99`：当前 confirmed truth 为 2026-05-01 17:06-17:27、39 span refs 的巴塘县城到达/总结事件；巴塘后续活动由独立事件处理。
- 高密度 route 仍需后续拆节奏：`route-ac9bb623fc5b`、`route-918a3d2f990a`、`route-80152945a92e`、`route-caf6ee3d91ec`、`route-39b65d2ffd59`。
- 多个地面/航拍重叠节点应合并处理：德姆拉山口、然乌湖、金沙江大桥、扎瓦拉、格聂之眼、子梅垭口。
- 机场尾声部分地点字段仍可能较泛，统一归入成都天府机场上下文，避免后续结构误判为空间缺失。
- 本阶段未读取 spans 或 asset reports，因此不在 event-table 阶段硬判静音、照片类型或具体素材取舍。
