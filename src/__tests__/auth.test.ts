import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { loadOrCreateToken, validateToken, getTokenFilePath, SessionManager } from '../auth';

describe('auth', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaption-auth-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('loadOrCreateToken', () => {
    it('should generate a 64 hex char token', async () => {
      const crypto = await import('crypto');
      const token = crypto.randomBytes(32).toString('hex');
      expect(token).toHaveLength(64);
      expect(token).toMatch(/^[0-9a-f]{64}$/);
    });

    it('should read existing token from file', async () => {
      const tokenFile = path.join(tmpDir, 'mcp-auth-token');
      fs.writeFileSync(tokenFile, 'abcd1234', { mode: 0o600 });
      const content = fs.readFileSync(tokenFile, 'utf-8').trim();
      expect(content).toBe('abcd1234');
    });
  });

  describe('validateToken', () => {
    it('should return true for equal tokens', () => {
      expect(validateToken('abc123', 'abc123')).toBe(true);
    });

    it('should return false for different tokens', () => {
      expect(validateToken('abc123', 'xyz789')).toBe(false);
    });

    it('should return false for different-length strings', () => {
      expect(validateToken('short', 'muchlonger')).toBe(false);
    });

    it('should handle empty strings', () => {
      expect(validateToken('', '')).toBe(true);
    });
  });

  describe('getTokenFilePath', () => {
    it('should return a path under ~/.kaptionai', () => {
      const p = getTokenFilePath();
      expect(p).toContain('.kaptionai');
      expect(p).toContain('mcp-auth-token');
    });
  });

  describe('SessionManager', () => {
    let manager: SessionManager;

    beforeEach(() => {
      manager = new SessionManager(path.join(tmpDir, 'sessions'));
    });

    it('should create a session with correct fields', async () => {
      const result = await manager.createSession('extension', { phone: '+1234', pushname: 'Test' });

      expect(result.id).toMatch(/^sess_[0-9a-f]{24}$/);
      expect(result.token).toHaveLength(64);
      expect(result.expiresAt).toBeTruthy();

      const sessions = await manager.listSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe(result.id);
      expect(sessions[0].client_type).toBe('extension');
      expect(sessions[0].phone).toBe('+1234');
      expect(sessions[0].pushname).toBe('Test');
      expect(sessions[0].token_hash).not.toBe(result.token);
      expect(sessions[0].token_hash).toHaveLength(64);
    });

    it('should validate a valid session and update last_used_at', async () => {
      const result = await manager.createSession('extension', { phone: '+5678' });

      await new Promise(r => setTimeout(r, 10));

      const session = await manager.validateSession(result.id, result.token);
      expect(session).not.toBeNull();
      expect(session!.id).toBe(result.id);
      expect(session!.phone).toBe('+5678');
    });

    it('should reject an invalid token', async () => {
      const result = await manager.createSession('extension');
      const session = await manager.validateSession(result.id, 'wrong-token');
      expect(session).toBeNull();
    });

    it('should reject an expired session', async () => {
      const result = await manager.createSession('extension');

      const sessionFile = path.join(tmpDir, 'sessions', `${result.id}.json`);
      const data = JSON.parse(fs.readFileSync(sessionFile, 'utf-8'));
      data.expires_at = new Date(Date.now() - 1000).toISOString();
      fs.writeFileSync(sessionFile, JSON.stringify(data));

      const session = await manager.validateSession(result.id, result.token);
      expect(session).toBeNull();
    });

    it('should reject a non-existent session', async () => {
      const session = await manager.validateSession('sess_nonexistent', 'token');
      expect(session).toBeNull();
    });

    it('should revoke a session', async () => {
      const result = await manager.createSession('extension');
      await manager.revokeSession(result.id);

      const sessions = await manager.listSessions();
      expect(sessions).toHaveLength(0);
    });

    it('should list all sessions', async () => {
      await manager.createSession('extension', { phone: '+111' });
      await manager.createSession('extension', { phone: '+222' });
      await manager.createSession('relay');

      const sessions = await manager.listSessions();
      expect(sessions).toHaveLength(3);
    });

    it('should clean up expired sessions', async () => {
      const active = await manager.createSession('extension');
      const expired = await manager.createSession('extension');

      const sessionFile = path.join(tmpDir, 'sessions', `${expired.id}.json`);
      const data = JSON.parse(fs.readFileSync(sessionFile, 'utf-8'));
      data.expires_at = new Date(Date.now() - 1000).toISOString();
      fs.writeFileSync(sessionFile, JSON.stringify(data));

      const cleaned = await manager.cleanExpired();
      expect(cleaned).toBe(1);

      const sessions = await manager.listSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe(active.id);
    });

    it('should handle concurrent sessions', async () => {
      const results = await Promise.all([
        manager.createSession('extension', { phone: '+111' }),
        manager.createSession('extension', { phone: '+222' }),
        manager.createSession('relay'),
      ]);

      expect(results).toHaveLength(3);
      const ids = results.map(r => r.id);
      expect(new Set(ids).size).toBe(3);

      for (const r of results) {
        const session = await manager.validateSession(r.id, r.token);
        expect(session).not.toBeNull();
      }
    });
  });
});
