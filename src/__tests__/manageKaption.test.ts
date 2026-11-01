// mcp-manage-kaption.LIST.1-2, HELP.3, PROMPTS.2, UI.1-3 — the five "manage Kaption" tools on the local hub: listed
// only while a connected account said its family is on (unknown = hidden), forwarded to the extension, the guides and
// prompts as MCP resources and prompts, and the plans UI resource. fixtures/mcp-manage-tools.json is a copy of the
// extension's kext/scripts/mcp-manage-tools.json (the canonical definitions).
import type { AddressInfo } from 'net';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  PromptListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  ToolListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { Bridge } from '../bridge';
import { RelayBridge } from '../relayBridge';
import { createMcpServer } from '../mcpServer';
import { MANAGE_KAPTION_TOOLS, parseAnswer, readManageFeatures, visibleManageTools } from '../manageKaption';
import { PLANS_UI_HTML, PLANS_UI_MIME_TYPE } from '../plansUi';
import { TOOLS } from '../tools';
import canonical from './fixtures/mcp-manage-tools.json';

jest.mock('../updateCheck', () => ({ getUpdateInfo: () => null, getCurrentVersion: () => '0.0.0-test', checkForUpdates: () => {} }));

const flush = () => new Promise(r => setTimeout(r, 20));

const PLANS_ANSWER = {
  currency: 'USD',
  periods: ['yearly', 'quarterly', 'monthly'],
  default_period: 'yearly',
  methods: ['card'],
  labels: { title: 'Plans', per_month: '/ month', periods: { yearly: 'Yearly', quarterly: 'Every 3 months', monthly: 'Monthly' }, pay_note: 'You pay on the checkout page.' },
  plans: [
    { id: 'pro', name: 'Pro', state: 'recommended', badge: 'Recommended', prices: { yearly: { per_month: 'US$ 5.99', total: 'US$ 71.88 a year' } }, trial: null, highlights_label: 'Everything in Free, plus', highlights: ['a'], features: ['b'], button: 'Subscribe', checkout: true, alipay: false, note: null },
  ],
  message: 'Here are the plans.',
};

/** A fake extension behind one hub account: answers kaption_help and kaption_plans like the account core. */
function fakeExtension(bridge: Bridge, sessionId: string, features?: unknown, opts: { fail?: boolean } = {}) {
  const calls: Array<{ method: string; params: any }> = [];
  bridge.setConnection(sessionId, (raw: string) => {
    if (opts.fail) throw new Error('socket closed');
    const req = JSON.parse(raw);
    calls.push({ method: req.method, params: req.params });
    let result: unknown = { ok: true, account: sessionId };
    if (req.method === 'kaption_help') {
      if (req.params.action === 'list') result = { topics: [{ id: 'pricing', title: 'Plans and prices', summary: 'What each plan costs' }, { id: 'connect', title: 'Connect Claude', summary: 'How to add Kaption' }], count: 2 };
      if (req.params.action === 'read') result = req.params.topic === 'pricing' ? { id: 'pricing', title: 'Plans and prices', text: '# Plans\n\nPro is…' } : undefined;
      if (req.params.action === 'prompts') result = { language: 'en', prompts: [{ id: 'summarize-day', group: 'daily', title: 'Summarize my day', text: 'Summarize what happened in my chats today.' }] };
      if (result === undefined) {
        setImmediate(() => bridge.handleResponse(JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: -32602, message: 'unknown topic' } })));
        return;
      }
    }
    if (req.method === 'kaption_plans' || req.method === 'create_kaption_checkout_link') {
      result = req.method === 'create_kaption_checkout_link'
        ? JSON.stringify({ plan: req.params.plan, period: req.params.period, method: 'card', url: 'https://kaptionai.com/pay?x', message: 'Open the link' })
        : PLANS_ANSWER;
    }
    setImmediate(() => bridge.handleResponse(JSON.stringify({ jsonrpc: '2.0', id: req.id, result })));
  });
  if (features !== undefined) bridge.setFeatures(sessionId, features);
  bridge.setSession(sessionId, { phone: sessionId, pushname: sessionId });
  return calls;
}

