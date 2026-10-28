import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// E2E 0.87.2: a hub started on 0.5.6 answered `version: 0.5.8` once package.json on disk had been updated,
// while its update notice still said `current: 0.5.6`. The running code's version is the one it was started
// with: read once, so every field agrees and a hub that needs a restart can be seen.
describe('reported version', () => {
  afterEach(() => jest.resetModules());

  it('stays the version the process started with when package.json changes on disk', () => {
    const real = jest.requireActual('fs');
    let onDisk = '0.5.6';
    jest.doMock('fs', () => ({
      ...real,
      readFileSync: (p: string, enc: string) =>
        String(p).endsWith('package.json') ? JSON.stringify({ version: onDisk }) : real.readFileSync(p, enc),
    }));
    const { getCurrentVersion } = require('../updateCheck');
    expect(getCurrentVersion()).toBe('0.5.6');
    onDisk = '0.5.8';
    expect(getCurrentVersion()).toBe('0.5.6');
  });

  it('the MCP server introduces itself with the package version, not a fixed one', () => {
    const { createMcpServer } = require('../mcpServer');
    const { getCurrentVersion } = require('../updateCheck');
    const server = createMcpServer({ connected: false, localSendAvailable: true, onAccountsChanged: () => {}, sessions: () => [], call: jest.fn() } as any);
    const info = (server as any).server._serverInfo;
    expect(info.version).toBe(getCurrentVersion());
  });
});
