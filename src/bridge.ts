import { toolRequest } from './clientName';
import { resolveLocalAttachment } from './attachment';
import { EventEmitter } from 'events';

export interface SessionInfo {
  phone?: string;
  pushname?: string;
  isBusiness?: boolean;
  browser?: string;
}

export interface ToolCallResult {
  data: unknown;
  source?: {
    sessionId: string;
    phone?: string;
    pushname?: string;
  };
}

/** Shared interface for both hub Bridge and relay RelayBridge. */
export interface ToolBridge {
  readonly connected: boolean;
  readonly session: SessionInfo | null;
  /**
   * mcp.LOCAL_HUB.11 — false only when every connected account reported `features.local_send: false`
   * (MCP_LOCAL_SEND off). No account, or one that sent no `features` (older extensions), counts as available.
   */
  readonly localSendAvailable: boolean;
  /** mcp.LOCAL_HUB.11 — called whenever the connected accounts or their features may have changed. */
  onAccountsChanged(listener: () => void): void;
  /**
   * mcp-usage-accounting.LOCAL.3 — `clientName` is the AI app's MCP `initialize` clientInfo.name; it travels
   * beside method/params (never inside params) so the extension can count local calls per app.
   */
  callTool(method: string, params: Record<string, unknown>, targetSessionId?: string, clientName?: string): Promise<ToolCallResult>;
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  connectionId: string;
}

type SendFn = (data: string) => void;

/**
 * mcp.LOCAL_HUB.10 — a request that names an account the hub doesn't have. It never falls back to
 * another account: the caller asked for one account's data and must not get another's.
 */
export class UnknownSessionError extends Error {
  readonly code = 'UNKNOWN_SESSION';
  constructor(readonly sessionId: string, readonly connected: string[]) {
    super(`Account ${sessionId} is not connected. Connected accounts: ${connected.length ? connected.join(', ') : 'none'}. Query entity="session" for the current list.`);
    this.name = 'UnknownSessionError';
  }
}

export interface ExtensionFeatures {
  /** mcp.LOCAL_HUB.11 — whether this account may send from this computer (MCP_LOCAL_SEND). */
  local_send?: boolean;
}

interface ExtensionConnection {
  sendFn: SendFn;
  session: SessionInfo | null;
  features: ExtensionFeatures | null;
}

/** mcp.LOCAL_HUB.11 — the send tools stay unless every account said no; unknown counts as yes. */
export function localSendAvailableFor(accounts: Array<{ localSend?: boolean }>): boolean {
  return accounts.length === 0 || accounts.some(a => a.localSend !== false);
}

/**
 * Bridge routes MCP tool calls through WebSocket to the Chrome extension.
 * Uses JSON-RPC 2.0 protocol for communication.
 * Supports multiple extension connections keyed by sessionId.
 */
export class Bridge extends EventEmitter implements ToolBridge {
  private pendingRequests = new Map<string, PendingRequest>();
  private requestCounter = 0;
  // mcp.AUTH.3 — hub keys connections by sessionId, not raw phone number
  private connections = new Map<string, ExtensionConnection>();
  private lastActiveId: string | null = null;
  private readonly REQUEST_TIMEOUT_MS = 30_000;

  /** Returns true if any extension is connected. */
  get connected(): boolean {
    return this.connections.size > 0;
  }

  /** Returns session info from the first connected extension (backward compat). */
  get session(): SessionInfo | null {
    for (const conn of this.connections.values()) {
      if (conn.session) return conn.session;
    }
    return null;
  }

  /** Returns all connected sessions. */
  get sessions(): Map<string, SessionInfo> {
    const result = new Map<string, SessionInfo>();
    for (const [id, conn] of this.connections) {
      if (conn.session) result.set(id, conn.session);
    }
    return result;
  }

  get localSendAvailable(): boolean {
    return localSendAvailableFor([...this.connections.values()].map(c => ({ localSend: c.features?.local_send })));
  }

  /** mcp.LOCAL_HUB.11 — `features.local_send` of one account, if it said. */
  localSendOf(sessionId: string): boolean | undefined {
    return this.connections.get(sessionId)?.features?.local_send;
  }

  onAccountsChanged(listener: () => void): void {
    for (const event of ['connected', 'disconnected', 'session', 'features']) this.on(event, listener);
  }

  /** mcp.LOCAL_HUB.11 — the handshake's `features` (only a boolean local_send is kept). */
  setFeatures(sessionId: string, features: unknown): void {
    const conn = this.connections.get(sessionId);
    if (!conn || !features || typeof features !== 'object') return;
    const localSend = (features as ExtensionFeatures).local_send;
    conn.features = typeof localSend === 'boolean' ? { local_send: localSend } : {};
    this.emit('features', sessionId);
  }

