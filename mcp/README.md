# contract-mcp

MCP server for the [Contract](https://github.com/zhixuanlucasfeng-cmyk/contract) tool gateway. It gives your agent search, scraping, social, crypto, finance and company data behind one `ct_…` key, with automatic provider failover.

```sh
npx contract-mcp --key ct_… --url https://your-gateway
# Claude Code
claude mcp add contract -- npx contract-mcp --key ct_… --url https://your-gateway
```

- `tools/list` asks the gateway every time, so new tools appear without updating this package.
- `find_tools` searches the live catalog by keyword or category (Search, Scrape, Social, Crypto, Finance, E-commerce, Business).
- Tool calls stream from the gateway and send one MCP progress notification per result when the client asks for progress.

The key can also be passed through the `CONTRACT_KEY` and `CONTRACT_URL` environment variables.

MIT
