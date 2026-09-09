#!/usr/bin/env node
/**
 * VEEWER MCP server (23002-1120).
 *
 * VEEWER'in salt okunur public API'sini MCP tool'lari olarak aciyor: bir AI asistani
 * kullanicinin modellerini listeleyebilir, birini bulup gomme kodunu alabilir. Yukleme, silme
 * ve yeniden adlandirma BILEREK yok -- yukleme kredi harciyor, silme ise bir agent'in elinde
 * geri donusu olmayan bir islem.
 *
 * Kimlik: VEEWER hesabindan alinan API anahtari, VEEWER_API_KEY ortam degiskeni.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  VeewerAccount,
  VeewerApiError,
  VeewerClient,
  VeewerEmbed,
  VeewerFolder,
  VeewerModel,
  VeewerModelList,
} from "./client.js";

const apiKey = process.env.VEEWER_API_KEY;
if (!apiKey) {
  // stderr'e yaziliyor: stdout MCP protokolunun kendisi, oraya yazilan her sey istemcinin
  // ayristirmasini bozar.
  process.stderr.write(
    "VEEWER_API_KEY is not set. Create a key at https://veewer.com/api-keys and pass it in the MCP server configuration.\n",
  );
  process.exit(1);
}

const client = new VeewerClient({ apiKey, baseUrl: process.env.VEEWER_API_URL });

const server = new McpServer({
  name: "veewer",
  version: "0.1.0",
});

/** Tool sonuclarinin ortak sarmalayicisi: hata mesaji kullaniciya okunabilir sekilde donsun. */
async function respond(run: () => Promise<unknown>) {
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

    return {
      content: [{ type: "text" as const, text: message }],
      isError: true,
    };
  }
}

/** Model listesi ve arama ayni ucu kullaniyor; ikisini ayri tool yapan sey niyet, adres degil. */
const listInput = {
  folderId: z.string().optional().describe("Only models in this folder."),
  limit: z.number().int().min(1).max(100).optional().describe("How many models to return (default 25)."),
  cursor: z.string().optional().describe("Pass the nextCursor from a previous call to get the next page."),
};

server.registerTool(
  "list_models",
  {
    title: "List models",
    description:
      "List the 3D models in the user's VEEWER storage, newest first. Returns each model's id, name, " +
      "status (active, processing or failed) and whether it has AR. Paged: pass the returned nextCursor to continue.",
    inputSchema: listInput,
  },
  async ({ folderId, limit, cursor }) =>
    respond(() => client.get<VeewerModelList>("/models", { folderId, limit, cursor })),
);

server.registerTool(
  "search_models",
  {
    title: "Search models",
    description: "Find the user's VEEWER models whose name contains the given text.",
    inputSchema: {
      query: z.string().min(1).describe("Text to look for in the model name."),
      ...listInput,
    },
  },
  async ({ query, folderId, limit, cursor }) =>
    respond(() => client.get<VeewerModelList>("/models", { search: query, folderId, limit, cursor })),
);

server.registerTool(
  "get_model",
  {
    title: "Get a model",
    description:
      "Read one VEEWER model by id: name, status, failure reason if the conversion failed, " +
      "AR availability and view count.",
    inputSchema: { modelId: z.string().min(1).describe("The model id.") },
  },
  async ({ modelId }) => respond(() => client.get<VeewerModel>(`/models/${encodeURIComponent(modelId)}`)),
);

server.registerTool(
  "list_folders",
  {
    title: "List folders",
    description: "List the user's VEEWER folders. Leave parentId empty for the top level.",
    inputSchema: { parentId: z.string().optional().describe("List the folders inside this folder.") },
  },
  async ({ parentId }) => respond(() => client.get<VeewerFolder[]>("/folders", { parentId })),
);

// Asagidaki uc tool ayni ucu cagiriyor. Ayri tool olmalarinin sebebi model degil kullanici:
// "gomme kodu ver", "paylasim linki ver" ve "goruntuleyici adresi" ayri niyetler, ve tek bir
// tool'un uc alanli JSON'una bakip dogru alani secmesini beklemek gereksiz bir adim.
server.registerTool(
  "get_embed_code",
  {
    title: "Get embed code",
    description:
      "Get a ready-to-paste HTML iframe that shows this VEEWER model on any website. " +
      "The width and height come from the model's viewer settings.",
    inputSchema: { modelId: z.string().min(1).describe("The model id.") },
  },
  async ({ modelId }) =>
    respond(async () => {
      const embed = await client.get<VeewerEmbed>(`/models/${encodeURIComponent(modelId)}/embed`);
      return { modelId: embed.modelId, iframeCode: embed.iframeCode };
    }),
);

server.registerTool(
  "get_share_link",
  {
    title: "Get share link",
    description: "Get the link that shows this VEEWER model in a browser, for sharing with anyone.",
    inputSchema: { modelId: z.string().min(1).describe("The model id.") },
  },
  async ({ modelId }) =>
    respond(async () => {
      const embed = await client.get<VeewerEmbed>(`/models/${encodeURIComponent(modelId)}/embed`);
      return { modelId: embed.modelId, shareUrl: embed.shareUrl, arUrl: embed.arUrl };
    }),
);

server.registerTool(
  "get_viewer_url",
  {
    title: "Get viewer URL",
    description: "Get the viewer URL of a VEEWER model, the address an iframe would point at.",
    inputSchema: { modelId: z.string().min(1).describe("The model id.") },
  },
  async ({ modelId }) =>
    respond(async () => {
      const embed = await client.get<VeewerEmbed>(`/models/${encodeURIComponent(modelId)}/embed`);
      return { modelId: embed.modelId, viewerUrl: embed.viewerUrl };
    }),
);

server.registerTool(
  "get_account",
  {
    title: "Get account summary",
    description:
      "Read the user's VEEWER plan, remaining credits and storage in use. Useful for answering " +
      "how much room is left before uploading more models.",
    inputSchema: {},
  },
  async () => respond(() => client.get<VeewerAccount>("/account")),
);

async function main() {
  await server.connect(new StdioServerTransport());
}

main().catch((error) => {
  process.stderr.write(`veewer-mcp failed to start: ${error}\n`);
  process.exit(1);
});
