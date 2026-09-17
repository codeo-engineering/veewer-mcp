/**
 * The tools, and the server that carries them (23002-1127).
 *
 * These used to live in `index.ts`. They moved here when the package grew a second entry point:
 * `index.ts` speaks stdio on the user's own machine, `http.ts` serves the hosted server. A tool
 * defined in two places is a tool that drifts, and the two would answer differently for the same
 * account.
 *
 * The factory takes the client rather than building one, because the two entry points learn the
 * API key at different moments. stdio reads it once from the environment; the hosted server reads
 * it from each request, since every caller brings their own. A client captured at startup would
 * therefore be the wrong client for every hosted request but the first.
 *
 * ONE RULE FOR ANY TOOL ADDED HERE: it may answer the call it was given and nothing else. No
 * progress notifications, no logging messages, nothing the client did not ask for. The hosted
 * transport is stateless and has no channel back to the caller, so such a message would work
 * over stdio and be dropped in silence over HTTP -- a difference nobody would notice until a
 * user reported that the same tool behaves differently in two places.
 */
import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SCOPE_READ, SCOPE_WRITE, isToolAllowed } from "./scopes.js";
import {
  VeewerAccount,
  VeewerApiError,
  VeewerClient,
  VeewerEmbed,
  VeewerFolder,
  VeewerModel,
  VeewerModelList,
} from "./client.js";

export const SERVER_NAME = "veewer";

// Read rather than repeated. The repository bumps the version at the close of every day that
// changed the package, and a copy kept here would be a copy that is wrong by the next morning.
export const SERVER_VERSION: string = (
  createRequire(import.meta.url)("../package.json") as { version: string }
).version;

export interface ServerOptions {
  /**
   * Called when a tool answers with an error. It exists because a failed tool is still a
   * successful JSON-RPC response: without this the hosted server's access log reads 200 while
   * every call is failing, and an outage would be invisible in the only place we can see it.
   * The stdio entry leaves it unset -- its stdout is the protocol and its user is watching the
   * client anyway.
   */
  onToolError?: (tool: string, message: string) => void;

  /**
   * The scopes the caller's OAuth token carries (23002-1145). A tool whose scope is missing is
   * NOT registered, so the model never sees a tool it cannot use -- Claude's own handling of a
   * 403 was deliberately not relied on. `undefined` means "not known": an API key (its scopes
   * live only in the backend) or the stdio entry; every tool is registered and a scope the key
   * lacks comes back as the backend's 403 message, which names the fix.
   */
  grantedScopes?: string[];
}

/** Listing and searching share one endpoint; what makes them separate tools is intent, not address. */
const listInput = {
  folderId: z
    .string()
    .optional()
    .describe(
      "Only models in this folder. Leave empty for all models. A model at the top level has folderId null; " +
        "there is no top-level-only filter, so list all and keep the ones with a null folderId.",
    ),
  limit: z.number().int().min(1).max(100).optional().describe("How many models to return (default 25)."),
  cursor: z.string().optional().describe("Pass the nextCursor from a previous call to get the next page."),
};

/**
 * Annotations tell the client what a call does before it is made (Claude shows read-only tools
 * without a confirmation step) and the Connectors Directory review rejects a tool without
 * `readOnlyHint`/`destructiveHint` (23002-1140). `openWorldHint: false`: the tools talk to
 * VEEWER only, never to arbitrary hosts. A write tool declares `readOnlyHint: false` and says
 * whether it is destructive. The spec's wording for `destructiveHint: false` is "only additive
 * updates"; a rename overwrites the old name, so this is a judgement call: nothing is lost that
 * a second rename cannot put back, and Claude asks for confirmation on any non-read-only tool
 * either way. Repeating it with the same name changes nothing (`idempotentHint: true`). A delete
 * tool must say `destructiveHint: true`.
 */
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const reversibleWrite = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

