import WebSocket from 'ws';
import { Bridge } from './bridge';
import type { ToolBridge, ToolCallResult, SessionInfo } from './bridge';
import { createWebSocketServer } from './wsServer';
import { loadOrCreateToken, SessionManager } from './auth';

interface PendingRequest {
  resolve: (result: ToolCallResult) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
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
 * Relay bridge — connects as a WS client to an existing Kaption AI MCP hub.
 * Provides the same ToolBridge interface so the MCP server works identically.
 *
 * If the hub dies, automatically promotes to hub mode (starts own WS server).
 */
export class RelayBridge implements ToolBridge {
  private ws: WebSocket | null = null;
  private pendingRequests = new Map<string, PendingRequest>();
  private requestCounter = 0;
  private _connected = false;
  private readonly REQUEST_TIMEOUT_MS = 30_000;
  private url = '';
  private _session: SessionInfo | null = null;
  private _extensions: ExtensionInfo[] = [];
  private authToken: string | null = null;

  /** When promoted to hub, this holds the real bridge. */
  private hubBridge: Bridge | null = null;

  get connected(): boolean {
    if (this.hubBridge) return this.hubBridge.connected;
    return this._connected;
  }

  get session(): SessionInfo | null {
    if (this.hubBridge) return this.hubBridge.session;
    return this._session;
  }

  get extensions(): ExtensionInfo[] {
    return this._extensions;
  }

  async connect(url: string, token?: string): Promise<void> {
    this.url = url;
    if (token) this.authToken = token;

    // If no token provided, try to load from file
    if (!this.authToken) {
      this.authToken = await loadOrCreateToken();
    }

    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;

      ws.on('open', () => {
        ws.send(JSON.stringify({
          method: 'relay_connect',
          params: { auth_token: this.authToken },
        }));
      });

      ws.on('message', (data) => {
        let msg: any;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          return;
        }

        // Auth failure
        if (msg.error?.code === -32403) {
          console.error('[Kaption AI MCP] Relay authentication failed');
          reject(new Error('Authentication failed'));
          return;
        }

        // Relay handshake acknowledgement
        if (msg.method === 'relay_ack') {
          this._connected = msg.params?.extensionConnected ?? false;
          this._extensions = msg.params?.extensions ?? [];
          if (this._extensions.length > 0) {
            const ext = this._extensions[0];
            this._session = { phone: ext.phone, pushname: ext.pushname, isBusiness: ext.isBusiness, browser: ext.browser };
          }
          console.error(`[Kaption AI MCP] Relay connected (extensions: ${this._extensions.length})`);
          resolve();
          return;
        }

        // Extension status update from hub
        if (msg.method === 'extension_status') {
          this._connected = msg.params?.connected ?? false;
          this._extensions = msg.params?.extensions ?? [];
          if (this._extensions.length > 0) {
            const ext = this._extensions[0];
            this._session = { phone: ext.phone, pushname: ext.pushname, isBusiness: ext.isBusiness, browser: ext.browser };
          } else {
            this._session = null;
          }
          console.error(`[Kaption AI MCP] Extensions: ${this._extensions.length}`);
          return;
        }

        // Response to a tool call
        if (msg.id) {
          const pending = this.pendingRequests.get(msg.id);
          if (!pending) return;
          clearTimeout(pending.timeout);
          this.pendingRequests.delete(msg.id);
          if (msg.error) {
            pending.reject(new Error(msg.error.message));
          } else {
            pending.resolve(msg.result);
          }
        }
      });

      ws.on('close', () => {
        this._connected = false;
        for (const [, p] of this.pendingRequests) {
          clearTimeout(p.timeout);
          p.reject(new Error('Hub disconnected'));
        }
        this.pendingRequests.clear();
        this.ws = null;

        // Hub died — try to promote to hub mode
        this.promoteToHub();
      });

      ws.on('error', (err) => {
        if (this.requestCounter === 0) reject(err);
      });
    });
  }

  async callTool(method: string, params: Record<string, unknown>, targetSessionId?: string): Promise<ToolCallResult> {
    // If promoted to hub, delegate to the real bridge
    if (this.hubBridge) {
      return this.hubBridge.callTool(method, params, targetSessionId);
    }

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Not connected to Kaption AI MCP hub');
    }

    const id = `relay_${++this.requestCounter}`;

    // Include target_session so the hub routes to the right extension
    const sendParams = targetSessionId
      ? { ...params, target_session: targetSessionId }
      : params;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request timed out after ${this.REQUEST_TIMEOUT_MS}ms: ${method}`));
      }, this.REQUEST_TIMEOUT_MS);

      this.pendingRequests.set(id, { resolve, reject, timeout });

      try {
        this.ws!.send(JSON.stringify({ jsonrpc: '2.0', id, method, params: sendParams }));
      } catch (err) {
        clearTimeout(timeout);
        this.pendingRequests.delete(id);
        reject(new Error(`Failed to send request: ${(err as Error).message}`));
      }
    });
  }

  /** Hub died — try to start our own WS server and become the hub. */
  private async promoteToHub(): Promise<void> {
    console.error('[Kaption AI MCP] Hub disconnected, promoting to hub mode...');
    try {
      const token = this.authToken ?? await loadOrCreateToken();
      const sessionManager = new SessionManager();
      const bridge = new Bridge();
      await createWebSocketServer(bridge, token, sessionManager);
      this.hubBridge = bridge;
      console.error('[Kaption AI MCP] Promoted to hub mode — waiting for extension to reconnect');
    } catch (err: any) {
      // Another process beat us to it — reconnect as relay
      if (err.code === 'EADDRINUSE') {
        console.error('[Kaption AI MCP] Another instance took over, reconnecting as relay...');
        setTimeout(() => this.connect(this.url).catch(() => {}), 1000);
      } else {
        console.error('[Kaption AI MCP] Failed to promote to hub:', err.message);
      }
    }
  }
}
