import { RelayBridge } from '../relayBridge';

// We test RelayBridge in isolation by mocking WebSocket
jest.mock('ws', () => {
  const EventEmitter = require('events');
  class MockWebSocket extends EventEmitter {
    static OPEN = 1;
    readyState = 1; // OPEN
    sentMessages: string[] = [];
    send(data: string) {
      this.sentMessages.push(data);
    }
    close() {
      this.readyState = 3;
      this.emit('close');
    }
  }
  return { __esModule: true, default: MockWebSocket };
});

// Also need to mock the imports used by relayBridge for promotion
jest.mock('../bridge', () => {
  const EventEmitter = require('events');
  class MockBridge extends EventEmitter {
    _connected = false;
    _session = null;
    connections = new Map();
    get connected() { return this._connected; }
    get session() { return this._session; }
    get sessions() { return new Map(); }
    setConnection() { this._connected = true; }
    clearConnection() { this._connected = false; }
    replaceConnection() {}
    setSession(id: string, s: any) { this._session = s; }
    async callTool() { return {}; }
    handleResponse() {}
  }
  return {
    Bridge: MockBridge,
    __esModule: true,
  };
});

jest.mock('../wsServer', () => ({
  createWebSocketServer: jest.fn().mockResolvedValue({}),
}));

jest.mock('../auth', () => ({
  loadOrCreateToken: jest.fn().mockResolvedValue('test-token-abc'),
  SessionManager: jest.fn().mockImplementation(() => ({
    cleanExpired: jest.fn().mockResolvedValue(0),
  })),
}));

describe('RelayBridge', () => {
  let relay: RelayBridge;
  let mockWs: any;

  beforeEach(async () => {
    relay = new RelayBridge();

    // Start connect with auth token
    const connectPromise = relay.connect('ws://127.0.0.1:7865', 'test-auth-token');

    // Get the mock WS
    mockWs = (relay as any).ws;

    // Simulate connection open
    mockWs.emit('open');

    // The relay sends relay_connect with auth_token on open
    expect(mockWs.sentMessages).toHaveLength(1);
    const sent = JSON.parse(mockWs.sentMessages[0]);
    expect(sent.method).toBe('relay_connect');
    expect(sent.params.auth_token).toBe('test-auth-token');

    // Simulate hub ack with extensions array
    mockWs.emit('message', JSON.stringify({
      method: 'relay_ack',
      params: {
        extensionConnected: true,
        extensions: [
          { sessionId: 'sess_1', phone: '123', pushname: 'Test', connected: true },
        ],
      },
    }));

    await connectPromise;
  });

  it('should be connected after relay_ack', () => {
    expect(relay.connected).toBe(true);
  });

  it('should capture session from first extension in relay_ack', () => {
    expect(relay.session).toEqual({ phone: '123', pushname: 'Test' });
  });

  it('should track extensions from relay_ack', () => {
    expect(relay.extensions).toHaveLength(1);
    expect(relay.extensions[0].sessionId).toBe('sess_1');
  });

  it('should update extensions on extension_status', () => {
    mockWs.emit('message', JSON.stringify({
      method: 'extension_status',
      params: {
        connected: true,
        extensions: [
          { sessionId: 'sess_1', phone: '123', pushname: 'Test', connected: true },
          { sessionId: 'sess_2', phone: '456', pushname: 'New', connected: true },
        ],
      },
    }));
    expect(relay.extensions).toHaveLength(2);
  });

  it('should update connected state on extension_status', () => {
    mockWs.emit('message', JSON.stringify({
      method: 'extension_status',
      params: { connected: false, extensions: [] },
    }));
    expect(relay.connected).toBe(false);
    expect(relay.session).toBeNull();
  });

  it('should send tool calls as JSON-RPC', async () => {
    const promise = relay.callTool('query', { limit: 5 });

    // Verify sent message (index 1, since index 0 is relay_connect)
    expect(mockWs.sentMessages).toHaveLength(2);
    const sent = JSON.parse(mockWs.sentMessages[1]);
    expect(sent.jsonrpc).toBe('2.0');
    expect(sent.method).toBe('query');
    expect(sent.params).toEqual({ limit: 5 });
    expect(sent.id).toMatch(/^relay_\d+$/);

    // Simulate response
    mockWs.emit('message', JSON.stringify({
      jsonrpc: '2.0',
      id: sent.id,
      result: { conversations: [] },
    }));

    const result = await promise;
    expect(result).toEqual({ conversations: [] });
  });

  it('should reject on error response', async () => {
    const promise = relay.callTool('query', {});
    const sent = JSON.parse(mockWs.sentMessages[1]);

    mockWs.emit('message', JSON.stringify({
      jsonrpc: '2.0',
      id: sent.id,
      error: { code: -32603, message: 'Extension not connected' },
    }));

    await expect(promise).rejects.toThrow('Extension not connected');
  });

  it('should reject pending requests on close', async () => {
    const promise = relay.callTool('query', {});
    mockWs.emit('close');
    await expect(promise).rejects.toThrow('Hub disconnected');
  });

  it('should timeout on no response', async () => {
    jest.useFakeTimers();

    const promise = relay.callTool('query', {});
    jest.advanceTimersByTime(30_001);

    await expect(promise).rejects.toThrow('Request timed out');
    jest.useRealTimers();
  });

  it('should handle concurrent requests', async () => {
    const p1 = relay.callTool('query', { limit: 1 });
    const p2 = relay.callTool('manage_labels', { action: 'list' });

    const sent1 = JSON.parse(mockWs.sentMessages[1]);
    const sent2 = JSON.parse(mockWs.sentMessages[2]);

    // Respond out of order
    mockWs.emit('message', JSON.stringify({ jsonrpc: '2.0', id: sent2.id, result: 'labels' }));
    mockWs.emit('message', JSON.stringify({ jsonrpc: '2.0', id: sent1.id, result: 'convos' }));

    expect(await p1).toBe('convos');
    expect(await p2).toBe('labels');
  });

  it('should ignore unknown response IDs', () => {
    mockWs.emit('message', JSON.stringify({ jsonrpc: '2.0', id: 'unknown_123', result: {} }));
  });

  it('should ignore malformed JSON', () => {
    mockWs.emit('message', 'not json');
  });

  it('should become disconnected on WS close', () => {
    mockWs.emit('close');
    expect(relay.connected).toBe(false);
  });

  it('should attempt promotion to hub on disconnect', () => {
    const { createWebSocketServer } = require('../wsServer');
    mockWs.emit('close');
    expect(createWebSocketServer).toHaveBeenCalled();
  });
});
