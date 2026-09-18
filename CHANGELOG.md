# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Versioning rules for this repository (live since 1.0.0):

- The version is bumped **by hand** in `package.json`, recorded here, and tagged `vX.Y.Z` in the
  same commit; there is no CI/CD. Nothing is pushed or published without the owner's approval.
- Tool names, their arguments and their result shapes are the public contract: removing or
  renaming one, or changing an argument's meaning, is a **major** bump; a new tool or a new
  optional argument is a minor bump.

## [Unreleased]

## [1.0.0] - 2026-09-18

### Changed

- Stable contract. No code change from 0.9.0: the tool set (13 tools: read, rename, move,
  delete, upload from a URL), the `models:read` / `models:write` / `models:delete` scopes and the
  hosted server at `https://mcp.veewer.com/mcp` are what 1.x commits to. Measured before tagging:
  a narrowed (read-only) OAuth grant in claude.ai survived a token refresh without re-consent,
  and upload → rename → delete ran end to end against production.

## [0.9.0] - 2026-09-18

### Added

- `upload_model(sourceUrl, name?, folderId?)`: the last write tool of 23002-1142. The file is
  not in the call -- the backend downloads the public https URL itself, in the background --
  so the tool answers at once with an upload id and `status: "queued"`; `POST /models`
  answers 202. `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: false` (every
  call creates a model and spends credits), `openWorldHint: true` (the backend reaches the
  host the caller named). Registered only for a grant that carries `models:write`; API keys
  always see it. Needs backend 23002-1149.
- `get_upload_status(uploadId)`: read-only; `queued | downloading | uploading | completed |
  failed`. `completed` carries the new model's id, whose conversion is then followed with
  `get_model`.
- `VeewerClient.post` (JSON in, JSON out) beside `get`, `patch` and `delete`.

## [0.8.0] - 2026-09-18

### Added

- `delete_model(modelId)`: permanently deletes a model (source file, viewer and AR files, share
  link, view count). Calls `DELETE /models/{id}`; `readOnlyHint: false`, `destructiveHint: true`,
  `idempotentHint: true` (a second call on the same id answers "not found"). Registered only for
  an OAuth grant that carries `models:delete` -- its own consent box, so a connection allowed to
  rename cannot delete; API keys always see it and a key without the "Delete your models"
  permission gets the backend's 403 message. No `confirm` argument by design: the safeguard is
  the granted scope plus the destructive hint, not a field the model fills in. Needs backend
  23002-1148.
- `VeewerClient.delete` (no body in, no body out), sharing the deadline and error mapping with
  `get` and `patch`.

## [0.7.0] - 2026-09-17

### Added

- `move_model(modelId, folderId)`: moves a model into one of the user's folders, or to the top
  level with `folderId: null`. Same `PATCH /models/{id}` as `rename_model`, same reversible-write
  annotations, same `models:write` gate. Needs backend 23002-1147.

## [0.6.0] - 2026-09-17

### Added

- `rename_model(modelId, name)`: the first write tool. Calls `PATCH /models/{id}` on the public
  API and returns the model; `readOnlyHint: false`, `destructiveHint: false`,
  `idempotentHint: true`. Registered only for an OAuth grant that carries `models:write`; API
  keys always see it and a read-only key gets the backend's 403 message. Needs backend
  23002-1146.
- `VeewerClient.patch` (JSON in, JSON out) sharing the deadline and error mapping with `get`;
  a ProblemDetails `title` is now read as the error message too.

## [0.5.0] - 2026-09-17

### Added

- Scopes (`src/scopes.ts`): `models:read`, `models:write` and `models:delete`, the same
  vocabulary as the backend. Protected resource metadata lists all three and the `401` challenge
  asks for all three, so the VEEWER consent page can offer Changes/Delete as options. Needs
  backend 23002-1145.
- Tool registration is gated on the OAuth token's `scope` claim (`ServerOptions.grantedScopes`):
  a tool whose scope the grant lacks is not listed. API-key callers still see every tool; a
  scope the key lacks answers with the backend's 403 message. No write tool exists yet — the
  gate is what 1146 (`rename_model`) will register through.

### Changed

- A verified bearer token must carry `models:read`; one without it is refused as invalid.
- A bodiless `403` now reads "This key or connection does not allow that action." instead of
  "Request failed with status 403".

## [0.4.0] - 2026-09-11

### Added

- OAuth 2.1 sign-in for the hosted server: with `VEEWER_OAUTH_ISSUER` and `MCP_PUBLIC_URL` set it
  serves protected resource metadata, challenges unauthenticated calls with a `401` +
  `WWW-Authenticate`, verifies bearer tokens against the issuer's JWKS (audience-bound) and
  forwards them to the VEEWER API. API keys keep working. Needs backend 23002-1140.
- Tool annotations (`readOnlyHint` etc.) on all eight tools.
- The hosted server is live at `https://mcp.veewer.com/mcp` (Azure App Service Linux B1, East
  US; DNS-only in Cloudflare with an App Service managed certificate). README and the repository
  guide describe the deploy and the domain setup.

### Changed

- `VeewerClient` takes either `apiKey` or `accessToken`; new dependency `jose`.

## [0.3.0] - 2026-09-11

### Added

- `get_account` returns `creditCosts` (credits per upload for every format), `usedStorageBytes`
  and `totalStorageBytes` (null when the stored quota cannot be read); models carry `format` and
  `storageBytes`. The tool description tells the agent to count whole models, round down and
  name the format — until now it invented an average model size and a per-format cost.
  The fields are absent on backends before 23002-1130; every tool still works there.

