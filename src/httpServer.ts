import { createServer, IncomingMessage, ServerResponse, Server } from 'http';
import type { ToolBridge } from './bridge';
import { validateToken } from './auth';

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

export function createHttpServer(bridge: ToolBridge, authToken: string): Promise<Server> {
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
    if (path === '/sessions' && req.method === 'GET') {
      if (!bridge.connected) {
        return respond(res, 200, { ok: true, data: { sessions: [] } });
      }
      try {
        const result = await bridge.callTool('query', { entity: 'session' });
        return respond(res, 200, { ok: true, data: result.data });
      } catch (error) {
        return respond(res, 500, { ok: false, error: (error as Error).message, code: 'INTERNAL_ERROR' });
      }
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
        return respond(res, 500, { ok: false, error: (error as Error).message, code: 'TOOL_ERROR' });
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

      // Session routing from query param
      const session = params.get('session');
      if (session) toolParams.target_session = session;

      try {
        const result = await bridge.callTool(toolName, toolParams, session || undefined);
        return respond(res, 200, {
          ok: true,
          data: result.data,
          source: result.source || undefined,
        });
      } catch (error) {
        return respond(res, 500, { ok: false, error: (error as Error).message, code: 'TOOL_ERROR' });
      }
    }

    respond(res, 404, { ok: false, error: 'Not found', code: 'NOT_FOUND' });
  });

  return new Promise((resolve, reject) => {
    server.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        console.error(`[Kaption AI MCP] HTTP port ${HTTP_PORT} in use, skipping HTTP server`);
        resolve(server);
      } else {
        reject(err);
      }
    });
    server.listen(HTTP_PORT, '127.0.0.1', () => {
      console.error(`[Kaption AI MCP] HTTP API listening on http://127.0.0.1:${HTTP_PORT}`);
      resolve(server);
    });
  });
}
