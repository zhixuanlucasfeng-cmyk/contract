# 扩展指南

## 加一个服务商（给已有工具加备份）

在对应的 `gateway/src/providers/<分类>.ts` 里，往工具的 `providers` 数组加一项。**它在数组里的位置就是优先级。**

```ts
{ id: 'my-search', needs: 'MY_SEARCH_API_KEY', probe: { query: 'test', limit: 1 },
  async *stream({ query, limit }, c) {
    const d = await json(await get(`https://api.example.com/search?q=${encodeURIComponent(query)}&n=${limit}`, c, { authorization: `Bearer ${c.key}` }));
    for (const x of d.items) yield hit('my-search', { title: x.name, url: x.link, snippet: x.summary, publish_time: x.date });
  } },
```

然后：
1. 把 `MY_SEARCH_API_KEY=` 加进 `.env.example`；
2. 重启网关。

**写法约定：**
- **输出结构：** `yield` 出来的条目必须是这个工具约定的统一结构，字段名统一，比如时间一律叫 `publish_time`，作者一律叫 `author`。可以用 `http.ts` 里的 `iso()` 和 `num()` 统一格式。
- **出错：**
  - HTTP 错误用 `get()` / `post()` 抛出，引擎会自动判断要不要换下一家；
  - 业务错误（返回 200 但内容是失败）就 `throw new Error(...)`，会被当成可切换的失败。
- **流式：** 上游本身能流式返回，就边读边 `yield`，这样中途切换才是真实的，参考 `scrape.ts` 里的 `jina`。
- **probe：** 给 `probe` 填一组最便宜的参数，worker 才能把冷却中的它自动救回来。
- **需要签名的接口**（OAuth、AWS SigV4、企查查式 MD5 签名……）：签名逻辑就写在 provider 里，凭证从 `c.key` 和 `process.env` 取。参考 `business.ts` 里的 `qichacha`。
- **数据来源：** 只用官方或公开 API，不抓有反爬保护的页面，不轮换账号或 IP 去规避限制。

## 加一个工具

在某个 provider 文件里加一个键：

```ts
my_tool: {
  category: 'Finance',                         // Search | Scrape | Social | Crypto | Finance | E-commerce | Business
  description: '一句话说清楚它做什么',
  params: { symbol: { type: 'string', required: true }, limit: { type: 'integer', default: 10 } },
  credits: 1,                                  // 每次成功调用扣的积分
  output: '{ symbol, date, value, source }',   // 写进 /v1/tools，给 Agent 看
  markdown: (x) => `- ${x.date}: ${x.value}`,  // format=markdown/text 时怎么显示
  dedupe: (x) => String(x.date),               // 流式续传时判断"这条发过没有"；单值结果用常量
  providers: [ /* 至少两家，主 + 备 */ ],
},
```

如果是新的分类文件，再在 `registry.ts` 里展开它。不用改别的地方：`/v1/tools`、MCP、后台和计费都会自动带上新工具。

## 接更多 Agent 客户端

- **支持 MCP 的：** 用 `mcp/dist/index.js --key … --url …` 这条命令，各家只是配置文件的格式不同。
- **不支持 MCP 的：** 直接调 HTTP 接口。工具列表从 `/v1/tools` 取，里面有 JSON Schema，可以直接转成 OpenAI、Gemini 等的 function calling 格式。
- **需要远程 MCP（HTTP 传输）的：** 可以在网关上加一个 Streamable HTTP 的 MCP 端点，复用同一个引擎。现在没做，等真有客户端需要再加。

## 改计费

- **改套餐：** `plans` 表，可以直接改数据，也可以在 `schema.sql` 里改默认值。
- **改单价：** 每个工具的 `credits` 字段。
- **按数据量计费：** 在 `server.ts` 的 `execute` 里，按返回的条数或字节数算出 `credits` 再交给 `db.record`。
