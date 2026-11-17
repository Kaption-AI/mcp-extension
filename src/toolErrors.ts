/**
 * mcp-local-hub-growth.ERRORS.1 — the text a failed tool call answers with, the same as the cloud relay's
 * (Kaption-AI/mcp-extension-remote src/tool-errors.ts, mcp.CLOUD_RELAY.21). Messages written by the extension itself
 * (a refusal with its reason, a plan limit, a bad argument) pass through as `Error: <message>`; the hub's own failures
 * get the cloud's wording, adapted only where the cloud says something that is not true of a hub on this computer.
 */
const NOT_CONNECTED =
  'Extension not connected: Kaption is not connected to this computer. Open WhatsApp Web with the Kaption ' +
  'extension (or open the Kaption desktop app), check that Claude and ChatGPT access is turned on in Kaption and ' +
  '"Connect on this computer" is allowed, then try again.';

const DISCONNECTED =
  'Kaption disconnected before it answered (WhatsApp Web was closed or reloaded). Nothing is known about the ' +
  'result: check WhatsApp is open with Kaption, then look before retrying a change.';

const timedOut = (seconds: string) =>
  `Kaption did not answer within ${seconds} seconds. Keep WhatsApp Web open with Kaption and try again; for a large ` +
  'read, ask for fewer results with limit.';

/** The hub's own failures, matched on the messages bridge.ts and relayBridge.ts throw. */
const HUB_FAILURES: Array<{ match: RegExp; text: (found: RegExpMatchArray) => string }> = [
  { match: /^Extension not connected/, text: () => NOT_CONNECTED },
  // A second hub (relay mode) whose main hub is gone: nothing reaches Kaption from this computer either.
  { match: /^Not connected to Kaption AI MCP hub/, text: () => NOT_CONNECTED },
  // The extension's socket, or the main hub's for a relay, closed while the call waited.
  { match: /^(Extension|Hub) disconnected/, text: () => DISCONNECTED },
  { match: /^Request timed out after (\d+)ms/, text: f => timedOut(String(Math.round(Number(f[1]) / 1000))) },
  { match: /^Request timed out after (\d+)s/, text: f => timedOut(f[1]) },
  {
    match: /^Too many pending requests/,
    text: () => 'Too many requests are waiting for Kaption on this account. Wait a few seconds, then try again.',
  },
  {
    match: /^Message too large/,
    text: () => 'The answer was too large to pass on. Ask for fewer results with limit, or a narrower date range.',
  },
];

/** mcp-local-hub-growth.ERRORS.2 — JSON-RPC "method not found": a Kaption version that predates the tool. */
const METHOD_NOT_FOUND = -32601;

export function toolErrorText(tool: string, err: unknown): string {
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  const code = (err as { code?: unknown } | null)?.code;
  // mcp.LOCAL_HUB.10 — the unknown-account error (UnknownSessionError) already says what to do.
  if (code === 'UNKNOWN_SESSION') return `Error: ${message}`;
  if (code === METHOD_NOT_FOUND || /^Method not found|^Unknown (method|tool)/i.test(message)) {
    return `Error: this Kaption version cannot run ${tool} yet. Update the Kaption extension or desktop app, reload WhatsApp Web, then try again.`;
  }
  for (const failure of HUB_FAILURES) {
    const found = message.match(failure.match);
    if (found) return `Error: ${failure.text(found)}`;
  }
  if (!message || message === 'Extension returned error') {
    return `Error: Kaption could not complete ${tool} and gave no reason. Check WhatsApp Web is open with Kaption and try again.`;
  }
  return `Error: ${message}`;
}

/** mcp-local-hub-growth.ERRORS.2 — an extension (or main hub) error that keeps its JSON-RPC code. */
export function rpcError(error: { code?: unknown; message?: unknown } | undefined): Error {
  const message = typeof error?.message === 'string' ? error.message : '';
  return typeof error?.code === 'number' ? Object.assign(new Error(message), { code: error.code }) : new Error(message);
}
