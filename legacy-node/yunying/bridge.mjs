#!/usr/bin/env node
/**
 * WeCom (企业微信) smart robot long-connection bridge.
 *
 * Protocol (official): https://developer.work.weixin.qq.com/document/path/101463
 * SDK: @wecom/aibot-node-sdk (WecomTeam)
 *
 * Env:
 *   WECOM_BOT_ID, WECOM_BOT_SECRET  (required to connect)
 *   WECOM_FORWARD_URL             (optional HTTP forward of inbound msgs)
 *   WECOM_FORWARD_KEY             (optional; Authorization defaults to Bearer <key>)
 *   WECOM_FORWARD_KEY_HEADER      (header name, default Authorization)
 *   WECOM_HTTP_HOST / WECOM_HTTP_PORT  (default 127.0.0.1:8787)
 *   WECOM_WS_URL                  (override, for mock tests; default SDK wss://openws.work.weixin.qq.com)
 *   WECOM_CONNECT                 (set "0"/"false" to skip WS connect — HTTP-only mode for unit tests)
 *   WECOM_PLACEHOLDER             (placeholder stream text)
 *   WECOM_STREAM_TTL_MS           (stream reply window; protocol max 10min; default 540000 = 9min)
 *   WECOM_HEARTBEAT_MS            (SDK heartbeat interval; default 30000)
 *   WECOM_WATCHDOG_STALE_MS       (no-frame watchdog; default max(90000, 3*heartbeat))
 *   WECOM_WATCHDOG_CHECK_MS       (watchdog poll; default 15000)
 */
import AiBot, { generateReqId } from '@wecom/aibot-node-sdk';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const LOG = path.join(DIR, 'bridge.log');
const INBOX = path.join(DIR, 'inbox.jsonl');

const BOT_ID = (process.env.WECOM_BOT_ID || '').trim();
const SECRET = process.env.WECOM_BOT_SECRET || '';
const FORWARD_URL = (process.env.WECOM_FORWARD_URL || '').trim();
const FORWARD_KEY = process.env.WECOM_FORWARD_KEY || '';
const FORWARD_KEY_HEADER = (process.env.WECOM_FORWARD_KEY_HEADER || 'Authorization').trim();
/** Default: Authorization: Bearer <key>. If key already has a scheme (Bearer/Basic), use as-is. */
function forwardAuthValue() {
  if (!FORWARD_KEY) return '';
  if (FORWARD_KEY_HEADER.toLowerCase() === 'authorization' && !/^(bearer|basic)\s/i.test(FORWARD_KEY)) {
    return `Bearer ${FORWARD_KEY}`;
  }
  return FORWARD_KEY;
}
const HTTP_HOST = process.env.WECOM_HTTP_HOST || '127.0.0.1';
const HTTP_PORT = Number(process.env.WECOM_HTTP_PORT || 8787);
const WS_URL = (process.env.WECOM_WS_URL || '').trim();
const DO_CONNECT = !['0', 'false', 'no'].includes(String(process.env.WECOM_CONNECT || '1').toLowerCase());
const PLACEHOLDER = process.env.WECOM_PLACEHOLDER || '收到，正在处理…';
// Protocol: finish stream within 10 minutes from first stream segment. Finish early with a note.
const STREAM_TTL_MS = Number(process.env.WECOM_STREAM_TTL_MS || 9 * 60 * 1000);
const STREAM_WARN_MS = Math.max(30_000, STREAM_TTL_MS - 60_000);
const HEARTBEAT_MS = Number(process.env.WECOM_HEARTBEAT_MS || 30_000);
const WATCHDOG_STALE_MS = Number(
  process.env.WECOM_WATCHDOG_STALE_MS || Math.max(90_000, HEARTBEAT_MS * 3),
);
const WATCHDOG_CHECK_MS = Number(process.env.WECOM_WATCHDOG_CHECK_MS || 15_000);
// After a kick / stale, exit so start.sh supervisor relaunches a clean process.
const EXIT_ON_HARD_RESTART = !['0', 'false', 'no'].includes(
  String(process.env.WECOM_EXIT_ON_HARD_RESTART || '1').toLowerCase(),
);

