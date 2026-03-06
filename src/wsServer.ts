import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import { Bridge } from './bridge';
import { validateToken, SessionManager } from './auth';

const WS_PORT = 7865;
const CONNECTION_TIMEOUT_MS = 10_000;
const PAIRING_TIMEOUT_MS = 30_000;

/**
 * Verify the origin header to block CSRF from web pages.
 * Allow: no origin (Node.js clients), chrome-extension://, moz-extension://
 * Block: http://, https://
 */
function verifyClient(info: { origin: string; req: IncomingMessage }): boolean {
  const origin = info.origin;
  if (!origin) return true; // Node.js clients (relay, wscat)
  if (origin.startsWith('chrome-extension://')) return true;
  if (origin.startsWith('moz-extension://')) return true;
  console.error(`[Kaption AI MCP] Rejected connection from origin: ${origin}`);
  return false;
}

export interface ExtensionInfo {
  sessionId: string;
  phone?: string;
  pushname?: string;
  isBusiness?: boolean;
  browser?: string;
  connected: boolean;
}

/**
 * Creates a WebSocket server on localhost:7865 that accepts connections
 * from the KaptionAI Chrome extension AND from relay MCP bridge clients.
 *
 * Security layers:
 * 1. Origin check — blocks CSRF from web pages
 * 2. Token file — blocks unauthorized relay clients
 * 3. Pairing flow — extension shows Allow/Deny popup
 */
export function createWebSocketServer(
  bridge: Bridge,
  authToken: string,
  sessionManager: SessionManager,
): Promise<WebSocketServer> {
  return new Promise((resolve, reject) => {
    const wss = new WebSocketServer({
      port: WS_PORT,
      host: '127.0.0.1',
      verifyClient,
    });

    const relayClients = new Set<WebSocket>();

    const getExtensionList = (): ExtensionInfo[] => {
      const extensions: ExtensionInfo[] = [];
      for (const [sessionId, info] of bridge.sessions) {
        extensions.push({
          sessionId,
          phone: info.phone,
          pushname: info.pushname,
          isBusiness: info.isBusiness,
          browser: info.browser,
          connected: true,
        });
      }
      return extensions;
    };

    // Notify relay clients when extension status changes
    const broadcastExtensionStatus = () => {
      const extensions = getExtensionList();
      const msg = JSON.stringify({
        method: 'extension_status',
        params: { connected: bridge.connected, extensions },
      });
      for (const client of relayClients) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(msg);
        }
      }
    };

    bridge.on('connected', () => broadcastExtensionStatus());
    bridge.on('disconnected', () => broadcastExtensionStatus());

    wss.on('connection', (ws) => {
      // Connection timeout: close if no first message within 10s
      const connectionTimeout = setTimeout(() => {
        console.error('[Kaption AI MCP] Connection timeout — no first message');
        ws.close(4000, 'Connection timeout');
      }, CONNECTION_TIMEOUT_MS);

      ws.once('message', (firstData) => {
        clearTimeout(connectionTimeout);

        let msg: any;
        try {
          msg = JSON.parse(firstData.toString());
        } catch {
          ws.close(4001, 'Invalid JSON');
          return;
        }

        if (msg.method === 'relay_connect') {
          handleRelayConnect(ws, msg, bridge, authToken, relayClients, getExtensionList);
        } else if (msg.method === 'handshake') {
          handleExtensionHandshake(ws, msg, bridge, sessionManager);
        } else {
          ws.close(4002, 'Unknown first message');
        }
      });
    });

    wss.once('listening', () => {
      console.error(`[Kaption AI MCP] WebSocket server listening on ws://127.0.0.1:${WS_PORT}`);
      resolve(wss);
    });

    wss.once('error', (err: NodeJS.ErrnoException) => {
      reject(err);
    });
  });
}

/**
 * Handle relay client connection with token authentication.
 */
function handleRelayConnect(
  ws: WebSocket,
  msg: any,
  bridge: Bridge,
  authToken: string,
  relayClients: Set<WebSocket>,
  getExtensionList: () => ExtensionInfo[],
) {
  const providedToken = msg.params?.auth_token;
  if (!providedToken || !validateToken(providedToken, authToken)) {
    console.error('[Kaption AI MCP] Relay auth failed — invalid token');
    ws.send(JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32403, message: 'Authentication failed' },
    }));
    ws.close(4003, 'Authentication failed');
    return;
  }

  console.error('[Kaption AI MCP] Relay client authenticated');
  relayClients.add(ws);

  // Acknowledge with current extension status
  ws.send(JSON.stringify({
    method: 'relay_ack',
    params: {
      extensionConnected: bridge.connected,
      extensions: getExtensionList(),
    },
  }));

  ws.on('message', (data) => {
    let parsed: any;
    try {
      parsed = JSON.parse(data.toString());
    } catch {
      return;
    }

    // Forward tool calls through the bridge to the extension
    if (parsed.id && parsed.method) {
      const targetSession = parsed.params?.target_session;
      bridge.callTool(parsed.method, parsed.params || {}, targetSession)
        .then((result) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result }));
          }
        })
        .catch((error) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              jsonrpc: '2.0',
              id: parsed.id,
              error: { code: -32603, message: error.message },
            }));
          }
        });
    }
  });

  ws.on('close', () => {
    console.error('[Kaption AI MCP] Relay client disconnected');
    relayClients.delete(ws);
  });

  ws.on('error', (err) => {
    console.error('[Kaption AI MCP] Relay client error:', err.message);
  });
}

