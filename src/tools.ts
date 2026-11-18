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
import { SCOPE_DELETE, SCOPE_READ, SCOPE_WRITE, isToolAllowed } from "./scopes.js";
import {
  VeewerAccount,
  VeewerApiError,
  VeewerClient,
  VeewerEmbed,
  VeewerFolder,
  VeewerModel,
  VeewerModelList,
  VeewerShareLink,
  VeewerUploadJob,
  VeewerVisitList,
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
 * tool says `destructiveHint: true` (23002-1148): the model, its files and its view count are gone
 * for good. It is still idempotent -- a second call on the same id answers "not found" and
 * removes nothing further.
 */
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const reversibleWrite = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const destructiveWrite = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } as const;
// upload_model (23002-1149): every call creates a new model and spends credits, so not idempotent;
// and the backend fetches whatever public URL the caller names, so this is the one tool that
// reaches beyond VEEWER (`openWorldHint: true`).
const creatingWrite = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;
// create_share_link (23002-1206): every call adds one more link, so not idempotent; nothing is
// overwritten and VEEWER talks to no other host, so additive and closed-world.
const additiveWrite = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;

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

  // The second write tool (23002-1147): same endpoint as rename_model, other field. `folderId`
  // travels as an explicit null for the top level -- JSON.stringify keeps null and drops
  // undefined, and the backend treats an absent field as "unchanged".
  whenGranted(SCOPE_WRITE, () => server.registerTool(
    "move_model",
    {
      title: "Move a model",
      description:
        "Move one VEEWER model into a folder, or to the top level, and return the model as get_model shows it. " +
        "The model keeps its name. Needs the \"Change your models\" permission on the API key or connection.",
      annotations: reversibleWrite,
      inputSchema: {
        modelId: z.string().min(1).describe("The model id."),
        folderId: z
          .string()
          .min(1)
          .nullable()
          .describe("The target folder id from list_folders, or null to move the model to the top level."),
      },
    },
    async ({ modelId, folderId }) =>
      respond("move_model", () => client.patch<VeewerModel>(`/models/${encodeURIComponent(modelId)}`, { folderId })),
  ));

  // The destructive tool (23002-1148), behind its own scope: "Delete your models" is a separate
  // box on the consent page and the key form, so a connection that may rename cannot delete.
  // No `confirm` argument on purpose -- a field the model fills in itself is not a safeguard;
  // the safeguard is the scope the user granted plus `destructiveHint`, which makes Claude ask
  // before calling. The backend answers 204, so the result text is built here.
  whenGranted(SCOPE_DELETE, () => server.registerTool(
    "delete_model",
    {
      title: "Delete a model",
      description:
        "Permanently delete one VEEWER model: the uploaded file, the viewer and AR files, the share link and the view " +
        "count are all removed and cannot be recovered. Use get_model first to confirm which model this is. " +
        "Needs the \"Delete your models\" permission on the API key or connection.",
      annotations: destructiveWrite,
      inputSchema: {
        modelId: z.string().min(1).describe("The id of the model to delete."),
      },
    },
    async ({ modelId }) =>
      respond("delete_model", async () => {
        await client.delete(`/models/${encodeURIComponent(modelId)}`);
        return { deleted: true, modelId };
      }),
  ));

  // Upload (23002-1149). The file is not in the call: the backend downloads the URL itself,
  // asynchronously -- a POST that downloaded, uploaded and converted in one request would be cut
  // by the edge (100 s on prod) long before a real model finished. So the tool returns an upload
  // id and the agent polls get_upload_status. Credits are spent when the conversion starts, not
  // when this tool answers; a refused upload spends none.
  whenGranted(SCOPE_WRITE, () => server.registerTool(
    "upload_model",
    {
      title: "Upload a model from a URL",
      description:
        "Start uploading a 3D model into VEEWER from a public https URL that ends with the file name and its extension " +
        "(for example https://example.com/models/house.rvt). VEEWER downloads the file itself; the call returns at once " +
        "with an upload id and status \"queued\". Poll get_upload_status every 10 seconds or so until the status is " +
        "\"completed\" (then follow the new model with get_model: its status goes processing -> active) or \"failed\" " +
        "(failureReason says why). An upload SPENDS CREDITS according to the file format and the file size, which VEEWER " +
        "measures after the download (see get_account creditCosts: credits below largeFileFromBytes, largeFileCredits at " +
        "or above it); if the size is unknown, assume largeFileCredits. Check the balance first and confirm the cost with " +
        "the user before uploading. Addresses on private networks are refused; " +
        "single files only (a zip archive is refused). Needs the \"Change your models\" permission on the API key or connection.",
      annotations: creatingWrite,
      inputSchema: {
        sourceUrl: z
          .string()
          .url()
          .describe("The https address of the file, ending with its name and extension. Must be reachable from the public internet."),
        name: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .optional()
          .describe("Display name for the new model; the file name is used when left out."),
        folderId: z
          .string()
          .min(1)
          .optional()
          .describe("The folder id from list_folders to put the model in; leave out for the top level."),
      },
    },
    async ({ sourceUrl, name, folderId }) =>
      respond("upload_model", () => client.post<VeewerUploadJob>("/models", { sourceUrl, name, folderId })),
  ));

  whenGranted(SCOPE_READ, () => server.registerTool(
    "get_upload_status",
    {
      title: "Get upload status",
      description:
        "Read the state of an upload started with upload_model: queued, downloading, uploading, completed (modelId is " +
        "set; use get_model for the conversion) or failed (failureReason; if modelId is set too, a refused model record " +
        "exists and can be deleted). Poll every 10 seconds or so; a large file can take minutes.",
      annotations: readOnly,
      inputSchema: { uploadId: z.string().min(1).describe("The id returned by upload_model.") },
    },
    async ({ uploadId }) =>
      respond("get_upload_status", () => client.get<VeewerUploadJob>(`/uploads/${encodeURIComponent(uploadId)}`)),
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

  // Folder writes (23002-1219). The backend owns every rule -- name rules, the plan gate, the
  // parent's owner, and that the hidden root container can be neither renamed nor deleted; these
  // registrations only mirror the name limit so an obviously bad call never leaves the process.
  const folderName = z
    .string()
    .trim()
    .min(1)
    .max(100)
    .describe("The folder name: 1 to 100 characters, no line breaks; surrounding spaces are removed.");

  whenGranted(SCOPE_WRITE, () => server.registerTool(
    "create_folder",
    {
      title: "Create a folder",
      description:
        "Create a VEEWER folder at the top level or inside another folder and return it as list_folders shows it; " +
        "its id can go straight into upload_model or move_model. Folder names do not have to be unique and every " +
        "call creates a new folder, so check list_folders first and reuse a folder that already has the name. " +
        "Folders are not included in every plan; a plan without them is refused with a plain-words reason. " +
        "Needs the \"Change your models\" permission on the API key or connection.",
      annotations: additiveWrite,
      inputSchema: {
        name: folderName,
        parentId: z
          .string()
          .min(1)
          .optional()
          .describe("The folder id from list_folders to create the new folder in; leave out for the top level."),
      },
    },
    async ({ name, parentId }) =>
      respond("create_folder", () => client.post<VeewerFolder>("/folders", { name, parentId })),
  ));

  whenGranted(SCOPE_WRITE, () => server.registerTool(
    "rename_folder",
    {
      title: "Rename a folder",
      description:
        "Change the name of one VEEWER folder and return it as list_folders shows it. The models and subfolders " +
        "inside are untouched. Sending the current name changes nothing. Needs the \"Change your models\" " +
        "permission on the API key or connection.",
      annotations: reversibleWrite,
      inputSchema: {
        folderId: z.string().min(1).describe("The folder id from list_folders."),
        name: folderName,
      },
    },
    async ({ folderId, name }) =>
      respond("rename_folder", () => client.patch<VeewerFolder>(`/folders/${encodeURIComponent(folderId)}`, { name })),
  ));

  // Destructive and recursive, hence its own scope and destructiveHint -- the same reasoning as
  // delete_model, and likewise no `confirm` argument: a field the model fills in is no safeguard.
  whenGranted(SCOPE_DELETE, () => server.registerTool(
    "delete_folder",
    {
      title: "Delete a folder and everything in it",
      description:
        "Permanently delete one VEEWER folder TOGETHER WITH EVERYTHING INSIDE IT: every subfolder, at any depth, " +
        "and every model in them (uploaded files, viewer and AR files, share links and view counts). Nothing can be " +
        "recovered. Before calling, use list_folders (with parentId) and list_models (with folderId) to see what the " +
        "folder holds and tell the user; to keep a model, move it out with move_model first. Needs the \"Delete your " +
        "models\" permission on the API key or connection.",
      annotations: destructiveWrite,
      inputSchema: {
        folderId: z.string().min(1).describe("The id of the folder to delete, from list_folders."),
      },
    },
    async ({ folderId }) =>
      respond("delete_folder", async () => {
        await client.delete(`/folders/${encodeURIComponent(folderId)}`);
        return { deleted: true, folderId };
      }),
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

  // Share links and their visits (23002-1206, backend 23002-1202). get_share_link above answers
  // "the" link -- the default one; these three are for the several-links-per-model case: one
  // labelled link per recipient, and the visits that come back through each. Against a backend
  // that predates the endpoints they answer a 404 tool error, so the deploy order is backend -> MCP.
  whenGranted(SCOPE_READ, () => server.registerTool(
    "list_share_links",
    {
      title: "List share links",
      description:
        "List every share link of one VEEWER model, the default one and any labelled links created for individual " +
        "recipients. Each link has its public token (the last part of url; visits name their link by it), url (viewer " +
        "page), arUrl (AR page, null when the model has no AR version), label (null for an unnamed link), isDefault " +
        "(the link the share button and the embed code use; get_share_link returns this one), expiresAt (null = never " +
        "expires), revokedAt (null while live; a revoked link no longer opens), viewCount and lastViewedAt. viewCount " +
        "counts every open, including the owner's own and automated link checkers in mail systems, so it is not the " +
        "number of people; use list_visits for what visitors actually did. Dates are ISO 8601 UTC.",
      annotations: readOnly,
      inputSchema: { modelId: z.string().min(1).describe("The model id.") },
    },
    async ({ modelId }) =>
      respond("list_share_links", () =>
        client.get<VeewerShareLink[]>(`/models/${encodeURIComponent(modelId)}/share-links`),
      ),
  ));

  whenGranted(SCOPE_WRITE, () => server.registerTool(
    "create_share_link",
    {
      title: "Create a share link",
      description:
        "Create one more share link for a VEEWER model, usually one per recipient, so the visits made through it can " +
        "be told apart (list_visits returns the link's token and label on every visit). Returns the new link as " +
        "list_share_links shows it: send its url (or arUrl for the AR page). The model's default link and the embed " +
        "code do not change. Every call creates a new link, so reuse a link from list_share_links when one with the " +
        "same label already exists. A model can have at most 20 links that are not revoked; an expiry in the past, a " +
        "bad label or the limit is refused with a plain-words reason. Needs the \"Change your models\" permission on " +
        "the API key or connection.",
      annotations: additiveWrite,
      inputSchema: {
        modelId: z.string().min(1).describe("The model id."),
        label: z
          .string()
          .trim()
          .max(100)
          .optional()
          .describe(
            "A name for the link, for example the recipient's name or company; it comes back on every visit made " +
              "through the link. At most 100 characters, no line breaks; surrounding spaces are removed. Leave out " +
              "for an unnamed link.",
          ),
        expiresAt: z
          .string()
          .datetime({ offset: true })
          .optional()
          .describe(
            "When the link should stop working, ISO 8601 (for example 2027-01-31T23:59:59Z). Must be in the future; " +
              "leave out for a link that never expires.",
          ),
      },
    },
    async ({ modelId, label, expiresAt }) =>
      respond("create_share_link", () =>
        client.post<VeewerShareLink>(`/models/${encodeURIComponent(modelId)}/share-links`, { label, expiresAt }),
      ),
  ));

  whenGranted(SCOPE_READ, () => server.registerTool(
    "list_visits",
    {
      title: "List share link visits",
      description:
        "List the visits made through the user's VEEWER share links, across all models, most recently active first. " +
        "A visit is one page load of the viewer page (page \"viewer\", also when embedded in another site) or the AR " +
        "page (page \"ar\"); it names its link by token and label and its model by modelId. Visits are recorded only " +
        "for accounts that have visit tracking switched on, and only from then on: an empty list may mean tracking is " +
        "off, not that nobody looked. The user's own visits (signed in, a browser marked with ?internal=1, automated " +
        "test browsers) are left out unless includeInternal is true. How to read a visit: activeMs counts only time " +
        "with real mouse, keyboard or touch input, so activeMs 0 with loadedMs null is typically an automated link " +
        "checker in a mail system, not a person; orbit, zoom, tools (measure, section, explode, walk) and views " +
        "(switching 3D/2D views) count interactions; ar counts AR button presses and arStarted says whether AR " +
        "actually started on the phone; fromQr means the AR page was opened by scanning the QR code on the desktop " +
        "viewer, so it is the same person on a second device. Several visits with the same viewerId are one browser " +
        "tab reloading or moving between pages, not several people. Times are ISO 8601 UTC, day is the UTC date. " +
        "Paged: pass the returned nextCursor to continue.",
      annotations: readOnly,
      inputSchema: {
        days: z
          .number()
          .int()
          .min(1)
          .max(180)
          .optional()
          .describe("How many days back to look (default 60, at most 180; older visits are not kept)."),
        includeInternal: z
          .boolean()
          .optional()
          .describe("Also return the user's own visits (internal: true). Default false."),
        limit: z.number().int().min(1).max(1000).optional().describe("How many visits to return (default 500)."),
        cursor: z.string().optional().describe("Pass the nextCursor from a previous call to get the next page."),
      },
    },
    async ({ days, includeInternal, limit, cursor }) =>
      respond("list_visits", () =>
        client.get<VeewerVisitList>("/visits", {
          days,
          includeInternal: includeInternal === undefined ? undefined : String(includeInternal),
          limit,
          cursor,
        }),
      ),
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
        "per file format (creditCosts). The cost depends on the file size: a file smaller than " +
        "largeFileFromBytes costs credits, a file at or above it costs largeFileCredits, and a null " +
        "largeFileFromBytes means every file of that format costs largeFileCredits. To answer how many more " +
        "models can be uploaded: divide availableCredit by the cost for that format and file size and round " +
        "DOWN to whole models; never report a fraction of a model. When the file size is not known, count " +
        "with largeFileCredits (the worst case) and say the number may be higher for smaller files. If " +
        "availableCredit is below the cost, say that file cannot be uploaded yet. Name the format beside " +
        "every count. Storage is a second, separate " +
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
