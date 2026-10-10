# Contract Lite

一个主密钥（`ct_…`），让任何 AI Agent 用上所有工具。服务商挂了会自动换下一家，流式输出中途换也不让客户端看到报错。

单进程 Node.js + SQLite，零外部服务。完整版（Postgres / Redis / BullMQ / Docker / React 后台）见 `../contract`。

## 架构

```
Agent（Claude Code / Codex / Cursor / Power …）
   │  MCP（stdio）               │  HTTP
   ▼                             ▼
mcp.mjs ──── HTTP ────▶ server.mjs ── 认证（主密钥哈希、IP 白名单、每分钟限流、积分）
                           │
                           ▼
                       engine.mjs ── 按优先级试服务商；5xx / 429 / 超时 / 断网 → 下一家
                           │         流式：已发出的条目按去重键记住，换服务商后只补发新的
                           ▼
                     providers.mjs ── web_search: tavily → brave → wikipedia → duckduckgo
                                      web_scrape: firecrawl → jina → direct
```

**数据流：** 请求带主密钥 → 校验哈希、白名单、限流、余额 → 引擎按顺序调用服务商 → 每条结果统一成同一个结构 → 以 JSON、Markdown、纯文本或 NDJSON 流返回 → 扣积分、写调用记录（含故障转移经过）。

**故障转移规则：**
- **触发条件：** 5xx、429、超时（两条结果之间超过 `timeoutMs`）、连接失败，以及 401/403（服务商密钥坏了）。参数错误（400）直接返回，不换服务商。
- **重试与冷却：** 同一家先重试 `retries` 次；连续失败 `failThreshold` 次后进入冷却 `cooldownMs`，冷却期排到队尾；冷却结束自动回到原优先级。
- **流式中途切换：** 结果按"条"流出（搜索一条结果，抓取一段文字）。主服务商中途挂了，引擎记住已发的条目，去备用服务商重新请求，跳过已发过的，继续补后面的。客户端收到的是一条完整、不重复、以 `done` 结尾的流。
- **已知限制：** 备用服务商的内容可能和主服务商不完全一样。比如 direct 不执行 JavaScript，抓到的段落会比 Jina 少；去重只能保证不重复，不能保证一字不差。

## 数据表

```sql
create table keys (
  id integer primary key, hash text unique not null,      -- SHA-256(主密钥)，明文只在创建时显示一次
  hint text not null, name text not null,
  credits integer not null default 1000, per_minute integer not null default 60,
  ip_allow text not null default '',                      -- 逗号分隔，空 = 不限
  created text not null default (datetime('now')), revoked integer not null default 0);
create table usage (
  id integer primary key, key_id integer not null references keys(id),
  tool text not null, provider text, ok integer not null, ms integer not null,
  credits integer not null, failed_over text not null default '[]',   -- JSON：哪些服务商失败、原因
  at text not null default (datetime('now')));
```

## 运行

```sh
npm install
node cli.mjs key create --name me --credits 1000    # 打印 ct_…，只显示这一次
node cli.mjs serve                                  # http://127.0.0.1:7070，后台在 /dashboard
```

服务商密钥只放在网关这边：`~/.contract-lite/config.json`

```json
{ "secrets": { "TAVILY_API_KEY": "tvly-…", "BRAVE_API_KEY": "…", "FIRECRAWL_API_KEY": "fc-…" },
  "settings": { "web_search": { "timeoutMs": 8000, "retries": 1, "cooldownMs": 60000, "failThreshold": 2 } },
  "port": 7070, "host": "127.0.0.1" }
```

也可以用同名环境变量。没配密钥的服务商会被自动跳过；wikipedia、duckduckgo、jina、direct 不需要密钥，所以不配也能用。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/tools` | 按分类返回全部工具：说明、参数 Schema、返回格式、示例、服务商顺序 |
| POST | `/v1/tools/{name}/execute` | `{ "params": {…}, "stream": false, "format": "json" \| "markdown" \| "text" }`；`stream: true` 时返回 NDJSON：`{type:"item"}…{type:"done"}` |
| GET | `/v1/account/balance` | 剩余积分、已用积分 |
| GET | `/v1/account/usage` | 按天统计、最近调用（含故障转移经过）、服务商健康状态 |
| POST | `/v1/account/rotate` | 重置主密钥：账户不变，旧密钥立刻失效 |

认证方式：请求头 `Authorization: Bearer ct_…`，或 `x-api-key: ct_…`。
错误统一为 `{ "error": { "code", "message" } }`：`invalid_key`、`ip_not_allowed`、`rate_limited`、`no_credits`、`bad_params`、`upstream_failed`。

## 接入 Agent（MCP）

```sh
# Claude Code
claude mcp add contract -- node /path/to/contract-lite/cli.mjs mcp --key ct_…
# Codex
codex mcp add contract -- node /path/to/contract-lite/cli.mjs mcp --key ct_…
```

其他支持 MCP stdio 的客户端（Cursor、Gemini CLI、opencode……）同理，命令都是 `node cli.mjs mcp --key ct_… [--url http://网关地址]`。

MCP 客户端每次列工具都会去问网关，所以服务端新加的工具，客户端不用更新就能看到。Agent 也可以调 `find_tools`，按关键词或分类查找工具。

## 测故障转移

```sh
# 在本机制造故障："500"、"429"、"timeout"、"drop:N"（发完 N 条后断开）
CONTRACT_FAULTS='{"jina":"drop:3"}' node cli.mjs serve
CONTRACT_FAULTS='{"wikipedia":"500"}' node cli.mjs serve
npm test     # 引擎单元测试：5xx 切换、中途断开拼接、不重试 400、超时与冷却、全部挂掉
```

## 扩展

- **新增服务商：** 在 `providers.mjs` 对应工具的 `providers` 数组里加一项：`{ id, needs: '环境变量名', async *stream(params, { key, signal }) { …yield 统一格式的条目 } }`。在数组里的位置就是它的优先级。
- **新增工具：** 在 `TOOLS` 里加一个键，写好 `category`、`description`、`params`、`credits`、`dedupe` 和 `providers`。它会自动出现在 `/v1/tools` 和 MCP 里。
- **新的 Agent 客户端：** 能用 MCP 的直接接；不能用的就走 HTTP 接口。
