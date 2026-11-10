# RCM 输入统一与视觉分组

## 2026-11-10：统一七节点模板

用户确认横屏、原生竖屏及 ±90° 素材统一使用 `config/default.drt`，不再按方向维护不同调色模板。新的 Clip 顺序固定为 `Gyroflow → Dehaze → User1 → User2 → Beauty → Blemish Removal → Noise Reduction`；以用户在 `调色分类 scene-v5 20261106 [Color]` 的 C4786.MP4 上制作的七节点为效果参数来源。技术还原仍由 RCM 在 Group Pre 之前完成。

- 原片独立 probe 仍决定竖屏分类与 Edit Transform：`+90 → -90`、`-90/270 → +90`、原生竖屏无 quarter-turn 为 0。既有 fill/framing 算法不变；Analyze 不参与方向判断。
- 新建片段只从统一七节点 DRT seed；Gyroflow 按 gyroEligible 开启，Dehaze/NR 默认关闭，User1/User2 默认开启，Beauty/Blemish 只对已接受的 presenter 主类默认开启。不新增自适应肤色限定器或效果参数推断。
- 重复 Prepare 保留既有节点及人工参数；已有五节点作为兼容结构保留，不能因模板 hash 或旧 portrait key 改变而 ResetAllGrades。已有七节点必须识别 Beauty/Blemish 的独立角色，不能把它们当 User 区或把第 5 节点当 NR。同组重复准备不覆盖人工开关；明确从 presenter 移出时关闭美颜对，进入 presenter 时开启。
- 历史 portrait 模板 key 只作历史审计，新请求统一 default；旧模板文件退出正式路径。保留旧片段实际 seed hash，不冒充已套用新模板。存量五节点的增补迁移须有单独可验证的非破坏性路径，本轮不全图覆盖。
- 模板清理不得把来源素材的路径、镜头、Gyroflow 状态缓存当通用参数。保留用户效果设置；清理和原生导入须有审计。DRT 压缩必须声明 Zstandard frame content size。
- 验收：原生导入严格七节点及 presenter/non-presenter 开关；重复 Prepare 保留节点、Inspector 和 Group 前后层；同时运行宿主/管线测试、根仓和 Console 构建。用户本轮明确暂缓竖屏实际效果验证：Gyroflow Load 后会自行改变角度，另行处理；本轮不修改旋转规则、不继续渲染验证、不宣称 Gyroflow 加载/稳定/方向效果通过。

### 本轮验收记录

Resolve Studio 21.2.0.6，独立 `Kairos 统一七节点验证 20261110` / `Unified Seven Real Sources`。C4786、C4922、C4540 原生导入统一七节点，presenter 的 5/6 开启、其它主类关闭，NR 为第 7 节点。额外将验证副本 C4994 设置为历史五节点，给两种结构加入手调 CDL、标签、Inspector 与人工开关后重复正式 host Prepare：四条 item 身份、范围、属性与开关完全保留，8 份 Clip/Group grade versions 经连续无修改导出控制后无参数差异，历史 portrait seed key/hash 保留。C4786 验证副本进出 presenter 时仅两个美颜开关按约定变化，其余手调保留。

87 项宿主/执行器/RCM/管线测试、根仓 `pnpm build` 与 Console build 通过。原 scene-v5 工程的 C4786 七节点与其他旧五节点未批量重套，原工程已保存恢复备份。源模板提取、逐字段清理审计、原生导入与保留性比较位于 Git 忽略的 `projects/tmp-color-v5-20261106/.fixtures/unified-seven-20261110/`。本轮只清理 Gyroflow 的 ProjectPath/LoadedProject/LoadedLens/Status 来源缓存，保留用户节点效果参数；所有角度与实际 Gyroflow 效果问题按用户要求留待后续。

### 崩溃日志复核与验收边界

