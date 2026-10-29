import { McpServer, type RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { ToolBridge } from './bridge';
import { listAccounts, MULTIPLE_ACCOUNTS_WARNING } from './accounts';
import { TOOLS } from './tools';
import { getUpdateInfo, getCurrentVersion } from './updateCheck';
import { getTokenFilePath } from './auth';

const HTTP_API_PORT = 7866;

/** mcp.LOCAL_HUB.11 — listed only while some connected account may send from this computer (MCP_LOCAL_SEND). */
export const LOCAL_SEND_TOOLS = ['send_message', 'create_attachment_upload'];

/**
 * Creates and configures the MCP server with all WhatsApp tools.
 * Uses stdio transport for communication with Claude Code / Cursor.
 */
/**
 * mcp.LOCAL_HUB.12 — get_api_info never returns the hub's access token: the answer lands in the
 * assistant's transcript (and anything that syncs it). It says where the token lives instead, so a
 * local script run by the same user can read it from the 0600 file.
 */
export function apiInfo(): Record<string, unknown> {
  return {
    http_api: {
      url: `http://127.0.0.1:${HTTP_API_PORT}`,
      auth: {
        header: 'Authorization: Bearer <token>',
        token_file: getTokenFilePath(),
        note: 'The token is not shown here on purpose. Read it from token_file on this computer (only your user can read it) and never paste it into a chat.',
      },
      endpoints: [
        { method: 'GET', path: '/health', description: 'Connection status + session count' },
        { method: 'GET', path: '/sessions', description: 'List all connected accounts' },
        { method: 'POST', path: '/tools/:toolName', description: 'Call any tool (body = params JSON)' },
      ],
    },
  };
}

export function createMcpServer(bridge: ToolBridge): McpServer {
  const server = new McpServer({
    name: 'kaptionai-whatsapp',
    version: getCurrentVersion(),
  });

  const sendTools: RegisteredTool[] = [];
  // Register each tool
  for (const tool of TOOLS) {
    const schema = tool.inputSchema;
    const shape = schema instanceof z.ZodObject ? schema.shape : {};
    const registered = server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: shape,
        annotations: tool.annotations ?? {},
      },
      async (params: Record<string, unknown>) => {
        try {
          // mcp.LOCAL_HUB.5 — stdio MCP server registers all ten tools
          // Handle get_api_info locally (no extension needed)
          if (tool.name === 'get_api_info') {
            const info = apiInfo();
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
                      'The KaptionAI extension is not installed, or Claude and ChatGPT access is not turned on in it',
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
            const sessions = listAccounts(bridge);

            const update = getUpdateInfo();
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({
                    connected: bridge.connected,
                    accounts: sessions,
                    version: getCurrentVersion(),
                    ...(update ? { update_available: update } : {}),
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
          if (!targetSession && listAccounts(bridge).length > 1) {
            response._warning = MULTIPLE_ACCOUNTS_WARNING;
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
    if (LOCAL_SEND_TOOLS.includes(tool.name)) sendTools.push(registered);
  }

  // mcp.LOCAL_HUB.11 — hide the send tools when every connected account reported MCP_LOCAL_SEND off;
  // enable()/disable() send notifications/tools/list_changed to a connected client.
  const syncSendTools = () => {
    const available = bridge.localSendAvailable;
    for (const t of sendTools) {
      if (t.enabled === available) continue;
      if (available) t.enable(); else t.disable();
    }
  };
  syncSendTools();
  bridge.onAccountsChanged(syncSendTools);

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