const SECRET_VALUES = [SECRET, FORWARD_KEY, FORWARD_KEY ? `Bearer ${FORWARD_KEY}` : ''].filter(Boolean);

function redact(s) {
  let out = String(s);
  for (const v of SECRET_VALUES) {
    if (v && v.length >= 4) out = out.split(v).join('***');
  }
  // Extra safety: scrub common secret JSON keys if somehow present
  out = out.replace(/("secret"\s*:\s*")[^"]*(")/gi, '$1***$2');
  return out;
}

function log(level, msg, extra) {
  let line = `${new Date().toISOString()} [${level}] ${msg}`;
  if (extra !== undefined) {
    try {
      line += ' ' + (typeof extra === 'string' ? extra : JSON.stringify(extra));
    } catch {
      /* ignore */
    }
  }
  fs.appendFileSync(LOG, redact(line) + '\n');
}

const logger = {
  debug: () => {},
  info: (m, ...a) => log('sdk', m, a.length ? a : undefined),
  warn: (m, ...a) => log('sdk-warn', m, a.length ? a : undefined),
  error: (m, ...a) => log('sdk-error', m, a.length ? a : undefined),
};

// ---- dedupe ----
const seen = new Set();
const seenOrder = [];
function remember(id) {
  if (!id) return;
  seen.add(id);
  seenOrder.push(id);
  if (seenOrder.length > 5000) seen.delete(seenOrder.shift());
}
try {
  const lines = fs.readFileSync(INBOX, 'utf8').trim().split('\n').slice(-1000);
  for (const l of lines) {
    try {
      const j = JSON.parse(l);
      if (j.msgid) remember(j.msgid);
    } catch {
      /* ignore */
    }
  }
} catch {
  /* no inbox yet */
}

/**
 * Pending stream contexts keyed by callback req_id.
 * Holds frame headers + stream.id + chat info until finish=true or TTL.
 */
const pending = new Map();

function clearPending(reqId, reason) {
  const p = pending.get(reqId);
  if (!p) return;
  if (p.warnTimer) clearTimeout(p.warnTimer);
  if (p.ttlTimer) clearTimeout(p.ttlTimer);
  pending.delete(reqId);
  log('info', 'pending cleared', { req_id: reqId, reason });
}

function schedulePendingTimers(reqId) {
  const p = pending.get(reqId);
  if (!p) return;
  if (p.warnTimer) clearTimeout(p.warnTimer);
  if (p.ttlTimer) clearTimeout(p.ttlTimer);

  p.warnTimer = setTimeout(() => {
    const cur = pending.get(reqId);
    if (!cur || cur.finished) return;
    log('warn', 'stream near TTL, will auto-finish soon', { req_id: reqId });
  }, STREAM_WARN_MS);

  p.ttlTimer = setTimeout(async () => {
    const cur = pending.get(reqId);
    if (!cur || cur.finished) return;
    log('warn', 'stream TTL reached, auto-finishing', { req_id: reqId });
    try {
      const note =
        (cur.lastContent || PLACEHOLDER) +
        '\n\n_(回复超时，流式消息已结束；后续答案将通过主动推送发送)_';
      await client.replyStream(cur.frame, cur.streamId, note, true);
      cur.finished = true;
      cur.fallbackToSend = true;
      // Keep chatid for later /send fallback association briefly, then clear
      clearPending(reqId, 'ttl-auto-finish');
    } catch (e) {
      log('error', 'ttl auto-finish failed', e?.message || String(e));
      clearPending(reqId, 'ttl-error');
    }
  }, STREAM_TTL_MS);
}

const state = {
  authenticated: false,
  connected: false,
  lastAuthAt: null,
  lastAuthAtMs: 0,
  lastAuthResponse: null,
  lastDisconnect: null,
  lastKickAt: null,
  lastFrameAt: null,
  lastFrameAtMs: 0,
  lastFrameKind: null,
  lastPongAt: null,
  lastPongAtMs: 0,
  lastInboundAt: null,
  lastInboundAtMs: 0,
  reconnectAttempts: 0,
  reconnectTotal: 0,
  hardRestartCount: 0,
  started: new Date().toISOString(),
  inbound: 0,
  forwardOk: 0,
  forwardFail: 0,
  subscribeSkipped: !DO_CONNECT,
  frames: 0,
};

let exiting = false;
function requestHardRestart(reason) {
  if (exiting) return;
  exiting = true;
  state.hardRestartCount++;
  log('error', 'hard restart', {
    reason,
    exit: EXIT_ON_HARD_RESTART,
    lastFrameAt: state.lastFrameAt,
    lastPongAt: state.lastPongAt,
    lastInboundAt: state.lastInboundAt,
    reconnectTotal: state.reconnectTotal,
  });
  try {
    client.disconnect();
  } catch {
    /* ignore */
  }
  if (EXIT_ON_HARD_RESTART) {
    // Supervisor (start.sh) will relaunch within ~5s.
    setTimeout(() => process.exit(3), 250);
  } else {
    // Best-effort in-process reconnect (SDK connect() after disconnect).
    setTimeout(() => {
      exiting = false;
      try {
        client.connect();
      } catch (e) {
        log('error', 'in-process reconnect failed', e?.message || String(e));
        process.exit(3);
      }
    }, 1000);
  }
}

/**
 * Classify + record every WS frame the SDK parses (including ping ack / subscribe ack).
 * Never logs message body / secret fields.
 */
function observeFrame(frame) {
  const now = Date.now();
  const cmd = frame?.cmd || '';
  const reqId = String(frame?.headers?.req_id || '');
  let kind = 'unknown';
  if (cmd === 'aibot_msg_callback') kind = 'msg_callback';
  else if (cmd === 'aibot_event_callback') {
    kind = `event:${frame?.body?.event?.eventtype || 'unknown'}`;
  } else if (cmd === 'ping') kind = 'ping';
  else if (cmd === 'aibot_subscribe') kind = 'subscribe';
  else if (!cmd && reqId.startsWith('ping')) kind = 'pong';
  else if (!cmd && reqId.startsWith('aibot_subscribe')) kind = 'subscribe_ack';
  else if (!cmd && reqId) kind = 'ack_other';
  else if (cmd) kind = `cmd:${cmd}`;

  state.frames++;
  state.lastFrameAt = new Date(now).toISOString();
  state.lastFrameAtMs = now;
  state.lastFrameKind = kind;
  if (kind === 'pong') {
    state.lastPongAt = state.lastFrameAt;
    state.lastPongAtMs = now;
  }

  // Rate-limit noisy pong logs: log every pong at debug-equivalent "frame" level but keep short.
  // Heartbeats every 30s — acceptable volume (~2880 lines/day).
  log('frame', kind, {
    errcode: frame?.errcode,
    req_prefix: reqId ? reqId.slice(0, 20) : null,
  });
}

if (DO_CONNECT && (!BOT_ID || !SECRET)) {
  console.error('missing WECOM_BOT_ID or WECOM_BOT_SECRET (never log secret values)');
  process.exit(1);
}

const clientOpts = {
  botId: BOT_ID || 'test-bot-id',
  secret: SECRET || 'test-bot-secret',
  maxReconnectAttempts: -1,
  reconnectInterval: 1000,
  heartbeatInterval: HEARTBEAT_MS,
  logger,
};
if (WS_URL) clientOpts.wsUrl = WS_URL;

const client = new AiBot.WSClient(clientOpts);

// Instrument SDK frame handler so heartbeats (pong) and subscribe acks are visible.
try {
  const mgr = client.wsManager;
  if (mgr && typeof mgr.handleFrame === 'function') {
    const origHandleFrame = mgr.handleFrame.bind(mgr);
    mgr.handleFrame = (frame) => {
      try {
        observeFrame(frame);
      } catch (e) {
        log('error', 'observeFrame failed', e?.message || String(e));
      }
      return origHandleFrame(frame);
    };
    log('info', 'frame observer attached');
  } else {
    log('warn', 'wsManager.handleFrame not found — frame observer skipped');
  }
} catch (e) {
  log('warn', 'failed to attach frame observer', e?.message || String(e));
}

client.on('connected', () => {
  state.connected = true;
  log('info', 'ws connected', WS_URL ? { wsUrl: WS_URL } : undefined);
});
client.on('authenticated', () => {
  state.authenticated = true;
  state.lastAuthAt = new Date().toISOString();
  state.lastAuthAtMs = Date.now();
  state.lastAuthResponse = { errcode: 0, errmsg: 'ok' };
  state.reconnectAttempts = 0;
  // Treat auth as a live frame so watchdog doesn't fire before first pong.
  if (!state.lastFrameAtMs || state.lastFrameAtMs < state.lastAuthAtMs) {
    state.lastFrameAt = state.lastAuthAt;
    state.lastFrameAtMs = state.lastAuthAtMs;
    state.lastFrameKind = 'authenticated';
  }
  log('info', 'authenticated (aibot_subscribe ok)', { errcode: 0, errmsg: 'ok' });
});
client.on('disconnected', (r) => {
  state.connected = false;
  state.authenticated = false;
  state.lastDisconnect = { at: new Date().toISOString(), reason: String(r) };
  log('warn', 'disconnected', String(r));
});
client.on('reconnecting', (n) => {
  state.reconnectAttempts = n;
  state.reconnectTotal++;
  log('warn', 'reconnecting', { attempt: n, total: state.reconnectTotal });
});
client.on('error', (e) => log('error', 'client error', e?.message || String(e)));
client.on('event.disconnected_event', () => {
  // SDK sets isManualClose=true and WILL NOT auto-reconnect after a kick.
  // Exit so start.sh supervisor brings up a fresh process that can re-subscribe.
  state.lastKickAt = new Date().toISOString();
  log('warn', 'server disconnected_event (kicked by new subscribe)');
  requestHardRestart('disconnected_event');
});

function extractText(b) {
  const parts = [];
  switch (b.msgtype) {
    case 'text':
      parts.push(b.text?.content ?? '');
      break;
    case 'voice':
      parts.push(b.voice?.content ?? '');
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
    case 'mixed':
      for (const it of b.mixed?.msg_item || []) {
        parts.push(it.msgtype === 'text' ? (it.text?.content ?? '') : '[图片]');
      }
      break;
    default:
      parts.push(`[${b.msgtype || 'unknown'}]`);
  }
  let text = parts.join(' ').trim();
  const q = b.quote;
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

async function forwardMessage(payload) {
  if (!FORWARD_URL) {
    log('info', 'forward skipped (WECOM_FORWARD_URL unset)', { msgid: payload.msgid, req_id: payload.req_id });
    return null;
  }
  const headers = { 'content-type': 'application/json' };
  const authVal = forwardAuthValue();
  if (authVal) headers[FORWARD_KEY_HEADER] = authVal;

  let lastErr;
  for (let i = 1; i <= 3; i++) {
    try {
      const r = await fetch(FORWARD_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15000),
      });
      if (r.status >= 200 && r.status < 300) {
        state.forwardOk++;
        log('info', 'forward ok', { status: r.status, msgid: payload.msgid });
        return r.status;
      }
      lastErr = `status ${r.status}`;
      if (r.status < 500 && r.status !== 429) break;
    } catch (e) {
      lastErr = e?.message || String(e);
    }
    await new Promise((res) => setTimeout(res, 1000 * i));
  }
  state.forwardFail++;
  log('error', 'forward failed', { msgid: payload.msgid, err: lastErr });
  return null;
}

async function onMessage(frame) {
  const b = frame.body || {};
  const reqId = frame.headers?.req_id;
  if (!b.msgid || seen.has(b.msgid)) {
    log('info', 'dup/empty msg skipped', { msgid: b.msgid });
    return;
  }
  remember(b.msgid);
  state.inbound++;
  state.lastInboundAt = new Date().toISOString();
  state.lastInboundAtMs = Date.now();

  const text = extractText(b);
  const ts = b.create_time ? Number(b.create_time) * 1000 : Date.now();
  const rec = {
    msgid: b.msgid,
    req_id: reqId,
    chatid: b.chatid || (b.chattype === 'single' ? b.from?.userid : null) || null,
    chattype: b.chattype || null,
    from_userid: b.from?.userid || null,
    text,
    timestamp: new Date(ts).toISOString(),
    msgtype: b.msgtype,
  };

  fs.appendFile(INBOX, JSON.stringify({ ...rec, received_at: new Date().toISOString() }) + '\n', () => {});
  log('info', 'inbound', {
    msgid: rec.msgid,
    req_id: rec.req_id,
    chattype: rec.chattype,
    msgtype: rec.msgtype,
    from: rec.from_userid,
    len: text.length,
  });

  // Open a streaming reply immediately (finish=false) so the user sees a placeholder.
  const streamId = generateReqId('stream');
  pending.set(reqId, {
    frame: { headers: { req_id: reqId } },
    streamId,
    chatid: rec.chatid,
    chattype: rec.chattype,
    from_userid: rec.from_userid,
    startedAt: Date.now(),
    finished: false,
    lastContent: PLACEHOLDER,
    fallbackToSend: false,
  });
  schedulePendingTimers(reqId);

  try {
    await client.replyStream(frame, streamId, PLACEHOLDER, false);
    log('info', 'placeholder sent', { req_id: reqId, stream_id: streamId });
  } catch (e) {
    log('error', 'placeholder reply failed', e?.message || String(e));
  }

  await forwardMessage(rec);
}

client.on('message', (f) => {
  onMessage(f).catch((e) => log('error', 'onMessage', e?.message || String(e)));
});

client.on('event.enter_chat', async (frame) => {
  log('info', 'enter_chat', { from: frame.body?.from?.userid });
  try {
    await client.replyWelcome(frame, {
      msgtype: 'text',
      text: { content: '你好，我是智能助手，有什么可以帮你？' },
    });
  } catch (e) {
    log('error', 'welcome failed', e?.message || String(e));
  }
});

// ---- app-level watchdog ----
// SDK already treats 2 missed pongs as dead and reconnects. Gaps remain:
// 1) disconnected_event → SDK stops reconnecting (isManualClose); we must exit.
// 2) Half-open via egress tunnel where socket stays OPEN but no frames arrive —
//    if SDK heartbeat somehow stalls, we still force a clean process restart.
if (DO_CONNECT) {
  setInterval(() => {
    if (exiting) return;
    const now = Date.now();

    // Stuck disconnected (e.g. kick path didn't exit, or reconnect exhausted)
    if (!state.authenticated && !client.isConnected) {
      const since = state.lastDisconnect?.at
        ? now - Date.parse(state.lastDisconnect.at)
        : now - Date.parse(state.started);
      if (Number.isFinite(since) && since > Math.max(60_000, WATCHDOG_STALE_MS)) {
        requestHardRestart('watchdog_disconnected_too_long');
      }
      return;
    }

    if (!state.authenticated) return;
    const last = state.lastFrameAtMs || state.lastAuthAtMs || Date.parse(state.started);
    const stale = now - last;
    if (stale > WATCHDOG_STALE_MS) {
      requestHardRestart('watchdog_stale_no_frames');
    }
  }, WATCHDOG_CHECK_MS).unref?.();
}

// ---- local HTTP API ----
function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 2e6) {
        req.destroy();
        reject(new Error('body too large'));
      }
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(new Error('invalid json'));
      }
    });
    req.on('error', reject);
  });
}

