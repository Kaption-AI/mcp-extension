/**
 * mcp-credits-simple.HUB.1-3 (kaptionai features/mcp/mcp-credits-simple.feature.yaml) — allow_extra_actions on the local
 * hub, kept in step with the cloud relay's src/credits-tool.ts (kaption-mcp-remote): the person said yes once to extra
 * Claude and ChatGPT actions. Listed only while a connected extension said features.credits_simple (MCP_CREDITS_SIMPLE
 * on for that account). The hub holds no Kaption credentials, so the call goes to that account's extension, which asks
 * rest-api (the same decision as the relay's /__internal/mcp-ledger/allow-extra); the hub passes its words back.
 */
import { z } from 'zod';
import type { ManageFeatures } from './manageKaption';

export const ALLOW_EXTRA_TOOL = 'allow_extra_actions';

export const ALLOW_EXTRA_DEFINITION = {
  title: 'Allow extra actions',
  description:
    "Call this only after the user agreed, in this conversation, to keep using Kaption past their plan's included Claude and ChatGPT actions. " +
    'It turns extra actions on, up to the user\'s monthly limit, and Kaption will not ask again. Never call it without the user\'s yes.',
  inputSchema: z.object({}).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

/** HUB.1 — listed while SOME connected account said credits_simple is true (unknown or missing hides it). */
export function creditsToolVisible(accounts: Array<ManageFeatures | null | undefined>): boolean {
  return accounts.some(a => a?.credits_simple === true);
}

const FAILED = "Kaption could not turn extra actions on right now. Ask the user to try again in a moment, or set a monthly limit in Kaption (AI Connectors → Usage).";

/** HUB.2 — the extension's answer ({ok, message}) as the tool result; anything else is the failure words. */
export function creditsAnswer(data: unknown): { text: string; isError: boolean } {
  let v: unknown = data;
  if (typeof v === 'string') {
    try { v = JSON.parse(v); } catch { /* plain text */ }
  }
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const content = (v as { content?: unknown }).content;
    if (Array.isArray(content)) {
      const text = content.find((c: any) => c?.type === 'text')?.text;
      if (typeof text === 'string') return creditsAnswer(text);
    }
    const o = v as { ok?: unknown; message?: unknown };
    if (typeof o.message === 'string' && o.message.trim()) return { text: o.message.slice(0, 2000), isError: o.ok !== true };
  }
  return { text: FAILED, isError: true };
}
