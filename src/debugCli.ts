#!/usr/bin/env node

/**
 * Dev-only CLI for the Kaption debug_eval MCP handler.
 *
 * Connects as a relay client over WebSocket to the MCP hub and forwards
 * debug_eval tool calls to the extension running in WhatsApp Web.
 *
 * Usage:
 *   kaption-debug                          # Interactive REPL
 *   kaption-debug --store-keys             # List Store modules
 *   kaption-debug --inspect Chat           # Inspect Store.Chat
 *   kaption-debug --eval "return 1+1"      # One-shot eval
 */

import WebSocket from 'ws';
import * as readline from 'readline';
import { loadOrCreateToken } from './auth';

const WS_URL = 'ws://127.0.0.1:7865';
const REQUEST_TIMEOUT_MS = 30_000;

let requestId = 0;
let ws: WebSocket | null = null;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();

async function connect(): Promise<void> {
  const token = await loadOrCreateToken();

  return new Promise((resolve, reject) => {
    ws = new WebSocket(WS_URL);

    ws.on('open', () => {
      ws!.send(JSON.stringify({
        method: 'relay_connect',
        params: { auth_token: token },
      }));
    });

    ws.on('message', (data) => {
      let msg: any;
      try { msg = JSON.parse(data.toString()); } catch { return; }

      // Relay ack — connection established
      if (msg.method === 'relay_ack') {
        const exts = msg.params?.extensions || [];
        if (exts.length === 0) {
          console.error('Warning: No extension connected. Make sure WhatsApp Web is open with a dev build.');
        } else {
          const ext = exts[0];
          console.error(`Connected to: ${ext.pushname || 'Unknown'} (${ext.phone || 'no phone'})`);
        }
        resolve();
        return;
      }

      // Extension status updates
      if (msg.method === 'extension_status') {
        const connected = msg.params?.connected;
        if (!connected) {
          console.error('Warning: Extension disconnected.');
        }
        return;
      }

      // Response to a request
      if (msg.id !== undefined && pending.has(msg.id)) {
        const p = pending.get(msg.id)!;
        pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) {
          p.reject(new Error(msg.error.message));
        } else {
          p.resolve(msg.result);
        }
      }
    });

    ws.on('error', (err) => {
      reject(new Error(`WebSocket error: ${err.message}\nIs the MCP hub running? (npx mcp-whatsapp)`));
    });

    ws.on('close', (code, reason) => {
      if (code === 4003) {
        reject(new Error('Authentication failed. Token mismatch — is the hub using the same token file?'));
      }
      // Reject any pending requests
      for (const [id, p] of pending) {
        clearTimeout(p.timer);
        p.reject(new Error('Connection closed'));
        pending.delete(id);
      }
    });
  });
}

function callTool(method: string, params: Record<string, unknown>): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return reject(new Error('Not connected'));
    }

    const id = ++requestId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Request timed out after ${REQUEST_TIMEOUT_MS}ms`));
    }, REQUEST_TIMEOUT_MS);

    pending.set(id, { resolve, reject, timer });

    ws.send(JSON.stringify({
      jsonrpc: '2.0',
      id,
      method,
      params,
    }));
  });
}

async function debugEval(mode: string, params: Record<string, unknown> = {}): Promise<any> {
  return callTool('debug_eval', { mode, ...params });
}

function printResult(result: any): void {
  if (result?.error) {
    console.error('Error:', result.error.message || result.error);
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
}

async function runRepl(): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'kapton> ',
    historySize: 100,
  });

  console.log('Kaption Debug REPL');
  console.log('Commands: .keys  .inspect <path>  .status  .exit');
  console.log('Anything else is evaluated as JS in the page context.');
  console.log('Use "return <expr>" to get a value back.\n');

  rl.prompt();

  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) { rl.prompt(); return; }

    try {
      if (trimmed === '.exit' || trimmed === '.quit') {
        rl.close();
        process.exit(0);
      }

      if (trimmed === '.keys') {
        printResult(await debugEval('store_keys'));
      } else if (trimmed.startsWith('.inspect ')) {
        const path = trimmed.slice('.inspect '.length).trim();
        printResult(await debugEval('store_inspect', { path }));
      } else if (trimmed === '.status') {
        printResult(await callTool('query', { entity: 'session' }));
      } else {
        // Treat as JS code
        printResult(await debugEval('eval', { code: trimmed }));
      }
    } catch (e) {
      console.error('Error:', e instanceof Error ? e.message : String(e));
    }

    rl.prompt();
  });

  rl.on('close', () => {
    process.exit(0);
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  try {
    await connect();
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }

  // One-shot modes
  if (args.includes('--store-keys')) {
    try {
      printResult(await debugEval('store_keys'));
    } catch (e) {
      console.error('Error:', e instanceof Error ? e.message : String(e));
      process.exit(1);
    }
    process.exit(0);
  }

  const inspectIdx = args.indexOf('--inspect');
  if (inspectIdx !== -1) {
    const path = args[inspectIdx + 1];
    if (!path) { console.error('Usage: --inspect <Store.path>'); process.exit(1); }
    try {
      printResult(await debugEval('store_inspect', { path }));
    } catch (e) {
      console.error('Error:', e instanceof Error ? e.message : String(e));
      process.exit(1);
    }
    process.exit(0);
  }

  const evalIdx = args.indexOf('--eval');
  if (evalIdx !== -1) {
    const code = args[evalIdx + 1];
    if (!code) { console.error('Usage: --eval "<code>"'); process.exit(1); }
    try {
      printResult(await debugEval('eval', { code }));
    } catch (e) {
      console.error('Error:', e instanceof Error ? e.message : String(e));
      process.exit(1);
    }
    process.exit(0);
  }

  // Interactive REPL (default)
  await runRepl();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