async function connectClient(bridge: Bridge | RelayBridge) {
  const server = createMcpServer(bridge);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 't', version: '1' });
  const changed = { tools: 0, resources: 0, prompts: 0 };
  await server.connect(serverT);
  await client.connect(clientT);
  client.setNotificationHandler(ToolListChangedNotificationSchema, async () => { changed.tools++; });
  client.setNotificationHandler(ResourceListChangedNotificationSchema, async () => { changed.resources++; });
  client.setNotificationHandler(PromptListChangedNotificationSchema, async () => { changed.prompts++; });
  const names = async () => (await client.listTools()).tools.map(t => t.name);
  const manage = async () => (await names()).filter(n => MANAGE_KAPTION_TOOLS.includes(n));
  return { client, names, manage, changed };
}

describe('mcp-manage-kaption.LIST.2 definitions', () => {
  it('are the canonical ones, verbatim, after every other tool', async () => {
    // The status tools (scheduled-status.MCP) follow the manage block.
    const names = TOOLS.map(t => t.name);
    expect(names.slice(-2)).toEqual(['manage_status', 'list_status_posts']);
    expect(names.slice(-canonical.length - 2, -2)).toEqual(canonical.map(t => t.name));
    const bridge = new Bridge();
    fakeExtension(bridge, 'sess_owner', { manage_kaption: true, business_agent: true, plans: true });
    const { client } = await connectClient(bridge);
    const listed = (await client.listTools()).tools;
    for (const want of canonical as any[]) {
      const got = listed.find(t => t.name === want.name)!;
      expect(got.description).toBe(want.description);
      expect(got.annotations).toEqual(want.annotations);
      expect(got._meta).toEqual(want._meta);
      const props = got.inputSchema.properties as Record<string, any>;
      expect(Object.keys(props)).toEqual(Object.keys(want.inputSchema.properties));
      for (const [key, p] of Object.entries<any>(want.inputSchema.properties)) {
        expect(props[key].description).toBe(p.description);
        expect(props[key].type).toBe(p.type);
        expect(props[key].enum).toEqual(p.enum);
        if (p.items) expect(props[key].items).toMatchObject(p.items);
      }
      expect((got.inputSchema.required ?? []).slice().sort()).toEqual((want.inputSchema.required ?? []).slice().sort());
    }
    await client.close();
  });
});

