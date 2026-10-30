# Cloudflare Workers 版企微智能机器人长连接桥接

TypeScript · Workers + Durable Object。由 DO **主动出站** WebSocket 连接 `wss://openws.work.weixin.qq.com`，协议对齐官方长连接文档与 Node 版 `bridge.mjs`（运营版含 `/send-media`）。

## 设计要点

| 项 | 选择 |
| --- | --- |
| 多 Bot | **每个 Bot 单独部署一个 Worker**（或 `wrangler` environment）。密钥是扁平 `wrangler secret`，一部署一套；DO 固定名 `default`。 |
| 出站 WS | DO 内 `fetch(url, { headers: { Upgrade: 'websocket' } })`，`resp.webSocket.accept()` |
| 心跳 | DO `alarm` 每 30s：发 `ping`，检查最近 pong/帧；超时或断线指数退避重连 |
| 常驻 | Worker `cron`（默认每 2 分钟）调用 DO `/internal/ensure`；alarm 自身也会续期 |
| 入站转发 | `POST WEBHOOK_URL`，`Authorization: Bearer ${FORWARD_KEY}`，payload 与 Node 一致 |
| 对外 API | `/health` `/reply` `/send` `/send-media`，均需 `Authorization: Bearer ${API_KEY}` |

### 与 Node 版差异（有意为之）

- `/send-media`：Workers 无本地磁盘，**不支持** `path`；改为 `content_base64` 或 `media_url` + `filename`。上传协议仍是 `aibot_upload_media_{init,chunk,finish}`。
- 上传省略可选字段 `md5`（Workers SubtleCrypto 无 MD5）。
- 对外 API 一律鉴权（Node 版绑在 `127.0.0.1`，CF 版公网暴露）。

## 已知限制（务必读）

1. **出站 WebSocket 不能 hibernate**（文档明确）。打开的出站连接最多约 **15 分钟** 阻止 DO 被驱逐；之后连接可能仍在，但需靠 alarm / cron / 入站请求续命。见 [DO WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/) 与 [Lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)。
2. **部署新版本会断开**所有 WS；cron/alarm 会重连。
3. 需要 **Workers 付费套餐**（Durable Objects）。
4. 同一 BotID **同时只能一条长连接**——迁移时必须先停 Node，再启用 CF。

## Secrets

```bash
cd cloudflare
npx wrangler secret put WECOM_BOT_ID
npx wrangler secret put WECOM_BOT_SECRET
npx wrangler secret put FORWARD_KEY      # webhook 鉴权；可带或不带 Bearer 前缀
npx wrangler secret put API_KEY          # 调用本 Worker HTTP API
npx wrangler secret put WEBHOOK_URL      # 入站转发目标（即 Node 的 WECOM_FORWARD_URL）
```

`wrangler.toml` 里只放占位符，**不要**写入真实 account_id / 密钥。

## 部署步骤（需你本人操作；本仓库只做本地准备）

1. Cloudflare 账号开通 Workers Paid。
2. 编辑 `wrangler.toml`：填 `account_id`（可选，也可用 `wrangler login` 默认账号）。
3. `npm install && npm run typecheck`
4. 配置上述 5 个 secret。
5. **先停止**对应 Bot 的 Node 桥接（`stop.sh`），确认无残留进程。
6. `npx wrangler deploy`（本任务不执行）。
7. 用 `Authorization: Bearer $API_KEY` 打 `GET /health`，确认 `authenticated: true`。
8. 在企微里发一条测试消息，确认 webhook 收到与 Node 相同字段的 JSON。

### 从 Node 切换 checklist

1. 记下 Node 的 `WECOM_BOT_ID` / Secret / forward URL / forward key。
2. 配置 CF secrets（`WEBHOOK_URL` = 原 `WECOM_FORWARD_URL`，`FORWARD_KEY` = 原 `WECOM_FORWARD_KEY`）。
3. 调用方把 `http://127.0.0.1:878x/{reply,send,...}` 改成 `https://<worker>.workers.dev/...`，并加 `Authorization: Bearer $API_KEY`。
4. **停 Node → 再 deploy/启用 CF**（顺序不可反）。
5. 观察 `/health` 的 `lastPongAt` / `frameAgeMs`。

## 本地验证

```bash
cd cloudflare
npm install
npm run typecheck          # tsc --noEmit
npx wrangler deploy --dry-run   # 不登录也可尝试打包；若提示 login 可忽略
```

`wrangler dev` 可以起本地 DO，但出站连真实企微需要 secret，且本任务**不**登录、**不**真实部署。出站 WS 在 miniflare 下的行为以 Cloudflare 文档为准，未做联调时请视为未验证。

## HTTP 契约（与运营 Node 对齐）

### `GET /health`

扩展字段含 `runtime: "cloudflare-do"`；其余与 Node 看门狗版一致（connected / authenticated / lastPongAt / pending 等）。

### `POST /reply`

```json
{ "req_id": "<入站>", "content": "...", "finish": true }
```

### `POST /send`

```json
{ "chatid": "<userid 或 chatid>", "chattype": "single|group", "content": "markdown" }
```

### `POST /send-media`

```json
{
  "chatid": "...",
  "media_type": "image|file|voice|video",
  "filename": "a.png",
  "content_base64": "<...>"
}
```

或 `"media_url": "https://..."`。
