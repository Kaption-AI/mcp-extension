// mcp-apps-cards.FLAG.1-4, DATA.1-2, SENT.3 — the local hub with MCP_APPS_CARDS off (nothing changes) and on (the card
// tools link the cards page, results carry their card, the text stays), and the flags worker lookup.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ResourceListChangedNotificationSchema, ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { Bridge } from '../bridge';
import { createMcpServer } from '../mcpServer';
import { AVATARS_TOOL, CARD_TOOLS, CARDS_UI_URI } from '../cards';
import { CARDS_UI_HTML, CARDS_UI_MIME_TYPE } from '../cardsUi';
import { CardsFlag, CARDS_FLAG_TTL_MS, flagOn } from '../cardsFlag';
import answers from './fixtures/mcp-apps-cards-answers.json';

jest.mock('../updateCheck', () => ({ getUpdateInfo: () => null, getCurrentVersion: () => '0.0.0-test', checkForUpdates: () => {} }));

const A: any = answers;
const PIC = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
const flush = () => new Promise(r => setTimeout(r, 20));

/** One account whose extension answers like the fixture (send_message refused when the text says so). */
function fakeExtension(bridge: Bridge, sessionId: string, phone: string) {
  const calls: Array<{ method: string; params: any }> = [];
  bridge.setConnection(sessionId, (raw: string) => {
    const req = JSON.parse(raw);
    calls.push({ method: req.method, params: req.params });
    let result: unknown = { ok: true };
    if (req.method === 'query') result = A.search;
    if (req.method === 'send_message') {
      if (req.params.message === 'refuse') {
        setImmediate(() => bridge.handleResponse(JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: -32602, message: A.refusal_text.replace(/^Error: /, '') } })));
        return;
      }
      result = A.sent_read;
    }
    if (req.method === 'get_avatars') result = { avatars: { '5511987654821@c.us': PIC, '5511987654822@c.us': 'https://pps.whatsapp.net/x.jpg' } };
    if (req.method === 'manage_scheduled_messages') result = req.params.action === 'list' ? A.scheduled_list : A.scheduled_get;
    setImmediate(() => bridge.handleResponse(JSON.stringify({ jsonrpc: '2.0', id: req.id, result })));
  });
  bridge.setFeatures(sessionId, { local_send: true });
  bridge.setSession(sessionId, { phone, pushname: sessionId });
  return calls;
}

async function hub(on: { value: boolean }) {
  const asked: string[][] = [];
  const bridge = new Bridge();
  fakeExtension(bridge, 'sess_owner', '17374202658');
  const server = createMcpServer(bridge, { cardsFlag: { anyOn: async (phones: string[]) => { asked.push(phones); return on.value; } } });
  await (server as any).cardsReady;
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 't', version: '1' });
  await server.connect(serverT);
  await client.connect(clientT);
  const changed = { tools: 0, resources: 0 };
  client.setNotificationHandler(ToolListChangedNotificationSchema, async () => { changed.tools++; });
  client.setNotificationHandler(ResourceListChangedNotificationSchema, async () => { changed.resources++; });
  return { bridge, client, asked, changed };
}

describe('mcp-apps-cards.FLAG.2 off: exactly as before', () => {
  it('no _meta.ui, no cards page, no card in results', async () => {
    const { client, asked } = await hub({ value: false });
    expect(asked[0]).toEqual(['17374202658']);
    const tools = (await client.listTools()).tools;
    for (const name of CARD_TOOLS) expect(tools.find(t => t.name === name)?._meta).toBeUndefined();
    const resources = (await client.listResources()).resources.map(r => r.uri);
    expect(resources).not.toContain(CARDS_UI_URI);
    await expect(client.readResource({ uri: CARDS_UI_URI })).rejects.toThrow(/not found/);
    const q: any = await client.callTool({ name: 'query', arguments: { query: 'delivery' } });
    expect(q.structuredContent).toBeUndefined();
    expect(JSON.parse(q.content[0].text).messages).toHaveLength(5);
    const refused: any = await client.callTool({ name: 'send_message', arguments: { conversation_id: '5511987654821@c.us', message: 'refuse' } });
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent).toBeUndefined();
  });
});

