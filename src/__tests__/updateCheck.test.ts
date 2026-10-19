import fs from 'fs';

// The hub must report the version of the code that is running, not whatever package.json says on disk now.
// A checkout updated under a running hub (git pull + build) used to make `version` jump to the new number
// while `update_available.current` (captured at start) kept the old one.
describe('getCurrentVersion', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.resetModules();
  });

  it('keeps the version the process started with when package.json changes on disk', () => {
    const real = fs.readFileSync;
    let onDisk = '0.5.6';
    jest.spyOn(fs, 'readFileSync').mockImplementation(((path: any, ...rest: any[]) => {
      if (String(path).endsWith('package.json')) return JSON.stringify({ version: onDisk });
      return (real as any)(path, ...rest);
    }) as any);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getCurrentVersion } = require('../updateCheck');
    expect(getCurrentVersion()).toBe('0.5.6');
    onDisk = '0.5.8';
    expect(getCurrentVersion()).toBe('0.5.6');
  });

  it('is the version the MCP server announces', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getCurrentVersion } = require('../updateCheck');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createMcpServer } = require('../mcpServer');
    const server = createMcpServer({ connected: false } as any);
    const info = (server as any).server?._serverInfo;
    expect(info?.version).toBe(getCurrentVersion());
  });
});
