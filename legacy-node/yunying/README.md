# 运营Bot Node 版企微长连接桥接（备份）

来源：`/workspace/wecom-bridge-yunying`（运行中的运营Bot 桥接）。本目录为只读备份，**不含** `.env`、日志、`inbox.jsonl`、密钥。

## 环境变量

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `WECOM_BOT_ID` | 是 | 智能机器人 BotID |
| `WECOM_BOT_SECRET` | 是 | 长连接 Secret |
| `WECOM_FORWARD_URL` | 否 | 入站消息转发 webhook |
| `WECOM_FORWARD_KEY` | 否 | 鉴权值；若 header 为 Authorization 且无 Bearer/Basic 前缀，bridge 会自动加 `Bearer ` |
| `WECOM_HTTP_PORT` | 否 | 默认 `8789` |

> 原运行时用 `yunying.env` 映射 `WECOM_YUNYING_*` → `WECOM_*`；备份版 `start.sh` 直接读标准 `WECOM_*`，不再附带任何 `.env` 文件。

## 本地 HTTP

- `GET /health`
- `POST /reply` — `{"req_id","content","finish"}`
- `POST /send` — `{"chatid","chattype","content"}`
- `POST /send-media` — `{"chatid","media_type","path"}`（`path` 须在 `/workspace/` 下）

## 启动 / 停止

```bash
export WECOM_BOT_ID=... WECOM_BOT_SECRET=...
./start.sh   # 需 flock；前台 supervisor
./stop.sh
```

同一 BotID **只能**保留一条长连接。
