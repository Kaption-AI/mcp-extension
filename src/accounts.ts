import { Bridge, type ToolBridge } from './bridge';
import { RelayBridge } from './relayBridge';

export interface AccountInfo {
  sessionId: string;
  phone: string;
  pushname: string;
  isBusiness: boolean;
  browser: string;
}

/** mcp.LOCAL_HUB.10 — every connected account, answered by the hub itself (never one account's view). */
export function listAccounts(bridge: ToolBridge): AccountInfo[] {
  const accounts: AccountInfo[] = [];
  if (bridge instanceof Bridge) {
    for (const [sessionId, info] of bridge.sessions) {
      accounts.push({
        sessionId,
        phone: info.phone || '',
        pushname: info.pushname || '',
        isBusiness: info.isBusiness || false,
        browser: info.browser || 'unknown',
      });
    }
  } else if (bridge instanceof RelayBridge) {
    for (const ext of bridge.extensions) {
      accounts.push({
        sessionId: ext.sessionId,
        phone: ext.phone || '',
        pushname: ext.pushname || '',
        isBusiness: ext.isBusiness || false,
        browser: ext.browser || 'unknown',
      });
    }
  }
  return accounts;
}

export const MULTIPLE_ACCOUNTS_WARNING =
  'Multiple accounts connected. Use target_session for accuracy. Query entity="session" to see accounts.';
