# 产研Bot Node 版企微长连接桥接（备份）

来源：`/workspace/wecom-bridge`。本目录为只读备份，**不含** `bot_id.env`、`forward.env`、日志、`inbox.jsonl`、密钥、测试样例。

特性相对运营版：看门狗、帧日志、扩展 `/health`；**无** `/send-media`。

## 环境变量

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `WECOM_BOT_ID` | 是 | 智能机器人 BotID |
| `WECOM_BOT_SECRET` | 是 | 长连接 Secret |
| `WECOM_FORWARD_URL` | 否 | 入站转发 webhook |
| `WECOM_FORWARD_KEY` | 否 | 鉴权值（见 bridge.mjs 注释） |
| `WECOM_HTTP_PORT` | 否 | 默认 `8787` |

协议与官方文档：https://developer.work.weixin.qq.com/document/path/101463

## 本地 HTTP

- `GET /health`
- `POST /reply`
- `POST /send`

## 启动 / 停止

```bash
export WECOM_BOT_ID=... WECOM_BOT_SECRET=...
./start.sh
./stop.sh
```

同一 BotID **只能**保留一条长连接。
