import { McpServer, type RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { ToolBridge } from './bridge';
import { listAccounts, MULTIPLE_ACCOUNTS_WARNING } from './accounts';
import { takeUsageNotice } from './usageNotice';
import { ALLOW_EXTRA_DEFINITION, ALLOW_EXTRA_TOOL, creditsAnswer, creditsToolVisible } from './creditsTool';
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
import { sanitizeClient } from './mcpClient';
import { toolErrorText } from './toolErrors';
import {
  AVATARS_TOOL,
  AVATARS_TOOL_DESCRIPTION,
  AVATARS_TOOL_TITLE,
  avatarIds,
  avatarsAnswer,
  avatarsToolMeta,
  cardFor,
  cardToolMeta,
  errorCardFor,
  isCardTool,
} from './cards';
import { CardsFlag } from './cardsFlag';

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

export interface McpServerOptions {
  /** mcp-apps-cards.FLAG.1 — where MCP_APPS_CARDS is asked (tests pass their own). */
  cardsFlag?: Pick<CardsFlag, 'anyOn'>;
}

export function createMcpServer(bridge: ToolBridge, options: McpServerOptions = {}): McpServer {
  const server = new McpServer({
    name: 'kaptionai-whatsapp',
    version: getCurrentVersion(),
  });

  // mcp-local-hub-growth.CLIENT.1 — the AI app connected over stdio, as its initialize request said (sanitized);
  // undefined until it has said, and then `client` is left out of the calls.
  const mcpClient = () => sanitizeClient(server.server.getClientVersion());
  // mcp-local-hub-growth.CLIENT.2 — the hub tells the extension which app it serves when it pairs.
  const previousOnInitialized = server.server.oninitialized;
  server.server.oninitialized = () => {
    previousOnInitialized?.();
    bridge.setMcpClient?.(mcpClient());
  };

  const sendTools: RegisteredTool[] = [];
  // mcp-apps-cards.FLAG.1-4 — MCP_APPS_CARDS for the connected accounts (off until the flags worker said on).
  const cardsFlag = options.cardsFlag ?? new CardsFlag();
  let cardsOn = false;
  const cardTools = new Map<string, { registered: RegisteredTool; meta: Record<string, unknown> | undefined }>();
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
            // mcp-local-hub-growth.ERRORS.1 — the cloud's "Extension not connected" text.
            return errorAnswer(tool.name, new Error('Extension not connected'), params, cardsOn);
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
          const called = await bridge.callTool(routed.method, routed.params, routedSession, mcpClient());
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
          let structuredContent: Record<string, unknown> | undefined = tool.name === 'kaption_plans' || tool.name === 'create_kaption_checkout_link' ? plansStructuredContent(data) : undefined;
          // mcp-apps-cards.DATA.1-2 — with MCP_APPS_CARDS on, a card tool's answer also carries its card (the text stays).
          if (cardsOn && isCardTool(tool.name)) {
            const card = cardFor(tool.name, forwardParams, data);
            if (card) structuredContent = { card };
          }
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
          // mcp-local-hub-growth.ERRORS.1 — the same text the cloud relay answers, not a JSON object.
          return errorAnswer(tool.name, error, params, cardsOn);
        }
      }
    );
  };

  // Register each tool; the manage tools only while some account said so (syncManageTools below).
  for (const tool of TOOLS) {
    if (MANAGE_TOOL_FEATURE[tool.name]) continue;
    const registered = register(tool);
    if (LOCAL_SEND_TOOLS.includes(tool.name)) sendTools.push(registered);
    if (isCardTool(tool.name)) cardTools.set(tool.name, { registered, meta: tool._meta });
  }

  /**
   * mcp-apps-cards.AVATAR.1-5 — get_avatars: listed only while MCP_APPS_CARDS is on and only to the card (visibility
   * app / openai private). Forwarded to the extension, which reads the pictures in the WhatsApp page; never counted by
   * the hub. A failure answers no pictures, so the card keeps its initials.
   */
  // (server as any): the SDK's registerTool generics are too deep for this schema (TS2589); the shape is plain zod.
  const avatarsTool: RegisteredTool = (server as any).registerTool(
    AVATARS_TOOL,
    {
      title: AVATARS_TOOL_TITLE,
      description: AVATARS_TOOL_DESCRIPTION,
      inputSchema: { ids: z.array(z.string()).max(50) },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: avatarsToolMeta(),
    },
    async (params: Record<string, unknown>) => {
      const ids = avatarIds(params);
      let answer = avatarsAnswer(ids, null);
      if (bridge.connected && ids.length) {
        try {
          answer = avatarsAnswer(ids, (await bridge.callTool(AVATARS_TOOL, { ids }, undefined, mcpClient())).data);
        } catch {
          // An older extension, or no WhatsApp tab: initials.
        }
      }
      const found = Object.values(answer.avatars).filter(Boolean).length;
      return {
        content: [{ type: 'text' as const, text: `${found} of ${ids.length} profile pictures for the Kaption card.` }],
        structuredContent: answer,
      };
    },
  );
  avatarsTool.disable();

  /**
   * mcp-apps-cards.FLAG.1-4 — asks the flags worker for the connected accounts' phones; on a change the card tools gain
   * or lose _meta.ui and the cards page (tools/list_changed, resources/list_changed). Off: exactly as before.
   */
  const syncCards = async (): Promise<boolean> => {
    let on = false;
    try {
      on = await cardsFlag.anyOn(listAccounts(bridge).map(a => a.phone).filter(Boolean));
    } catch {
      on = false;
    }
    if (on === cardsOn) return on;
    cardsOn = on;
    for (const { registered, meta } of cardTools.values()) {
      registered._meta = on ? { ...(meta ?? {}), ...cardToolMeta() } : meta;
    }
    if (on) avatarsTool.enable(); else avatarsTool.disable();
    if (server.isConnected()) {
      try { server.sendToolListChanged(); } catch { /* not connected */ }
      try { Promise.resolve(server.server.sendResourceListChanged()).catch(() => {}); } catch { /* not connected */ }
    }
    return on;
  };
  const cardsReady = syncCards();
  bridge.onAccountsChanged(() => { void syncCards(); });
  // FLAG.4 — a flag change reaches a running hub within 5 minutes (the flag's cache time).
  const cardsTimer = setInterval(() => { void syncCards(); }, 5 * 60_000);
  cardsTimer.unref?.();
  (server as McpServer & { cardsReady?: Promise<boolean> }).cardsReady = cardsReady;

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
    callHelp: async args => withLiveGuide(args, (await bridge.callTool('kaption_help', args, bridge.sessionWithFeature?.('manage_kaption'), mcpClient())).data),
    cards: () => cardsOn,
  });

  // mcp-credits-simple.HUB.1-2 — allow_extra_actions, listed while some account said credits_simple; forwarded to
  // that account's extension (which asks rest-api), its words returned as the result. Never counted by the hub.
  let creditsTool: RegisteredTool | null = null;
  const syncCreditsTool = () => {
    const show = creditsToolVisible(bridge.manageFeatures ?? []);
    if (show && !creditsTool) {
      creditsTool = server.registerTool(
        ALLOW_EXTRA_TOOL,
        {
          title: ALLOW_EXTRA_DEFINITION.title,
          description: ALLOW_EXTRA_DEFINITION.description,
          inputSchema: ALLOW_EXTRA_DEFINITION.inputSchema.shape,
          annotations: ALLOW_EXTRA_DEFINITION.annotations,
        },
        async (params: Record<string, unknown>) => {
          try {
            if (!bridge.connected) return { content: [{ type: 'text' as const, text: creditsAnswer(null).text }], isError: true };
            const target = (params?.target_session as string | undefined) ?? bridge.sessionWithFeature?.('credits_simple');
            const called = await bridge.callTool(ALLOW_EXTRA_TOOL, {}, target);
            const answer = creditsAnswer(called.data);
            return { content: [{ type: 'text' as const, text: answer.text }], ...(answer.isError ? { isError: true } : {}) };
          } catch {
            return { content: [{ type: 'text' as const, text: creditsAnswer(null).text }], isError: true };
          }
        },
      );
    } else if (!show && creditsTool) {
      creditsTool.remove();
      creditsTool = null;
    }
  };
  syncCreditsTool();
  bridge.onAccountsChanged(syncCreditsTool);

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
 * mcp-local-hub-growth.ERRORS.1 — a failed tool call, answered as the cloud relay answers it.
 * mcp-apps-cards.SENT.3 — with MCP_APPS_CARDS on, a refused send_message also carries its card.
 */
function errorAnswer(tool: string, error: unknown, params?: Record<string, unknown>, cards = false) {
  const text = toolErrorText(tool, error);
  const card = cards && isCardTool(tool) ? errorCardFor(tool, params, text) : null;
  return { content: [{ type: 'text' as const, text }], isError: true, ...(card ? { structuredContent: { card } } : {}) };
}

/**
 * Start the MCP server with stdio transport
 */
export async function startMcpServer(server: McpServer): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[Kaption AI MCP] MCP server started (stdio transport)');
}