/**
 * Handle extension handshake — validate existing session or start pairing flow.
 */
async function handleExtensionHandshake(
  ws: WebSocket,
  msg: any,
  bridge: Bridge,
  sessionManager: SessionManager,
) {
  const sessionToken = msg.params?.auth?.session_token;
  const sessionId = msg.params?.auth?.session_id;

  // Try to validate existing session
  if (sessionToken && sessionId) {
    const session = await sessionManager.validateSession(sessionId, sessionToken);
    if (session) {
      console.error(`[Kaption AI MCP] Extension re-authenticated (session: ${sessionId})`);
      ws.send(JSON.stringify({
        method: 'auth_success',
        params: { session_id: sessionId },
      }));
      setupExtension(ws, bridge, msg, sessionId);
      return;
    }
    console.error('[Kaption AI MCP] Extension session invalid/expired — starting pairing');
  }

  // No valid session — start pairing flow
  startPairingFlow(ws, msg, bridge, sessionManager);
}

/**
 * Pairing flow: ask extension to show Allow/Deny popup.
 */
function startPairingFlow(
  ws: WebSocket,
  handshakeMsg: any,
  bridge: Bridge,
  sessionManager: SessionManager,
) {
  console.error('[Kaption AI MCP] Sending pairing request to extension');

  ws.send(JSON.stringify({
    method: 'pairing_request',
    params: { hub_name: 'Kaption AI MCP' },
  }));

  const pairingTimeout = setTimeout(() => {
    console.error('[Kaption AI MCP] Pairing timeout — no response from extension');
    ws.close(4004, 'Pairing timeout');
  }, PAIRING_TIMEOUT_MS);

  // Listen for pairing_response
  const onMessage = async (data: any) => {
    let parsed: any;
    try {
      parsed = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (parsed.method !== 'pairing_response') return;

    clearTimeout(pairingTimeout);
    ws.removeListener('message', onMessage);

    if (!parsed.params?.approved) {
      console.error('[Kaption AI MCP] Pairing denied by user');
      ws.close(4005, 'Pairing denied');
      return;
    }

    console.error('[Kaption AI MCP] Pairing approved — creating session');

    const phone = handshakeMsg.params?.session?.phone;
    const pushname = handshakeMsg.params?.session?.pushname;

    const session = await sessionManager.createSession('extension', { phone, pushname });

    ws.send(JSON.stringify({
      method: 'pairing_complete',
      params: {
        session_id: session.id,
        session_token: session.token,
        expires_at: new Date(session.expiresAt).getTime(),
      },
    }));

    setupExtension(ws, bridge, handshakeMsg, session.id);
  };

  ws.on('message', onMessage);

  ws.on('close', () => {
    clearTimeout(pairingTimeout);
    ws.removeListener('message', onMessage);
  });
}

function handleExtensionMessage(bridge: Bridge, msg: any, sessionId: string): void {
  // Capture session info from handshake
  if (msg.method === 'handshake' && msg.params?.session) {
    bridge.setSession(sessionId, msg.params.session);
    console.error(`[Kaption AI MCP] Session: ${msg.params.session.pushname || 'Unknown'} (${msg.params.session.phone})`);
  }
  // Forward to bridge for response routing
  bridge.handleResponse(JSON.stringify(msg));
}

function setupExtension(
  ws: WebSocket,
  bridge: Bridge,
  firstMessage: any,
  sessionId: string,
) {
  console.error(`[Kaption AI MCP] Extension connected (session: ${sessionId})`);

  // Close any existing connection for this session
  bridge.replaceConnection(sessionId);

  bridge.setConnection(sessionId, (data: string) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  });

  // Process the first message (handshake — extract session info)
  handleExtensionMessage(bridge, firstMessage, sessionId);

  ws.on('message', (data) => {
    let msg: any;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    handleExtensionMessage(bridge, msg, sessionId);
  });

  ws.on('close', () => {
    console.error(`[Kaption AI MCP] Extension disconnected (session: ${sessionId})`);
    bridge.clearConnection(sessionId);
  });

  ws.on('error', (err) => {
    console.error('[Kaption AI MCP] WebSocket error:', err.message);
  });
}
