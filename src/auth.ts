import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export const AUTH_DIR = path.join(os.homedir(), '.kaptionai');
const SESSIONS_DIR = path.join(AUTH_DIR, 'sessions');
const TOKEN_FILE = path.join(AUTH_DIR, 'mcp-auth-token');
const TOKEN_BYTES = 32; // 256-bit
const SESSION_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface Session {
  id: string;
  token_hash: string;
  client_type: 'relay' | 'extension';
  phone?: string;
  pushname?: string;
  created_at: string;
  expires_at: string;
  last_used_at: string;
}

export function getTokenFilePath(): string {
  return TOKEN_FILE;
}

/**
 * Load existing auth token or create a new one.
 * File is created with mode 0600 (owner read/write only).
 */
export async function loadOrCreateToken(): Promise<string> {
  try {
    const existing = await fs.promises.readFile(TOKEN_FILE, 'utf-8');
    const trimmed = existing.trim();
    if (trimmed.length > 0) return trimmed;
  } catch {
    // File doesn't exist or can't be read
  }

  await fs.promises.mkdir(AUTH_DIR, { recursive: true });
  const token = crypto.randomBytes(TOKEN_BYTES).toString('hex');
  await fs.promises.writeFile(TOKEN_FILE, token, { mode: 0o600 });
  return token;
}

/**
 * Timing-safe token comparison. Returns false for mismatched lengths.
 */
export function validateToken(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export class SessionManager {
  private readonly dir: string;

  constructor(dir?: string) {
    this.dir = dir ?? SESSIONS_DIR;
  }

  private sessionPath(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  /**
   * Create a new session. Returns the raw token (only available at creation time).
   */
  async createSession(
    clientType: 'relay' | 'extension',
    metadata?: { phone?: string; pushname?: string },
  ): Promise<{ id: string; token: string; expiresAt: string }> {
    await fs.promises.mkdir(this.dir, { recursive: true });

    const id = `sess_${crypto.randomBytes(12).toString('hex')}`;
    const token = crypto.randomBytes(TOKEN_BYTES).toString('hex');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + SESSION_EXPIRY_MS).toISOString();

    const session: Session = {
      id,
      token_hash: hashToken(token),
      client_type: clientType,
      phone: metadata?.phone,
      pushname: metadata?.pushname,
      created_at: now.toISOString(),
      expires_at: expiresAt,
      last_used_at: now.toISOString(),
    };

    await fs.promises.writeFile(this.sessionPath(id), JSON.stringify(session, null, 2), { mode: 0o600 });
    return { id, token, expiresAt };
  }

  /**
   * Validate a session token. Returns the session if valid, null otherwise.
   * Updates last_used_at and extends expiry on success.
   */
  async validateSession(sessionId: string, token: string): Promise<Session | null> {
    let session: Session;
    try {
      const data = await fs.promises.readFile(this.sessionPath(sessionId), 'utf-8');
      session = JSON.parse(data);
    } catch {
      return null;
    }

    // Check expiry
    if (new Date(session.expires_at).getTime() < Date.now()) {
      // Expired — clean up
      await this.revokeSession(sessionId);
      return null;
    }

    // Validate token hash
    const providedHash = hashToken(token);
    if (!validateToken(providedHash, session.token_hash)) {
      return null;
    }

    // Rolling expiry — update last_used_at and extend expiry
    const now = new Date();
    session.last_used_at = now.toISOString();
    session.expires_at = new Date(now.getTime() + SESSION_EXPIRY_MS).toISOString();
    await fs.promises.writeFile(this.sessionPath(sessionId), JSON.stringify(session, null, 2), { mode: 0o600 });

    return session;
  }

  async revokeSession(id: string): Promise<void> {
    try {
      await fs.promises.unlink(this.sessionPath(id));
    } catch {
      // Already deleted
    }
  }

  async listSessions(): Promise<Session[]> {
    try {
      const files = await fs.promises.readdir(this.dir);
      const sessions: Session[] = [];
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        try {
          const data = await fs.promises.readFile(path.join(this.dir, file), 'utf-8');
          sessions.push(JSON.parse(data));
        } catch {
          // Skip corrupt files
        }
      }
      return sessions;
    } catch {
      return [];
    }
  }

  async cleanExpired(): Promise<number> {
    const sessions = await this.listSessions();
    let cleaned = 0;
    const now = Date.now();
    for (const session of sessions) {
      if (new Date(session.expires_at).getTime() < now) {
        await this.revokeSession(session.id);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      console.error(`[Kaption AI MCP] Cleaned ${cleaned} expired session(s)`);
    }
    return cleaned;
  }
}