function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  try {
    const url = req.url?.split('?')[0];

    if (req.method === 'GET' && url === '/health') {
      const pendingList = [...pending.entries()].map(([req_id, p]) => ({
        req_id,
        stream_id: p.streamId,
        chatid: p.chatid,
        chattype: p.chattype,
        finished: p.finished,
        age_ms: Date.now() - p.startedAt,
        ttl_ms: STREAM_TTL_MS,
      }));
      const now = Date.now();
      return json(res, 200, {
        ok: true,
        connected: client.isConnected,
        authenticated: state.authenticated,
        lastAuthAt: state.lastAuthAt,
        lastAuthResponse: state.lastAuthResponse,
        lastDisconnect: state.lastDisconnect,
        lastKickAt: state.lastKickAt,
        lastFrameAt: state.lastFrameAt,
        lastFrameKind: state.lastFrameKind,
        lastPongAt: state.lastPongAt,
        lastInboundAt: state.lastInboundAt,
        frameAgeMs: state.lastFrameAtMs ? now - state.lastFrameAtMs : null,
        pongAgeMs: state.lastPongAtMs ? now - state.lastPongAtMs : null,
        inboundAgeMs: state.lastInboundAtMs ? now - state.lastInboundAtMs : null,
        reconnectAttempts: state.reconnectAttempts,
        reconnectTotal: state.reconnectTotal,
        hardRestartCount: state.hardRestartCount,
        frames: state.frames,
        started: state.started,
        inbound: state.inbound,
        forwardOk: state.forwardOk,
        forwardFail: state.forwardFail,
        pending_req_ids: pendingList.map((p) => p.req_id),
        pending: pendingList,
        bot_id_set: Boolean(BOT_ID),
        forward_url_set: Boolean(FORWARD_URL),
        ws_url_override: WS_URL || null,
        heartbeatMs: HEARTBEAT_MS,
        watchdogStaleMs: WATCHDOG_STALE_MS,
        pid: process.pid,
      });
    }

    if (req.method === 'POST' && url === '/reply') {
      let body;
      try {
        body = await readJson(req);
      } catch (e) {
        return json(res, 400, { ok: false, error: e.message });
      }
      const reqId = body.req_id;
      const content = body.content;
      const finish = Boolean(body.finish);
      if (!reqId || content == null) {
        return json(res, 400, { ok: false, error: 'req_id and content required' });
      }
      const p = pending.get(reqId);
      if (!p) {
        return json(res, 404, {
          ok: false,
          error: 'no pending stream for req_id (expired or unknown)',
          hint: 'use POST /send with chatid for late answers',
        });
      }
      if (p.finished) {
        return json(res, 409, { ok: false, error: 'stream already finished; use POST /send' });
      }

      const age = Date.now() - p.startedAt;
      let forceFinish = finish;
      let outContent = String(content);
      if (!finish && age >= STREAM_WARN_MS) {
        forceFinish = true;
        outContent =
          outContent +
          '\n\n_(接近流式回复时限，本条已结束；后续内容请改用主动推送)_';
        log('warn', 'forcing finish near TTL on /reply', { req_id: reqId, age_ms: age });
      }

      try {
        const r = await client.replyStream(p.frame, p.streamId, outContent, forceFinish);
        p.lastContent = outContent;
        if (forceFinish) {
          p.finished = true;
          clearPending(reqId, 'reply-finished');
        }
        log('info', 'reply segment', {
          req_id: reqId,
          finish: forceFinish,
          errcode: r?.errcode,
          len: outContent.length,
        });
        return json(res, 200, {
          ok: true,
          finish: forceFinish,
          errcode: r?.errcode,
          errmsg: r?.errmsg,
          stream_id: p.streamId,
        });
      } catch (e) {
        log('error', 'reply failed', e?.message || String(e));
        return json(res, 502, { ok: false, error: e?.message || String(e) });
      }
    }

    if (req.method === 'POST' && url === '/send') {
      let body;
      try {
        body = await readJson(req);
      } catch (e) {
        return json(res, 400, { ok: false, error: e.message });
      }
      const chatid = body.chatid || body.chatid_or_userid || body.userid || body.to;
      const content = body.content ?? body.markdown ?? body.text;
      if (!chatid || content == null) {
        return json(res, 400, { ok: false, error: 'chatid and content required' });
      }
      if (DO_CONNECT && !state.authenticated) {
        return json(res, 503, { ok: false, error: 'not authenticated' });
      }

      // chat_type: 1 single, 2 group (official aibot_send_msg). Optional.
      const msgBody = {
        msgtype: 'markdown',
        markdown: { content: String(content) },
      };
      if (body.chat_type != null) msgBody.chat_type = Number(body.chat_type);
      else if (body.chattype === 'single') msgBody.chat_type = 1;
      else if (body.chattype === 'group') msgBody.chat_type = 2;

      try {
        const r = await client.sendMessage(String(chatid), msgBody);
        log('info', 'send ok', {
          chatid: String(chatid),
          chat_type: msgBody.chat_type,
          errcode: r?.errcode,
        });
        return json(res, 200, {
          ok: true,
          errcode: r?.errcode,
          errmsg: r?.errmsg,
          req_id: r?.headers?.req_id,
        });
      } catch (e) {
        log('error', 'send failed', e?.message || String(e));
        return json(res, 502, { ok: false, error: e?.message || String(e) });
      }
    }

    if (req.method === 'POST' && url === '/send-media') {
      // Upload a local file under /workspace and push it as an image/file message.
      let body;
      try { body = await readJson(req); } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
      const chatid = body.chatid;
      const mediaType = body.media_type || 'image';
      const fpath = String(body.path || '');
      if (!chatid || !fpath.startsWith('/workspace/')) {
        return json(res, 400, { ok: false, error: 'chatid and path under /workspace required' });
      }
      if (DO_CONNECT && !state.authenticated) return json(res, 503, { ok: false, error: 'not authenticated' });
      try {
        const fsm = await import('node:fs');
        const pathm = await import('node:path');
        const buf = fsm.readFileSync(fpath);
        const up = await client.uploadMedia(buf, { type: mediaType, filename: body.filename || pathm.basename(fpath) });
        const r = await client.sendMediaMessage(String(chatid), mediaType, up.media_id);
        log('info', 'send-media ok', { chatid: String(chatid), media_type: mediaType, errcode: r?.errcode });
        return json(res, 200, { ok: true, errcode: r?.errcode, errmsg: r?.errmsg, media_id_set: Boolean(up?.media_id) });
      } catch (e) {
        log('error', 'send-media failed', e?.message || String(e));
        return json(res, 502, { ok: false, error: e?.message || String(e) });
      }
    }

    json(res, 404, { ok: false, error: 'not found' });
  } catch (e) {
    log('error', 'http handler', e?.message || String(e));
    json(res, 500, { ok: false, error: 'internal' });
  }
});

