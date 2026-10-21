// mcp.LOCAL_HUB.10 — a request names one account; the hub answers for that account or says it isn't
// connected. It never answers with another account's data.
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { Bridge, UnknownSessionError } from '../bridge';
import { createHttpServer } from '../httpServer';

const TOKEN = 'a'.repeat(64);

jest.mock('../auth', () => ({ validateToken: (given: string, expected: string) => given === expected }));

/** An extension that answers every call with which account it is. */
function connect(bridge: Bridge, sessionId: string, phone: string, sent: string[] = []): string[] {
  bridge.setConnection(sessionId, (data) => {
    const request = JSON.parse(data);
    sent.push(request.method);
    setImmediate(() => bridge.handleResponse(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { account: sessionId, params: request.params } })));
  });
  bridge.setSession(sessionId, { phone, pushname: phone, isBusiness: phone === '222', browser: 'Chrome' });
  return sent;
}

describe('Bridge account routing', () => {
  it('refuses an unknown account instead of answering from another one', async () => {
    const bridge = new Bridge();
    const sent = connect(bridge, 'sess_business', '222');
    await expect(bridge.callTool('query', {}, 'sess_personal')).rejects.toBeInstanceOf(UnknownSessionError);
    await expect(bridge.callTool('query', {}, 'sess_personal')).rejects.toThrow(/sess_personal is not connected.*sess_business/);
    expect(sent).toEqual([]);
  });

  it('tells relay clients when a handshake names an account and when one of several leaves', () => {
    const bridge = new Bridge();
    const events: string[] = [];
    bridge.on('session', (id) => events.push(`session:${id}`));
    bridge.on('connected', () => events.push('connected'));
    connect(bridge, 'sess_a', '111');
    connect(bridge, 'sess_b', '222');
    bridge.clearConnection('sess_a');
    expect(events).toEqual(['connected', 'session:sess_a', 'connected', 'session:sess_b', 'session:sess_a']);
  });
});

describe('HTTP API account routing', () => {
  let bridge: Bridge;
  let server: Server;
  let base: string;

  beforeEach(async () => {
    bridge = new Bridge();
    connect(bridge, 'sess_personal', '111');
    connect(bridge, 'sess_business', '222'); // the most recent account: the old default
    server = await createHttpServer(bridge, TOKEN, 0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const post = async (path: string, body: unknown) => {
    const res = await fetch(base + path, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() as any };
  };

  it('routes by target_session in the body', async () => {
    const { status, body } = await post('/tools/query', { limit: 3, target_session: 'sess_personal' });
    expect(status).toBe(200);
    expect(body.data.account).toBe('sess_personal');
    expect(body.data.params).toEqual({ limit: 3 });
    expect(body._warning).toBeUndefined();
  });

  it('still routes by ?session=', async () => {
    const { body } = await post('/tools/query?session=sess_personal', { limit: 3 });
    expect(body.data.account).toBe('sess_personal');
  });

  it('answers 404 UNKNOWN_SESSION for an account that is not connected', async () => {
    const { status, body } = await post('/tools/query', { target_session: 'sess_gone' });
    expect(status).toBe(404);
    expect(body).toMatchObject({ ok: false, code: 'UNKNOWN_SESSION', session: 'sess_gone' });
  });

  it('refuses a request whose query and body name different accounts', async () => {
    const { status } = await post('/tools/query?session=sess_personal', { target_session: 'sess_business' });
    expect(status).toBe(400);
  });

  it('warns when no account is named and several are connected', async () => {
    const { body } = await post('/tools/query', {});
    expect(body.data.account).toBe('sess_business');
    expect(body._warning).toMatch(/Multiple accounts/);
  });

  it('lists every account on GET /sessions and query entity=session', async () => {
    const res = await fetch(`${base}/sessions`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    const listed = (await res.json() as any).data.accounts.map((a: any) => a.sessionId).sort();
    expect(listed).toEqual(['sess_business', 'sess_personal']);
    const { body } = await post('/tools/query', { entity: 'session' });
    expect(body.data.accounts.map((a: any) => a.phone).sort()).toEqual(['111', '222']);
  });
});
