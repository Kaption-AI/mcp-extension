import { McpServer, type RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { ToolBridge } from './bridge';
import { listAccounts, MULTIPLE_ACCOUNTS_WARNING } from './accounts';
import { takeUsageNotice } from './usageNotice';
import { TOOLS, routeToolCall, type ToolDefinition } from './tools';
import {
  installManageResources,
  MANAGE_TOOL_FEATURE,
  notifyResourcesAndPromptsChanged,
  parseAnswer,
  plansStructuredContent,
  resourcesChanged,
  syncGatedTools,
  visibleManageTools,
} from './manageKaption';
import { withLiveGuide } from './liveGuide';
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
  const register = (tool: ToolDefinition): RegisteredTool => {
    const schema = tool.inputSchema;
    const shape = schema instanceof z.ZodObject ? schema.shape : {};
    // mcp-manage-kaption.LIST.2 — a manage tool goes to an account that said its family is on.
    const feature = MANAGE_TOOL_FEATURE[tool.name];
    return server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: shape,
        annotations: tool.annotations ?? {},
        ...(tool._meta ? { _meta: tool._meta } : {}),
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

          // mcp.TOOLS.19 — a read-only tool reaches the extension as its manage_* method and action.
          const routed = routeToolCall(tool.name, forwardParams);
          const routedSession = targetSession ?? (feature ? bridge.sessionWithFeature?.(feature) : undefined);
          const called = await bridge.callTool(routed.method, routed.params, routedSession);
          const source = called.source;
          // mcp-usage-pricing.RELAY.1 — a usage warning from the extension becomes its own line after the result.
          const marked = takeUsageNotice(feature ? parseAnswer(called.data) : called.data);
          // mcp-manage-kaption.HELP.5 — kaption_help "read" answers the guide's live page on kaptionai.com.
          const data = tool.name === 'kaption_help' ? await withLiveGuide(routed.params, marked.result) : marked.result;

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

          // mcp-manage-kaption.UI.2 — the plans UI (and clients without it) read the answer as structuredContent.
          const structuredContent = tool.name === 'kaption_plans' || tool.name === 'create_kaption_checkout_link' ? plansStructuredContent(data) : undefined;
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(response, null, 2),
              },
              ...(marked.notice ? [{ type: 'text' as const, text: marked.notice }] : []),
            ],
            ...(structuredContent ? { structuredContent } : {}),
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
  };

  // Register each tool; the manage tools only while some account said so (syncManageTools below).
  for (const tool of TOOLS) {
    if (MANAGE_TOOL_FEATURE[tool.name]) continue;
    const registered = register(tool);
    if (LOCAL_SEND_TOOLS.includes(tool.name)) sendTools.push(registered);
  }

  // mcp-manage-kaption.LIST.2 — listed only while some connected account said its family is on; unknown is no. A
  // hidden tool is not registered, so calling it answers the usual unknown-tool error; adding or removing one sends
  // notifications/tools/list_changed.
  const manageTools = new Map<string, RegisteredTool>();
  let visible = new Set<string>();
  const syncManageTools = () => {
    const next = visibleManageTools(bridge.manageFeatures ?? []);
    syncGatedTools(next, manageTools, name => register(TOOLS.find(t => t.name === name)!));
    // HELP.3, PROMPTS.2, UI.1 — the guides, prompts and plans page follow kaption_help / kaption_plans.
    if (resourcesChanged(visible, next) && server.isConnected()) notifyResourcesAndPromptsChanged(server.server);
    visible = next;
  };
  syncManageTools();
  bridge.onAccountsChanged(syncManageTools);

  installManageResources(server.server, {
    visible: () => visible,
    // mcp-manage-kaption.HELP.5 — a guide read answers its live page (kaption://guide/{topic}).
    callHelp: async args => withLiveGuide(args, (await bridge.callTool('kaption_help', args, bridge.sessionWithFeature?.('manage_kaption'))).data),
  });

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