export function createVeewerServer(client: VeewerClient, options: ServerOptions = {}): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  /**
   * The scope gate around `server.registerTool`. Every registration below goes through it, so a
   * new write tool cannot be added without naming the scope it needs. A thunk rather than a
   * pass-through of the arguments: `registerTool` is generic over the input schema and a
   * re-typed wrapper would lose the callback's argument inference.
   */
  const whenGranted = (scope: string, register: () => unknown): void => {
    if (isToolAllowed(options.grantedScopes, scope)) register();
  };

  /** Common wrapper for tool results: an error comes back readable instead of as a throw. */
  const respond = async (tool: string, run: () => Promise<unknown>) => {
    try {
      const result = await run();
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      const message =
        error instanceof VeewerApiError
          ? error.message
          : error instanceof Error
            ? error.message
            : String(error);

      options.onToolError?.(tool, message);

      return {
        content: [{ type: "text" as const, text: message }],
        isError: true,
      };
    }
  };

  whenGranted(SCOPE_READ, () => server.registerTool(
    "list_models",
    {
      title: "List models",
      description:
        "List the 3D models in the user's VEEWER storage, newest first. Returns each model's id, name, " +
        "status (active, processing or failed), format, the storage it takes in bytes and whether it has AR. " +
        "Paged: pass the returned nextCursor to continue.",
      annotations: readOnly,
      inputSchema: listInput,
    },
    async ({ folderId, limit, cursor }) =>
      respond("list_models", () => client.get<VeewerModelList>("/models", { folderId, limit, cursor })),
  ));

  whenGranted(SCOPE_READ, () => server.registerTool(
    "search_models",
    {
      title: "Search models",
      description: "Find the user's VEEWER models whose name contains the given text.",
      annotations: readOnly,
      inputSchema: {
        query: z.string().min(1).describe("Text to look for in the model name."),
        ...listInput,
      },
    },
    async ({ query, folderId, limit, cursor }) =>
      respond("search_models", () =>
        client.get<VeewerModelList>("/models", { search: query, folderId, limit, cursor }),
      ),
  ));

  whenGranted(SCOPE_READ, () => server.registerTool(
    "get_model",
    {
      title: "Get a model",
      description:
        "Read one VEEWER model by id: name, status, failure reason if the conversion failed, " +
        "format, storage taken in bytes, AR availability and view count.",
      annotations: readOnly,
      inputSchema: { modelId: z.string().min(1).describe("The model id.") },
    },
    async ({ modelId }) =>
      respond("get_model", () => client.get<VeewerModel>(`/models/${encodeURIComponent(modelId)}`)),
  ));

  // The first write tool (23002-1146). Registered only for a grant that carries models:write;
  // an API key always sees it and a read-only key gets the backend's 403 sentence back.
  whenGranted(SCOPE_WRITE, () => server.registerTool(
    "rename_model",
    {
      title: "Rename a model",
      description:
        "Change the display name of one VEEWER model and return the model as get_model shows it. " +
        "Only the name shown in VEEWER changes; the uploaded file is untouched. Sending the current name " +
        "changes nothing. Needs the \"Change your models\" permission on the API key or connection.",
      annotations: reversibleWrite,
      inputSchema: {
        modelId: z.string().min(1).describe("The model id."),
        // trim() first, exactly as the backend's ModelNameRules does, so a 200-char name with
        // surrounding spaces is not refused here and accepted there.
        name: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .describe("The new name: 1 to 200 characters, no line breaks; surrounding spaces are removed."),
      },
    },
    async ({ modelId, name }) =>
      respond("rename_model", () => client.patch<VeewerModel>(`/models/${encodeURIComponent(modelId)}`, { name })),
  ));

  whenGranted(SCOPE_READ, () => server.registerTool(
    "list_folders",
    {
      title: "List folders",
      description:
        "List the user's VEEWER folders. Leave parentId empty for the top level; a top-level folder has parentId null.",
      annotations: readOnly,
      inputSchema: { parentId: z.string().optional().describe("List the folders inside this folder.") },
    },
    async ({ parentId }) =>
      respond("list_folders", () => client.get<VeewerFolder[]>("/folders", { parentId })),
  ));

  // The three tools below call one endpoint. They are separate because of the user, not the model:
  // "give me the embed code", "give me a share link" and "the viewer address" are separate
  // intents, and expecting the caller to pick the right field out of one three-field JSON is a
  // step that need not exist.
  whenGranted(SCOPE_READ, () => server.registerTool(
    "get_embed_code",
    {
      title: "Get embed code",
      description:
        "Get a ready-to-paste HTML iframe that shows this VEEWER model on any website. " +
        "The width and height come from the model's viewer settings.",
      annotations: readOnly,
      inputSchema: { modelId: z.string().min(1).describe("The model id.") },
    },
    async ({ modelId }) =>
      respond("get_embed_code", async () => {
        const embed = await client.get<VeewerEmbed>(`/models/${encodeURIComponent(modelId)}/embed`);
        return { modelId: embed.modelId, iframeCode: embed.iframeCode };
      }),
  ));

  whenGranted(SCOPE_READ, () => server.registerTool(
    "get_share_link",
    {
      title: "Get share link",
      description: "Get the link that shows this VEEWER model in a browser, for sharing with anyone.",
      annotations: readOnly,
      inputSchema: { modelId: z.string().min(1).describe("The model id.") },
    },
    async ({ modelId }) =>
      respond("get_share_link", async () => {
        const embed = await client.get<VeewerEmbed>(`/models/${encodeURIComponent(modelId)}/embed`);
        return { modelId: embed.modelId, shareUrl: embed.shareUrl, arUrl: embed.arUrl };
      }),
  ));

  whenGranted(SCOPE_READ, () => server.registerTool(
    "get_viewer_url",
    {
      title: "Get viewer URL",
      description: "Get the viewer URL of a VEEWER model, the address an iframe would point at.",
      annotations: readOnly,
      inputSchema: { modelId: z.string().min(1).describe("The model id.") },
    },
    async ({ modelId }) =>
      respond("get_viewer_url", async () => {
        const embed = await client.get<VeewerEmbed>(`/models/${encodeURIComponent(modelId)}/embed`);
        return { modelId: embed.modelId, viewerUrl: embed.viewerUrl };
      }),
  ));

  whenGranted(SCOPE_READ, () => server.registerTool(
    "get_account",
    {
      title: "Get account summary",
      description:
        "Read the user's VEEWER plan, remaining credits, storage in use and the credit cost of one upload " +
        "per file format (creditCosts). To answer how many more models can be uploaded: divide " +
        "availableCredit by the credits of the format in question and round DOWN to whole models; never " +
        "report a fraction of a model, and if availableCredit is below the format's cost say that format " +
        "cannot be uploaded yet. Name the format beside every count. Storage is a second, separate " +
        "ceiling (usedStorageBytes against totalStorageBytes); a null totalStorageBytes means the quota is " +
        "unknown, not unlimited. usedStorageBytes already sums every model, and each model's own footprint is " +
        "its storageBytes; the storage a file not yet uploaded will take cannot be predicted from either — " +
        "say so rather than estimate.",
      annotations: readOnly,
      inputSchema: {},
    },
    async () => respond("get_account", () => client.get<VeewerAccount>("/account")),
  ));

  return server;
}
