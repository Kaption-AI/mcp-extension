// mcp-local-hub-growth.CLIENT.1-2, CLIENT.5, ERRORS.1-2 — the hub says which AI app made each call and which app
// (and hub version) it serves when it pairs, and a failed call answers with the cloud relay's text.
// fixtures/mcp-clients.json is a copy of kaptionai kaption-core/fixtures/mcp/clients.json.
import type { AddressInfo } from 'net';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Bridge, UnknownSessionError } from '../bridge';
import { RelayBridge } from '../relayBridge';
import { createMcpServer } from '../mcpServer';
import { createWebSocketServer } from '../wsServer';
import { normalizeMcpClient, sanitizeClient, sanitizeClientName, sanitizeClientVersion } from '../mcpClient';
import { toolErrorText } from '../toolErrors';
import fixture from './fixtures/mcp-clients.json';

jest.mock('../updateCheck', () => ({ getUpdateInfo: () => null, getCurrentVersion: () => '0.5.21-test', checkForUpdates: () => {} }));

const flush = () => new Promise(r => setTimeout(r, 20));
const TOKEN = 'b'.repeat(64);

/** A fake extension: records every raw JSON-RPC request; `answer` decides the reply (default: ok). */
function fakeExtension(bridge: Bridge, sessionId: string, answer?: (req: any) => object | null) {
  const requests: any[] = [];
  bridge.setConnection(sessionId, (raw: string) => {
    const req = JSON.parse(raw);
    requests.push(req);
    const reply = answer ? answer(req) : { result: { ok: true } };
    if (reply) setImmediate(() => bridge.handleResponse(JSON.stringify({ jsonrpc: '2.0', id: req.id, ...reply })));
  });
  bridge.setSession(sessionId, { phone: sessionId, pushname: sessionId });
  return requests;
}

async function mcpClient(bridge: Bridge | RelayBridge, clientInfo = { name: 'claude-code', version: '2.0.31' }) {
  const server = createMcpServer(bridge);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client(clientInfo);
  await server.connect(serverT);
  await client.connect(clientT);
  return client;
}

const text = (res: any): string => res.content[0].text;

describe('mcp-local-hub-growth.CLIENT.5 sanitized client name and version', () => {
  it.each(fixture.cases.map(c => [JSON.stringify(c.name), c]))('mcp-local-hub-growth.CLIENT.5 %s', (_label, c: any) => {
    expect(sanitizeClientName(c.name)).toBe(c.expected.mcpClientName);
    expect(sanitizeClientVersion(c.version)).toBe(c.expected.mcpClientVersion);
  });

  it.each(fixture.cases.map(c => [`${JSON.stringify(c.name)} ${c.path}`, c]))('mcp-local-hub-growth.CLIENT.4 normalizes %s', (_label, c: any) => {
    expect(normalizeMcpClient(c.name, c.path)).toBe(c.expected.mcpClient);
  });

  it('mcp-local-hub-growth.CLIENT.1 nothing usable said is no client', () => {
    expect(sanitizeClient(undefined)).toBeUndefined();
    expect(sanitizeClient({ name: '  ', version: '' })).toBeUndefined();
    expect(sanitizeClient({ name: 'kally', version: null, extra: 'x' })).toEqual({ name: 'kally', version: '' });
  });
});