describe('mcp-manage-kaption.LIST.2 visibility follows the connected accounts\' features', () => {
  it('some account true shows; no account, no features or no key hides', () => {
    expect([...visibleManageTools([])]).toEqual([]);
    expect([...visibleManageTools([{}, undefined, null])]).toEqual([]);
    expect([...visibleManageTools([{ manage_kaption: false }, { manage_kaption: true }])]).toEqual(['get_kaption_settings', 'update_kaption_settings', 'reconnect_kaption_connection', 'kaption_help', 'report_bug']);
    expect([...visibleManageTools([{ business_agent: true }])]).toEqual(['get_business_agent', 'manage_business_agent']);
    expect([...visibleManageTools([{ plans: true }])]).toEqual(['kaption_plans', 'create_kaption_checkout_link']);
    expect(readManageFeatures({ manage_kaption: 'yes', plans: 1, business_agent: true, other: true })).toEqual({ business_agent: true });
    // scheduled-status.MCP — the status tools follow their own key.
    expect([...visibleManageTools([{ scheduled_status: true }])]).toEqual(['manage_status', 'list_status_posts']);
    expect([...visibleManageTools([{ manage_kaption: true, business_agent: true, plans: true }])]).not.toContain('manage_status');
    expect(readManageFeatures({ scheduled_status: true })).toEqual({ scheduled_status: true });
    expect(readManageFeatures({ scheduled_status: 'true' })).toEqual({});
  });

  it('hidden until an account says true; list_changed on every change', async () => {
    const bridge = new Bridge();
    const mcp = await connectClient(bridge);
    expect(await mcp.manage()).toEqual([]);

    fakeExtension(bridge, 'sess_old'); // an older extension: no features
    await flush();
    expect(await mcp.manage()).toEqual([]);
    expect(await mcp.names()).toContain('query');

    fakeExtension(bridge, 'sess_junk', { local_send: true, manage_kaption: 'true' });
    await flush();
    expect(await mcp.manage()).toEqual([]);

    const before = mcp.changed.tools;
    fakeExtension(bridge, 'sess_a', { local_send: true, manage_kaption: true });
    await flush();
    expect(await mcp.manage()).toEqual(['get_kaption_settings', 'update_kaption_settings', 'reconnect_kaption_connection', 'kaption_help', 'report_bug']);
    expect(mcp.changed.tools).toBeGreaterThan(before);
    expect(mcp.changed.resources).toBeGreaterThan(0);
    expect(mcp.changed.prompts).toBeGreaterThan(0);

    fakeExtension(bridge, 'sess_b', { business_agent: true, plans: true });
    await flush();
    expect(await mcp.manage()).toEqual(['get_kaption_settings', 'update_kaption_settings', 'reconnect_kaption_connection', 'kaption_help', 'report_bug', 'get_business_agent', 'manage_business_agent', 'kaption_plans', 'create_kaption_checkout_link']);

    // The same account handshaking again with the family off hides it.
    bridge.setFeatures('sess_b', { business_agent: false, plans: true });
    await flush();
    expect(await mcp.manage()).not.toContain('get_business_agent');

    const beforeLeave = mcp.changed.tools;
    bridge.clearConnection('sess_a');
    await flush();
    expect(await mcp.manage()).toEqual(['kaption_plans', 'create_kaption_checkout_link']);
    expect(mcp.changed.tools).toBeGreaterThan(beforeLeave);
    bridge.clearConnection('sess_b');
    await flush();
    expect(await mcp.manage()).toEqual([]);
    await mcp.client.close();
  });

  it('a call to a hidden tool answers the usual unknown-tool error and never reaches the extension', async () => {
    const bridge = new Bridge();
    const calls = fakeExtension(bridge, 'sess_a', { local_send: true });
    const mcp = await connectClient(bridge);
    const hidden: any = await mcp.client.callTool({ name: 'get_kaption_settings', arguments: {} });
    const unknown: any = await mcp.client.callTool({ name: 'no_such_tool', arguments: {} });
    expect(hidden.isError).toBe(true);
    expect(unknown.isError).toBe(true);
    expect(unknown.content[0].text).toMatch(/Tool no_such_tool not found/);
    expect(hidden.content[0].text).toBe(unknown.content[0].text.replace('no_such_tool', 'get_kaption_settings'));
    expect(calls).toEqual([]);
    await mcp.client.close();
  });

  it('a visible tool is forwarded like any other, to an account that said its family is on', async () => {
    const bridge = new Bridge();
    const owner = fakeExtension(bridge, 'sess_owner', { manage_kaption: true });
    const other = fakeExtension(bridge, 'sess_other', { manage_kaption: false }); // most recently active
    const mcp = await connectClient(bridge);
    const res: any = await mcp.client.callTool({ name: 'update_kaption_settings', arguments: { id: 'transcription.automatic', value: false } });
    expect(res.isError).toBeFalsy();
    expect(owner).toEqual([{ method: 'update_kaption_settings', params: { id: 'transcription.automatic', value: false } }]);
    expect(other).toEqual([]);
    expect(JSON.parse(res.content[0].text)).toMatchObject({ ok: true, account: 'sess_owner', _source: { sessionId: 'sess_owner' } });
    await mcp.client.close();
  });

  it('a relay client follows the features the hub reports per account; an older hub reports none', async () => {
    const relay = new RelayBridge();
    const mcp = await connectClient(relay);
    (relay as any)._extensions = [{ sessionId: 's1', connected: true, features: { plans: true } }];
    (relay as any).accountsChanged({ connected: true });
    await flush();
    expect(await mcp.manage()).toEqual(['kaption_plans', 'create_kaption_checkout_link']);
    expect(relay.sessionWithFeature('plans')).toBe('s1');
    (relay as any)._extensions = [{ sessionId: 's1', connected: true }];
    (relay as any).accountsChanged({ connected: true });
    await flush();
    expect(await mcp.manage()).toEqual([]);
    await mcp.client.close();
  });
});

