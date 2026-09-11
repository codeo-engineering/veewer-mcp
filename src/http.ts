#!/usr/bin/env node
/**
 * VEEWER MCP server, hosted over HTTP (23002-1127).
 *
 * The stdio entry point (`index.ts`) runs on one person's machine and serves one account. This
 * one runs on our own host and serves everybody, so the two differ in exactly one thing that
 * then decides the whole shape of the file: **the API key arrives with each request, not at
 * startup**.
 *
 * That is why a server is built per request. An `McpServer` created once and shared would be
 * holding the first caller's client, and every later caller would read the first caller's
 * models. The objects are cheap -- registering eight tools is a handful of allocations -- and
 * the alternative is a cross-account data leak, so the trade is not close.
 *
 * Transport decisions, both deliberate:
 *
 * - **Stateless** (`sessionIdGenerator: undefined`). There is no session to pin a caller to one
 *   instance, so the app can be restarted or scaled out without dropping anyone mid-conversation.
 *   Nothing is lost: the tools are reads, and no tool sends the client anything it did not ask
 *   for.
 * - **`enableJsonResponse: true`** -- reply with a plain JSON body instead of opening an SSE
 *   stream. Azure App Service's load balancer closes an idle connection at around 230 seconds, so
 *   a stream held open per caller would be dropped under the client rather than by it, and on a
 *   small shared plan those held connections are the resource we have least of.
 *
 * **No CORS headers are sent, on purpose.** This mirrors the backend's `[DisableCors]` on the
 * public API (23002-1115): an API key kept in browser JavaScript is readable by anyone who opens
 * the page, so this server is for server-to-server callers. A browser being unable to read the
 * response is the intended behaviour, not a bug to fix.
 */
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { unsupportedNodeMessage, VeewerClient, type VeewerClientOptions } from "./client.js";
import { challengeHeader, metadataPaths, protectedResourceMetadata, readOAuthConfig, TokenVerifier } from "./oauth.js";
import { createVeewerServer, SERVER_VERSION } from "./tools.js";

const nodeComplaint = unsupportedNodeMessage();
if (nodeComplaint) {
  console.error(nodeComplaint);
  process.exit(1);
}

const MCP_PATH = "/mcp";
const HEALTH_PATH = "/health";

/**
 * Tool arguments here are ids, page cursors and short search strings. Anything larger is not a
 * caller we serve, and this endpoint is public: the cap is read off the bytes actually received
 * rather than off `content-length`, which the sender controls.
 */
const MAX_BODY_BYTES = 1024 * 1024;

/** JSON-RPC reserves -32000..-32099 for implementation-defined errors; this one means "no key". */
const UNAUTHORIZED_CODE = -32001;

// A bad PORT must not be papered over: `listen(NaN)` binds a random free port, the host's probe
// never connects, and the only trace is a log line reading "listening on NaN".
const parsedPort = Number.parseInt(process.env.PORT ?? "", 10);
const port = Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : 3000;
const baseUrl = process.env.VEEWER_API_URL;

/**
 * OAuth (23002-1140) is on only when VEEWER_OAUTH_ISSUER is set -- see oauth.ts for why the
 * challenge must not be advertised against a backend that has OAuth switched off. Read at
 * startup so a malformed value stops the process here, not on the first caller.
 */
const oauth = readOAuthConfig(process.env);
const verifier = oauth ? new TokenVerifier(oauth) : null;

/**
 * The key travels in `x-api-key`, and ONLY there.
 *
 * `Authorization: Bearer` is deliberately not accepted, for two reasons that point the same way.
 * The backend refuses it on purpose (see `ApiKeyAuthenticationOptions`: the JwtBearer scheme's
 * `OnMessageReceived` claims that header for its own tokens), so accepting it here would mean
 * this server accepting a credential shape its own API rejects. And Bearer is where the OAuth
 * access token will arrive when OAuth is added -- spending the header now on a different kind of
 * secret would mean unpicking it later, with a period in between where an OAuth token is
 * mistaken for a key and rejected as an unknown one.
 */
function readApiKey(req: IncomingMessage): string | undefined {
  const header = req.headers["x-api-key"];
  return (Array.isArray(header) ? header[0] : header)?.trim() || undefined;
}

/** The OAuth access token, from `Authorization: Bearer` and nowhere else (never the query string). */
function readBearer(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (!header || !/^bearer\s+/i.test(header)) return undefined;
  return header.replace(/^bearer\s+/i, "").trim() || undefined;
}

/**
 * The transport-level refusal that makes a client start (or redo) the OAuth flow. Claude acts
 * only on a real 401 with this header -- a 200 carrying a tool error is shown to the model as
 * text and nothing happens. Without OAuth configured the header is omitted and the body says
 * where to get a key, exactly as before.
 */
