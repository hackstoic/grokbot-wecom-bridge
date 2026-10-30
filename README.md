# grokbot-wecom-bridge

企微智能机器人长连接桥接：Node 版备份 + Cloudflare Workers/Durable Object 可部署实现。

目标仓库（尚未配置 remote / 未推送）：`hackstoic/grokbot-wecom-bridge`。

## 目录结构

```
grokbot-wecom-bridge/
├── README.md
├── .gitignore
├── docs/
│   └── compat-research.md          # 企微 × CF 出口兼容性调研
├── legacy-node/
│   ├── yunying/                    # 运营Bot Node 备份（含 /send-media）
│   │   ├── bridge.mjs
│   │   ├── start.sh / stop.sh
│   │   ├── package.json / package-lock.json
│   │   └── README.md
│   └── chanyan/                    # 产研Bot Node 备份（看门狗 / 扩展 health）
│       ├── bridge.mjs
│       ├── start.sh / stop.sh / run.sh
│       ├── package.json / package-lock.json
│       └── README.md
└── cloudflare/                     # Workers + Durable Object（TypeScript）
    ├── README.md
    ├── package.json
    ├── tsconfig.json
    ├── wrangler.toml               # 仅占位符
    └── src/
        ├── index.ts                # Worker：HTTP 鉴权 + cron 唤醒
        ├── bridge-do.ts            # DO：出站 WS / 心跳 / 转发 / API
        ├── protocol.ts
        └── types.ts
```

## 安全

备份时已排除：`*.env`、`*.log`、`inbox.jsonl`、`node_modules`、`*.pid`、`*.lock`、`*.bak*`、含真实会话的测试样例。  
`bridge.mjs` 本身从环境变量读 `WECOM_BOT_ID` / `WECOM_BOT_SECRET`，无硬编码密钥。  
`start.sh` 已改为只依赖标准 `WECOM_*` 环境变量（不再 source 被排除的 `.env`）。

## 迁移警告

**同一个 Bot ID 同时只能保留一条长连接。**  
从 Node 切到 Cloudflare 时：先停 Node 桥接，再启用 CF Worker；否则两边会互相踢线（`disconnected_event`）。

## 快速入口

- Cloudflare 部署说明：[`cloudflare/README.md`](./cloudflare/README.md)
- 兼容性调研：[`docs/compat-research.md`](./docs/compat-research.md)
