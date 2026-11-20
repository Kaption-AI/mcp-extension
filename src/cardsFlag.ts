/**
 * mcp-apps-cards.FLAG.1, FLAG.4 — is MCP_APPS_CARDS on for any connected account? The hub asks the flags worker for
 * each account's phone, like rest-api (GET /active, version 99.0.0). A failure, a timeout or an odd answer counts as
 * off; real answers are remembered for 5 minutes per phone.
 */
import { CARDS_FLAG } from './cards';

export const FLAGS_URL = process.env.KAPTION_FLAGS_URL || 'https://flags.kaptionai.com';
export const CARDS_FLAG_TTL_MS = 5 * 60_000;
const TIMEOUT_MS = 2_000;

type Fetch = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

/** A row of the flags worker's /active answer is on: remotely enabled (or enabled) and not remotely disabled. */
export function flagOn(payload: unknown, name: string): boolean {
  const list = payload && typeof payload === 'object' ? (payload as { flags?: unknown }).flags : undefined;
  if (!Array.isArray(list)) return false;
  const row = list.find((f) => f && typeof f === 'object' && (f as { name?: unknown }).name === name) as
    | { enabled?: unknown; remoteEnabled?: unknown; remoteDisabled?: unknown }
    | undefined;
  if (!row || row.remoteDisabled === true) return false;
  return row.remoteEnabled === true || row.enabled === true;
}

export class CardsFlag {
  private cache = new Map<string, { on: boolean; at: number }>();

  constructor(
    private readonly fetchImpl: Fetch = (url, init) => fetch(url, init as RequestInit),
    private readonly now: () => number = Date.now,
    private readonly baseUrl: string = FLAGS_URL,
  ) {}

  /** MCP_APPS_CARDS for one phone (digits); cached answers within the TTL. */
  async onFor(phone: string): Promise<boolean> {
    const digits = String(phone || '').replace(/\D/g, '');
    if (!digits) return false;
    const hit = this.cache.get(digits);
    if (hit && this.now() - hit.at < CARDS_FLAG_TTL_MS) return hit.on;
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/active?app=KAPTION&version=99.0.0&phone=${encodeURIComponent(digits)}`, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) return hit?.on ?? false;
      const on = flagOn(await res.json(), CARDS_FLAG);
      this.cache.set(digits, { on, at: this.now() });
      return on;
    } catch {
      return hit?.on ?? false;
    }
  }

  /**
   * mcp-apps-cards.FLAG.1 — on while any connected account has it on. KAPTION_CARDS_FLAG=off (the hub's tests, or a user
   * who wants text only) or =on (a local check with an MCP Apps host) answers without asking.
   */
  async anyOn(phones: string[]): Promise<boolean> {
    const forced = (process.env.KAPTION_CARDS_FLAG || '').trim().toLowerCase();
    if (forced === 'off') return false;
    if (forced === 'on') return true;
    const answers = await Promise.all(phones.map((p) => this.onFor(p)));
    return answers.some(Boolean);
  }
}
