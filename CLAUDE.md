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
| `VEEWER_OAUTH_ISSUER` | no | — (OAuth off) | HTTP only |
| `MCP_PUBLIC_URL` | with the issuer | — (must end in `/mcp`) | HTTP only |

## Layout

```
src/client.ts   # HTTP client, the response types the API returns, the Node version check
src/tools.ts    # the eight tools and the server factory -- shared by both entry points
src/stdio.ts    # stdio entry point: one account, key from the environment (bin/main point here)
src/http.ts     # HTTP entry point: many accounts, credential from each request
src/oauth.ts    # OAuth resource-server side: metadata, challenge header, JWKS token verification
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

## Hosting (the remote transport)

The HTTP server runs on **Azure App Service Linux B1** (measured 2026-09-11 from the Retail Prices
API: €0.0146/h ≈ €10.66/mo, $0.017/h ≈ $12.41/mo; the portal quoted 435.44 TRY/mo), created by
the owner on 2026-09-11:

- Resource group `veewer-mcp-rg`, plan `veewer-mcp-plan`, app `veewer-mcp`, East US, Node 22 LTS,
  no Application Insights. Host: `veewer-mcp-gmeaevgbframbwbv.eastus-01.azurewebsites.net`
  (Azure's "secure unique default hostname"; a custom domain can be bound later).
- Endpoints: `GET /health`, `POST /mcp`. App Service injects `PORT`; nothing else is needed.
- App settings: `SCM_DO_BUILD_DURING_DEPLOYMENT=true` (Oryx runs `npm install` + `npm run build`
  on the server, so the zip carries **source**, not `dist/`) and `VEEWER_API_URL`, which points at
  the **dev** backend until the prod publish that carries the public API; remove the setting then
  and the client falls back to `server.veewer.com`.
- Deploy from a checkout:

  ```powershell
  # zip package.json, package-lock.json, tsconfig.json, src/ — with FORWARD-slash entry names.
  # Windows Compress-Archive writes "src\client.ts" and Oryx then finds no src/ (measured: TS6053
  # "file not found" for every source file). Use python's zipfile or 7-Zip.
  az webapp deploy -g veewer-mcp-rg -n veewer-mcp --src-path veewer-mcp.zip --type zip
  ```

  Build logs live in Kudu: `az rest --url https://<app>.scm.eastus-01.azurewebsites.net/api/deployments`
  then `/api/deployments/{id}/log` and each entry's `details_url` — `az webapp log deployment show`
  only prints the summary ("Deployment Failed", no reason).
- First smoke test (2026-09-11, v0.3.0): `/health` 200, keyless `POST /mcp` 401, and with a dev
  API key `initialize` → `tools/list` (8 tools) → `get_account` / `list_models` / `get_share_link`
  all returned live data from veewerdev.
- **Public address: `https://mcp.veewer.com/mcp`** (same day). The `/mcp` after an `mcp.` host
  looks doubled but is the convention — Linear `mcp.linear.app/mcp`, Notion `mcp.notion.com/mcp`,
  Sentry `mcp.sentry.dev/mcp`, Cloudflare `*.mcp.cloudflare.com/mcp` — because `/health` and,
  later, `/.well-known/oauth-protected-resource` share the host; do not move the protocol to `/`.
  DNS is in Cloudflare (zone `veewer.com`) and **DNS-only (grey cloud), deliberately**: the free
  App Service managed certificate validates and renews through the CNAME, which a proxied record
  hides; the backend's reasons for sitting behind Cloudflare (client-IP resolution, IP rate
  limits) do not apply here, and Cloudflare's 100 s proxy timeout would only add a failure mode.
  Records: `CNAME mcp → veewer-mcp-gmeaevgbframbwbv.eastus-01.azurewebsites.net`,
  `TXT asuid.mcp → <customDomainVerificationId of the app>`. Azure side:
  `az webapp config hostname add`, then the certificate — `az webapp config ssl create` threw a
  JSON-decode error and created nothing, so it was done with an ARM `PUT
  Microsoft.Web/certificates/mcp.veewer.com` (`canonicalName` + `serverFarmId`), then
  `az webapp config ssl bind --ssl-type SNI`. Result: GeoTrust-issued managed cert valid to
  2027-03-11 (auto-renews), HTTPS-only on (HTTP answers 301). Verify with `curl`/Python, not
  Windows PowerShell 5.1's `Invoke-WebRequest` — its default TLS settings fail the handshake and
  look like a bad certificate.

## OAuth (the resource-server side, 23002-1140)

`src/oauth.ts` makes the hosted server an OAuth 2.1 resource server per the MCP authorization
spec (version 2026-07-28); the authorization server is the VEEWER backend (design and the
measured Claude requirements: VEEWER-Backend `docs/MCP-OAuth-Design-23002-1140.md`).

- Switched on by `VEEWER_OAUTH_ISSUER` + `MCP_PUBLIC_URL`. **Deliberately off without them**: the
  backend it points at may have `OAuth:Enabled=false`, and a `WWW-Authenticate` that names a 404
  metadata document sends every client into a dead discovery loop. Prod: issuer
  `https://server.veewer.com`, resource `https://mcp.veewer.com/mcp`. The resource must equal the
  URL users type, path included — Claude compares them literally.
