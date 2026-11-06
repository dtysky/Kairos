# RCM 输入统一与视觉分组

状态：2026-11-05 已实施并完成隔离工程实测，替代同日第一轮“Clip User1 放技术 LUT”的方案。

## 原因与处理顺序

普通 DaVinci YRGB 中，Group Pre-Clip 在 Clip 的 User1 LUT 之前。同一视觉组混合 S-Log3、D-Log、Rec.709 时，组前调整面对不同编码，不能承担统一工作空间里的类别基础调整。新正式 scene prepare 使用 Resolve Color Management v2：

`逐片输入色域/Gamma → DWG / Intermediate → Group Pre 基础调整 → Clip Gyro / Dehaze / User1 / User2 / NR → Group Post 风格 → Rec.709 Gamma 2.4 输出`。

2026-11-06 已撤回 VLM 技术诊断驱动的 scene-v1 分组。scene-v5 分类与独立曝光/噪声/大光比测量见 [首阶段合同](color-assessment-v1.md)；待复核不创建 Color Group，RCM 和五节点初始化按 colorManagementPolicy 判断，与是否有分类解耦。RCM 输入转换和本节以下工程约束不变。User1 / User2 回归逐片手调，不再自动写 Log→709 LUT；Group Pre 与 Post 不注入技术 LUT。RCM 输入映射在每条 MediaPoolItem 上明确设置并回读，不能只设置项目默认值。项目和 timeline 的实际有效色彩管理设置均须校验，避免 timeline override 绕过项目设置。

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
