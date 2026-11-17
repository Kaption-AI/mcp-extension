/**
 * mcp-local-hub-growth.CLIENT.1, CLIENT.5 — the AI app (MCP client) that called: the `clientInfo` of its MCP
 * initialize request, cut down to a short name and version before it leaves the hub. Nothing else of the request is
 * kept. Pinned by fixtures/mcp-clients.json (a copy of kaptionai kaption-core/fixtures/mcp/clients.json).
 */
export interface McpClientInfo {
  name: string;
  version: string;
}

/** mcp-local-hub-growth.CLIENT.5 — at most 32 characters of letters, digits, space and . _ - / ( ) +. */
export function sanitizeClientName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();
  return collapse(collapse(raw).replace(/[^A-Za-z0-9 ._\-/()+]/g, '')).slice(0, 32).trim();
}

/** mcp-local-hub-growth.CLIENT.5 — at most 16 characters of letters, digits and . + -. */
export function sanitizeClientVersion(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[^A-Za-z0-9.+-]/g, '').slice(0, 16);
}

/** The client as it is sent to the extension; undefined when nothing usable was said (the field is then left out). */
export function sanitizeClient(raw: unknown): McpClientInfo | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const name = sanitizeClientName((raw as { name?: unknown }).name);
  const version = sanitizeClientVersion((raw as { version?: unknown }).version);
  return name || version ? { name, version } : undefined;
}

export type McpClientId =
  | 'claude-desktop' | 'claude-code' | 'claude-ai' | 'chatgpt' | 'cursor' | 'vscode' | 'windsurf' | 'other' | 'unknown';

/**
 * mcp-local-hub-growth.CLIENT.4 — the normalized client (first match on the name, case-insensitive). The extension
 * does this on its side; exported here so the hub and the fixture agree.
 */
export function normalizeMcpClient(rawName: unknown, path: 'local' | 'cloud'): McpClientId {
  const name = sanitizeClientName(rawName).toLowerCase();
  if (!name) return 'unknown';
  if (/claude[\s_-]*code/.test(name)) return 'claude-code';
  if (name.includes('cursor')) return 'cursor';
  if (/windsurf|codeium/.test(name)) return 'windsurf';
  if (/visual[\s_-]*studio[\s_-]*code|vscode|copilot/.test(name)) return 'vscode';
  if (/chatgpt|openai/.test(name)) return 'chatgpt';
  if (/claude[\s_-]*desktop/.test(name)) return 'claude-desktop';
  if (/claude|anthropic/.test(name)) return path === 'local' ? 'claude-desktop' : 'claude-ai';
  return 'other';
}