- Unauthenticated `POST /mcp` → **401 + `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource/mcp", scope="models:read models:write models:delete"`**;
  a bad bearer adds `error="invalid_token"`. Only a transport-level 401 makes Claude start the
  flow; a 200 with `isError` is shown to the model as text. The challenge asks for **all three
  scopes** (23002-1145) so the consent page has Changes/Delete to untick. That Claude copies the
  challenge's `scope` rather than `scopes_supported` is **inference, not measured** — both said
  `models:read` in the 1140 run; check the `/oauth/authorize` query on the first live connection
  after deploy. A token narrowed to `models:read` is still accepted.
- **Scopes** (`src/scopes.ts`, same names as the backend's `ApiScopes`): the verified token's
  `scope` claim reaches `createVeewerServer` as `grantedScopes`, and every registration goes
  through `whenGranted(scope, …)` — a tool whose scope the grant lacks is **not registered**, so
  the model never sees it (Claude's own 403 handling is deliberately not relied on). API-key
  callers pass `grantedScopes: undefined` (the key's scopes live only in the backend) and see
  every tool; a scope the key lacks comes back as the backend's 403 text, which names the fix.
  A token without `models:read` is refused as `invalid_token` — the backend forces it into every
  grant, so its absence means the token is not one of ours.
- Protected resource metadata is served at both `/.well-known/oauth-protected-resource/mcp` (RFC
  9728 path form, tried first) and `/.well-known/oauth-protected-resource`.
- Bearer tokens are verified **locally** with `jose` against `{issuer}/.well-known/jwks.json`:
  RS256, `iss`, **`aud` = the resource** (a token the same issuer minted for another resource is
  refused — measured), `exp`, plus the backend's `purpose=mcp` and `uid` claims. Nothing is
  forwarded before that check. The verified token then goes to the public API as
  `Authorization: Bearer`; `VeewerClient` takes either `apiKey` or `accessToken`.
- `x-api-key` still works and wins when both are present.
- Every tool carries `annotations: readOnly` (`readOnlyHint`, `destructiveHint:false`,
  `idempotentHint`, `openWorldHint:false`) — the Connectors Directory review rejects tools
  without them.
- Local e2e recipe: backend on 5057 as `Environment.DEV` (the issuer is derived from
  `BackEndUrl`, so `PRODUCTION_DEV` would mint `iss=https://veewerdev…` and fail here) with
  `OAuth__Enabled=true`, `OAuth__SigningKeyPem=<pem>`, `OAuth__Resources__1=http://localhost:3001/mcp`;
  this server with `PORT=3001 VEEWER_API_URL=http://localhost:5057/api/v1/public
  VEEWER_OAUTH_ISSUER=http://localhost:5057 MCP_PUBLIC_URL=http://localhost:3001/mcp` (`http`
  is accepted for `localhost` only). Node lower-cases response header names — read
  `www-authenticate`, not `WWW-Authenticate`, in a test.

## Things that will bite

- **No secrets in this repository, ever.** The API key arrives from the environment or from the
  request, and is never written to a file, a URL or a log line. Keep it out of error messages too:
  it travels in a header precisely so it cannot end up in a logged URL. The hosted server writes
  one log line per request — method, path, JSON-RPC method, status, duration — and deliberately no
  key, no account and no tool arguments, since a search term is the user's data.
- **stdout is the protocol** under stdio. A stray `console.log` in `stdio.ts` or `tools.ts` breaks
  every client. `http.ts` is the exception, and only because nothing reads its stdout as protocol.
- The hosted server sends **no CORS headers**, matching `[DisableCors]` on the backend's public
  API. A key held in browser JavaScript is public; a browser being unable to read the response is
  the point, not a defect.
- **The key goes in `x-api-key` and nowhere else; `Authorization: Bearer` carries only the OAuth
  access token** (23002-1140). The backend tells the two credentials apart by header, and a key
  sent as a bearer is verified as a JWT and refused. When both arrive, the key wins.
- **A JWKS fetch failure is 503, never 401.** `TokenVerifier` separates jose's verdicts on the
  token (`ERR_JWT_*`, `ERR_JWS_*`, no matching key → 401 `invalid_token`) from the key set being
  unreachable (fetch failed, timeout, non-200 → 503 + `Retry-After`, no challenge header). jose
  does not fall back to a stale key set once `cacheMaxAge` (1 h) has passed, so a backend blip
  answered with 401 would have signed every OAuth user out. Ops rule that follows from local
  verification: after rotating `OAuth:SigningKeyPem` on the backend, restart this app (or have
  the backend publish both keys for an hour) — otherwise old-key tokens verify here for up to an
  hour and are refused upstream as a 200 tool error, which does not make Claude re-authenticate.
- The API client has a **30 second deadline** on every call. It is a resource decision, not a
  backend rule: without it a stalled backend holds a hosted request until the platform cuts it.
- The repository is **private** while all repositories in the `codeo-engineering` organization are;
  it must be made public before the npm publish, because the package page links to it.
- The tools cover reads only so far. Adding a write tool means adding a write endpoint to the
  backend first, guarded with `[Authorize(Policy = ApiScopes.ModelsWrite)]` (or `ModelsDelete`) —
  since 23002-1145 both the API-key and the OAuth scheme land in one `scope` claim and the policy
  name is the scope, so an unguarded endpoint is the only way an old read-only key gains write
  access. On this side the tool is registered through `whenGranted(SCOPE_WRITE, …)` with
  `readOnlyHint: false` (and `destructiveHint: true` for delete); registering it with the read
  annotations would make Claude skip its confirmation step.