describe('mcp-local-hub-growth.CLIENT.1 the AI app rides beside every forwarded tool call', () => {
  it('mcp-local-hub-growth.CLIENT.1 a stdio call carries the initialize clientInfo at the top level, outside params', async () => {
    const bridge = new Bridge();
    const requests = fakeExtension(bridge, 'sess_a');
    const client = await mcpClient(bridge, { name: '  Cursor  (1.7)\n', version: '\t1.7.0' });
    const res: any = await client.callTool({ name: 'list_contacts', arguments: { limit: 2 } });
    expect(res.isError).toBeFalsy();
    expect(requests).toHaveLength(1);
    expect(Object.keys(requests[0]).sort()).toEqual(['client', 'id', 'jsonrpc', 'method', 'params']);
    expect(requests[0].client).toEqual({ name: 'Cursor (1.7)', version: '1.7.0' });
    expect(requests[0].params).not.toHaveProperty('client');
    await client.close();
  });

  it('mcp-local-hub-growth.CLIENT.1 an unknown client leaves the field out', async () => {
    const bridge = new Bridge();
    const requests = fakeExtension(bridge, 'sess_a');
    await bridge.callTool('query', { entity: 'chats' });
    expect(Object.keys(requests[0]).sort()).toEqual(['id', 'jsonrpc', 'method', 'params']);
  });

  it('mcp-local-hub-growth.CLIENT.1 relay mode: the second hub\'s app reaches the extension, not the main hub\'s', async () => {
    const promote = jest.spyOn(RelayBridge.prototype as any, 'promoteToHub').mockResolvedValue(undefined);
    const bridge = new Bridge();
    bridge.setMcpClient({ name: 'Claude', version: '1.0.0' }); // the main hub's own stdio app
    const requests = fakeExtension(bridge, 'sess_a', req =>
      req.params.limit === 99 ? { error: { code: -32601, message: 'no handler' } } : { result: { ok: true } });
    const wss = await createWebSocketServer(bridge, TOKEN, {} as any, 0);
    const relay = new RelayBridge();
    await relay.connect(`ws://127.0.0.1:${(wss.address() as AddressInfo).port}`, TOKEN);
    const client = await mcpClient(relay, { name: 'cursor-vscode', version: '1.0.0 <x>' });

    const ok: any = await client.callTool({ name: 'list_contacts', arguments: {} });
    expect(ok.isError).toBeFalsy();
    expect(requests[0].client).toEqual({ name: 'cursor-vscode', version: '1.0.0x' });
    expect(requests[0].params).not.toHaveProperty('client');

    // mcp-local-hub-growth.ERRORS.2 — the extension's code survives the trip through the main hub.
    const old: any = await client.callTool({ name: 'list_contacts', arguments: { limit: 99 } });
    expect(old.isError).toBe(true);
    expect(text(old)).toBe('Error: this Kaption version cannot run list_contacts yet. Update the Kaption extension or desktop app, reload WhatsApp Web, then try again.');

    await client.close();
    for (const c of wss.clients) c.terminate();
    await new Promise(r => wss.close(r));
    await flush();
    promote.mockRestore();
  });
});

