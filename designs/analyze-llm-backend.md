# Analyze 全局 LLM 后端接入

日期：2026-11-05。用户确认正式开始；范围是接入架构，保持现有分析流程。

2026-11-06 纠正：后端接入与技术判断边界是两个变更。按用户要求，现已单独撤回更早引入的 VLM 技术 colorEvidence 合同及 scene-v1 消费，详见 [技术判断边界纠正](color-technical-analysis-boundary.md)。下文“不改 prompt/分类”描述接入本身的范围，不覆盖此次纠正；其余抽帧、ASR、窗口与调度仍保持原样。

## 范围与实施顺序

1. 在工作区 `config/runtime.json.llm` 增加后端和 OpenAI 配置，在 `/project` 提供全局编辑入口。
2. 在原有 `vlmAnalyze` 调用边界注入 OpenAI Responses 适配器，继续返回现有 description/timing 合同。
3. 增加配置状态、请求用量审计和契约测试；运行根仓、Console 测试与构建，并同步规则与技能。

不改抽帧、原片/目标选择、LUT、阶段顺序、并发、提示词业务内容、JSON 解析与校验、细扫窗口、分类规则、ASR 或下游调色。尤其不能为了模型测试中的行车差异修改 `scene-v1`。

## 全局配置

`llm.backend` 为 `local | openai`，未配置时保持 `local`。本轮应用范围仅 Analyze 视觉调用；Style VLM、span-builder 文本 LM 和 Agent runner 保持现有路由。ASR 继续使用独立全局配置。

`llm.openai`：

- `model` 默认 `gpt-6-luna`。
- `reasoningEffort` 默认 `high`，支持模型文档列出的 none/low/medium/high/xhigh/max。
- `apiKey` 为本机私有值，可在全局配置输入；未保存时可使用服务端 `OPENAI_API_KEY`。
- `baseUrl` 默认 `https://api.openai.com/v1`，仅允许 HTTPS 或 loopback HTTP，不允许 URL 用户信息、query 或 fragment。
- `maxOutputTokens` 默认 32768，包含推理和最终输出；不能照搬本地 96/512 token 预算作为推理模型的总预算。
- `timeoutMs` 默认 180000，是单次 HTTP 请求超时。

工作区配置是 LLM 唯一来源，项目本地 runtime 不覆盖它。一次 Analyze 运行快照配置，运行中保存仅影响后续作业。

GET/PUT `/api/workspace/config/llm` 只返回非敏感配置和 Key 配置来源/状态。PUT 不提供 key 表示保留，`null` 表示清除已保存 key；空字符串不清除旧值。保存保留其它 runtime 字段，私有文件不进 git。UI 使用密码输入，保存后清空输入值，接入现有未保存草稿保护。API/日志/审计不回传 key，也不回传第三方原始错误正文。

## 请求适配

由 Analyze 注入视觉适配器，`MlClient` 的 ASR/OCR/CLIP/text 行为不变。OpenAI 接收现有 JPEG/PNG 帧按原顺序编码的 data URL 和原始 prompt；使用 Responses、`reasoning.effort`、`store:false`、标准服务层，不使用会话历史或工具。不增加业务提示或另建分析步骤。

保留当前业务重试与解析规则。适配器仅对 429/408/409/5xx 和网络错误进行有界重试；鉴权、拒绝、空输出与 incomplete 明确失败，不切换后端或模型。推理预算由独立 API 配置控制，本地 token 重试序列保持原样。

Analyze 现有本地 ML/ASR 健康检查与 Supervisor 启停行为保持不变；选择云端视觉不等于整个任务无需本地 ML。缺少 OpenAI key 时在分析准备前报告配置错误。

## 缓存与审计

配置保存只改变未来模型调用，不批量失效现有 report、checkpoint、ASR、spans 或 chronology，不隐式重跑。媒体内容签名及其失效流程保持原样。显式选中素材重新 Analyze 继续遵守已有作用域行为。

每次 API 尝试将非敏感运行信息追加到项目 `.tmp/media-analyze/llm-requests.jsonl`：运行标识、请求标识、配置指纹（不含 key）、prompt/frame 指纹、模型/推理设置、时间、成功/错误状态和 API 返回 usage（输入、缓存输入、缓存写入、输出、推理 token）。保留失败响应中可用 usage，不把推理 token 在输出用量之外重复相加。配置变化不把历史报告标成新模型产出。

`/analyze` 显示配置后端和模型、配置是否完整；它不是云端连通性/账户余额检测结果。云端配置状态不替代现有 live job 真值或 ASR 状态。

## 验证

- 配置默认、工作区唯一来源、保留其它配置、Key 留空保留/替换/清除、GET/PUT 脱敏及错误脱敏。
- HTTP 模拟验证原 prompt、图片顺序、推理预算、Responses 输出/usage、超时、限流重试、incomplete/refusal/error，不请求真实付费 API。
- Analyze 的现有业务回归和配置 UI/API 测试；确保业务 prompt 与 `scene-v1` 没有 diff。
- `pnpm build` 与 `npm --prefix apps/kairos-console run build` 均必须通过。

## 本轮验证结果

初次实现验证：已通过 47 项后端检查（含原 Analyze 回归）、13 项 Console 检查、根仓与 Console 构建。独立临时 workspace 的真实 Supervisor HTTP 验证覆盖默认读取、保存、GET/PUT 脱敏、空值保留和 null 清除。正式 Console 已重启，`/project` 新 bundle 和配置 GET 可用；当时未配置 Key，未发起真实 OpenAI 请求。分类、抽帧、输入选择和业务 prompt 没有修改。

用户配置 Key 后的真实 API 验证（2026-11-06）：经正式 `createAnalyzeVisionClient` 读取工作区配置并调用 `gpt-6-luna / high`，复用原抽帧及 prompt，6 次 finalize、2 次 fine-scan、1 次 photo 共 38 张图，9/9 通过原生产 parser，9 次 API 尝试无重试。finalize 中位 10.15 秒，fine-scan 中位 3.48 秒，照片 3.77 秒；请求耗时合计 72.50 秒。输入 33935、输出 4831 tokens（输出内含 2525 reasoning），按当日 Standard 单价及 cache-write 用量估算 $0.006633425；不是账户账单实扣。3 条行车类型均为 drive，但新模型均判断 highContrast=true，因此原 scene-v1 将它们归为 high-contrast；这暴露了既有技术判断错误交给 VLM 的边界问题。该技术结论及 scene-v1 消费现已撤回；此次记录只能证明 API 接入/耗时/用量，不能证明技术判断有效。历史报告 hash 校验未变，未重跑完整 Ingest/ASR/Analyze。证据保存在 gitignored `.tmp/openai-vision-eval-20261105/api-live-20261105/summary.json` 及逐请求审计。

## 官方资料

- [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna)
- [Responses create](https://developers.openai.com/api/reference/typescript/resources/responses/methods/create)
- [Reasoning token budget](https://developers.openai.com/api/docs/guides/reasoning)
