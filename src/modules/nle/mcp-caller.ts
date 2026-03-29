/**
 * 通用 MCP 工具调用接口。
 * 由调用方注入具体实现。
 *
 * `src/modules/nle` 只依赖这个最小调用面，
 * 不负责宿主环境中的 MCP bridge、进程生命周期或 server 发现逻辑。
 */
export interface IMcpCaller {
  call(toolName: string, args: Record<string, unknown>): Promise<unknown>;
}