  setSession(sessionId: string, info: SessionInfo): void {
    const conn = this.connections.get(sessionId);
    if (conn) {
      conn.session = info;
      this.lastActiveId = sessionId;
      // mcp.LOCAL_HUB.10 — relay clients learn the account once its handshake names it.
      this.emit('session', sessionId);
    }
  }

  /**
   * Set the WebSocket send function for an extension session.
   */
  setConnection(sessionId: string, sendFn: SendFn): void {
    this.connections.set(sessionId, { sendFn, session: null, features: null });
    this.lastActiveId = sessionId;
    this.emit('connected');
  }

  /**
   * Replace an existing connection (close it cleanly before setting a new one).
   */
  replaceConnection(sessionId: string): void {
    if (this.connections.has(sessionId)) {
      this.connections.delete(sessionId);
    }
  }

  /**
   * Clear the connection for a specific extension session.
   */
  clearConnection(sessionId: string): void {
    this.connections.delete(sessionId);

    if (this.lastActiveId === sessionId) {
      const remaining = [...this.connections.keys()];
      this.lastActiveId = remaining.length > 0 ? remaining[0] : null;
    }

    // Reject pending requests that were sent through this connection
    for (const [id, pending] of this.pendingRequests) {
      if (pending.connectionId === sessionId) {
        clearTimeout(pending.timeout);
        pending.reject(new Error('Extension disconnected'));
        this.pendingRequests.delete(id);
      }
    }

    if (this.connections.size === 0) {
      this.emit('disconnected');
    } else {
      // mcp.LOCAL_HUB.10 — one account left while others stay: relay clients drop it from their list.
      this.emit('session', sessionId);
    }
  }

  /**
   * Send a tool call to the extension and wait for the response.
   * If targetSessionId is provided, route to that specific extension.
   */
  async callTool(
    method: string,
    params: Record<string, unknown>,
    targetSessionId?: string,
    clientName?: string,
  ): Promise<ToolCallResult> {
    if (targetSessionId && !this.connections.has(targetSessionId)) {
      throw new UnknownSessionError(targetSessionId, [...this.connections.keys()]);
    }
    const [sessionId, conn] = this.getConnection(targetSessionId);
    if (!conn) {
      throw new Error(
        'Extension not connected. Make sure the KaptionAI Chrome extension is running with Claude and ChatGPT access turned on.'
      );
    }

    if (['send_message', 'manage_scheduled_messages'].includes(method) && params.attachment != null) params = await resolveLocalAttachment(method, params, async metadata => (await this.callTool('create_attachment_upload', metadata, sessionId ?? undefined, clientName)).data);
    const id = `req_${++this.requestCounter}`;

    const data = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request timed out after ${this.REQUEST_TIMEOUT_MS}ms: ${method}`));
      }, this.REQUEST_TIMEOUT_MS);

      this.pendingRequests.set(id, { resolve, reject, timeout, connectionId: sessionId });

      const request = JSON.stringify(toolRequest(id, method, params, clientName));

      try {
        conn.sendFn(request);
      } catch (err) {
        clearTimeout(timeout);
        this.pendingRequests.delete(id);
        reject(new Error(`Failed to send request: ${(err as Error).message}`));
      }
    });

    return {
      data,
      source: {
        sessionId,
        phone: conn.session?.phone,
        pushname: conn.session?.pushname,
      },
    };
  }

  /**
   * Handle a JSON-RPC response from the extension
   */
  handleResponse(data: string): void {
    let parsed: {
      jsonrpc: string;
      id?: string;
      result?: unknown;
      error?: { code: number; message: string };
    };

    try {
      parsed = JSON.parse(data);
    } catch {
      console.error('[Kaption AI MCP] Failed to parse response:', data);
      return;
    }

    if (!parsed.id) {
      // Notification from extension (no id) - ignore for now
      return;
    }

    const pending = this.pendingRequests.get(parsed.id);
    if (!pending) {
      console.warn('[Kaption AI MCP] Received response for unknown request:', parsed.id);
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingRequests.delete(parsed.id);

    if (parsed.error) {
      pending.reject(new Error(parsed.error.message));
    } else {
      pending.resolve(parsed.result);
    }
  }

  private getConnection(targetSessionId?: string): [string, ExtensionConnection] | [string, null] {
    if (targetSessionId) {
      const conn = this.connections.get(targetSessionId);
      return conn ? [targetSessionId, conn] : ['', null];
    }
    // Prefer the most recently active connection
    if (this.lastActiveId) {
      const conn = this.connections.get(this.lastActiveId);
      if (conn) return [this.lastActiveId, conn];
    }
    // Fall back to any connection
    for (const [id, conn] of this.connections) {
      return [id, conn];
    }
    return ['', null];
  }
}
