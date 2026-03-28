import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { IMcpCaller } from './mcp-caller.js';

export interface IStdioMcpConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/**
 * 通过 stdio 连接 MCP Server，包装成 IMcpCaller。
 * 适用于 jianying-mcp 等 stdio 类型的 MCP Server。
 */
export class StdioMcpCaller implements IMcpCaller {
  private client: Client;
  private transport: StdioClientTransport;
  private connected = false;

  constructor(private config: IStdioMcpConfig) {
    this.transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: config.env as Record<string, string> | undefined,
    });
    this.client = new Client({
      name: 'kairos',
      version: '0.1.0',
    });
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    await this.client.connect(this.transport);
    this.connected = true;
  }

  async call(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.connected) await this.connect();

    const result = await this.client.callTool({
      name: toolName,
      arguments: args,
    });

    const content = result.content as Array<{ type: string; text?: string }>;
    const text = content?.find(c => c.type === 'text')?.text;
    if (!text) return result;

    try {
      return JSON.parse(text);
    } catch {
      return { text };
    }
  }

  async close(): Promise<void> {
    if (this.connected) {
      await this.client.close();
      this.connected = false;
    }
  }
}

/**
 * 快捷创建 jianying-mcp 的 caller。
 *
 * @param jianyingMcpRoot - jianying-mcp 仓库根目录（例如 vendor/jianying-mcp）
 * @param savePath - 中间数据存储目录（MCP 的 SAVE_PATH 环境变量）
 * @param outputPath - 导出到剪映草稿的目标目录（MCP 的 OUTPUT_PATH 环境变量）
 */
export function createJianyingMcpCaller(
  jianyingMcpRoot: string,
  savePath: string,
  outputPath: string,
): StdioMcpCaller {
  const serverDir = jianyingMcpRoot.endsWith('/jianyingdraft')
    ? jianyingMcpRoot
    : `${jianyingMcpRoot}/jianyingdraft`;

  return new StdioMcpCaller({
    command: 'uv',
    args: ['--directory', serverDir, 'run', 'server.py'],
    env: {
      SAVE_PATH: savePath,
      OUTPUT_PATH: outputPath,
    },
  });
}
