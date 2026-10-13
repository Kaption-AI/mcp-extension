import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename, extname, isAbsolute } from 'node:path';

const MAX = 8 * 1024 * 1024;
const TYPES: Record<string, string> = {
  '.pdf':'application/pdf', '.txt':'text/plain', '.csv':'text/csv',
  '.doc':'application/msword', '.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls':'application/vnd.ms-excel', '.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt':'application/vnd.ms-powerpoint', '.pptx':'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.gif':'image/gif', '.webp':'image/webp',
  '.mp3':'audio/mpeg', '.m4a':'audio/mp4', '.ogg':'audio/ogg', '.wav':'audio/wav',
  '.mp4':'video/mp4', '.webm':'video/webm', '.mov':'video/quicktime',
};
function fail(message: string): never { throw new Error(`attachment: ${message}`); }

/** mcp-local-send.REFERENCES.2 — only the local process reads paths, never the relay/extension. */
export async function resolveLocalAttachment(method: string, params: Record<string, unknown>, createSlot: (metadata: Record<string, unknown>) => Promise<unknown>, fetcher: typeof fetch = fetch): Promise<Record<string, unknown>> {
  if (!['send_message', 'manage_scheduled_messages'].includes(method) || params.attachment == null) return params;
  const a = params.attachment as Record<string, unknown>;
  if (typeof a !== 'object' || Array.isArray(a)) fail('must be an object');
  if (['dataB64', 'ref', 'path'].filter(k => Object.prototype.hasOwnProperty.call(a, k)).length !== 1) fail('provide exactly one of dataB64, ref, or path');
  if (!Object.prototype.hasOwnProperty.call(a, 'path')) return params;
  if (method === 'manage_scheduled_messages' && (params.mode !== 'local' || !['create','update'].includes(String(params.action)))) fail('paths require local create/update');
  if (Object.keys(a).some(k => !['path','name','mime'].includes(k))) fail('unsupported path attachment field');
  if (typeof a.path !== 'string' || !isAbsolute(a.path) || a.path.includes('\0')) fail('path must be absolute');
  const name = a.name ?? basename(a.path);
  if (typeof name !== 'string' || !name.trim() || name.length > 200 || /[\\/\x00-\x1f\x7f]/.test(name)) fail('name must be a filename');
  // Open once, then fstat/read the same descriptor. NONBLOCK avoids hanging on FIFOs.
  let file;
  try { file = await open(a.path, constants.O_RDONLY | constants.O_NONBLOCK); } catch { return fail('could not open local file'); }
  try {
    const stat = await file.stat();
    if (!stat.isFile()) fail('path must name a regular file');
    if (stat.size < 1 || stat.size > MAX) fail('file must contain 1 to 8388608 bytes');
    const bytes = Buffer.alloc(MAX + 1);
    let size = 0;
    while (size <= MAX) {
      const read = await file.read(bytes, size, bytes.length - size, null);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    if (!size || size > MAX) fail('file must contain 1 to 8388608 bytes');
    const mime = a.mime ?? TYPES[extname(a.path).toLowerCase()];
    if (typeof mime !== 'string' || !mime || mime.length > 200) fail('unknown MIME type; provide mime');
    const slot = await createSlot({name, mime, size}) as {uploadUrl?:unknown; attachmentRef?:unknown};
    if (!slot || typeof slot.uploadUrl !== 'string' || typeof slot.attachmentRef !== 'string' || !/^[a-f0-9]{64}$/.test(slot.attachmentRef)) fail('invalid upload slot response');
    const url = new URL(slot.uploadUrl);
    if (url.origin !== 'https://schedule.kaptionai.com' || url.pathname !== `/attachments/${slot.attachmentRef}` || url.username || url.password || !/^[a-f0-9]{64}$/.test(url.searchParams.get('token') ?? '')) fail('invalid upload destination');
    const response = await fetcher(url.href, {method:'PUT', body:bytes.subarray(0,size), redirect:'error', credentials:'omit', signal:AbortSignal.timeout(30_000)});
    if (!response.ok) fail('upload failed; create a new upload');
    return { ...params, attachment: { ref: slot.attachmentRef } };
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('attachment:')) throw e;
    return fail('could not read local file');
  } finally { await file.close(); }
}
