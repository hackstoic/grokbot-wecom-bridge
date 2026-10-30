/** Env bindings + secrets for the Worker / Durable Object. */
export interface Env {
  BRIDGE: DurableObjectNamespace;
  WECOM_BOT_ID: string;
  WECOM_BOT_SECRET: string;
  FORWARD_KEY: string;
  API_KEY: string;
  WEBHOOK_URL: string;
  PLACEHOLDER?: string;
  WECOM_WS_URL?: string;
}

export interface WsFrame {
  cmd?: string;
  headers?: { req_id?: string; [k: string]: unknown };
  body?: Record<string, unknown>;
  errcode?: number;
  errmsg?: string;
}

export interface ForwardPayload {
  msgid: string;
  req_id: string | undefined;
  chatid: string | null;
  chattype: string | null;
  from_userid: string | null;
  text: string;
  timestamp: string;
  msgtype: string | undefined;
}

export interface PendingStream {
  reqId: string;
  streamId: string;
  chatid: string | null;
  chattype: string | null;
  from_userid: string | null;
  startedAt: number;
  finished: boolean;
  lastContent: string;
}

export interface BridgeStateSnapshot {
  ok: true;
  connected: boolean;
  authenticated: boolean;
  lastAuthAt: string | null;
  lastAuthResponse: { errcode: number; errmsg: string } | null;
  lastDisconnect: { at: string; reason: string } | null;
  lastKickAt: string | null;
  lastFrameAt: string | null;
  lastFrameKind: string | null;
  lastPongAt: string | null;
  lastInboundAt: string | null;
  frameAgeMs: number | null;
  pongAgeMs: number | null;
  inboundAgeMs: number | null;
  reconnectAttempts: number;
  reconnectTotal: number;
  hardRestartCount: number;
  frames: number;
  started: string;
  inbound: number;
  forwardOk: number;
  forwardFail: number;
  pending_req_ids: string[];
  pending: Array<{
    req_id: string;
    stream_id: string;
    chatid: string | null;
    chattype: string | null;
    finished: boolean;
    age_ms: number;
    ttl_ms: number;
  }>;
  bot_id_set: boolean;
  forward_url_set: boolean;
  ws_url_override: string | null;
  heartbeatMs: number;
  watchdogStaleMs: number;
  runtime: 'cloudflare-do';
}
