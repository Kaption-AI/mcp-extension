import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { ToolBridge } from './bridge';
import { Bridge } from './bridge';
import { RelayBridge } from './relayBridge';
import { TOOLS } from './tools';

const HTTP_API_PORT = 7866;

/**
 * Creates and configures the MCP server with all WhatsApp tools.
 * Uses stdio transport for communication with Claude Code / Cursor.
 */
export function createMcpServer(bridge: ToolBridge, authToken?: string): McpServer {
  const server = new McpServer({
    name: 'kaptionai-whatsapp',
    version: '0.2.0',
  });

  // Register each tool
  for (const tool of TOOLS) {
    const schema = tool.inputSchema;
    const shape = schema instanceof z.ZodObject ? schema.shape : {};
    server.tool(
      tool.name,
      tool.description,
      shape,
      async (params: Record<string, unknown>) => {
        try {
          // Handle get_api_info locally (no extension needed)
          if (tool.name === 'get_api_info') {
            const info = {
              http_api: {
                url: `http://127.0.0.1:${HTTP_API_PORT}`,
                auth_token: authToken || null,
                endpoints: [
                  { method: 'GET', path: '/health', description: 'Connection status + session count' },
                  { method: 'GET', path: '/sessions', description: 'List all connected accounts' },
                  { method: 'POST', path: '/tools/:toolName', description: 'Call any tool (body = params JSON)' },
                ],
              },
            };
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(info, null, 2) }],
            };
          }

          if (!bridge.connected) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({
                    error: 'WhatsApp extension not connected',
                    reasons: [
                      'WhatsApp Web is not open in Chrome/Edge',
                      'The KaptionAI extension is not installed or MCP bridge is not enabled',
                      'The extension just started and hasn\'t connected yet (wait a few seconds and retry)',
                    ],
                    fix: 'Open WhatsApp Web (web.whatsapp.com) in Chrome/Edge with the KaptionAI extension, then retry.',
                  }),
                },
              ],
              isError: true,
            };
          }

          // Handle session query locally — return flat list of all connected WhatsApp accounts
          if (tool.name === 'query' && params.entity === 'session') {
            const sessions: any[] = [];

            if (bridge instanceof Bridge) {
              for (const [sessionId, info] of bridge.sessions) {
                sessions.push({
                  sessionId,
                  phone: info.phone || '',
                  pushname: info.pushname || '',
                  isBusiness: info.isBusiness || false,
                  browser: info.browser || 'unknown',
                });
              }
            } else if (bridge instanceof RelayBridge) {
              for (const ext of bridge.extensions) {
                sessions.push({
                  sessionId: ext.sessionId,
                  phone: ext.phone || '',
                  pushname: ext.pushname || '',
                  isBusiness: ext.isBusiness || false,
                  browser: ext.browser || 'unknown',
                });
              }
            }

            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({
                    connected: bridge.connected,
                    accounts: sessions,
                    help: sessions.length > 1
                      ? 'Use target_session with a sessionId to query a specific account.'
                      : undefined,
                  }, null, 2),
                },
              ],
            };
          }

          // Extract target_session before forwarding (don't send it to the extension)
          const targetSession = params.target_session as string | undefined;
          const forwardParams = { ...params };
          delete forwardParams.target_session;

          const { data, source } = await bridge.callTool(tool.name, forwardParams, targetSession);

          const sourceInfo = source?.sessionId ? {
            sessionId: source.sessionId,
            phone: source.phone,
            pushname: source.pushname,
          } : undefined;

          const response: any = data && typeof data === 'object' && !Array.isArray(data)
            ? { ...data as object, ...(sourceInfo && { _source: sourceInfo }) }
            : { data, ...(sourceInfo && { _source: sourceInfo }) };

          // Multi-session warning
          const hasMultiple = (bridge instanceof Bridge && bridge.sessions.size > 1)
            || (bridge instanceof RelayBridge && bridge.extensions.length > 1);
          if (!targetSession && hasMultiple) {
            response._warning = 'Multiple accounts connected. Use target_session for accuracy. Query entity="session" to see accounts.';
          }

          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(response, null, 2),
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  error: (error as Error).message,
                }),
              },
            ],
            isError: true,
          };
        }
      }
    );
  }

  return server;
}

/**
 * Start the MCP server with stdio transport
 */
export async function startMcpServer(server: McpServer): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[Kaption AI MCP] MCP server started (stdio transport)');
}
