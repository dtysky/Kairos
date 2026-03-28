/**
 * 通用 MCP 工具调用接口。
 * 由调用方注入具体实现（Cursor MCP、SDK direct connect、etc.）
 */
export interface IMcpCaller {
  call(toolName: string, args: Record<string, unknown>): Promise<unknown>;
}
