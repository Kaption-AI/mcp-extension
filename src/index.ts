#!/usr/bin/env node

import { Bridge } from './bridge';
import type { ToolBridge } from './bridge';
import { createWebSocketServer } from './wsServer';
import { RelayBridge } from './relayBridge';
import { createMcpServer, startMcpServer } from './mcpServer';
import { createHttpServer } from './httpServer';
import { loadOrCreateToken, getTokenFilePath, SessionManager } from './auth';

const WS_URL = 'ws://127.0.0.1:7865';

async function main(): Promise<void> {
  console.error('[Kaption AI MCP] Starting...');

  const authToken = await loadOrCreateToken();
  const sessionManager = new SessionManager();
  sessionManager.cleanExpired();

  let toolBridge: ToolBridge;
  let cleanup = () => {};

  try {
    // Try hub mode: own the WebSocket server
    const bridge = new Bridge();
    const wss = await createWebSocketServer(bridge, authToken, sessionManager);
    toolBridge = bridge;

    // Start HTTP REST API (hub mode only — relay skips to avoid port conflicts)
    let httpServer: import('http').Server | null = null;
    try {
      httpServer = await createHttpServer(bridge, authToken);
    } catch (err) {
      console.error('[Kaption AI MCP] HTTP server failed to start:', (err as Error).message);
    }

    cleanup = () => {
      httpServer?.close();
      wss.close();
    };
    console.error('[Kaption AI MCP] Running in hub mode');
    console.error(`[Kaption AI MCP] Auth token file: ${getTokenFilePath()}`);
  } catch (err: any) {
    if (err.code === 'EADDRINUSE') {
      // Another hub is already running — connect as relay client
      console.error('[Kaption AI MCP] Port in use, connecting as relay to existing hub...');
      const relay = new RelayBridge();
      await relay.connect(WS_URL, authToken);
      toolBridge = relay;
      console.error('[Kaption AI MCP] Running in relay mode');
    } else {
      throw err;
    }
  }

  // Create and start the MCP server (stdio)
  const mcpServer = createMcpServer(toolBridge, authToken);
  await startMcpServer(mcpServer);

  // Handle graceful shutdown
  const shutdown = () => {
    console.error('[Kaption AI MCP] Shutting down...');
    cleanup();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[Kaption AI MCP] Fatal error:', err);
  process.exit(1);
});