describe('mcp-apps-cards.FLAG.3 on', () => {
  it('the card tools link the cards page, which is listed and readable', async () => {
    const { client } = await hub({ value: true });
    const tools = (await client.listTools()).tools;
    for (const name of CARD_TOOLS) {
      expect(tools.find(t => t.name === name)?._meta).toEqual({ ui: { resourceUri: CARDS_UI_URI }, 'openai/outputTemplate': CARDS_UI_URI, 'openai/widgetAccessible': true });
    }
    expect(tools.find(t => t.name === 'list_contacts')?._meta).toBeUndefined();
    const listed = (await client.listResources()).resources.find(r => r.uri === CARDS_UI_URI);
    expect(listed).toMatchObject({ name: 'cards.html', mimeType: CARDS_UI_MIME_TYPE });
    const read: any = await client.readResource({ uri: CARDS_UI_URI });
    expect(read.contents[0]).toMatchObject({ uri: CARDS_UI_URI, mimeType: 'text/html;profile=mcp-app', text: CARDS_UI_HTML });
  });

  it('mcp-apps-cards.DATA.1-2 — results carry the card; the text answer is unchanged', async () => {
    const { client } = await hub({ value: true });
    const q: any = await client.callTool({ name: 'query', arguments: { query: 'delivery' } });
    expect(q.structuredContent.card).toMatchObject({ kind: 'search', total: 5, chats: 4 });
    expect(JSON.parse(q.content[0].text).messages).toEqual(A.search.messages);
    const sent: any = await client.callTool({ name: 'send_message', arguments: { conversation_id: '5511987654821@c.us', message: 'x' } });
    expect(sent.structuredContent.card).toMatchObject({ kind: 'sent', status: 'sent', whatsapp: 'read' });
    const list: any = await client.callTool({ name: 'list_scheduled_messages', arguments: {} });
    expect(list.structuredContent.card).toMatchObject({ kind: 'scheduled', count: 4 });
    expect(JSON.parse(list.content[0].text).scheduled_messages).toHaveLength(4);
    // A listing has no messages list: no card.
    const session: any = await client.callTool({ name: 'query', arguments: { entity: 'session' } });
    expect(session.structuredContent).toBeUndefined();
  });

  it('mcp-apps-cards.SENT.3 — a refused send carries its not-sent card beside the same error text', async () => {
    const { client } = await hub({ value: true });
    const refused: any = await client.callTool({ name: 'send_message', arguments: { conversation_id: '5511987654821@c.us', message: 'refuse' } });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toBe(A.refusal_text);
    expect(refused.structuredContent.card).toMatchObject({ kind: 'sent', status: 'not_sent', reason: 'not-a-contact' });
  });

  it('mcp-apps-cards.FLAG.4 — turning on or off later is announced and changes the list', async () => {
    const on = { value: false };
    const { bridge, client, changed } = await hub(on);
    on.value = true;
    bridge.setSession('sess_owner', { phone: '17374202658', pushname: 'again' });
    await flush();
    expect(changed.tools).toBeGreaterThan(0);
    expect(changed.resources).toBeGreaterThan(0);
    expect((await client.listTools()).tools.find(t => t.name === 'query')?._meta).toBeDefined();
    on.value = false;
    bridge.setSession('sess_owner', { phone: '17374202658', pushname: 'again' });
    await flush();
    expect((await client.listTools()).tools.find(t => t.name === 'query')?._meta).toBeUndefined();
    expect((await client.listResources()).resources.map(r => r.uri)).not.toContain(CARDS_UI_URI);
  });

  it('mcp-apps-cards.FLAG.5 — the plans page keeps its own gating', async () => {
    const { client } = await hub({ value: true });
    expect((await client.listResources()).resources.map(r => r.uri)).not.toContain('ui://kaption/plans.html');
  });
});