## [0.2.1] - 2026-09-11

### Changed

- The `list_models`/`search_models` `folderId` input and the `list_folders` description now say
  that a top-level model or folder carries `null`, and that there is no top-level-only filter.
  Requires backend 23002-1129, which stops returning the unlistable root container id.

## [0.2.0] - 2026-09-10

### Added

- A second entry point, `dist/http.js`, that speaks the MCP Streamable HTTP transport, so the
  server can be hosted once for everybody instead of being run by each user. `npm start` runs it;
  `npm run start:stdio` runs the original.
- `PORT` (default 3000) and the endpoints `POST /mcp` and `GET /health`.

### Changed

- The tools moved out of the entry point into `tools.ts`, and the server is now built by a factory
  that takes the client. Both entry points build from it, so the two transports cannot end up
  offering different tools.
- `src/index.ts` became `src/stdio.ts`, and `bin`/`main` point at `dist/stdio.js`. "index" read as
  the package's main thing and hid the fact that it is one of two transports.
- Calls to the VEEWER API now time out after 30 seconds. Without a deadline a stalled backend
  holds a request until whatever sits in front of the server cuts it, and on a small instance
  those held requests are the scarcest resource there is.
- A 429 is no longer rewritten as "wait a minute": there are two windows per key and another per
  IP, all of them the backend's to define, so the API's own message is passed through. The README
  no longer quotes the numbers either.
- The Node version check moved into `client.ts`, the file that actually needs `fetch`, and now
  returns a message instead of calling `process.exit` — ending the process is an entry point's
  decision, not a library module's.

### Fixed

- **An aborted request used to leak its server, transport and the caller's API key for the life
  of the process.** In JSON-response mode the SDK settles its promise only when the reply is
  written, so a caller that disappears first — a cancelled tool call, a client shutting down, the
  platform cutting a slow request — left the handler suspended forever, holding all three in
  memory. The wait now ends on whichever comes first, disconnect or reply, and the cleanup runs in
  `finally`. Verified with 600 aborted mid-flight calls against an upstream that never answers:
  memory returns to its baseline instead of growing.
- A tool failure is a successful JSON-RPC response, so the hosted access log read `200` through
  an outage. Tool errors are now reported to the entry point and logged.
- Shutdown closed idle keep-alive connections nowhere, so `close()` could not finish inside the
  platform's stop window and every restart ended in a kill.
- `keepAliveTimeout` is raised above the platform front end's idle window, which is the
  proxy-reuse race that shows up as sporadic 502s with nothing in the application log.
- A malformed `PORT` bound a random port and the health probe then never connected; it now falls
  back to 3000.
- An error after the headers were sent left the response open until something timed it out.
- An oversized body was reported as a JSON parse error, which it is not.

### Notes

- The hosted server reads the API key **per request** (`x-api-key` only) and builds a server and
  client for that request alone. A shared instance would hold the first caller's key and serve
  their models to everyone after them. `Authorization: Bearer` is deliberately not accepted: the
  backend refuses it as well, because its JWT scheme claims that header, and it is where the
  OAuth access token will arrive.
- It is stateless (`sessionIdGenerator: undefined`) and replies with a JSON body rather than an
  SSE stream (`enableJsonResponse: true`). Both follow from where it runs: Azure App Service
  closes an idle connection at around 230 seconds, and held-open streams are the scarcest
  resource on a small shared plan. Nothing is lost, because every tool is a read and the server
  never sends anything unasked.
- No CORS headers are sent, matching the backend's decision for the public API: a key held in
  browser JavaScript is public, so this endpoint is server-to-server.
- Authorization is still the API key. OAuth 2.1 with protected-resource metadata, which is what
  the connector directories require, is deliberately not part of this release.

## [0.1.0] - 2026-09-09

### Added

- MCP server speaking stdio, published as `@veewer/mcp` and runnable with
  `npx -y @veewer/mcp`.
- Eight read-only tools over the VEEWER public API: `list_models`, `search_models`, `get_model`,
  `list_folders`, `get_embed_code`, `get_share_link`, `get_viewer_url` and `get_account`.
- API key authentication through the `VEEWER_API_KEY` environment variable, sent as the
  `x-api-key` header. `VEEWER_API_URL` overrides the base URL for testing against a non-production
  VEEWER instance.
- A Node.js version check at startup: the server needs Node 18 or newer for `fetch`, and on an
  older runtime it used to start, list its tools and then fail every call with
  `fetch is not defined`. `engines` in package.json does not prevent this — npm only warns — so
  the check refuses to start and names the version it found.
- Errors are reported with the message the API returned, so a revoked key or an unknown model
  reads as what it is rather than as a status code. A rate-limited request is reported as such.

### Notes

- Upload, rename and delete are deliberately absent in this version: uploading spends account
  credits and deleting cannot be undone, neither of which belongs in an agent's hands yet.

[Unreleased]: https://github.com/codeo-engineering/veewer-mcp/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/codeo-engineering/veewer-mcp/compare/v0.9.0...v1.0.0
[0.9.0]: https://github.com/codeo-engineering/veewer-mcp/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/codeo-engineering/veewer-mcp/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/codeo-engineering/veewer-mcp/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/codeo-engineering/veewer-mcp/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/codeo-engineering/veewer-mcp/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/codeo-engineering/veewer-mcp/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/codeo-engineering/veewer-mcp/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/codeo-engineering/veewer-mcp/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/codeo-engineering/veewer-mcp/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/codeo-engineering/veewer-mcp/releases/tag/v0.1.0
