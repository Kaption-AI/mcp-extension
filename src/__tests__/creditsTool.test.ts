// mcp-credits-simple.HUB.1-3 — allow_extra_actions on the local hub: listed only while a connected account said
// credits_simple, forwarded to that account's extension, its words returned; the ask line rides _kaption_notice.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Bridge } from '../bridge';
import { createMcpServer } from '../mcpServer';
import { ALLOW_EXTRA_TOOL, creditsAnswer, creditsToolVisible } from '../creditsTool';
import { readManageFeatures } from '../manageKaption';

jest.mock('../updateCheck', () => ({ getUpdateInfo: () => null, getCurrentVersion: () => '0.0.0-test', checkForUpdates: () => {} }));

const flush = () => new Promise(r => setTimeout(r, 20));

function fakeExtension(bridge: Bridge, sessionId: string, features: unknown, answer: (method: string) => unknown) {
  const calls: Array<{ method: string; params: any }> = [];
  bridge.setConnection(sessionId, (raw: string) => {
    const req = JSON.parse(raw);
    calls.push({ method: req.method, params: req.params });
    setImmediate(() => bridge.handleResponse(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: answer(req.method) })));
  });
  bridge.setFeatures(sessionId, features);
  bridge.setSession(sessionId, { phone: sessionId, pushname: sessionId });
  return calls;
}

async function connect(bridge: Bridge) {
  const server = createMcpServer(bridge);
  const [c, s] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 't', version: '1' });
  await server.connect(s);
  await client.connect(c);
  const names = async () => (await client.listTools()).tools.map(t => t.name);
  return { client, names };
}

describe('mcp-credits-simple.HUB', () => {
  it('HUB.1 — credits_simple is read as a boolean feature; anything else is unknown', () => {
    expect(readManageFeatures({ credits_simple: true })).toEqual({ credits_simple: true });
    expect(readManageFeatures({ credits_simple: 'yes' })).toEqual({});
    expect(creditsToolVisible([{ credits_simple: false }, { credits_simple: true }])).toBe(true);
    expect(creditsToolVisible([{}, null, { credits_simple: false }])).toBe(false);
  });

  it('HUB.1 — hidden without the feature, listed once an account says credits_simple, hidden again when it stops', async () => {
    const bridge = new Bridge();
    fakeExtension(bridge, 'a', { local_send: true }, () => ({ ok: true }));
    const { names } = await connect(bridge);
    expect(await names()).not.toContain(ALLOW_EXTRA_TOOL);
    bridge.setFeatures('a', { local_send: true, credits_simple: true });
    await flush();
    expect(await names()).toContain(ALLOW_EXTRA_TOOL);
    bridge.setFeatures('a', { local_send: true, credits_simple: false });
    await flush();
    expect(await names()).not.toContain(ALLOW_EXTRA_TOOL);
  });

  it('HUB.2 — forwarded to the account that has the feature; the extension\'s words are the result', async () => {
    const bridge = new Bridge();
    fakeExtension(bridge, 'other', { local_send: true }, () => ({ ok: true }));
    const calls = fakeExtension(bridge, 'mine', { local_send: true, credits_simple: true },
      () => ({ ok: true, message: 'Extra actions are on, up to US$10 a month. Kaption will not ask again.' }));
    const { client } = await connect(bridge);
    const out: any = await client.callTool({ name: ALLOW_EXTRA_TOOL, arguments: {} });
    expect(calls).toEqual([{ method: ALLOW_EXTRA_TOOL, params: {} }]);
    expect(out.isError).toBeFalsy();
    expect(out.content[0].text).toBe('Extra actions are on, up to US$10 a month. Kaption will not ask again.');
  });

  it('HUB.2 — a refusal (Free, Pix, no card) is an error result with the extension\'s words', async () => {
    const bridge = new Bridge();
    fakeExtension(bridge, 'mine', { credits_simple: true }, () => ({ ok: false, message: 'Extra actions need a subscription: https://kaptionai.com/plans' }));
    const { client } = await connect(bridge);
    const out: any = await client.callTool({ name: ALLOW_EXTRA_TOOL, arguments: {} });
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toContain('subscription');
  });

  it('HUB.2 — an answer without words is the failure message', () => {
    expect(creditsAnswer({}).isError).toBe(true);
    expect(creditsAnswer('nonsense').text).toContain('could not turn extra actions on');
    expect(creditsAnswer(JSON.stringify({ ok: true, message: 'On.' }))).toEqual({ text: 'On.', isError: false });
    expect(creditsAnswer({ content: [{ type: 'text', text: '{"ok":true,"message":"On."}' }] })).toEqual({ text: 'On.', isError: false });
  });

  it('HUB.3 — the ask line the extension marks (_kaption_notice) becomes its own line after the result', async () => {
    const bridge = new Bridge();
    const ask = 'Kaption: 230 of 250 Claude and ChatGPT actions used. Ask the user: "Extra actions cost 1¢ each, up to US$10 a month (you can raise it up to US$40). Continue?" If they agree, call allow_extra_actions once; Kaption will not ask again.';
    fakeExtension(bridge, 'mine', { local_send: true, credits_simple: true }, () => ({ chats: [], _kaption_notice: ask }));
    const { client } = await connect(bridge);
    const out: any = await client.callTool({ name: 'list_chat_lists', arguments: {} });
    expect(out.content.at(-1).text).toBe(ask);
    expect(out.content[0].text).not.toContain('_kaption_notice');
  });
});