describe('mcp-apps-cards.FLAG.1 the flags worker lookup', () => {
  const row = (r: Record<string, unknown>) => ({ ok: true, json: async () => ({ flags: [{ name: 'MCP_APPS_CARDS', ...r }] }) });

  it('reads remoteEnabled / enabled / remoteDisabled like rest-api', () => {
    expect(flagOn({ flags: [{ name: 'MCP_APPS_CARDS', enabled: false, remoteEnabled: true }] }, 'MCP_APPS_CARDS')).toBe(true);
    expect(flagOn({ flags: [{ name: 'MCP_APPS_CARDS', enabled: true, remoteDisabled: true }] }, 'MCP_APPS_CARDS')).toBe(false);
    expect(flagOn({ flags: [{ name: 'MCP_APPS_CARDS', enabled: false }] }, 'MCP_APPS_CARDS')).toBe(false);
    expect(flagOn({ nope: 1 }, 'MCP_APPS_CARDS')).toBe(false);
  });

  it('asks once per phone within 5 minutes, version 99.0.0; failures are off; any account on is on', async () => {
    const prev = process.env.KAPTION_CARDS_FLAG;
    delete process.env.KAPTION_CARDS_FLAG;
    try {
      let t = 0;
      const urls: string[] = [];
      const flag = new CardsFlag(async (url: string) => {
        urls.push(url);
        if (url.includes('15555550100')) throw new Error('offline');
        return row({ enabled: false, remoteEnabled: url.includes('17374202658') });
      }, () => t, 'https://flags.test');
      expect(await flag.anyOn(['+1 737 420 2658'])).toBe(true);
      expect(urls[0]).toBe('https://flags.test/active?app=KAPTION&version=99.0.0&phone=17374202658');
      expect(await flag.anyOn(['17374202658'])).toBe(true);
      expect(urls).toHaveLength(1);
      expect(await flag.anyOn(['15555550100'])).toBe(false);
      expect(await flag.anyOn(['15555550199'])).toBe(false);
      expect(await flag.anyOn(['15555550199', '17374202658'])).toBe(true);
      expect(await flag.anyOn([''])).toBe(false);
      t += CARDS_FLAG_TTL_MS + 1;
      await flag.anyOn(['17374202658']);
      expect(urls.filter(u => u.includes('17374202658'))).toHaveLength(2);
      process.env.KAPTION_CARDS_FLAG = 'off';
      expect(await flag.anyOn(['17374202658'])).toBe(false);
      process.env.KAPTION_CARDS_FLAG = 'on';
      expect(await flag.anyOn([])).toBe(true);
    } finally {
      process.env.KAPTION_CARDS_FLAG = prev;
    }
  });
});

describe('mcp-apps-cards.AVATAR the card-only picture tool (hub)', () => {
  it('AVATAR.1 — not listed while off', async () => {
    const { client } = await hub({ value: false });
    expect((await client.listTools()).tools.map(t => t.name)).not.toContain(AVATARS_TOOL);
  });
  it('AVATAR.1-4 — listed only to the card while on; forwarded; only data: pictures come back', async () => {
    const { client } = await hub({ value: true });
    const tool = (await client.listTools()).tools.find(t => t.name === AVATARS_TOOL)!;
    expect(tool._meta).toMatchObject({ ui: { resourceUri: CARDS_UI_URI, visibility: ['app'] }, 'openai/visibility': 'private' });
    const r: any = await client.callTool({ name: AVATARS_TOOL, arguments: { ids: ['5511987654821@c.us', '5511987654822@c.us'] } });
    expect(r.structuredContent).toEqual({ avatars: { '5511987654821@c.us': PIC, '5511987654822@c.us': null } });
    expect(r.content[0].text).not.toContain('base64');
  });
});
