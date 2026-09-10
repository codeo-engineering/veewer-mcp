# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this
repository.

## What this is

`@veewer/mcp` is an MCP (Model Context Protocol) server that exposes a VEEWER user's own 3D models
to any MCP client — Claude Desktop, Claude Code, or a custom agent. It is a **thin client over the
VEEWER public API** (`api/v1/public`, built in YouTrack epic 23002-1115); the backend lives in the
separate `VEEWER-Backend` repository and owns every rule. Nothing here decides anything the backend
also decides — duplicate a rule and the two drift, and an MCP user ends up seeing different answers
than the website.

## Build & run

```bash
npm install
npm run build                                  # tsc -> dist/
VEEWER_API_KEY=vwr_... npm run start:stdio     # speaks MCP over stdio
PORT=3000 npm start                            # speaks MCP over HTTP
```

`npm start` is the hosted server, because that is the command a host runs by default; the stdio
one, which is what the npm package is for, needs its name spelled out.

There are no tests. Both transports are exercised by driving them by hand: stdio by sending
`initialize`, then `notifications/initialized`, then `tools/call` on stdin; HTTP by posting the
same JSON-RPC bodies to `/mcp` with an `accept: application/json, text/event-stream` header (the
transport rejects a request without it).

Under **stdio**, JSON-RPC travels on **stdout**, so anything written there that is not a protocol
message corrupts the stream — diagnostics go to stderr. This binds `stdio.ts` and `tools.ts`, the
two files that run under it: neither may ever `console.log`. `http.ts` is exempt, its stdout is
just a log. `tools.ts` reports errors through the optional `onToolError` callback instead of
writing them, precisely so the shared layer stays silent for the transport that needs it to be.

| Variable | Required | Default | Used by |
| --- | --- | --- | --- |
| `VEEWER_API_KEY` | yes | — | stdio only |
| `VEEWER_API_URL` | no | `https://server.veewer.com/api/v1/public` | both |
| `PORT` | no | `3000` | HTTP only |

## Layout

```
src/client.ts   # HTTP client, the response types the API returns, the Node version check
src/tools.ts    # the eight tools and the server factory -- shared by both entry points
src/stdio.ts    # stdio entry point: one account, key from the environment (bin/main point here)
src/http.ts     # HTTP entry point: many accounts, key from each request
```

`client.ts` performs no interpretation: it sends the key, and on a non-2xx response it surfaces the
`message` field the API returned. `tools.ts` registers the tools and wraps every handler in one
`respond()` helper so a failure comes back as tool output with `isError`, not as a thrown exception
that kills the process.

The two entry points differ in one thing, and everything else follows from it: **when the API key
arrives.** stdio reads it once at startup and serves one account. The hosted server reads it from
each request, so it builds a client, a server and a transport **per request** — a shared server
would be holding the first caller's key and would serve their models to everyone after them. The
objects are cheap; the alternative is a cross-account leak.

Two hosted-transport settings are load-bearing and should not be flipped without rereading this:
`sessionIdGenerator: undefined` (stateless — nothing pins a caller to one instance) and
`enableJsonResponse: true` (a JSON body instead of an SSE stream — Azure App Service drops an idle
connection at around 230 seconds, and held-open streams are the scarcest resource on a small
shared plan). Neither costs anything here, because every tool is a read and the server never sends
a message the client did not ask for. That last clause is a **rule for any tool added later**: a
tool that sends an unsolicited notification works over stdio and is dropped in silence over HTTP.

`enableJsonResponse` has a trap that cost a leak once and will again if the shape is changed. The
SDK settles the promise from `handleRequest` **only when the JSON reply is written**. If the
caller disconnects first, that never happens, so awaiting it alone suspends the handler forever
and the suspended frame holds the server, the transport and **the caller's API key** for the life
of the process. `handleMcp` therefore races the call against the response's `close` event and
cleans up in `finally`. Do not simplify that back into a bare `await`.

## Conventions

- **English everywhere in the repository** — code, comments, documentation, commit messages. The
  conversation with the owner may be Turkish; nothing that lands in git is.
- Commit messages say why, not what; the diff already says what.
- `CHANGELOG.md` follows Keep a Changelog and semantic versioning.

## Versioning and releases

Two rules, and which one applies depends on whether the package is live:

1. **Not published yet** (today): a version is bumped and tagged at the close of each day that
   changed the package.
2. **Once published**: CI/CD performs the bump on every push, and **nothing is pushed without the
   owner's explicit approval**.

Publishing needs an npm account in the `veewer` organization:

```bash
npm login
npm publish --access public      # prepublishOnly runs the build
```

`package.json`'s `files` allowlist decides what ships (`dist/`, `README.md`); it wins over
`.gitignore`, which is why `dist/` is ignored in git yet present in the tarball. Confirm with
`npm pack --dry-run` before publishing.

## Things that will bite

- **No secrets in this repository, ever.** The API key arrives from the environment or from the
  request, and is never written to a file, a URL or a log line. Keep it out of error messages too:
  it travels in a header precisely so it cannot end up in a logged URL. The hosted server writes
  one log line per request — method, path, JSON-RPC method, status, duration — and deliberately no
  key, no account and no tool arguments, since a search term is the user's data.
- **stdout is the protocol** under stdio. A stray `console.log` in `index.ts` or `tools.ts` breaks
  every client. `http.ts` is the exception, and only because nothing reads its stdout as protocol.
- The hosted server sends **no CORS headers**, matching `[DisableCors]` on the backend's public
  API. A key held in browser JavaScript is public; a browser being unable to read the response is
  the point, not a defect.
- **The key goes in `x-api-key` and nowhere else.** Accepting `Authorization: Bearer` looks like a
  free courtesy and is not: the backend refuses that header on purpose (its JWT scheme's
  `OnMessageReceived` claims it), so we would be accepting a shape our own API rejects, and it is
  where the OAuth access token will arrive — at which point a key and a token would be
  indistinguishable in the same header.
- Authorization is the API key alone. **OAuth 2.1 with protected-resource metadata is not
  implemented**, and it is what the connector directories require — that is the next piece of
  work on the hosted path, not an oversight. When it lands, `sendError` will need to carry a
  `WWW-Authenticate` header and the router will need `.well-known` paths that are anonymous; both
  are small today and neither has been pre-built.
- The API client has a **30 second deadline** on every call. It is a resource decision, not a
  backend rule: without it a stalled backend holds a hosted request until the platform cuts it.
- The repository is **private** while all repositories in the `codeo-engineering` organization are;
  it must be made public before the npm publish, because the package page links to it.
- The tools deliberately cover reads only. Adding a write tool means adding a write endpoint to the
  backend first, and that endpoint has to check the API key's `scope` claim — the backend issues it
  today but nothing reads it, so every existing read-only key would otherwise gain write access
  silently.
