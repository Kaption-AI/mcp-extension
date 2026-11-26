// mcp.LOCAL_HUB.4 — with two WhatsApp numbers connected, every tool that reaches a WhatsApp account takes
// target_session and runs on that account, never on the one used last (E2E 2026-11-20: list_contacts meant for one
// number ran on the other and spent its weekly allowance). Also mcp.LOCAL_HUB.8: the hub says when npm has a newer hub.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Bridge } from '../bridge';
import { createMcpServer } from '../mcpServer';
import { TOOLS } from '../tools';

const mockUpdate: { info: any } = { info: null };
jest.mock('../updateCheck', () => ({
  getUpdateInfo: () => mockUpdate.info,
  getCurrentVersion: () => '0.5.21',
  checkForUpdates: () => {},
}));

const FEATURES = { manage_kaption: true, business_agent: true, plans: true, local_send: true, scheduled_status: true, channels_communities: true, credits_simple: false, kaption_links: true };

function account(bridge: Bridge, sessionId: string, phone: string) {
  const calls: Array<{ method: string; params: any }> = [];
  bridge.setConnection(sessionId, (raw: string) => {
    const req = JSON.parse(raw);
    calls.push({ method: req.method, params: req.params });
    setImmediate(() => bridge.handleResponse(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { ok: true, from: sessionId } })));
  });
  bridge.setFeatures(sessionId, FEATURES);
  bridge.setSession(sessionId, { phone, pushname: sessionId });
  return calls;
}

async function hub() {
  const bridge = new Bridge();
  const a = account(bridge, 'sess_2658', '17374202658');
  const b = account(bridge, 'sess_7172', '17373427172');
  const server = createMcpServer(bridge, { cardsFlag: { anyOn: async () => false } });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 't', version: '1' });
  await server.connect(serverT);
  await client.connect(clientT);
  return { client, a, b };
}

/** Tools answered by the hub itself, without any WhatsApp account. */
const HUB_ONLY = ['get_api_info'];

describe('mcp.LOCAL_HUB.4 target_session on every tool that reaches an account', () => {
  it('every tool definition except the hub-only ones declares target_session', () => {
    const missing = TOOLS.filter(t => !HUB_ONLY.includes(t.name))
      .filter(t => !('target_session' in ((t.inputSchema as any).shape ?? {})))
      .map(t => t.name);
    expect(missing).toEqual([]);
  });

  it('every listed tool takes it (as the AI app sees the tools)', async () => {
    const { client } = await hub();
    const listed = (await client.listTools()).tools;
    expect(listed.length).toBeGreaterThan(30);
    for (const tool of listed) {
      if (HUB_ONLY.includes(tool.name)) continue;
      expect([tool.name, Object.keys((tool.inputSchema as any).properties ?? {})]).toEqual([tool.name, expect.arrayContaining(['target_session'])]);
    }
  });

  it.each([
    ['list_contacts', {}],
    ['list_groups', {}],
    ['get_group', { jid: '120363000000000001@g.us' }],
    ['get_contact', { phone: '+15555550100' }],
    ['get_contact_groups', { jid: '15555550100@c.us' }],
    ['export_contacts', { format: 'json' }],
    ['manage_labels', { action: 'create', label_name: 'x' }],
    ['manage_notes', { action: 'set', contact_id: '15555550100@c.us', note: 'x' }],
    ['get_contact_note', { contact_id: '15555550100@c.us' }],
    ['get_kaption_settings', {}],
    ['create_kaption_checkout_link', { plan: 'pro' }],
    // kaption-links.MCP.10 — the Links tools follow mcp.LOCAL_HUB.4 too.
    ['list_tracked_links', {}],
    ['get_link_clicks', { link: 'l_0123456789abcdef' }],
  ])('%s runs on the session asked for, not the last one used', async (name, args) => {
    const { client, a, b } = await hub();
    // The other number is used last, so routing by "most recent" would pick it.
    await client.callTool({ name: 'query', arguments: { entity: 'labels', target_session: 'sess_7172' } });
    const before = { a: a.length, b: b.length };
    await client.callTool({ name, arguments: { ...args, target_session: 'sess_2658' } });
    expect(a.length).toBe(before.a + 1);
    expect(b.length).toBe(before.b);
    expect(a[a.length - 1].params).not.toHaveProperty('target_session');
  });
});

describe('mcp.LOCAL_HUB.8 update notice', () => {
  afterEach(() => { mockUpdate.info = null; });

  it('says a newer hub once per session, after the answer; nothing when up to date', async () => {
    const quiet = await hub();
    const r0: any = await quiet.client.callTool({ name: 'list_groups', arguments: { target_session: 'sess_2658' } });
    expect(r0.content).toHaveLength(1);
    mockUpdate.info = { current: '0.5.21', latest: '0.5.23', message: 'Kaption MCP update available: 0.5.21 → 0.5.23. Restart the AI app to pick it up, or run: npx @kaptionai/mcp-extension@latest' };
    const { client } = await hub();
    const r1: any = await client.callTool({ name: 'list_groups', arguments: { target_session: 'sess_2658' } });
    expect(r1.content[r1.content.length - 1].text).toMatch(/update available: 0\.5\.21 → 0\.5\.23/);
    const r2: any = await client.callTool({ name: 'list_groups', arguments: { target_session: 'sess_2658' } });
    expect(r2.content).toHaveLength(1);
    const info: any = await client.callTool({ name: 'get_api_info', arguments: {} });
    expect(JSON.parse(info.content[0].text)).toMatchObject({ version: '0.5.21', update_available: { latest: '0.5.23' } });
  });
});