2026-11-10 日志复核确认，保留的五份 crash dump 分别发生于 11 月 9 日 13:52、17:10 和 11 月 10 日 13:21、15:08、17:09。前四次为 SIGSEGV，堆栈共同涉及 Resolve DVIP GPU 图像处理，其中两次包含 OFX 平面/交错图像转换；最后一次为 SIGTRAP，涉及 Metal/IOGPU command queue/buffer 释放，发生在 Resolve 恢复活动、Color 页播放约四秒后。原生符号可能不完整，不能据此认定某个插件为根因。

15:08 的崩溃发生在独立七节点验证工程切入 Color 页时，先前“脚本连接/句柄失效”的解释应由此证据纠正。结构、开关、手调保留与代码测试结果仍有效，但不代表播放、页面切换或效果运行稳定性通过。类似堆栈在统一七节点接入前已有记录；当前也没有明确的内存耗尽日志，不能直接归咎于七节点模板、Gyroflow、Beauty 或瑕疵移除。本轮尚未进行逐项效果隔离复现，也未修复崩溃。

原始日志副本和诊断记录保存在 Git 忽略的 `projects/tmp-color-v5-20261106/.fixtures/resolve-crash-20261110/`；本地七节点验证状态已修正为 `structural-checks-passed-runtime-stability-unresolved`。后续稳定性验证使用备份保护的独立副本和同一素材，逐项隔离效果；不以批量重套正式工程代替排查。

状态：2026-11-05 已实施并完成隔离工程实测，替代同日第一轮“Clip User1 放技术 LUT”的方案。

## 原因与处理顺序

普通 DaVinci YRGB 中，Group Pre-Clip 在 Clip 的 User1 LUT 之前。同一视觉组混合 S-Log3、D-Log、Rec.709 时，组前调整面对不同编码，不能承担统一工作空间里的类别基础调整。新正式 scene prepare 使用 Resolve Color Management v2：

`逐片输入色域/Gamma → DWG / Intermediate → Group Pre 基础调整 → Clip Gyro / Dehaze / User1 / User2 / NR → Group Post 风格 → Rec.709 Gamma 2.4 输出`。

2026-11-06 已撤回 VLM 技术诊断驱动的 scene-v1 分组。scene-v7 分类与独立曝光/噪声/大光比测量见 [首阶段合同](color-assessment-v1.md)；局部反差按多数时长决定主类，少数区间留作附加信息。待复核不创建 Color Group，RCM 和五节点初始化按 colorManagementPolicy 判断，与是否有分类解耦。RCM 输入转换和本节以下工程约束不变。User1 / User2 回归逐片手调，不再自动写 Log→709 LUT；Group Pre 与 Post 不注入技术 LUT。RCM 输入映射在每条 MediaPoolItem 上明确设置并回读，不能只设置项目默认值。项目和 timeline 的实际有效色彩管理设置均须校验，避免 timeline override 绕过项目设置。

## 输入真值与兼容

素材级语义与元数据通过 `store/color-inputs.json` 持久化投影进入 Color，读取前验证源报告/资产签名，见 [调色输入合同](color-inputs-store.md)。RCM 仍以当前原片实际内容、sidecar 与显式 root 输入为准；投影不替代实片校验。

- Sony XML 的 CaptureColorPrimaries 与 CaptureGammaEquation 优先，区分 S-Gamut3 和 S-Gamut3.Cine；明确 Rec.709 不继承 root 的 S-Log3。只有 gamma 的 S-Log3 / HLG 不足以猜色域，须补齐显式 root 输入设置。
- DJI D-Log 与 D-Log M 不得混淆；仅对实际验证的输入空间建立映射，不把 D-Log M 冒充 D-Log。无可靠映射即阻塞。
- 原片版本登记保存解析到的色域/Gamma及来源；显式 root 输入空间仅补缺失证据，并纳入准备签名。Analyze 的 raw LUT 仅为 VLM 的显示代理，保持原合同与缓存，不等于 Resolve 输入转换。target 分析不重复转换。
- 准备签名升级为 rcm-dwg-v1，覆盖输入色域/Gamma、RCM 工作/输出设置及当前分类。导出前校验实际项目、timeline 和各素材输入设置，以及准备签名；色彩管理漂移不能冒充已准备。
- 新空项目可初始化 RCM；已有未受管项目或 User1 技术 LUT 项目禁止静默改变整体色彩科学或删除 LUT。此次实机使用独立 RCM 对照工程保留第一轮结果；后续旧工程迁移须明确范围并保留恢复点。
- 五节点模板和用户已有 OFX/Inspector/节点调整保留。模板参数的工作空间适配需实片验证；不把技术转换成功等同于美肤/降噪效果通过。

