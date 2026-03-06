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
  callTool(method: string, params: Record<string, unknown>, targetSessionId?: string): Promise<ToolCallResult>;
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  connectionId: string;
}

type SendFn = (data: string) => void;

interface ExtensionConnection {
  sendFn: SendFn;
  session: SessionInfo | null;
}

/**
 * Bridge routes MCP tool calls through WebSocket to the Chrome extension.
 * Uses JSON-RPC 2.0 protocol for communication.
 * Supports multiple extension connections keyed by sessionId.
 */
export class Bridge extends EventEmitter implements ToolBridge {
  private pendingRequests = new Map<string, PendingRequest>();
  private requestCounter = 0;
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

  setSession(sessionId: string, info: SessionInfo): void {
    const conn = this.connections.get(sessionId);
    if (conn) {
      conn.session = info;
      this.lastActiveId = sessionId;
    }
  }

  /**
   * Set the WebSocket send function for an extension session.
   */
  setConnection(sessionId: string, sendFn: SendFn): void {
    this.connections.set(sessionId, { sendFn, session: null });
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
  ): Promise<ToolCallResult> {
    const [sessionId, conn] = this.getConnection(targetSessionId);
    if (!conn) {
      throw new Error(
        'Extension not connected. Make sure the KaptionAI Chrome extension is running with the MCP bridge feature enabled.'
      );
    }

    const id = `req_${++this.requestCounter}`;

    const data = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request timed out after ${this.REQUEST_TIMEOUT_MS}ms: ${method}`));
      }, this.REQUEST_TIMEOUT_MS);

      this.pendingRequests.set(id, { resolve, reject, timeout, connectionId: sessionId });

      const request = JSON.stringify({
        jsonrpc: '2.0',
        id,
        method,
        params,
      });

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
