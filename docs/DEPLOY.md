# 部署与接入

## Docker 一键部署

```sh
cp .env.example .env          # 填 ADMIN_TOKEN 和你有的服务商密钥（都可以留空，留空的自动跳过）
docker compose up -d --build  # postgres + redis + gateway（:8080）+ worker
```

首次启动时，Postgres 会自动执行 `db/schema.sql`，包括三个套餐。

打开 <http://localhost:8080>：
- 选「管理员」，填 `ADMIN_TOKEN`：新建用户，新用户的主密钥只显示这一次；
- 选「用户」，填 `ct_…`：查看余额和调用记录，试用工具，重置密钥。

也可以用命令行开户：

```sh
docker compose exec gateway node dist/cli.js user create me@example.com pro
docker compose exec gateway node dist/cli.js topup 1 5000
```

## 配置

| 变量 | 说明 |
|---|---|
| `ADMIN_TOKEN` | 后台管理员令牌，必填 |
| `*_API_KEY` 等 | 各服务商凭证，见 `.env.example`；只有网关能看到，用户永远拿不到 |
| `CONTRACT_SETTINGS` | 按工具调整故障转移，例如 `{"web_search":{"timeoutMs":8000,"retries":1,"cooldownMs":60000,"failThreshold":2}}` |
| `CONTRACT_FAULTS` | 故障演练，例如 `{"jina":"drop:3","wikipedia":"500"}`，可选值：`"500"`、`"429"`、`"timeout"`、`"drop:N"` |
| `AUTH_FAIL_LIMIT` / `BLOCK_MINUTES` | 同一 IP 一分钟内错误密钥达到多少次，就封多少分钟（默认 20 次、10 分钟） |
| `TRUST_PROXY=1` | 部署在反向代理后面时打开，否则拿不到真实 IP |

## HTTP 接口

```
GET  /v1/tools                          全部工具，按分类给出 Schema、返回格式、示例、当前可用的服务商
POST /v1/tools/{name}/execute           { "params": {…}, "stream": false, "format": "json"|"markdown"|"text" }
                                        stream:true → application/x-ndjson：{"type":"item","data":…} … {"type":"done"}
GET  /v1/account/balance                余额、套餐、本期已用
GET  /v1/account/usage                  按天、按分类统计，最近调用（含故障转移经过），积分流水
POST /v1/account/rotate                 重置主密钥（旧的立刻失效）
```

认证用请求头 `Authorization: Bearer ct_…`。

错误统一为 `{ "error": { "code", "message" } }`：

| code | 含义 |
|---|---|
| `invalid_key` | 主密钥无效 |
| `ip_blocked` | 这个 IP 错误密钥太多，暂时被封 |
| `ip_not_allowed` | IP 不在白名单里 |
| `rate_limited` | 超过每分钟限额 |
| `no_credits` | 积分不够 |
| `unknown_tool` | 没有这个工具 |
| `bad_params` | 参数错误 |
| `upstream_failed` | 所有服务商都失败了 |

## 接入 Agent（MCP）

```sh
cd mcp && npm install && npm run build          # 发布到 npm 后：npx contract-mcp --key ct_… --url https://你的网关
```

| 客户端 | 一行配置 |
|---|---|
| Claude Code | `claude mcp add contract -- node /path/to/contract/mcp/dist/index.js --key ct_… --url http://localhost:8080` |
| Codex | `codex mcp add contract -- node /path/to/contract/mcp/dist/index.js --key ct_… --url http://localhost:8080` |
| Gemini CLI / opencode / Cursor / Windsurf / Claude Desktop | 在各自的 MCP 配置里加：`{"command":"node","args":["…/mcp/dist/index.js","--key","ct_…","--url","http://localhost:8080"]}` |
| LangChain / CrewAI 等框架 | 用它们的 MCP 适配器加载同一个命令；或者直接调 HTTP 接口 |

- MCP 客户端每次列工具，都会实时去问网关，所以网关新加的工具，客户端不用更新就能用。
- `find_tools` 可以按关键词或分类查找工具。
- 调用时如果客户端带了 `progressToken`，网关每流出一条结果，就会发一条 MCP 进度通知。

## 测试

```sh
cd gateway && npm test          # 故障转移引擎：5xx、中途断开、400 不重试、超时与冷却、日志、全部失败
```
