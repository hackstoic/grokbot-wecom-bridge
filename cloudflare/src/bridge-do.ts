import { DurableObject } from 'cloudflare:workers';
import type { BridgeStateSnapshot, Env, PendingStream, WsFrame } from './types';
import {
  CHUNK_SIZE,
  DEFAULT_WS_URL,
  HEARTBEAT_MS,
  STREAM_TTL_MS,
  STREAM_WARN_MS,
  WATCHDOG_STALE_MS,
  buildForwardPayload,
  bytesToBase64,
  classifyFrame,
  forwardAuthValue,
  framePing,
  frameRespondStream,
  frameRespondWelcome,
  frameSendMarkdown,
  frameSendMedia,
  frameSubscribe,
  frameUploadChunk,
  frameUploadFinish,
  frameUploadInit,
  generateReqId,
} from './protocol';

type Waiter = {
  resolve: (f: WsFrame) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * Holds one outbound WebSocket to WeCom for a single bot.
 * Heartbeat + stale watchdog via DO alarm (~30s).
 * Cron on the Worker periodically calls ensureConnected().
 */
export class WeComBridgeDO extends DurableObject<Env> {
  private ws: WebSocket | null = null;
  private connecting = false;
  private backoffMs = 1000;
  private readonly pending = new Map<string, PendingStream>();
  private readonly seen = new Set<string>();
  private readonly seenOrder: string[] = [];
  private readonly waiters = new Map<string, Waiter>();

  private state = {
    authenticated: false,
    connected: false,
    lastAuthAt: null as string | null,
    lastAuthAtMs: 0,
    lastAuthResponse: null as { errcode: number; errmsg: string } | null,
    lastDisconnect: null as { at: string; reason: string } | null,
    lastKickAt: null as string | null,
    lastFrameAt: null as string | null,
    lastFrameAtMs: 0,
    lastFrameKind: null as string | null,
    lastPongAt: null as string | null,
    lastPongAtMs: 0,
    lastInboundAt: null as string | null,
    lastInboundAtMs: 0,
    reconnectAttempts: 0,
    reconnectTotal: 0,
    hardRestartCount: 0,
    started: new Date().toISOString(),
    inbound: 0,
    forwardOk: 0,
    forwardFail: 0,
    frames: 0,
  };

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Restore seen msgids from storage (best-effort)
    this.ctx.blockConcurrencyWhile(async () => {
      const stored = (await this.ctx.storage.get<string[]>('seen_msgids')) || [];
      for (const id of stored.slice(-1000)) this.remember(id);
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (request.method === 'POST' && path === '/internal/ensure') {
        await this.ensureConnected();
        return this.json(200, { ok: true, authenticated: this.state.authenticated });
      }

      if (request.method === 'GET' && path === '/health') {
        return this.json(200, this.healthSnapshot());
      }

      if (request.method === 'POST' && path === '/reply') {
        return await this.handleReply(await request.json());
      }
      if (request.method === 'POST' && path === '/send') {
        return await this.handleSend(await request.json());
      }
      if (request.method === 'POST' && path === '/send-media') {
        return await this.handleSendMedia(await request.json());
      }

      return this.json(404, { ok: false, error: 'not found' });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('DO fetch error', msg);
      return this.json(500, { ok: false, error: msg });
    }
  }

  async alarm(): Promise<void> {
    try {
      await this.onAlarmTick();
    } finally {
      // Always reschedule — alarm is our heartbeat + keep-alive.
      await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_MS);
    }
  }

  /** Cron / first request: make sure WS is up and alarm is armed. */
  async ensureConnected(): Promise<void> {
    const existing = await this.ctx.storage.getAlarm();
    if (existing == null) {
      await this.ctx.storage.setAlarm(Date.now() + 1000);
    }
    if (!this.state.authenticated || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      await this.connectWs();
    }
  }

  // ---- WebSocket lifecycle -------------------------------------------------

  private async connectWs(): Promise<void> {
    if (this.connecting) return;
    this.connecting = true;
    try {
      this.teardownWs('reconnect');
      const botId = (this.env.WECOM_BOT_ID || '').trim();
      const secret = this.env.WECOM_BOT_SECRET || '';
      if (!botId || !secret) {
        console.error('missing WECOM_BOT_ID or WECOM_BOT_SECRET');
        return;
      }

      const wsUrl = (this.env.WECOM_WS_URL || DEFAULT_WS_URL).trim();
      const resp = await fetch(wsUrl, { headers: { Upgrade: 'websocket' } });
      const ws = resp.webSocket;
      if (!ws) {
        throw new Error(`WS upgrade failed: status=${resp.status}`);
      }
      ws.accept();
      this.ws = ws;
      this.state.connected = true;
      this.state.reconnectAttempts = 0;

      ws.addEventListener('message', (ev) => {
        void this.onWsMessage(ev.data);
      });
      ws.addEventListener('close', (ev) => {
        this.state.connected = false;
        this.state.authenticated = false;
        this.state.lastDisconnect = {
          at: new Date().toISOString(),
          reason: `close ${ev.code} ${ev.reason || ''}`.trim(),
        };
        this.rejectAllWaiters(new Error('ws closed'));
        void this.scheduleReconnect();
      });
      ws.addEventListener('error', () => {
        console.error('ws error');
      });

      const sub = frameSubscribe(botId, secret);
      const ack = await this.sendAndWait(sub, 15_000);
      if (ack.errcode !== 0) {
        throw new Error(`subscribe failed: ${ack.errcode} ${ack.errmsg}`);
      }
      this.state.authenticated = true;
      this.state.lastAuthAt = new Date().toISOString();
      this.state.lastAuthAtMs = Date.now();
      this.state.lastAuthResponse = { errcode: 0, errmsg: 'ok' };
      this.observeFrame({ ...ack, headers: sub.headers });
      this.state.lastFrameAt = this.state.lastAuthAt;
      this.state.lastFrameAtMs = this.state.lastAuthAtMs;
      this.state.lastFrameKind = 'authenticated';
      this.backoffMs = 1000;
      console.log('authenticated aibot_subscribe ok');

      await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_MS);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('connect failed', msg);
      this.state.connected = false;
      this.state.authenticated = false;
      this.state.lastDisconnect = { at: new Date().toISOString(), reason: msg };
      await this.scheduleReconnect();
    } finally {
      this.connecting = false;
    }
  }

  private async scheduleReconnect(): Promise<void> {
    this.state.reconnectAttempts++;
    this.state.reconnectTotal++;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(30_000, this.backoffMs * 2);
    await this.ctx.storage.setAlarm(Date.now() + delay);
  }

  private teardownWs(reason: string): void {
    if (this.ws) {
      try {
        this.ws.close(1000, reason.slice(0, 120));
      } catch {
        /* ignore */
      }
    }
    this.ws = null;
    this.state.connected = false;
    this.state.authenticated = false;
    this.rejectAllWaiters(new Error(reason));
  }

  private async onAlarmTick(): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.state.authenticated) {
      await this.connectWs();
      return;
    }

    const now = Date.now();
    const last = this.state.lastFrameAtMs || this.state.lastAuthAtMs || Date.parse(this.state.started);
    if (now - last > WATCHDOG_STALE_MS) {
      console.error('watchdog_stale_no_frames');
      this.state.hardRestartCount++;
      this.teardownWs('watchdog_stale');
      await this.connectWs();
      return;
    }

    // Expire pending streams near TTL
    for (const [reqId, p] of [...this.pending.entries()]) {
      if (p.finished) continue;
      const age = now - p.startedAt;
      if (age >= STREAM_TTL_MS) {
        try {
          const note =
            (p.lastContent || this.placeholder()) +
            '\n\n_(回复超时，流式消息已结束；后续答案将通过主动推送发送)_';
          await this.sendFrame(frameRespondStream(reqId, p.streamId, note, true));
        } catch (e) {
          console.error('ttl auto-finish failed', e);
        }
        this.clearPending(reqId);
      }
    }

    // Heartbeat ping (also refreshes outbound-I/O eviction window)
    try {
      const ping = framePing();
      await this.sendAndWait(ping, 10_000);
    } catch (e) {
      console.error('ping failed', e);
      this.teardownWs('ping_failed');
      await this.connectWs();
    }
  }

  // ---- Frame I/O -----------------------------------------------------------

  private sendFrame(frame: WsFrame): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('not connected');
    }
    this.ws.send(JSON.stringify(frame));
  }

  private sendAndWait(frame: WsFrame, timeoutMs: number): Promise<WsFrame> {
    const reqId = String(frame.headers?.req_id || '');
    if (!reqId) return Promise.reject(new Error('missing req_id'));
    return new Promise<WsFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(reqId);
        reject(new Error(`timeout waiting ack for ${reqId.slice(0, 24)}`));
      }, timeoutMs);
      this.waiters.set(reqId, { resolve, reject, timer });
      try {
        this.sendFrame(frame);
      } catch (e) {
        clearTimeout(timer);
        this.waiters.delete(reqId);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  private rejectAllWaiters(err: Error): void {
    for (const [k, w] of this.waiters) {
      clearTimeout(w.timer);
      w.reject(err);
      this.waiters.delete(k);
    }
  }

  private async onWsMessage(data: string | ArrayBuffer): Promise<void> {
    let text: string;
    if (typeof data === 'string') text = data;
    else text = new TextDecoder().decode(data);

    let frame: WsFrame;
    try {
      frame = JSON.parse(text) as WsFrame;
    } catch {
      console.error('invalid json frame');
      return;
    }

    const kind = this.observeFrame(frame);
    const reqId = String(frame.headers?.req_id || '');

    // Resolve pending request/response waiters (acks have no cmd or echo cmd)
    if (reqId && this.waiters.has(reqId)) {
      const w = this.waiters.get(reqId)!;
      clearTimeout(w.timer);
      this.waiters.delete(reqId);
      w.resolve(frame);
    }

    if (kind === 'msg_callback') {
      await this.onMessageCallback(frame);
      return;
    }

    if (kind.startsWith('event:')) {
      const ev = kind.slice('event:'.length);
      if (ev === 'disconnected_event') {
        this.state.lastKickAt = new Date().toISOString();
        this.state.hardRestartCount++;
        console.warn('disconnected_event — will reconnect');
        this.teardownWs('disconnected_event');
        this.backoffMs = 1000;
        await this.ctx.storage.setAlarm(Date.now() + 1000);
        return;
      }
      if (ev === 'enter_chat') {
        const cbReq = frame.headers?.req_id;
        if (cbReq) {
          try {
            await this.sendAndWait(
              frameRespondWelcome(cbReq, '你好，我是智能助手，有什么可以帮你？'),
              5_000,
            );
          } catch (e) {
            console.error('welcome failed', e);
          }
        }
      }
    }
  }

  private observeFrame(frame: WsFrame): string {
    const now = Date.now();
    const kind = classifyFrame(frame);
    this.state.frames++;
    this.state.lastFrameAt = new Date(now).toISOString();
    this.state.lastFrameAtMs = now;
    this.state.lastFrameKind = kind;
    if (kind === 'pong') {
      this.state.lastPongAt = this.state.lastFrameAt;
      this.state.lastPongAtMs = now;
    }
    return kind;
  }

  // ---- Inbound message + forward ------------------------------------------

  private remember(id: string): void {
    if (!id || this.seen.has(id)) return;
    this.seen.add(id);
    this.seenOrder.push(id);
    while (this.seenOrder.length > 5000) {
      const old = this.seenOrder.shift();
      if (old) this.seen.delete(old);
    }
  }

  private async persistSeen(): Promise<void> {
    await this.ctx.storage.put('seen_msgids', this.seenOrder.slice(-1000));
  }

  private clearPending(reqId: string): void {
    this.pending.delete(reqId);
  }

  private placeholder(): string {
    return this.env.PLACEHOLDER || '收到，正在处理…';
  }

  private async onMessageCallback(frame: WsFrame): Promise<void> {
    const payload = buildForwardPayload(frame);
    if (!payload || !payload.msgid || this.seen.has(payload.msgid)) {
      console.log('dup/empty msg skipped', payload?.msgid);
      return;
    }
    this.remember(payload.msgid);
    void this.persistSeen();
    this.state.inbound++;
    this.state.lastInboundAt = new Date().toISOString();
    this.state.lastInboundAtMs = Date.now();

    const reqId = payload.req_id;
    const streamId = generateReqId('stream');
    if (reqId) {
      this.pending.set(reqId, {
        reqId,
        streamId,
        chatid: payload.chatid,
        chattype: payload.chattype,
        from_userid: payload.from_userid,
        startedAt: Date.now(),
        finished: false,
        lastContent: this.placeholder(),
      });
      try {
        await this.sendAndWait(
          frameRespondStream(reqId, streamId, this.placeholder(), false),
          10_000,
        );
      } catch (e) {
        console.error('placeholder reply failed', e);
      }
    }

    await this.forwardMessage(payload);
  }

  private async forwardMessage(payload: ReturnType<typeof buildForwardPayload>): Promise<void> {
    if (!payload) return;
    const url = (this.env.WEBHOOK_URL || '').trim();
    if (!url) {
      console.log('forward skipped (WEBHOOK_URL unset)', payload.msgid);
      return;
    }
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    const auth = forwardAuthValue(this.env.FORWARD_KEY || '');
    if (auth) headers['Authorization'] = auth;

    let lastErr: string | undefined;
    for (let i = 1; i <= 3; i++) {
      try {
        const r = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(15_000),
        });
        if (r.status >= 200 && r.status < 300) {
          this.state.forwardOk++;
          return;
        }
        lastErr = `status ${r.status}`;
        if (r.status < 500 && r.status !== 429) break;
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e);
      }
      await new Promise((r) => setTimeout(r, 1000 * i));
    }
    this.state.forwardFail++;
    console.error('forward failed', payload.msgid, lastErr);
  }

  // ---- HTTP handlers (aligned with yunying bridge.mjs) --------------------

  private async handleReply(body: Record<string, unknown>): Promise<Response> {
    const reqId = String(body.req_id || '');
    const content = body.content;
    const finish = Boolean(body.finish);
    if (!reqId || content == null) {
      return this.json(400, { ok: false, error: 'req_id and content required' });
    }
    const p = this.pending.get(reqId);
    if (!p) {
      return this.json(404, {
        ok: false,
        error: 'no pending stream for req_id (expired or unknown)',
        hint: 'use POST /send with chatid for late answers',
      });
    }
    if (p.finished) {
      return this.json(409, { ok: false, error: 'stream already finished; use POST /send' });
    }

    const age = Date.now() - p.startedAt;
    let forceFinish = finish;
    let outContent = String(content);
    if (!finish && age >= STREAM_WARN_MS) {
      forceFinish = true;
      outContent +=
        '\n\n_(接近流式回复时限，本条已结束；后续内容请改用主动推送)_';
    }

    try {
      const r = await this.sendAndWait(
        frameRespondStream(reqId, p.streamId, outContent, forceFinish),
        15_000,
      );
      p.lastContent = outContent;
      if (forceFinish) {
        p.finished = true;
        this.clearPending(reqId);
      }
      return this.json(200, {
        ok: true,
        finish: forceFinish,
        errcode: r.errcode,
        errmsg: r.errmsg,
        stream_id: p.streamId,
      });
    } catch (e) {
      return this.json(502, {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  private async handleSend(body: Record<string, unknown>): Promise<Response> {
    const chatid = String(
      body.chatid || body.chatid_or_userid || body.userid || body.to || '',
    );
    const content = body.content ?? body.markdown ?? body.text;
    if (!chatid || content == null) {
      return this.json(400, { ok: false, error: 'chatid and content required' });
    }
    if (!this.state.authenticated) {
      return this.json(503, { ok: false, error: 'not authenticated' });
    }

    let chatType: number | undefined;
    if (body.chat_type != null) chatType = Number(body.chat_type);
    else if (body.chattype === 'single') chatType = 1;
    else if (body.chattype === 'group') chatType = 2;

    try {
      const r = await this.sendAndWait(
        frameSendMarkdown(chatid, String(content), chatType),
        15_000,
      );
      return this.json(200, {
        ok: true,
        errcode: r.errcode,
        errmsg: r.errmsg,
        req_id: r.headers?.req_id,
      });
    } catch (e) {
      return this.json(502, {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /**
   * CF adaptation of yunying /send-media.
   * Node uses local path under /workspace; Workers has no FS —
   * accept content_base64 (or media_url) + filename instead of path.
   */
  private async handleSendMedia(body: Record<string, unknown>): Promise<Response> {
    const chatid = String(body.chatid || '');
    const mediaType = String(body.media_type || 'image');
    if (!chatid) {
      return this.json(400, { ok: false, error: 'chatid required' });
    }
    if (!this.state.authenticated) {
      return this.json(503, { ok: false, error: 'not authenticated' });
    }

    let bytes: Uint8Array;
    let filename = String(body.filename || 'file.bin');
    if (typeof body.content_base64 === 'string' && body.content_base64) {
      const bin = atob(body.content_base64);
      bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    } else if (typeof body.media_url === 'string' && body.media_url) {
      const r = await fetch(String(body.media_url));
      if (!r.ok) {
        return this.json(400, { ok: false, error: `media_url fetch failed: ${r.status}` });
      }
      bytes = new Uint8Array(await r.arrayBuffer());
      if (!body.filename) {
        try {
          filename = new URL(String(body.media_url)).pathname.split('/').pop() || filename;
        } catch {
          /* keep default */
        }
      }
    } else if (typeof body.path === 'string') {
      return this.json(400, {
        ok: false,
        error:
          'path is not supported on Cloudflare Workers; use content_base64 or media_url (+ filename)',
      });
    } else {
      return this.json(400, {
        ok: false,
        error: 'content_base64 or media_url required',
      });
    }

    try {
      const mediaId = await this.uploadMedia(bytes, mediaType, filename);
      const r = await this.sendAndWait(frameSendMedia(chatid, mediaType, mediaId), 15_000);
      return this.json(200, {
        ok: true,
        errcode: r.errcode,
        errmsg: r.errmsg,
        media_id_set: Boolean(mediaId),
      });
    } catch (e) {
      return this.json(502, {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  private async uploadMedia(
    fileBuffer: Uint8Array,
    type: string,
    filename: string,
  ): Promise<string> {
    const totalSize = fileBuffer.byteLength;
    const totalChunks = Math.ceil(totalSize / CHUNK_SIZE) || 1;
    if (totalChunks > 100) {
      throw new Error(`File too large: ${totalChunks} chunks exceeds maximum of 100`);
    }

    const init = await this.sendAndWait(
      frameUploadInit({ type, filename, totalSize, totalChunks }),
      20_000,
    );
    if (init.errcode && init.errcode !== 0) {
      throw new Error(`upload init failed: ${init.errcode} ${init.errmsg}`);
    }
    const uploadId = String((init.body as { upload_id?: string } | undefined)?.upload_id || '');
    if (!uploadId) throw new Error('upload init missing upload_id');

    for (let i = 0; i < totalChunks; i++) {
      const start = i * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, totalSize);
      const chunk = fileBuffer.subarray(start, end);
      const b64 = bytesToBase64(chunk);
      const ack = await this.sendAndWait(frameUploadChunk(uploadId, i, b64), 30_000);
      if (ack.errcode && ack.errcode !== 0) {
        throw new Error(`chunk ${i} failed: ${ack.errcode} ${ack.errmsg}`);
      }
    }

    const fin = await this.sendAndWait(frameUploadFinish(uploadId), 30_000);
    if (fin.errcode && fin.errcode !== 0) {
      throw new Error(`upload finish failed: ${fin.errcode} ${fin.errmsg}`);
    }
    const mediaId = String((fin.body as { media_id?: string } | undefined)?.media_id || '');
    if (!mediaId) throw new Error('upload finish missing media_id');
    return mediaId;
  }

  private healthSnapshot(): BridgeStateSnapshot {
    const now = Date.now();
    const pendingList = [...this.pending.entries()].map(([req_id, p]) => ({
      req_id,
      stream_id: p.streamId,
      chatid: p.chatid,
      chattype: p.chattype,
      finished: p.finished,
      age_ms: now - p.startedAt,
      ttl_ms: STREAM_TTL_MS,
    }));
    return {
      ok: true,
      connected: Boolean(this.ws && this.ws.readyState === WebSocket.OPEN),
      authenticated: this.state.authenticated,
      lastAuthAt: this.state.lastAuthAt,
      lastAuthResponse: this.state.lastAuthResponse,
      lastDisconnect: this.state.lastDisconnect,
      lastKickAt: this.state.lastKickAt,
      lastFrameAt: this.state.lastFrameAt,
      lastFrameKind: this.state.lastFrameKind,
      lastPongAt: this.state.lastPongAt,
      lastInboundAt: this.state.lastInboundAt,
      frameAgeMs: this.state.lastFrameAtMs ? now - this.state.lastFrameAtMs : null,
      pongAgeMs: this.state.lastPongAtMs ? now - this.state.lastPongAtMs : null,
      inboundAgeMs: this.state.lastInboundAtMs ? now - this.state.lastInboundAtMs : null,
      reconnectAttempts: this.state.reconnectAttempts,
      reconnectTotal: this.state.reconnectTotal,
      hardRestartCount: this.state.hardRestartCount,
      frames: this.state.frames,
      started: this.state.started,
      inbound: this.state.inbound,
      forwardOk: this.state.forwardOk,
      forwardFail: this.state.forwardFail,
      pending_req_ids: pendingList.map((p) => p.req_id),
      pending: pendingList,
      bot_id_set: Boolean((this.env.WECOM_BOT_ID || '').trim()),
      forward_url_set: Boolean((this.env.WEBHOOK_URL || '').trim()),
      ws_url_override: this.env.WECOM_WS_URL || null,
      heartbeatMs: HEARTBEAT_MS,
      watchdogStaleMs: WATCHDOG_STALE_MS,
      runtime: 'cloudflare-do',
    };
  }

  private json(status: number, obj: unknown): Response {
    return new Response(JSON.stringify(obj), {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }
}
