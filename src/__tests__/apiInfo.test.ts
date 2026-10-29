// mcp.LOCAL_HUB.12 — get_api_info never hands the hub's access token to the assistant: its answer lands in
// the chat transcript. It says where the token file is instead. Also: tool descriptions never name internal
// feature flags or engines (they are shown to Claude and ChatGPT, who repeat them to the user).
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Bridge } from '../bridge';
import { createMcpServer } from '../mcpServer';
import { getTokenFilePath } from '../auth';
import { getToolsForMCP } from '../tools';

jest.mock('../updateCheck', () => ({ getUpdateInfo: () => null, getCurrentVersion: () => '0.0.0-test', checkForUpdates: () => {} }));

describe('mcp.LOCAL_HUB.12 get_api_info', () => {
  it('returns the URL, endpoints and token file, never the token', async () => {
    const server = createMcpServer(new Bridge());
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 't', version: '1' });
    await server.connect(serverT);
    await client.connect(clientT);
    try {
      const result: any = await client.callTool({ name: 'get_api_info', arguments: {} });
      const text: string = result.content[0].text;
      const info = JSON.parse(text);
      expect(info.http_api.url).toBe('http://127.0.0.1:7866');
      expect(info.http_api.endpoints.map((e: any) => e.path)).toEqual(['/health', '/sessions', '/tools/:toolName']);
      expect(info.http_api.auth.token_file).toBe(getTokenFilePath());
      expect(info.http_api.auth.header).toBe('Authorization: Bearer <token>');
      expect(info.http_api).not.toHaveProperty('auth_token');
      expect(text).not.toMatch(/[0-9a-f]{64}/);
    } finally {
      await client.close();
    }
  });
});

describe('tool descriptions use plain words', () => {
  it('name no internal flag or engine', () => {
    const text = JSON.stringify(getToolsForMCP());
    expect(text).not.toMatch(/\b[A-Z][A-Z0-9]+(?:_[A-Z0-9]+){1,}\b/);
    expect(text).not.toMatch(/owner-only|Rust core|Rust extension/i);
  });
});
