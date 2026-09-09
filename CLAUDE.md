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
VEEWER_API_KEY=vwr_... node dist/index.js      # speaks MCP over stdio
```

There are no tests. The server is exercised end to end by driving it over stdio: send
`initialize`, then `notifications/initialized`, then `tools/call`. It talks JSON-RPC on **stdout**,
so anything written there that is not a protocol message corrupts the stream — diagnostics go to
stderr (see `src/index.ts`).

| Variable | Required | Default |
| --- | --- | --- |
| `VEEWER_API_KEY` | yes | — |
| `VEEWER_API_URL` | no | `https://server.veewer.com/api/v1/public` |

## Layout

```
src/client.ts   # HTTP client + the response types the API returns
src/index.ts    # tool registration and the stdio server
```

`client.ts` performs no interpretation: it sends the key, and on a non-2xx response it surfaces the
`message` field the API returned. `index.ts` registers the tools and wraps every handler in one
`respond()` helper so a failure comes back as tool output with `isError`, not as a thrown exception
that kills the process.

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

- **No secrets in this repository, ever.** The API key arrives from the environment and is never
  written to a file, a URL or a log line. Keep it out of error messages too: it travels in a header
  precisely so it cannot end up in a logged URL.
- **stdout is the protocol.** A stray `console.log` breaks every client.
- The repository is **private** while all repositories in the `codeo-engineering` organization are;
  it must be made public before the npm publish, because the package page links to it.
- The tools deliberately cover reads only. Adding a write tool means adding a write endpoint to the
  backend first, and that endpoint has to check the API key's `scope` claim — the backend issues it
  today but nothing reads it, so every existing read-only key would otherwise gain write access
  silently.
