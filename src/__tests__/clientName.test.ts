// mcp-usage-accounting.LOCAL.3 — the hub forwards the AI app's name (MCP initialize clientInfo.name) with each
// tool call, as a top-level `client: { name }` beside method/params. Tool arguments never change, and only the
// trimmed name (≤ 64 characters) travels.
import type { AddressInfo } from 'net';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Bridge } from '../bridge';
import { clientNameOf, toolRequest, CLIENT_NAME_MAX } from '../clientName';
import { createMcpServer } from '../mcpServer';

jest.mock('../updateCheck', () => ({ getUpdateInfo: () => null, getCurrentVersion: () => '0.0.0-test', checkForUpdates: () => {} }));

const flush = (ms = 20) => new Promise(r => setTimeout(r, ms));

/** A bridge whose only extension answers every request with `{ ok: true }` and records what it got. */
function answeringBridge(): { bridge: Bridge; sent: any[] } {
  const bridge = new Bridge();
  const sent: any[] = [];
  bridge.setConnection('sess_1', data => {
    const msg = JSON.parse(data);
    sent.push(msg);
    setImmediate(() => bridge.handleResponse(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { ok: true } })));
  });
  bridge.setSession('sess_1', { phone: '1', pushname: 'x' });
  return { bridge, sent };
}

describe('mcp-usage-accounting.LOCAL.3 clientNameOf / toolRequest', () => {
  it('trims, caps at 64 characters, and drops empty or non-string names', () => {
    expect(clientNameOf('  claude-code  ')).toBe('claude-code');
    expect(clientNameOf('x'.repeat(100))).toHaveLength(CLIENT_NAME_MAX);
    expect(clientNameOf('é'.repeat(70))).toBe('é'.repeat(64));
    expect(clientNameOf('   ')).toBeUndefined();
    expect(clientNameOf('')).toBeUndefined();
    expect(clientNameOf(undefined)).toBeUndefined();
    expect(clientNameOf(42)).toBeUndefined();
    expect(clientNameOf({ name: 'x' })).toBeUndefined();
  });

  it('puts client beside method/params, never inside params', () => {
    const params = { entity: 'conversations', limit: 5 };
    expect(toolRequest('req_1', 'query', params, 'Claude Desktop')).toEqual({
      jsonrpc: '2.0', id: 'req_1', method: 'query', params, client: { name: 'Claude Desktop' },
    });
    expect(params).toEqual({ entity: 'conversations', limit: 5 });
  });

  it('leaves client out when the name is unknown (the request is exactly what older hubs sent)', () => {
    expect(toolRequest('req_1', 'query', { a: 1 })).toEqual({ jsonrpc: '2.0', id: 'req_1', method: 'query', params: { a: 1 } });
    expect(toolRequest('req_1', 'query', { a: 1 }, '  ')).not.toHaveProperty('client');
  });
});

describe('mcp-usage-accounting.LOCAL.3 Bridge.callTool', () => {
  it('sends client.name when given and leaves params untouched', async () => {
    const { bridge, sent } = answeringBridge();
    await bridge.callTool('query', { entity: 'labels' }, undefined, 'cursor');
    expect(sent[0]).toMatchObject({ method: 'query', params: { entity: 'labels' }, client: { name: 'cursor' } });
    expect(sent[0].params).not.toHaveProperty('client');
  });

  it('sends no client field without a name', async () => {
    const { bridge, sent } = answeringBridge();
    await bridge.callTool('query', { entity: 'labels' });
    expect(sent[0]).not.toHaveProperty('client');
  });
});

describe('mcp-usage-accounting.LOCAL.3 from the MCP client to the extension', () => {
  it('forwards the connected app\'s clientInfo.name with each tool call', async () => {
    const { bridge, sent } = answeringBridge();
    const server = createMcpServer(bridge);
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: '  claude-ai ', version: '0.1.0' });
    await server.connect(serverT);
    await client.connect(clientT);

    await client.callTool({ name: 'query', arguments: { entity: 'labels' } });
    expect(sent).toHaveLength(1);
    expect(sent[0].client).toEqual({ name: 'claude-ai' });
    expect(sent[0].params).toMatchObject({ entity: 'labels' });
    expect(sent[0].params).not.toHaveProperty('client');
    // Only the name: never the client's version or anything else from initialize.
    expect(JSON.stringify(sent[0])).not.toContain('0.1.0');
    await client.close();
  });

  it('a relay client\'s app name reaches the extension through the hub', async () => {
    jest.resetModules();
    const { createWebSocketServer } = require('../wsServer');
    const { Bridge: HubBridge } = require('../bridge');
    const { RelayBridge } = require('../relayBridge');
    const { SessionManager } = require('../auth');
    const sessions = new SessionManager();
    const session = { id: 'sess_ext', token: 't'.repeat(64) };
    jest.spyOn(sessions, 'validateSession').mockResolvedValue(session as any);
    const bridge = new HubBridge();
    const token = 'r'.repeat(64);
    const wss = await createWebSocketServer(bridge, token, sessions, 0);
    const port = (wss.address() as AddressInfo).port;

    const ext = new WebSocket(`ws://127.0.0.1:${port}`, { origin: 'chrome-extension://abc' });
    const extMsgs: any[] = [];
    ext.on('message', d => {
      const msg = JSON.parse(String(d));
      extMsgs.push(msg);
      if (msg.id && msg.method) ext.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { ok: true } }));
    });
    await new Promise(r => ext.on('open', r));
    ext.send(JSON.stringify({ jsonrpc: '2.0', method: 'handshake', params: {
      auth: { session_token: session.token, session_id: session.id },
      session: { phone: '1', pushname: 'x' },
    } }));
    await flush(150);

    const relay = new RelayBridge();
    await relay.connect(`ws://127.0.0.1:${port}`, token);
    await relay.callTool('query', { entity: 'labels' }, undefined, 'Cursor');
    const call = extMsgs.find(m => m.method === 'query');
    expect(call.client).toEqual({ name: 'Cursor' });
    expect(call.params).not.toHaveProperty('client');

    (relay as any).ws?.removeAllListeners('close'); // no promotion to hub while the test shuts down
    (relay as any).ws?.close();
    ext.close();
    await flush();
    await new Promise(r => wss.close(r));
  });
});