function sendUnauthorized(res: ServerResponse, error: "invalid_token" | undefined, message: string): void {
  if (res.headersSent) {
    res.end();
    return;
  }

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (oauth) headers["www-authenticate"] = challengeHeader(oauth, error);

  res.writeHead(401, headers);
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: UNAUTHORIZED_CODE, message }, id: null }));
}

class BodyError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: number,
  ) {
    super(message);
  }
}

/**
 * The body is read here rather than handed to the transport unparsed, for three reasons: the size
 * cap has to be enforced on real bytes, malformed JSON should answer 400 instead of surfacing as
 * a transport failure, and the JSON-RPC method name is what makes a log line worth writing.
 */
async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;

    if (size > MAX_BODY_BYTES) {
      // -32600 (invalid request), not -32700 (parse error): nothing was parsed, and saying
      // "parse error" would send whoever reads the log looking for malformed JSON.
      throw new BodyError(`Request body is larger than ${MAX_BODY_BYTES} bytes.`, 413, -32600);
    }

    chunks.push(buffer);
  }

  if (size === 0) throw new BodyError("Request body is empty.", 400, -32600);

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new BodyError("Request body is not valid JSON.", 400, -32700);
  }
}

function sendError(res: ServerResponse, status: number, code: number, message: string): void {
  if (res.headersSent) {
    // The status line is already gone, so the only thing left that helps is ending the response:
    // otherwise the caller waits on an open socket until something upstream times it out.
    res.end();
    return;
  }

  // Shaped as JSON-RPC even when the failure is at the HTTP layer: the caller is an MCP client
  // and this is the only shape it can report to its user in words.
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}

/**
 * What the one log line per request is allowed to say. The JSON-RPC method is useful; the
 * arguments are not ours to write down (a search term is the user's data) and neither is the key,
 * which travels in a header precisely so it cannot end up in a log.
 */
interface RequestLog {
  path: string;
  rpc: string;
}

/** The JSON-RPC method, for the log line. */
function methodOf(body: unknown): string {
  if (typeof body === "object" && body !== null && "method" in body) {
    const method = (body as { method?: unknown }).method;
    if (typeof method === "string") return method;
  }

  return "unknown";
}

async function handleMcp(req: IncomingMessage, res: ServerResponse, log: RequestLog): Promise<void> {
  // Two credentials, one per request: an API key in x-api-key, or an OAuth access token in
  // Authorization: Bearer. The key wins when both are present -- it is the older, explicit
  // choice -- and a bearer is only looked at when OAuth is configured.
  const apiKey = readApiKey(req);
  const bearer = apiKey ? undefined : readBearer(req);
  let credential: VeewerClientOptions;

  if (apiKey) {
    credential = { apiKey, baseUrl };
  } else if (bearer && verifier) {
    // Verified HERE, before anything is forwarded: the spec forbids passing on a token that was
    // not issued for this server, and the backend would refuse it anyway -- but a 401 from
    // upstream would come back as a tool error, not as the challenge the client needs.
    const payload = await verifier.verify(bearer);
    if (!payload) {
      sendUnauthorized(res, "invalid_token", "The access token is invalid or has expired. Sign in again.");
      return;
    }

    credential = { accessToken: bearer, baseUrl };
  } else {
    // Answered before any call to the backend: a request with no credential is not the backend's
    // problem to diagnose, and this way an unauthenticated flood costs us no upstream traffic.
    sendUnauthorized(
      res,
      undefined,
      oauth
        ? "Sign in to VEEWER to use this server, or send an API key in the x-api-key header (https://veewer.com/api-keys)."
        : "Missing API key. Send it in the x-api-key header. Create one at https://veewer.com/api-keys.",
    );
    return;
  }

  let body: unknown;
  try {
    body = await readBody(req);
  } catch (error) {
    const status = error instanceof BodyError ? error.status : 400;
    const code = error instanceof BodyError ? error.code : -32600;
    sendError(res, status, code, error instanceof Error ? error.message : "Could not read the request body.");
    return;
  }

  log.rpc = methodOf(body);

  const server = createVeewerServer(new VeewerClient(credential), {
    // A failed tool is still a successful JSON-RPC response, so without this the access log
    // would read 200 through an outage.
    onToolError: (tool, message) => console.error(`tool ${tool} failed: ${message}`),
  });

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  /**
   * In JSON-response mode the SDK's promise settles only when the JSON reply is written. If the
   * caller disappears first -- a cancelled tool call, a client shutting down, the platform
   * cutting a slow request -- that reply is never written and the promise never settles.
   * Awaiting it on its own would suspend this function for good, and a suspended frame holds the
   * server, the transport and THE CALLER'S API KEY in memory for the life of the process. One
   * cancelled call is a leak; a client that retries is unbounded growth.
   */
  const disconnected = new Promise<void>((resolve) => {
    if (res.destroyed) resolve();
    else res.on("close", () => resolve());
  });

  try {
    await server.connect(transport);

    const handled = transport.handleRequest(req, res, body);
    // Whichever side loses the race is abandoned; an abandoned rejection with no handler is an
    // unhandled rejection, and Node ends the process over one of those -- taking every other
    // caller's request on this instance with it.
    handled.catch(() => {});

    await Promise.race([handled, disconnected]);
  } catch (error) {
    console.error(`mcp ${log.rpc} failed:`, error);
    sendError(res, 500, -32603, "The MCP server could not handle the request.");
  } finally {
    // In `finally`, so the disconnect path releases them too -- that is the whole point above.
    void transport.close().catch(() => {});
    void server.close().catch(() => {});
  }
}