server.on('error', (e) => {
  log('error', 'http server error', e.message);
  process.exit(1);
});

server.listen(HTTP_PORT, HTTP_HOST, () => {
  log('info', `http listening ${HTTP_HOST}:${HTTP_PORT}`);
});

const shutdown = () => {
  log('info', 'shutdown');
  exiting = true;
  try {
    client.disconnect();
  } catch {
    /* ignore */
  }
  server.close();
  setTimeout(() => process.exit(0), 300);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', (e) => log('error', 'uncaught', e?.stack || String(e)));
process.on('unhandledRejection', (e) => log('error', 'unhandled', e?.message || String(e)));

log('info', 'starting bridge', {
  pid: process.pid,
  bot_id_set: Boolean(BOT_ID),
  connect: DO_CONNECT,
  forward_url_set: Boolean(FORWARD_URL),
  stream_ttl_ms: STREAM_TTL_MS,
  heartbeat_ms: HEARTBEAT_MS,
  watchdog_stale_ms: WATCHDOG_STALE_MS,
});

if (DO_CONNECT) {
  client.connect();
} else {
  log('info', 'WECOM_CONNECT disabled — skipping WebSocket connect');
}

// Exported for tests via dynamic import side effects only; process is the service.
export { client, pending, state, server, PLACEHOLDER, STREAM_TTL_MS };
