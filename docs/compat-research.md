# 企微长连接 × Cloudflare 出口兼容性调研

## 结论（摘要）

| 问题 | 结论 | 依据性质 |
| --- | --- | --- |
| 智能机器人长连接是否要求企业可信 IP / IP 白名单？ | **文档未要求**；长连接是客户端主动连 `wss://openws.work.weixin.qq.com`，官方对比表写明「无需固定的公网 IP」。企业可信 IP 主要约束**自建应用 API** 与 URL 回调模式。 | 文档明确（企微）+ 与自建应用规则对照（推断边界） |
| CF Workers/DO 能否建出站 WebSocket？ | **可以**。DO 可用标准 WebSocket 客户端连外部服务。 | 文档明确（CF） |
| 出站 WS 能否 hibernate？ | **不能**。「Hibernation is only supported when a Durable Object acts as a WebSocket server. Outgoing WebSockets do not hibernate.」 | 文档明确（CF） |
| 出站连接能撑多久、DO 会不会被赶走？ | 打开的出站连接最多约 **15 分钟**阻止驱逐；之后连接可能仍开着，但不再阻止驱逐，需 alarm/cron/请求续命。2026-06 起「Outbound connections keep Durable Objects alive」。 | 文档明确（CF） |
| 实际从 CF 出口连企微是否 100% 通？ | **未实测**（本任务不部署）。协议与 IP 规则上未见硬性阻挡；仍可能受企业侧风控、出口 IP 信誉、区域网络影响。 | 推断 |

## 企微依据

1. [智能机器人长连接](https://developer.work.weixin.qq.com/document/path/101463)
   - 地址：`wss://openws.work.weixin.qq.com`
   - 对比表：长连接「无需固定的公网 IP」
   - 鉴权：`aibot_subscribe` + BotID/Secret（非企业可信 IP）
   - 限制：**每个机器人同一时间只能一条有效长连接**；新 subscribe 踢旧连接（`disconnected_event`）
   - 全文未见「长连接须配置可信 IP」类表述

2. [企业可信 IP 说明（自建应用）](https://open.work.weixin.qq.com/help2/pc/21711)
   - 针对通讯录助手 / 自建应用等 API 调用来源 IP
   - **与智能机器人长连接是不同产品线**（推断：不直接套用）

3. 第三方说明（非官方，仅旁证）：阿里云 DataWorks 等接入文档写明长连接模式「IP 管控：不涉及」。

## Cloudflare 依据

1. [Use WebSockets · Durable Objects](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
   - Workers 与 DO 均可作 WebSocket **客户端**
   - 出站 WS **不**支持 hibernation
   - 出站打开时可阻止驱逐最长约 15 分钟

2. [Lifecycle of a Durable Object](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)
   - 无 pending I/O / 出站连接时，约 70–140s 空闲后可能被完全驱逐
   - 单次操作/连接阻止驱逐上限约 15 分钟；之后需新的 I/O 续命

3. [Outbound connections keep Durable Objects alive](https://developers.cloudflare.com/changelog/post/2026-06-19-outbound-connections-keep-dos-alive/)（2026-06-19）
   - 确认出站 TCP/WS 会 keep-alive DO，但仍有 15 分钟/连接上限

4. Cron：[`scheduled` handler](https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/) + [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/) 用于定期唤醒 DO。

## 本仓库的缓解措施

- DO alarm 每 30s ping（刷新 I/O 窗口 + 协议心跳）
- Worker cron 每 2 分钟 `ensureConnected`
- `disconnected_event` / stale / close → 指数退避重连
