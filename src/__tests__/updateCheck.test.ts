// mcp.LOCAL_HUB.8 — the npm check: newer only (never a downgrade), and a running hub learns of a release later.
import { checkOnce, getUpdateInfo, isNewer, resetUpdateInfoForTests, getCurrentVersion } from '../updateCheck';

const answer = (version: string) => (async () => ({ json: async () => ({ version }) })) as unknown as typeof fetch;

describe('mcp.LOCAL_HUB.8 update check', () => {
  beforeEach(() => resetUpdateInfoForTests());

  it('compares x.y.z numerically', () => {
    expect(isNewer('0.5.22', '0.5.21')).toBe(true);
    expect(isNewer('0.5.10', '0.5.9')).toBe(true);
    expect(isNewer('0.6.0', '0.5.99')).toBe(true);
    expect(isNewer('0.5.21', '0.5.21')).toBe(false);
    expect(isNewer('0.5.20', '0.5.21')).toBe(false);
    expect(isNewer('0.5.22-beta.1', '0.5.21')).toBe(true);
  });

  it('a newer version on npm is reported; the same or an older one is not; offline is silent', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const current = getCurrentVersion();
    await checkOnce(answer(current));
    expect(getUpdateInfo()).toBeNull();
    await checkOnce(answer('0.0.1'));
    expect(getUpdateInfo()).toBeNull();
    await checkOnce((async () => { throw new Error('offline'); }) as unknown as typeof fetch);
    expect(getUpdateInfo()).toBeNull();
    await checkOnce(answer('99.0.0'));
    expect(getUpdateInfo()).toMatchObject({ current, latest: '99.0.0' });
    expect(getUpdateInfo()!.message).toContain('99.0.0');
    spy.mockRestore();
  });
});
