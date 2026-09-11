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
| `get_model` | One model: status, failure reason, format, storage taken, AR availability, view count |
| `list_folders` | Your folders |
| `get_embed_code` | A ready-to-paste `<iframe>` for a model |
| `get_share_link` | The shareable link (and the AR link when the model has one) |
| `get_viewer_url` | The viewer URL an iframe would point at |
| `get_account` | Plan, remaining credits, storage in use and the credit cost of one upload per format |

## Configuration

| Variable | Required | Default | Used by |
| --- | --- | --- | --- |
| `VEEWER_API_KEY` | yes | — | stdio only |
| `VEEWER_API_URL` | no | `https://server.veewer.com/api/v1/public` | both |
| `PORT` | no | `3000` | hosted only |

`VEEWER_API_URL` only exists for testing against a non-production VEEWER instance.

## Running it as a hosted server

VEEWER hosts this server at **`https://mcp.veewer.com/mcp`**. Point an MCP client that supports the
Streamable HTTP transport at that URL and send your API key in the `x-api-key` header; nothing needs
to be installed. `https://mcp.veewer.com/health` reports the running version.

The package ships a second entry point that speaks MCP over HTTP instead of stdio, for hosting one
shared server rather than asking every user to run their own:

```bash
npm run build
PORT=3000 npm start        # POST /mcp, plus GET /health
```

The difference that shapes everything else: **the hosted server takes the API key from each
request**, in the `x-api-key` header, so one instance serves every account and each caller only
ever sees their own models. `VEEWER_API_KEY` is not used here — a key in the environment would be
one account's key for everybody.

The key goes in `x-api-key` and nowhere else. `Authorization: Bearer` is not accepted: the VEEWER
API refuses it too, and that header is reserved for the OAuth access token that a later version
will use.

It is stateless: every call is a self-contained `POST /mcp` that answers with a JSON body, with no
session and no long-lived stream, so it can be restarted or scaled without dropping anyone.
`GET /health` is unauthenticated and returns the version and uptime.

No CORS headers are sent, deliberately: an API key kept in browser JavaScript is readable by
anyone who opens the page, so this is a server-to-server endpoint. A browser failing to read the
response is the intended behaviour.

## Under the hood

This package is a thin client over the VEEWER public API — the same key works there directly,
sent in the `x-api-key` header. The API reference is at
[server.veewer.com/api/v1/public/docs](https://server.veewer.com/api/v1/public/docs).

Requests are rate limited per key, and the limits belong to the API rather than to this package —
they are listed in the reference above, and a request that exceeds one is reported with the
message the API itself returned.

## Development

```bash
npm install
npm run build
VEEWER_API_KEY=vwr_... npm run start:stdio   # speaks MCP over stdio
PORT=3000 npm start                          # speaks MCP over HTTP
```

## Publishing

```bash
npm login          # an account in the "veewer" npm organization
npm publish --access public
```

`prepublishOnly` runs the build, so the published `dist/` always matches `src/`.

## License

MIT
