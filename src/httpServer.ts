import { createServer, IncomingMessage, ServerResponse, Server } from 'http';
import type { ToolBridge } from './bridge';
import { validateToken } from './auth';
import { listAccounts, MULTIPLE_ACCOUNTS_WARNING } from './accounts';
import { UnknownSessionError } from './bridge';

/** mcp.LOCAL_HUB.10 — a named account the hub doesn't have answers 404 UNKNOWN_SESSION, never another account. */
function toolError(res: ServerResponse, error: unknown): void {
  if (error instanceof UnknownSessionError) {
    return respond(res, 404, { ok: false, error: error.message, code: error.code, session: error.sessionId });
  }
  respond(res, 500, { ok: false, error: (error as Error).message, code: 'TOOL_ERROR' });
}

const HTTP_PORT = 7866;

function respond(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

function parseUrl(raw: string | undefined): { path: string; params: URLSearchParams } {
  const url = new URL(raw || '/', 'http://localhost');
  return { path: url.pathname, params: url.searchParams };
}

// mcp.LOCAL_HUB.6 — HTTP REST API on 7866; /health no-auth, others bearer
export function createHttpServer(bridge: ToolBridge, authToken: string, port = HTTP_PORT): Promise<Server> {
  const server = createServer(async (req, res) => {
    // CORS headers for local dev
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const { path, params } = parseUrl(req.url);

    // Health check — no auth required
    if (path === '/health' && req.method === 'GET') {
      return respond(res, 200, {
        ok: true,
        data: { connected: bridge.connected },
      });
    }

    // Auth check for all other endpoints
    const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, '');
    if (!bearer || !validateToken(bearer, authToken)) {
      return respond(res, 401, { ok: false, error: 'Unauthorized', code: 'UNAUTHORIZED' });
    }

    // GET /sessions
    // mcp.LOCAL_HUB.10 — every connected account, listed by the hub (it used to ask one account,
    // which answered only for itself).
    if (path === '/sessions' && req.method === 'GET') {
      return respond(res, 200, { ok: true, data: { connected: bridge.connected, accounts: listAccounts(bridge) } });
    }

    // GET /media/:messageId?conversation_id=...&session=...
    // Returns raw binary media with proper Content-Type
    const mediaMatch = path.match(/^\/media\/(.+)$/);
    if (mediaMatch && req.method === 'GET') {
      const messageId = decodeURIComponent(mediaMatch[1]);
      const conversationId = params.get('conversation_id');

      if (!conversationId) {
        return respond(res, 400, { ok: false, error: 'conversation_id query param required', code: 'BAD_REQUEST' });
      }
      if (!bridge.connected) {
        return respond(res, 503, { ok: false, error: 'Extension not connected', code: 'NOT_CONNECTED' });
      }

      const session = params.get('session');
      try {
        const result = await bridge.callTool('download_media', {
          message_id: messageId,
          conversation_id: conversationId,
          ...(session ? { target_session: session } : {}),
        }, session || undefined);

        const data = result.data as any;
        if (!data?.base64_data) {
          return respond(res, 500, { ok: false, error: 'No media data returned', code: 'NO_DATA' });
        }

        const buffer = Buffer.from(data.base64_data, 'base64');
        res.writeHead(200, {
          'Content-Type': data.mimetype || 'application/octet-stream',
          'Content-Length': buffer.length,
          'Content-Disposition': data.filename
            ? `inline; filename="${data.filename}"`
            : 'inline',
        });
        res.end(buffer);
        return;
      } catch (error) {
        return toolError(res, error);
      }
    }

    // POST /tools/:toolName
    const toolMatch = path.match(/^\/tools\/([a-z_]+)$/);
    if (toolMatch && req.method === 'POST') {
      const toolName = toolMatch[1];

      if (!bridge.connected) {
        return respond(res, 503, { ok: false, error: 'Extension not connected', code: 'NOT_CONNECTED' });
      }

      let toolParams: Record<string, unknown> = {};
      try {
        const body = await readBody(req);
        if (body) toolParams = JSON.parse(body);
      } catch {
        return respond(res, 400, { ok: false, error: 'Invalid JSON body', code: 'BAD_REQUEST' });
      }

      // mcp.LOCAL_HUB.10 — route by ?session= or by target_session in the body, the name the MCP
      // tools use. Before, a body target_session was ignored and the most recent account answered.
      const querySession = params.get('session') || undefined;
      const bodySession = typeof toolParams.target_session === 'string' && toolParams.target_session
        ? toolParams.target_session
        : undefined;
      if (querySession && bodySession && querySession !== bodySession) {
        return respond(res, 400, {
          ok: false,
          error: `?session=${querySession} and target_session=${bodySession} name different accounts`,
          code: 'BAD_REQUEST',
        });
      }
      const session = querySession ?? bodySession;
      delete toolParams.target_session;

      if (toolName === 'query' && toolParams.entity === 'session' && !session) {
        return respond(res, 200, { ok: true, data: { connected: bridge.connected, accounts: listAccounts(bridge) } });
      }

      try {
        const result = await bridge.callTool(toolName, toolParams, session);
        return respond(res, 200, {
          ok: true,
          data: result.data,
          source: result.source || undefined,
          ...(!session && listAccounts(bridge).length > 1 ? { _warning: MULTIPLE_ACCOUNTS_WARNING } : {}),
        });
      } catch (error) {
        return toolError(res, error);
      }
    }

    respond(res, 404, { ok: false, error: 'Not found', code: 'NOT_FOUND' });
  });

  return new Promise((resolve, reject) => {
    server.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        console.error(`[Kaption AI MCP] HTTP port ${port} in use, skipping HTTP server`);
        resolve(server);
      } else {
        reject(err);
      }
    });
    server.listen(port, '127.0.0.1', () => {
      console.error(`[Kaption AI MCP] HTTP API listening on http://127.0.0.1:${port}`);
      resolve(server);
    });
  });
}
