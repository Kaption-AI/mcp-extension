// mcp.TOOLS.19 — reads and writes are separate tools. A read-only tool reaches the extension as the manage_* call
// (method + action) every Kaption version already answers, and is listed with its title and read-only hint.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Bridge } from '../bridge';
import { createMcpServer } from '../mcpServer';

jest.mock('../updateCheck', () => ({ getUpdateInfo: () => null, getCurrentVersion: () => '0.0.0-test', checkForUpdates: () => {} }));

async function connected() {
  const bridge = new Bridge();
  bridge.setConnection('sess_a', () => {});
  bridge.setSession('sess_a', { phone: '5491100000000', pushname: 'A' });
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  jest.spyOn(bridge, 'callTool').mockImplementation(async (method: string, params: Record<string, unknown>) => {
    calls.push({ method, params });
    return { data: { ok: true }, source: { sessionId: 'sess_a' } } as any;
  });
  const server = createMcpServer(bridge);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 't', version: '1' });
  await server.connect(serverT);
  await client.connect(clientT);
  return { client, calls };
}

describe('mcp.TOOLS.19 read-only tools on the local hub', () => {
  it('sends list_reminders to the extension as manage_reminders list', async () => {
    const { client, calls } = await connected();
    const result: any = await client.callTool({ name: 'list_reminders', arguments: { filter: 'all' } });
    expect(result.isError).toBeFalsy();
    expect(calls).toEqual([{ method: 'manage_reminders', params: { filter: 'all', action: 'list' } }]);
    await client.close();
  });

  it('sends get_contact_note as manage_notes get', async () => {
    const { client, calls } = await connected();
    await client.callTool({ name: 'get_contact_note', arguments: { contact_id: 'a@c.us' } });
    expect(calls).toEqual([{ method: 'manage_notes', params: { contact_id: 'a@c.us', action: 'get' } }]);
    await client.close();
  });

  it('lists every tool with a title and its read-only hint', async () => {
    const { client } = await connected();
    const tools = (await client.listTools()).tools;
    for (const tool of tools) expect(tool.title).toBeTruthy();
    expect(tools.find(t => t.name === 'list_scheduled_messages')!.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(tools.find(t => t.name === 'manage_scheduled_messages')!.annotations).toMatchObject({ readOnlyHint: false });
    await client.close();
  });
});