## 验证

先用独立 Resolve 项目验证官方 SetSetting / SetClipProperty 的真实值及读回，再接入正式 prepare/sync/export。代表样本包括 Sony S-Log3/S-Gamut3.Cine、Sony Rec.709、DJI D-Log，以及同视觉组混合设备。验证原生输出帧、组前调整能作用于混合设备、无重复技术 LUT、重复 prepare 保留片段/节点/手调，且失败设置不能写 ready。

完成后运行相关根仓/宿主测试及根仓、Console 两个构建，更新主设计、rules、skills 和隔离测试项目验收记录。颜色外观可能不同于 Sony LC-709 LUT，不承诺像素一致。

## 本轮实测结论

独立 `调色管线测试 20261105 RCM [Color]` 已完成两条时间线、六个完整素材、三个视觉 Group。Sony S-Gamut3.Cine/S-Log3、Sony Rec.709 (Scene)、DJI D-Gamut/D-Log 输入均经原生接口设置与回读；项目及 timeline 的全部 RCM_SETTINGS 校验通过。六张原生 ExportFrame 正常出图，Clip 五节点不含技术 LUT。普通白天混合 Sony/DJI 组施加同一临时 Group Pre 偏移，两种素材的输出均发生预期变化；测试后恢复原空组前节点。重复准备保留片段标识、时间、Inspector、输入空间和可回读节点信息。

首次无人机模板导入在 Resolve 卡死期间失败；用户重启后仅补完未完成 root，Sony 已保存片段保留。测试素材和审计位于 Git 忽略的 `projects/tmp-color-pipeline-20261105/.fixtures/v2-20261105/rcm-live/`。后端/管线 160 项、Console 3 项测试，以及两端构建通过。分类实片仅覆盖三个类别，未宣称动态美肤/降噪、所有类别或 D-Log M 已完成验收。

## scene-v5 追加验收（2026-11-06）

独立 `调色分类 scene-v5 20261106 [Color]` 已完成 11 条实片、两条 root 时间线、7 个真实视觉 Group 与2条待复核无组。S-Log3 和 DJI D-Log 的大光比素材进入同组；逐片输入、有效 RCM 与无技术 LUT 的五节点结构回读通过。范围追加与重复 prepare 保留全部片段 ID、时间、Inspector 和可读节点状态；DRT 通过无修改连续导出对照排除内部标识/易变字段后，其余调色字段一致。临时手动探针已恢复，保存 latest-only DRP 并导出11张原生帧。没有验证动态修正效果或新增 D-Log M 支持。详细记录见 [分类验收](color-high-contrast-v1.md)。

2026-11-06 扩展实测：旧 portrait DRT 的 Zstandard frame 未声明解压大小（streaming frame）；本机 Resolve 21.1.2.10 导入后丢弃其 Clip grade，变成单空节点。以带 content size 的 frame 重新封装后，两份模板均原生导入为标准五节点。只改压缩封装，解压后的 protobuf SHA-256 不变，Gyroflow InputRotation/Rotation、timeline rotation 和构图参数均不改。维护 DRT 必须保留已知 frame content size，并以原生导入验证；文件中存在 OFX 字符串不能代替导入成功。
