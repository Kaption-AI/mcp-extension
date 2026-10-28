// mcp.LOCAL_HUB.11 — the extension's handshake says whether its account may send from this computer
// (features.local_send = MCP_LOCAL_SEND); the hub lists send_message / create_attachment_upload only while
// some connected account may (support #10002231). Older extensions send no features: the tools stay.
import type { AddressInfo } from 'net';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Bridge, localSendAvailableFor } from '../bridge';
import { RelayBridge } from '../relayBridge';
import { createMcpServer, LOCAL_SEND_TOOLS } from '../mcpServer';

jest.mock('../updateCheck', () => ({ getUpdateInfo: () => null, getCurrentVersion: () => '0.0.0-test', checkForUpdates: () => {} }));

function connect(bridge: Bridge, sessionId: string, features?: unknown): void {
  bridge.setConnection(sessionId, () => {});
  if (features !== undefined) bridge.setFeatures(sessionId, features);
  bridge.setSession(sessionId, { phone: sessionId, pushname: sessionId });
}

async function listedTools(bridge: Bridge | RelayBridge) {
  const server = createMcpServer(bridge);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 't', version: '1' });
  let changed = 0;
  await server.connect(serverT);
  await client.connect(clientT);
  client.setNotificationHandler(
    (await import('@modelcontextprotocol/sdk/types.js')).ToolListChangedNotificationSchema,
    async () => { changed++; },
  );
  const names = async () => (await client.listTools()).tools.map(t => t.name);
  return { names, changed: () => changed, close: () => client.close() };
}

const flush = () => new Promise(r => setTimeout(r, 20));

describe('mcp.LOCAL_HUB.11 send tools follow the connected accounts\' MCP_LOCAL_SEND', () => {
  it('available unless every account said no; unknown counts as yes', () => {
    expect(localSendAvailableFor([])).toBe(true);
    expect(localSendAvailableFor([{ localSend: false }])).toBe(false);
    expect(localSendAvailableFor([{ localSend: false }, {}])).toBe(true);
    expect(localSendAvailableFor([{ localSend: false }, { localSend: true }])).toBe(true);
  });

  it('hides send_message and create_attachment_upload while the only account says no, and tells the client', async () => {
    const bridge = new Bridge();
    const mcp = await listedTools(bridge);
    expect(await mcp.names()).toEqual(expect.arrayContaining(LOCAL_SEND_TOOLS));

    connect(bridge, 'sess_a', { local_send: false });
    await flush();
    const hidden = await mcp.names();
    for (const t of LOCAL_SEND_TOOLS) expect(hidden).not.toContain(t);
    expect(hidden).toContain('query');
    expect(mcp.changed()).toBeGreaterThan(0);

    // A second account that may send brings them back; its leaving hides them again.
    connect(bridge, 'sess_b', { local_send: true });
    await flush();
    expect(await mcp.names()).toEqual(expect.arrayContaining(LOCAL_SEND_TOOLS));
    bridge.clearConnection('sess_b');
    await flush();
    expect(await mcp.names()).not.toContain('send_message');

    // The last account leaving: nothing known, listed again.
    bridge.clearConnection('sess_a');
    await flush();
    expect(await mcp.names()).toEqual(expect.arrayContaining(LOCAL_SEND_TOOLS));
    await mcp.close();
  });

  it('an older extension that sends no features keeps the send tools listed', async () => {
    const bridge = new Bridge();
    const mcp = await listedTools(bridge);
    connect(bridge, 'sess_old');
    await flush();
    expect(await mcp.names()).toEqual(expect.arrayContaining(LOCAL_SEND_TOOLS));
    connect(bridge, 'sess_junk', { local_send: 'no' });
    expect(bridge.localSendOf('sess_junk')).toBeUndefined();
    expect(bridge.localSendAvailable).toBe(true);
    await mcp.close();
  });

  it('a relay client follows the hub\'s localSendAvailable', async () => {
    const relay = new RelayBridge();
    const mcp = await listedTools(relay);
    (relay as any).accountsChanged({ connected: true, extensions: [], localSendAvailable: false });
    await flush();
    expect(await mcp.names()).not.toContain('send_message');
    (relay as any).accountsChanged({ connected: true, extensions: [] }); // an older hub: says nothing
    await flush();
    expect(await mcp.names()).toContain('send_message');
    await mcp.close();
  });
});

describe('mcp.LOCAL_HUB.11 over the hub\'s WebSocket', () => {
  it('reads features from the extension handshake and broadcasts localSendAvailable to relay clients', async () => {
    jest.resetModules();
    const { createWebSocketServer } = require('../wsServer');
    const { Bridge: HubBridge } = require('../bridge');
    const { SessionManager } = require('../auth');
    const sessions = new SessionManager();
    const session = { id: 'sess_ext', token: 't'.repeat(64) };
    jest.spyOn(sessions, 'validateSession').mockResolvedValue(session as any);
    const bridge = new HubBridge();
    const token = 'r'.repeat(64);
    const wss = await createWebSocketServer(bridge, token, sessions, 0);
    const port = (wss.address() as AddressInfo).port;
    const relay = new WebSocket(`ws://127.0.0.1:${port}`);
    const relayMsgs: any[] = [];
    relay.on('message', d => relayMsgs.push(JSON.parse(String(d))));
    await new Promise(r => relay.on('open', r));
    relay.send(JSON.stringify({ method: 'relay_connect', params: { auth_token: token } }));
    await flush();
    expect(relayMsgs[0]).toMatchObject({ method: 'relay_ack', params: { localSendAvailable: true } });

    const ext = new WebSocket(`ws://127.0.0.1:${port}`, { origin: 'chrome-extension://abc' });
    await new Promise(r => ext.on('open', r));
    ext.send(JSON.stringify({ jsonrpc: '2.0', method: 'handshake', params: {
      auth: { session_token: session.token, session_id: session.id },
      session: { phone: '1', pushname: 'x' },
      features: { local_send: false },
    } }));
    await new Promise(r => setTimeout(r, 150));
    expect(bridge.localSendAvailable).toBe(false);
    const last = relayMsgs.filter(m => m.method === 'extension_status').pop();
    expect(last.params.localSendAvailable).toBe(false);
    expect(last.params.extensions[0]).toMatchObject({ localSend: false });
    ext.close(); relay.close();
    await flush();
    await new Promise(r => wss.close(r));
  });
});