describe('mcp-manage-kaption.UI.2 kaption_plans results', () => {
  it('carry the parsed answer as structuredContent next to the text', async () => {
    const bridge = new Bridge();
    fakeExtension(bridge, 'sess_a', { plans: true });
    const mcp = await connectClient(bridge);
    const list: any = await mcp.client.callTool({ name: 'kaption_plans', arguments: {} });
    expect(list.structuredContent).toEqual(PLANS_ANSWER);
    expect(JSON.parse(list.content[0].text)).toMatchObject({ plans: PLANS_ANSWER.plans });
    // A JSON string answer is parsed too.
    const checkout: any = await mcp.client.callTool({ name: 'create_kaption_checkout_link', arguments: { plan: 'pro', period: 'monthly' } });
    expect(checkout.structuredContent).toEqual({ plan: 'pro', period: 'monthly', method: 'card', url: 'https://kaptionai.com/pay?x', message: 'Open the link' });
    // Other tools keep their plain result.
    fakeExtension(bridge, 'sess_b', { manage_kaption: true });
    await flush();
    const help: any = await mcp.client.callTool({ name: 'kaption_help', arguments: { action: 'list' } });
    expect(help.structuredContent).toBeUndefined();
    await mcp.client.close();
  });

  it('parseAnswer reads objects, JSON strings and MCP text results', () => {
    expect(parseAnswer({ a: 1 })).toEqual({ a: 1 });
    expect(parseAnswer('{"a":1}')).toEqual({ a: 1 });
    expect(parseAnswer({ content: [{ type: 'text', text: '{"a":1}' }] })).toEqual({ a: 1 });
    expect(parseAnswer('plain')).toBe('plain');
  });
});

