import type { ForwardPayload, WsFrame } from './types';

export const DEFAULT_WS_URL = 'https://openws.work.weixin.qq.com';
export const HEARTBEAT_MS = 30_000;
export const STREAM_TTL_MS = 9 * 60 * 1000;
export const STREAM_WARN_MS = Math.max(30_000, STREAM_TTL_MS - 60_000);
export const WATCHDOG_STALE_MS = Math.max(90_000, HEARTBEAT_MS * 3);
export const CHUNK_SIZE = 512 * 1024; // 512KB before base64

export function generateReqId(prefix = 'req'): string {
  const rand = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  return `${prefix}_${Date.now()}_${rand}`;
}

export function frameSubscribe(botId: string, secret: string): WsFrame {
  return {
    cmd: 'aibot_subscribe',
    headers: { req_id: generateReqId('aibot_subscribe') },
    body: { bot_id: botId, secret },
  };
}

export function framePing(): WsFrame {
  return {
    cmd: 'ping',
    headers: { req_id: generateReqId('ping') },
  };
}

export function frameRespondStream(
  callbackReqId: string,
  streamId: string,
  content: string,
  finish: boolean,
): WsFrame {
  return {
    cmd: 'aibot_respond_msg',
    headers: { req_id: callbackReqId },
    body: {
      msgtype: 'stream',
      stream: { id: streamId, finish, content },
    },
  };
}

export function frameRespondWelcome(callbackReqId: string, content: string): WsFrame {
  return {
    cmd: 'aibot_respond_welcome_msg',
    headers: { req_id: callbackReqId },
    body: {
      msgtype: 'text',
      text: { content },
    },
  };
}

export function frameSendMarkdown(
  chatid: string,
  content: string,
  chatType?: number,
): WsFrame {
  const body: Record<string, unknown> = {
    chatid,
    msgtype: 'markdown',
    markdown: { content },
  };
  if (chatType != null) body.chat_type = chatType;
  return {
    cmd: 'aibot_send_msg',
    headers: { req_id: generateReqId('aibot_send_msg') },
    body,
  };
}

export function frameSendMedia(
  chatid: string,
  mediaType: string,
  mediaId: string,
  chatType?: number,
): WsFrame {
  const body: Record<string, unknown> = {
    chatid,
    msgtype: mediaType,
    [mediaType]: { media_id: mediaId },
  };
  if (chatType != null) body.chat_type = chatType;
  return {
    cmd: 'aibot_send_msg',
    headers: { req_id: generateReqId('aibot_send_msg') },
    body,
  };
}

export function frameUploadInit(opts: {
  type: string;
  filename: string;
  totalSize: number;
  totalChunks: number;
}): WsFrame {
  return {
    cmd: 'aibot_upload_media_init',
    headers: { req_id: generateReqId('aibot_upload_media_init') },
    body: {
      type: opts.type,
      filename: opts.filename,
      total_size: opts.totalSize,
      total_chunks: opts.totalChunks,
      // md5 optional; Workers SubtleCrypto has no MD5 — omitted
    },
  };
}

export function frameUploadChunk(
  uploadId: string,
  chunkIndex: number,
  base64Data: string,
): WsFrame {
  return {
    cmd: 'aibot_upload_media_chunk',
    headers: { req_id: generateReqId('aibot_upload_media_chunk') },
    body: {
      upload_id: uploadId,
      chunk_index: chunkIndex,
      base64_data: base64Data,
    },
  };
}

export function frameUploadFinish(uploadId: string): WsFrame {
  return {
    cmd: 'aibot_upload_media_finish',
    headers: { req_id: generateReqId('aibot_upload_media_finish') },
    body: { upload_id: uploadId },
  };
}

export function extractText(b: Record<string, unknown>): string {
  const parts: string[] = [];
  const msgtype = String(b.msgtype || '');
  switch (msgtype) {
    case 'text':
      parts.push(String((b.text as { content?: string } | undefined)?.content ?? ''));
      break;
    case 'voice':
      parts.push(String((b.voice as { content?: string } | undefined)?.content ?? ''));
      break;
    case 'image':
      parts.push('[图片]');
      break;
    case 'file':
      parts.push('[文件]');
      break;
    case 'video':
      parts.push('[视频]');
      break;
    case 'mixed': {
      const items =
        ((b.mixed as { msg_item?: Array<{ msgtype?: string; text?: { content?: string } }> })
          ?.msg_item) || [];
      for (const it of items) {
        parts.push(it.msgtype === 'text' ? String(it.text?.content ?? '') : '[图片]');
      }
      break;
    }
    default:
      parts.push(`[${msgtype || 'unknown'}]`);
  }
  let text = parts.join(' ').trim();
  const q = b.quote as
    | {
        text?: { content?: string };
        voice?: { content?: string };
        mixed?: { msg_item?: Array<{ text?: { content?: string } }> };
        image?: unknown;
        file?: unknown;
      }
    | undefined;
  if (q) {
    const qt =
      q.text?.content ||
      q.voice?.content ||
      (q.mixed?.msg_item || []).map((i) => i.text?.content || '[图片]').join(' ') ||
      (q.image ? '[图片]' : q.file ? '[文件]' : '');
    if (qt) text += `\n\n(引用: ${qt})`;
  }
  return text;
}

export function buildForwardPayload(frame: WsFrame): ForwardPayload | null {
  const b = frame.body || {};
  const msgid = String(b.msgid || '');
  if (!msgid) return null;
  const chattype = (b.chattype as string | undefined) || null;
  const from = b.from as { userid?: string } | undefined;
  const chatid =
    (b.chatid as string | undefined) ||
    (chattype === 'single' ? from?.userid : null) ||
    null;
  const createTime = b.create_time ? Number(b.create_time) * 1000 : Date.now();
  return {
    msgid,
    req_id: frame.headers?.req_id,
    chatid,
    chattype,
    from_userid: from?.userid || null,
    text: extractText(b),
    timestamp: new Date(createTime).toISOString(),
    msgtype: b.msgtype as string | undefined,
  };
}

export function classifyFrame(frame: WsFrame): string {
  const cmd = frame.cmd || '';
  const reqId = String(frame.headers?.req_id || '');
  if (cmd === 'aibot_msg_callback') return 'msg_callback';
  if (cmd === 'aibot_event_callback') {
    const ev = (frame.body?.event as { eventtype?: string } | undefined)?.eventtype;
    return `event:${ev || 'unknown'}`;
  }
  if (cmd === 'ping') return 'ping';
  if (cmd === 'aibot_subscribe') return 'subscribe';
  if (!cmd && reqId.startsWith('ping')) return 'pong';
  if (!cmd && reqId.startsWith('aibot_subscribe')) return 'subscribe_ack';
  if (!cmd && reqId) return 'ack_other';
  if (cmd) return `cmd:${cmd}`;
  return 'unknown';
}

export function forwardAuthValue(key: string): string {
  if (!key) return '';
  if (!/^(bearer|basic)\s/i.test(key)) return `Bearer ${key}`;
  return key;
}

/** Bytes → base64 (Workers-safe). */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
