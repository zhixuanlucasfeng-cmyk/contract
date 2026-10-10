# Contract

[English](README.md)

AI 智能体的统一工具网关：一个主密钥（`ct_…`）调用所有工具，服务商挂了自动换下一家，流式输出中途也能无缝切换。

- **统一主密钥：** 用户只拿一个 `ct_` 密钥；各家服务商的凭证、认证方式、限流和计费都由网关代管。
- **自动故障转移：** 5xx、429、超时、断网、凭证失效都会切到备用服务商；流式中途切换不重复、不中断；坏掉的服务商自动冷却，恢复后自动回来。
- **即插即用：** 用 MCP 一行接入 Claude Code、Codex、Cursor、Gemini CLI、opencode……；不支持 MCP 的走 HTTP。
- **动态工具发现：** `/v1/tools` 和 MCP 的 `find_tools` 实时返回当前可用的工具，网关加了新工具，客户端不用更新。

![后台](docs/screenshots/user.jpg)

覆盖 7 类 15 个工具、39 个服务商：搜索、新闻、网页抓取、社交、视频、加密行情、DEX、钱包、股票、宏观、A 股、商品、公司信息。其中 18 个服务商不需要密钥，不配置也能用。

```sh
git clone https://github.com/zhixuanlucasfeng-cmyk/contract && cd contract
cp .env.example .env && docker compose up -d --build     # 打开 http://localhost:8080
```

轻量版在 `lite/`：单进程 Node.js + SQLite，只有搜索和抓取，`node cli.mjs serve` 就能跑。

| 文档 | 内容 |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 分层、数据流、故障转移细节、数据表、后台任务、和原需求的差异 |
| [db/schema.sql](db/schema.sql) | 全部 DDL |
| [docs/DEPLOY.md](docs/DEPLOY.md) | 部署、配置、HTTP 接口、接入各种 Agent |
| [docs/EXTEND.md](docs/EXTEND.md) | 加服务商、加工具、接新客户端、改计费 |

结构：`gateway/`（TypeScript：Fastify、pg、ioredis、BullMQ）· `mcp/`（`contract-mcp`）· `dashboard/`（React + Tailwind）· `db/`

只用官方或公开 API：不做账号池、住宅 IP 轮换和浏览器指纹伪装，没有开放 API 的平台不接。

MIT License
