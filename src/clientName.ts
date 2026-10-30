/**
 * mcp-usage-accounting.LOCAL.3 — the hub forwards the AI app's name (MCP `initialize` clientInfo.name) with
 * each tool call so the extension can count local calls per app. Only the name, nothing else.
 */
/** mcp-usage-accounting.LOCAL.3 — the longest client name the hub forwards. */
export const CLIENT_NAME_MAX = 64;

/**
 * mcp-usage-accounting.LOCAL.3 — the AI app's name as the hub forwards it: a trimmed string of at most
 * CLIENT_NAME_MAX characters, or undefined when there is none (nothing else from clientInfo is sent).
 */
export function clientNameOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const name = Array.from(value.trim()).slice(0, CLIENT_NAME_MAX).join('').trim();
  return name || undefined;
}

/**
 * mcp-usage-accounting.LOCAL.3 — the JSON-RPC request the hub sends for one tool call. `client` sits at the
 * top level, beside method/params: older extensions ignore unknown fields, and tool arguments stay unchanged.
 */
export function toolRequest(id: string, method: string, params: Record<string, unknown>, clientName?: string): Record<string, unknown> {
  const name = clientNameOf(clientName);
  return { jsonrpc: '2.0', id, method, params, ...(name ? { client: { name } } : {}) };
}
