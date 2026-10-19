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

/** Non-blocking check against npm registry. Call once at startup. */
export function checkForUpdates(): void {
  const currentVersion = getCurrentVersion();

  fetch(`https://registry.npmjs.org/${PACKAGE_NAME}/latest`)
    .then((res) => res.json())
    .then((data: any) => {
      const latest = data.version;
      if (latest && latest !== currentVersion) {
        updateAvailable = { current: currentVersion, latest };
        console.error(`\n[Kaption AI MCP] Update available: ${currentVersion} → ${latest}`);
        console.error(`[Kaption AI MCP] Run: npx ${PACKAGE_NAME}@latest\n`);
      }
    })
    .catch(() => { /* offline or registry down — silent */ });
}

/** Returns update info if a newer version is available, null otherwise. */
export function getUpdateInfo(): { current: string; latest: string; message: string } | null {
  if (!updateAvailable) return null;
  return {
    ...updateAvailable,
    message: `Update available: ${updateAvailable.current} → ${updateAvailable.latest}. Run: npx ${PACKAGE_NAME}@latest`,
  };
}
