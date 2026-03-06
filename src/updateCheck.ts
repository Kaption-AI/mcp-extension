import { join } from 'path';
import { readFileSync } from 'fs';

const PACKAGE_NAME = '@kaptionai/mcp-extension';

let updateAvailable: { current: string; latest: string } | null = null;

/** Get the current installed version. */
export function getCurrentVersion(): string {
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
  return pkg.version;
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
