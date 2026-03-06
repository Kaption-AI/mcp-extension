import { Bridge } from '../bridge';

describe('Bridge', () => {
  let bridge: Bridge;

  beforeEach(() => {
    bridge = new Bridge();
  });

  describe('connection state', () => {
    it('should start disconnected', () => {
      expect(bridge.connected).toBe(false);
    });

    it('should become connected when setConnection is called', () => {
      bridge.setConnection('sess_1', jest.fn());
      expect(bridge.connected).toBe(true);
    });

    it('should become disconnected when clearConnection is called', () => {
      bridge.setConnection('sess_1', jest.fn());
      bridge.clearConnection('sess_1');
      expect(bridge.connected).toBe(false);
    });

    it('should emit connected event', () => {
      const handler = jest.fn();
      bridge.on('connected', handler);
      bridge.setConnection('sess_1', jest.fn());
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should emit disconnected event only when last connection cleared', () => {
      const handler = jest.fn();
      bridge.on('disconnected', handler);
      bridge.setConnection('sess_1', jest.fn());
      bridge.setConnection('sess_2', jest.fn());

      bridge.clearConnection('sess_1');
      expect(handler).not.toHaveBeenCalled(); // sess_2 still alive

      bridge.clearConnection('sess_2');
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should support multiple concurrent connections', () => {
      bridge.setConnection('sess_1', jest.fn());
      bridge.setConnection('sess_2', jest.fn());
      expect(bridge.connected).toBe(true);

      bridge.clearConnection('sess_1');
      expect(bridge.connected).toBe(true); // sess_2 still connected

      bridge.clearConnection('sess_2');
      expect(bridge.connected).toBe(false);
    });

    it('should track sessions per connection', () => {
      bridge.setConnection('sess_1', jest.fn());
      bridge.setSession('sess_1', { phone: '+111', pushname: 'User1' });

      bridge.setConnection('sess_2', jest.fn());
      bridge.setSession('sess_2', { phone: '+222', pushname: 'User2' });

      const sessions = bridge.sessions;
      expect(sessions.size).toBe(2);
      expect(sessions.get('sess_1')?.phone).toBe('+111');
      expect(sessions.get('sess_2')?.phone).toBe('+222');
    });

    it('should return first session for backward compat', () => {
      bridge.setConnection('sess_1', jest.fn());
      bridge.setSession('sess_1', { phone: '+111' });
      expect(bridge.session?.phone).toBe('+111');
    });
  });

  describe('callTool', () => {
    it('should throw when not connected', async () => {
      await expect(bridge.callTool('query', {})).rejects.toThrow(
        'Extension not connected'
      );
    });

    it('should send JSON-RPC request through send function', async () => {
      const sendFn = jest.fn();
      bridge.setConnection('sess_1', sendFn);

      const promise = bridge.callTool('query', { limit: 10 });

      expect(sendFn).toHaveBeenCalledTimes(1);
      const sent = JSON.parse(sendFn.mock.calls[0][0]);
      expect(sent.jsonrpc).toBe('2.0');
      expect(sent.method).toBe('query');
      expect(sent.params).toEqual({ limit: 10 });
      expect(sent.id).toMatch(/^req_\d+$/);

      bridge.handleResponse(JSON.stringify({
        jsonrpc: '2.0',
        id: sent.id,
        result: [{ id: 'chat1' }],
      }));

      const result = await promise;
      expect(result.data).toEqual([{ id: 'chat1' }]);
      expect(result.source?.sessionId).toBe('sess_1');
    });

    it('should route to specific session when targetSessionId is provided', async () => {
      const sendFn1 = jest.fn();
      const sendFn2 = jest.fn();
      bridge.setConnection('sess_1', sendFn1);
      bridge.setConnection('sess_2', sendFn2);

      const promise = bridge.callTool('query', {}, 'sess_2');

      expect(sendFn1).not.toHaveBeenCalled();
      expect(sendFn2).toHaveBeenCalledTimes(1);

      const sent = JSON.parse(sendFn2.mock.calls[0][0]);
      bridge.handleResponse(JSON.stringify({
        jsonrpc: '2.0',
        id: sent.id,
        result: { ok: true },
      }));

      const result = await promise;
      expect(result.data).toEqual({ ok: true });
      expect(result.source?.sessionId).toBe('sess_2');
    });

    it('should reject on error response', async () => {
      const sendFn = jest.fn();
      bridge.setConnection('sess_1', sendFn);

      const promise = bridge.callTool('query', { id: 'x' });
      const sent = JSON.parse(sendFn.mock.calls[0][0]);

      bridge.handleResponse(JSON.stringify({
        jsonrpc: '2.0',
        id: sent.id,
        error: { code: -32001, message: 'Conversation not found' },
      }));

      await expect(promise).rejects.toThrow('Conversation not found');
    });

    it('should include session info in source', async () => {
      const sendFn = jest.fn();
      bridge.setConnection('sess_1', sendFn);
      bridge.setSession('sess_1', { phone: '+5491157390064', pushname: 'Cris' });

      const promise = bridge.callTool('query', {});
      const sent = JSON.parse(sendFn.mock.calls[0][0]);

      bridge.handleResponse(JSON.stringify({
        jsonrpc: '2.0',
        id: sent.id,
        result: { conversations: [] },
      }));

      const result = await promise;
      expect(result.source).toEqual({
        sessionId: 'sess_1',
        phone: '+5491157390064',
        pushname: 'Cris',
      });
    });

    it('should reject when send function throws', async () => {
      bridge.setConnection('sess_1', () => {
        throw new Error('WebSocket closed');
      });

      await expect(bridge.callTool('query', {})).rejects.toThrow(
        'Failed to send request'
      );
    });

    it('should reject pending requests on last disconnect', async () => {
      bridge.setConnection('sess_1', jest.fn());

      const promise = bridge.callTool('query', {});
      bridge.clearConnection('sess_1');

      await expect(promise).rejects.toThrow('Extension disconnected');
    });

    it('should NOT reject pending requests if other connections remain', async () => {
      jest.useFakeTimers();
      const sendFn1 = jest.fn();
      bridge.setConnection('sess_1', sendFn1);
      bridge.setConnection('sess_2', jest.fn());

      // sess_2 is lastActive, so callTool routes there... but let's target sess_1
      const promise = bridge.callTool('query', {}, 'sess_1');
      bridge.clearConnection('sess_2');

      const sent = JSON.parse(sendFn1.mock.calls[0][0]);
      bridge.handleResponse(JSON.stringify({
        jsonrpc: '2.0',
        id: sent.id,
        result: { ok: true },
      }));

      const result = await promise;
      expect(result.data).toEqual({ ok: true });
      jest.useRealTimers();
    });

    it('should reject pending requests for specific disconnected connection', async () => {
      const sendFn1 = jest.fn();
      const sendFn2 = jest.fn();
      bridge.setConnection('sess_1', sendFn1);
      bridge.setConnection('sess_2', sendFn2);

      // Route to sess_2 (most recently active)
      const promise = bridge.callTool('query', {});

      // Disconnect sess_2 — its pending request should be rejected immediately
      bridge.clearConnection('sess_2');
      await expect(promise).rejects.toThrow('Extension disconnected');

      // sess_1 still connected
      expect(bridge.connected).toBe(true);
    });

    it('should route to most recently active connection', async () => {
      const sendFn1 = jest.fn();
      const sendFn2 = jest.fn();
      bridge.setConnection('sess_1', sendFn1);
      bridge.setConnection('sess_2', sendFn2);

      // sess_2 is most recent, should get the call
      const promise = bridge.callTool('query', {});
      expect(sendFn1).not.toHaveBeenCalled();
      expect(sendFn2).toHaveBeenCalledTimes(1);

      const sent = JSON.parse(sendFn2.mock.calls[0][0]);
      bridge.handleResponse(JSON.stringify({ jsonrpc: '2.0', id: sent.id, result: 'ok' }));
      await promise;
    });

    it('should update lastActive when setSession is called', async () => {
      const sendFn1 = jest.fn();
      const sendFn2 = jest.fn();
      bridge.setConnection('sess_1', sendFn1);
      bridge.setConnection('sess_2', sendFn2); // sess_2 is lastActive

      // Update sess_1 session — makes it lastActive
      bridge.setSession('sess_1', { phone: '+111' });

      const promise = bridge.callTool('query', {});
      expect(sendFn1).toHaveBeenCalledTimes(1);
      expect(sendFn2).not.toHaveBeenCalled();

      const sent = JSON.parse(sendFn1.mock.calls[0][0]);
      bridge.handleResponse(JSON.stringify({ jsonrpc: '2.0', id: sent.id, result: 'ok' }));
      await promise;
    });

    it('should fall back to remaining connection when active disconnects', async () => {
      const sendFn1 = jest.fn();
      const sendFn2 = jest.fn();
      bridge.setConnection('sess_1', sendFn1);
      bridge.setConnection('sess_2', sendFn2); // lastActive

      bridge.clearConnection('sess_2'); // falls back to sess_1

      const promise = bridge.callTool('query', {});
      expect(sendFn1).toHaveBeenCalledTimes(1);

      const sent = JSON.parse(sendFn1.mock.calls[0][0]);
      bridge.handleResponse(JSON.stringify({ jsonrpc: '2.0', id: sent.id, result: 'fallback' }));
      const result = await promise;
      expect(result.data).toBe('fallback');
    });

    it('should timeout after REQUEST_TIMEOUT_MS', async () => {
      jest.useFakeTimers();
      bridge.setConnection('sess_1', jest.fn());

      const promise = bridge.callTool('query', {});

      jest.advanceTimersByTime(30_001);

      await expect(promise).rejects.toThrow('Request timed out');

      jest.useRealTimers();
    });
  });

  describe('handleResponse', () => {
    it('should ignore invalid JSON', () => {
      bridge.handleResponse('not json');
    });

    it('should ignore responses without id', () => {
      bridge.handleResponse(JSON.stringify({ jsonrpc: '2.0', method: 'notification' }));
    });

    it('should warn on unknown request id', () => {
      const spy = jest.spyOn(console, 'warn').mockImplementation();
      bridge.handleResponse(JSON.stringify({ jsonrpc: '2.0', id: 'unknown', result: {} }));
      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining('unknown request'),
        'unknown'
      );
      spy.mockRestore();
    });
  });

  describe('replaceConnection', () => {
    it('should remove existing connection', () => {
      bridge.setConnection('sess_1', jest.fn());
      expect(bridge.connected).toBe(true);

      bridge.replaceConnection('sess_1');
      expect(bridge.connected).toBe(false);
    });

    it('should be a no-op for non-existent session', () => {
      bridge.replaceConnection('sess_nonexistent');
      expect(bridge.connected).toBe(false);
    });
  });
});
