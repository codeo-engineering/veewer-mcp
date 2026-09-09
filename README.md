# @veewer/mcp

MCP server for [VEEWER](https://veewer.com). It lets an AI assistant read the 3D models in your
VEEWER account and hand you the embed code or share link for any of them — without you opening
the site.

Read-only by design: it can list and read, never upload, rename or delete.

Needs **Node.js 18 or newer** (20 LTS or newer recommended). On an older Node the server starts
but every call fails, so it refuses to start instead and says why.

## Setup

**1. Create an API key** at [veewer.com/api-keys](https://veewer.com/api-keys). It is shown once,
so copy it straight away.

**2. Add the server** to your MCP client configuration:

```json
{
  "mcpServers": {
    "veewer": {
      "command": "npx",
      "args": ["-y", "@veewer/mcp"],
      "env": {
        "VEEWER_API_KEY": "vwr_your_key_here"
      }
    }
  }
}
```

Restart the client and ask it something like *"list my VEEWER models"* or *"give me the embed code
for the armchair model"*.

## Tools

| Tool | What it does |
| --- | --- |
| `list_models` | Models in your storage, newest first, paged |
| `search_models` | Models whose name contains some text |
| `get_model` | One model: status, failure reason, AR availability, view count |
| `list_folders` | Your folders |
| `get_embed_code` | A ready-to-paste `<iframe>` for a model |
| `get_share_link` | The shareable link (and the AR link when the model has one) |
| `get_viewer_url` | The viewer URL an iframe would point at |
| `get_account` | Plan, remaining credits and storage in use |

## Configuration

| Variable | Required | Default |
| --- | --- | --- |
| `VEEWER_API_KEY` | yes | — |
| `VEEWER_API_URL` | no | `https://server.veewer.com/api/v1/public` |

`VEEWER_API_URL` only exists for testing against a non-production VEEWER instance.

## Under the hood

This package is a thin client over the VEEWER public API — the same key works there directly,
sent in the `x-api-key` header. The API reference is at
[server.veewer.com/api/v1/public/docs](https://server.veewer.com/api/v1/public/docs).

Requests are rate limited per key (60 per minute, 1000 per hour). Exceeding it returns a clear
message rather than a bare error.

## Development

```bash
npm install
npm run build
VEEWER_API_KEY=vwr_... node dist/index.js   # speaks MCP over stdio
```

## Publishing

```bash
npm login          # an account in the "veewer" npm organization
npm publish --access public
```

`prepublishOnly` runs the build, so the published `dist/` always matches `src/`.

## License

MIT
