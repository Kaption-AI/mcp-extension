import { join } from 'path';
import { readFileSync } from 'fs';

const PACKAGE_NAME = '@kaptionai/mcp-extension';

let updateAvailable: { current: string; latest: string } | null = null;

let startedWith: string | undefined;

/**
 * The version of the code this process is running: package.json read once, on first use. Reading it again
 * on every call reported a newer version than the running code after an update on disk (hub on 0.5.6
 * answering 0.5.8 until restarted).
 */
export function getCurrentVersion(): string {
  if (startedWith === undefined) {
    startedWith = String(JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')).version);
  }
  return startedWith;
}

/** mcp.LOCAL_HUB.8 — how often a running hub asks npm again (a hub stays up for days; 0.5.21 never saw 0.5.22). */
export const UPDATE_CHECK_EVERY_MS = 6 * 60 * 60_000;

/** a > b for x.y.z versions (a pre-release or odd part counts as 0); a downgrade is never an update. */
export function isNewer(a: string, b: string): boolean {
  const parts = (v: string) => String(v).split('-')[0].split('.').map(n => Number.parseInt(n, 10) || 0);
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  }
  return false;
}

/** One non-blocking check against the npm registry. */
export async function checkOnce(fetchFn: typeof fetch = fetch): Promise<void> {
  const currentVersion = getCurrentVersion();
  try {
    const data: any = await (await fetchFn(`https://registry.npmjs.org/${PACKAGE_NAME}/latest`)).json();
    const latest = data?.version;
    if (typeof latest === 'string' && isNewer(latest, currentVersion)) {
      const fresh = updateAvailable?.latest !== latest;
      updateAvailable = { current: currentVersion, latest };
      if (fresh) {
        console.error(`\n[Kaption AI MCP] Update available: ${currentVersion} → ${latest}`);
        console.error(`[Kaption AI MCP] Run: npx ${PACKAGE_NAME}@latest\n`);
      }
    }
  } catch {
    // offline or registry down — silent
  }
}

/** mcp.LOCAL_HUB.8 — checks at startup, then every 6 hours while the hub runs. */
export function checkForUpdates(): void {
  void checkOnce();
  const timer = setInterval(() => { void checkOnce(); }, UPDATE_CHECK_EVERY_MS);
  timer.unref?.();
}

/** Returns update info if a newer version is available, null otherwise. */
export function getUpdateInfo(): { current: string; latest: string; message: string } | null {
  if (!updateAvailable) return null;
  return {
    ...updateAvailable,
    message: `Kaption MCP update available: ${updateAvailable.current} → ${updateAvailable.latest}. Restart the AI app to pick it up, or run: npx ${PACKAGE_NAME}@latest`,
  };
}

/** Tests only. */
export function resetUpdateInfoForTests(): void {
  updateAvailable = null;
}