describe('mcp-local-hub-growth.CLIENT.2 the hub tells its version and its app when it pairs', () => {
  const sessions = {
    validateSession: async (id: string, token: string) => (id === 'sess_known' && token === 'tok' ? { id } : null),
    createSession: async () => ({ id: 'sess_new', token: 'tok_new', expiresAt: '2027-01-01T00:00:00Z' }),
  } as any;

  function nextMessage(ws: WebSocket): Promise<any> {
    return new Promise(resolve => ws.once('message', d => resolve(JSON.parse(d.toString()))));
  }

  it('mcp-local-hub-growth.CLIENT.2 initialize hands the stdio app to the bridge', async () => {
    const bridge = new Bridge();
    const client = await mcpClient(bridge, { name: 'claude-ai', version: '0.1.0' });
    await flush();
    expect(bridge.mcpClient).toEqual({ name: 'claude-ai', version: '0.1.0' });
    await client.close();
  });

  it('mcp-local-hub-growth.CLIENT.2 pairing_request, pairing_complete and auth_success carry hub_version and client', async () => {
    const bridge = new Bridge();
    bridge.setMcpClient({ name: 'claude-code', version: '2.0.31' });
    const wss = await createWebSocketServer(bridge, TOKEN, sessions, 0);
    const url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`;
    const expected = { hub_version: '0.5.21-test', client: { name: 'claude-code', version: '2.0.31' } };

    const fresh = new WebSocket(url, { origin: 'chrome-extension://abc' });
    await new Promise(r => fresh.once('open', r));
    const request = nextMessage(fresh);
    fresh.send(JSON.stringify({ method: 'handshake', params: { session: { phone: '1', pushname: 'A' } } }));
    expect(await request).toEqual({ method: 'pairing_request', params: { hub_name: 'Kaption AI MCP', ...expected } });
    const complete = nextMessage(fresh);
    fresh.send(JSON.stringify({ method: 'pairing_response', params: { approved: true } }));
    expect(await complete).toEqual({
      method: 'pairing_complete',
      params: { session_id: 'sess_new', session_token: 'tok_new', expires_at: Date.parse('2027-01-01T00:00:00Z'), ...expected },
    });

    // Before the app has said who it is, the client is left out.
    bridge.setMcpClient(undefined);
    const known = new WebSocket(url, { origin: 'chrome-extension://abc' });
    await new Promise(r => known.once('open', r));
    const success = nextMessage(known);
    known.send(JSON.stringify({ method: 'handshake', params: { auth: { session_id: 'sess_known', session_token: 'tok' } } }));
    expect(await success).toEqual({ method: 'auth_success', params: { session_id: 'sess_known', hub_version: '0.5.21-test' } });

    fresh.close(); known.close();
    await new Promise(r => wss.close(r));
  });
});

describe('mcp-local-hub-growth.ERRORS.1 a failed call answers the cloud relay\'s text', () => {
  const NOT_CONNECTED = 'Error: Extension not connected: Kaption is not connected to this computer. Open WhatsApp Web with the Kaption extension (or open the Kaption desktop app), check that Claude and ChatGPT access is turned on in Kaption and "Connect on this computer" is allowed, then try again.';
  const DISCONNECTED = 'Error: Kaption disconnected before it answered (WhatsApp Web was closed or reloaded). Nothing is known about the result: check WhatsApp is open with Kaption, then look before retrying a change.';

  it('mcp-local-hub-growth.ERRORS.1 the extension\'s own message passes through as Error: <message>', async () => {
    const bridge = new Bridge();
    fakeExtension(bridge, 'sess_a', () => ({ error: { code: -32001, message: 'Conversation not found' } }));
    const client = await mcpClient(bridge);
    const res: any = await client.callTool({ name: 'get_contact', arguments: { id: 'x' } });
    expect(res).toMatchObject({ isError: true, content: [{ type: 'text', text: 'Error: Conversation not found' }] });
    expect(res.content).toHaveLength(1);
    await client.close();
  });

  it('mcp-local-hub-growth.ERRORS.1 no extension connected', async () => {
    const client = await mcpClient(new Bridge());
    const res: any = await client.callTool({ name: 'list_contacts', arguments: {} });
    expect(res.isError).toBe(true);
    expect(text(res)).toBe(NOT_CONNECTED);
    expect(toolErrorText('x', new Error('Extension not connected. Make sure the KaptionAI Chrome extension is running.'))).toBe(NOT_CONNECTED);
    expect(toolErrorText('x', new Error('Not connected to Kaption AI MCP hub'))).toBe(NOT_CONNECTED);
    await client.close();
  });

  it('mcp-local-hub-growth.ERRORS.1 the connection closed while the call waited', async () => {
    const bridge = new Bridge();
    fakeExtension(bridge, 'sess_a', () => null);
    const client = await mcpClient(bridge);
    const pending = client.callTool({ name: 'list_contacts', arguments: {} });
    await flush();
    bridge.clearConnection('sess_a');
    expect(text(await pending)).toBe(DISCONNECTED);
    expect(toolErrorText('x', new Error('Hub disconnected'))).toBe(DISCONNECTED);
    await client.close();
  });

  it('mcp-local-hub-growth.ERRORS.1 timed out, in seconds', () => {
    expect(toolErrorText('query', new Error('Request timed out after 30000ms: query'))).toBe(
      'Error: Kaption did not answer within 30 seconds. Keep WhatsApp Web open with Kaption and try again; for a large read, ask for fewer results with limit.');
  });

  it('mcp-local-hub-growth.ERRORS.1 no reason given', () => {
    const none = 'Error: Kaption could not complete query and gave no reason. Check WhatsApp Web is open with Kaption and try again.';
    expect(toolErrorText('query', new Error(''))).toBe(none);
    expect(toolErrorText('query', new Error('Extension returned error'))).toBe(none);
  });

  it('mcp-local-hub-growth.ERRORS.1 an unknown account keeps its own message', async () => {
    const bridge = new Bridge();
    fakeExtension(bridge, 'sess_a');
    const client = await mcpClient(bridge);
    const res: any = await client.callTool({ name: 'query', arguments: { entity: 'conversations', target_session: 'sess_gone' } });
    expect(text(res)).toBe(`Error: ${new UnknownSessionError('sess_gone', ['sess_a']).message}`);
    await client.close();
  });
});

describe('mcp-local-hub-growth.ERRORS.2 the JSON-RPC code stays on the failure', () => {
  it('mcp-local-hub-growth.ERRORS.2 method-not-found reads as an older Kaption', async () => {
    const bridge = new Bridge();
    fakeExtension(bridge, 'sess_a', () => ({ error: { code: -32601, message: 'no handler' } }));
    await expect(bridge.callTool('export_chat', {})).rejects.toMatchObject({ message: 'no handler', code: -32601 });
    const client = await mcpClient(bridge);
    const res: any = await client.callTool({ name: 'list_contacts', arguments: {} });
    expect(text(res)).toBe('Error: this Kaption version cannot run list_contacts yet. Update the Kaption extension or desktop app, reload WhatsApp Web, then try again.');
    expect(toolErrorText('t', new Error('Unknown tool: t'))).toMatch(/cannot run t yet/);
    await client.close();
  });
});