async function route(req: IncomingMessage, res: ServerResponse, log: RequestLog): Promise<void> {
  let pathname: string;
  try {
    pathname = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`).pathname;
  } catch {
    sendError(res, 400, -32600, "Malformed request URL.");
    return;
  }

  log.path = pathname;

  if (pathname === HEALTH_PATH) {
    // Unauthenticated on purpose: this is what the host polls, and a health check that needs a
    // customer's key is a health check that stops working when a customer revokes one.
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", version: SERVER_VERSION, uptime: Math.round(process.uptime()) }));
    return;
  }

  if (oauth) {
    const paths = metadataPaths(oauth);
    if (pathname === paths.withPath || pathname === paths.root) {
      // Unauthenticated by definition: this is how a client learns where to authenticate.
      res.writeHead(200, { "content-type": "application/json", "cache-control": "public, max-age=300" });
      res.end(JSON.stringify(protectedResourceMetadata(oauth)));
      return;
    }
  }

  if (pathname !== MCP_PATH) {
    sendError(res, 404, -32600, `Not found. The MCP endpoint is POST ${MCP_PATH}.`);
    return;
  }

  if (req.method === "POST") {
    await handleMcp(req, res, log);
    return;
  }

  // GET would open the server-to-client SSE stream and DELETE would end a session. Stateless mode
  // has neither, so they are refused here instead of being built and then found empty.
  res.setHeader("allow", "POST");
  sendError(res, 405, -32600, "This server is stateless: use POST for every MCP request.");
}

const httpServer = createServer((req, res) => {
  const started = Date.now();
  const log: RequestLog = { path: "-", rpc: "-" };

  // One line per request, written from here rather than from each branch, because the lines that
  // matter most on a public endpoint are the refusals -- a run of 401s is how an attempt on the
  // keys announces itself, and every branch that returns early would otherwise be silent.
  res.on("close", () => {
    // The health check is what the host polls every few seconds; logging it would bury
    // everything else.
    if (log.path === HEALTH_PATH && res.statusCode === 200) return;

    console.log(`${req.method} ${log.path} ${log.rpc} ${res.statusCode} ${Date.now() - started}ms`);
  });

  void route(req, res, log).catch((error) => {
    console.error("mcp router failed:", error);
    sendError(res, 500, -32603, "The MCP server could not handle the request.");
  });
});

// Node closes an idle keep-alive socket after 5 seconds by default, while Azure App Service's
// front end keeps pooling it for far longer. That mismatch is the classic proxy-reuse race: the
// front end sends a request down a socket the app has just closed, the caller gets a 502, and
// nothing appears in the application log at all. Holding the socket longer than the front end
// does removes the race. `headersTimeout` must stay above `keepAliveTimeout`, and
// `requestTimeout` above the upstream deadline in `client.ts` plus the time to write a reply.
httpServer.keepAliveTimeout = 120_000;
httpServer.headersTimeout = 125_000;
httpServer.requestTimeout = 60_000;

httpServer.listen(port, () => {
  console.log(`veewer-mcp ${SERVER_VERSION} listening on ${port}, MCP at POST ${MCP_PATH}`);
});

// The host stops the app with SIGTERM and kills it shortly after -- five seconds on App Service
// Linux unless the platform setting is raised. `close()` on its own waits for idle keep-alive
// sockets too, which with the timeout above means it would never finish in time and every
// restart would end in a kill: hence closing the idle ones by hand, and a deadline under the
// platform's own.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    httpServer.close(() => process.exit(0));
    httpServer.closeIdleConnections();
    setTimeout(() => process.exit(0), 4_000).unref();
  });
}