describe('mcp-manage-kaption.HELP.3, PROMPTS.2, UI.1 resources and prompts', () => {
  it('declares resources and prompts', async () => {
    const mcp = await connectClient(new Bridge());
    expect(mcp.client.getServerCapabilities()).toMatchObject({ resources: { listChanged: true }, prompts: { listChanged: true } });
    await mcp.client.close();
  });

  it('lists nothing while kaption_help and kaption_plans are hidden', async () => {
    const bridge = new Bridge();
    const calls = fakeExtension(bridge, 'sess_a', { local_send: true });
    const mcp = await connectClient(bridge);
    expect((await mcp.client.listResources()).resources).toEqual([]);
    expect((await mcp.client.listPrompts()).prompts).toEqual([]);
    expect((await mcp.client.listResourceTemplates()).resourceTemplates).toEqual([]);
    await expect(mcp.client.readResource({ uri: 'kaption://guide/pricing' })).rejects.toThrow(/not found/);
    await expect(mcp.client.getPrompt({ name: 'summarize-day' })).rejects.toThrow(/not found/);
    expect(calls).toEqual([]);
    await mcp.client.close();
  });

  it('lists one resource per guide and reads it through kaption_help', async () => {
    const bridge = new Bridge();
    const calls = fakeExtension(bridge, 'sess_a', { manage_kaption: true });
    const mcp = await connectClient(bridge);
    expect((await mcp.client.listResources()).resources).toEqual([
      { uri: 'kaption://guide/pricing', name: 'pricing', title: 'Plans and prices', description: 'What each plan costs', mimeType: 'text/markdown' },
      { uri: 'kaption://guide/connect', name: 'connect', title: 'Connect Claude', description: 'How to add Kaption', mimeType: 'text/markdown' },
    ]);
    expect((await mcp.client.listResourceTemplates()).resourceTemplates).toEqual([
      expect.objectContaining({ uriTemplate: 'kaption://guide/{id}', mimeType: 'text/markdown' }),
    ]);
    const read = await mcp.client.readResource({ uri: 'kaption://guide/pricing' });
    expect(read.contents).toEqual([{ uri: 'kaption://guide/pricing', mimeType: 'text/markdown', text: '# Plans\n\nPro is…' }]);
    await expect(mcp.client.readResource({ uri: 'kaption://guide/nope' })).rejects.toThrow(/unknown topic/);
    expect(calls.map(c => c.params)).toEqual([{ action: 'list' }, { action: 'read', topic: 'pricing' }, { action: 'read', topic: 'nope' }]);
    await mcp.client.close();
  });

  it('lists the prompts and answers one as a user message', async () => {
    const bridge = new Bridge();
    fakeExtension(bridge, 'sess_a', { manage_kaption: true });
    const mcp = await connectClient(bridge);
    expect((await mcp.client.listPrompts()).prompts).toEqual([{ name: 'summarize-day', title: 'Summarize my day', description: 'Summarize my day' }]);
    const prompt = await mcp.client.getPrompt({ name: 'summarize-day' });
    expect(prompt.messages).toEqual([{ role: 'user', content: { type: 'text', text: 'Summarize what happened in my chats today.' } }]);
    await expect(mcp.client.getPrompt({ name: 'nope' })).rejects.toThrow(/Prompt nope not found/);
    await mcp.client.close();
  });

  it('answers empty lists when the extension cannot be reached', async () => {
    const bridge = new Bridge();
    fakeExtension(bridge, 'sess_a', { manage_kaption: true }, { fail: true });
    const mcp = await connectClient(bridge);
    expect((await mcp.client.listResources()).resources).toEqual([]);
    expect((await mcp.client.listPrompts()).prompts).toEqual([]);
    await mcp.client.close();
  });

  it('serves the plans UI with the MCP Apps mime type while kaption_plans is listed; the page holds no prices', async () => {
    const bridge = new Bridge();
    fakeExtension(bridge, 'sess_a', { plans: true });
    const mcp = await connectClient(bridge);
    expect((await mcp.client.listResources()).resources).toEqual([
      expect.objectContaining({ uri: 'ui://kaption/plans.html', mimeType: 'text/html;profile=mcp-app' }),
    ]);
    const read: any = await mcp.client.readResource({ uri: 'ui://kaption/plans.html' });
    expect(read.contents[0]).toMatchObject({ uri: 'ui://kaption/plans.html', mimeType: PLANS_UI_MIME_TYPE, text: PLANS_UI_HTML });
    expect(PLANS_UI_HTML).not.toMatch(/US\$|R\$|€|\$ ?\d/);
    expect(PLANS_UI_HTML).not.toMatch(/<script[^>]+src=|<link[^>]+href=|@import|https?:\/\//);
    expect(PLANS_UI_HTML).not.toContain('action: "checkout"');
    expect(PLANS_UI_HTML).toContain('callTool("create_kaption_checkout_link"');
    expect(PLANS_UI_HTML).toContain('ui/open-link');
    expect(PLANS_UI_HTML).toContain('openai.callTool');
    expect(PLANS_UI_HTML).toContain('prefers-color-scheme: dark');
    await mcp.client.close();
  });
});

describe('mcp-manage-kaption.LIST.1 over the hub\'s WebSocket', () => {
  it('keeps the handshake\'s manage features and reports them to relay clients', async () => {
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

    const ext = new WebSocket(`ws://127.0.0.1:${port}`, { origin: 'chrome-extension://abc' });
    await new Promise(r => ext.on('open', r));
    ext.send(JSON.stringify({ jsonrpc: '2.0', method: 'handshake', params: {
      auth: { session_token: session.token, session_id: session.id },
      session: { phone: '1', pushname: 'x' },
      features: { local_send: true, manage_kaption: true, business_agent: false, plans: true },
    } }));
    await new Promise(r => setTimeout(r, 150));
    expect(bridge.manageFeatures).toEqual([{ manage_kaption: true, business_agent: false, plans: true }]);
    expect(bridge.localSendAvailable).toBe(true);
    const last = relayMsgs.filter(m => m.method === 'extension_status').pop();
    expect(last.params.extensions[0]).toMatchObject({ localSend: true, features: { manage_kaption: true, business_agent: false, plans: true } });
    ext.close(); relay.close();
    await flush();
    await new Promise(r => wss.close(r));
  });
});

describe('scheduled-status.MCP the status tools on the hub', () => {
  it('hidden for an older extension (no scheduled_status) and when it is false; listed when true', async () => {
    const bridge = new Bridge();
    const mcp = await connectClient(bridge);
    fakeExtension(bridge, 'sess_old', { local_send: true, manage_kaption: true });
    fakeExtension(bridge, 'sess_off', { scheduled_status: false });
    await flush();
    expect(await mcp.names()).not.toContain('manage_status');
    expect(await mcp.names()).not.toContain('list_status_posts');
    fakeExtension(bridge, 'sess_owner', { scheduled_status: true });
    await flush();
    const tools = (await mcp.client.listTools()).tools;
    const manage = tools.find(t => t.name === 'manage_status')!;
    const list = tools.find(t => t.name === 'list_status_posts')!;
    expect((manage.inputSchema.properties as any).action.enum).toEqual(['schedule', 'cancel']);
    expect(manage.annotations).toEqual({ title: 'Schedule a WhatsApp status', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
    expect(list.annotations).toEqual({ title: 'List status posts', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(manage.description).not.toMatch(/post_now/);
    await mcp.client.close();
  });

  it('forwards to the account that said scheduled_status; list goes as manage_status list; post_now is refused', async () => {
    const bridge = new Bridge();
    const owner = fakeExtension(bridge, 'sess_owner', { scheduled_status: true });
    const other = fakeExtension(bridge, 'sess_other', { manage_kaption: true }); // most recently active
    const mcp = await connectClient(bridge);
    const listed: any = await mcp.client.callTool({ name: 'list_status_posts', arguments: { filter: 'all' } });
    expect(listed.isError).toBeFalsy();
    const cancelled: any = await mcp.client.callTool({ name: 'manage_status', arguments: { action: 'cancel', id: 's1' } });
    expect(cancelled.isError).toBeFalsy();
    const now: any = await mcp.client.callTool({ name: 'manage_status', arguments: { action: 'post_now', text: 'Hi' } });
    expect(now.isError).toBe(true);
    expect(owner).toEqual([
      { method: 'manage_status', params: { filter: 'all', action: 'list' } },
      { method: 'manage_status', params: { action: 'cancel', id: 's1' } },
    ]);
    expect(other).toEqual([]);
    await mcp.client.close();
  });

  it('a hidden status tool never reaches the extension', async () => {
    const bridge = new Bridge();
    const calls = fakeExtension(bridge, 'sess_a', { manage_kaption: true });
    const mcp = await connectClient(bridge);
    const res: any = await mcp.client.callTool({ name: 'manage_status', arguments: { action: 'cancel', id: 's1' } });
    expect(res.isError).toBe(true);
    expect(calls).toEqual([]);
    await mcp.client.close();
  });
});
