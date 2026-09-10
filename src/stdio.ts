#!/usr/bin/env node
/**
 * VEEWER MCP server, stdio transport (23002-1120).
 *
 * This is the entry point that runs on the user's own machine, started by their MCP client. It
 * serves one account: the key comes from the environment once, at startup. The hosted server is
 * `http.ts`, which serves many accounts and takes the key from each request instead.
 *
 * The tools themselves live in `tools.ts` so both entry points expose exactly the same ones.
 *
 * This file used to be `index.ts`, which read as the package's main thing and hid the fact that
 * it is one of two transports.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { unsupportedNodeMessage, VeewerClient } from "./client.js";
import { createVeewerServer } from "./tools.js";

// Everything below goes to stderr: stdout is the MCP protocol itself here, and anything written
// there that is not a protocol message breaks the client's parsing.
const nodeComplaint = unsupportedNodeMessage();
if (nodeComplaint) {
  process.stderr.write(`${nodeComplaint}\n`);
  process.exit(1);
}

const apiKey = process.env.VEEWER_API_KEY;
if (!apiKey) {
  process.stderr.write(
    "VEEWER_API_KEY is not set. Create a key at https://veewer.com/api-keys and pass it in the MCP server configuration.\n",
  );
  process.exit(1);
}

const client = new VeewerClient({ apiKey, baseUrl: process.env.VEEWER_API_URL });

async function main() {
  // No `onToolError`: a failed tool is already reported to the one user watching this client,
  // and the only channel left here is stdout, which belongs to the protocol.
  await createVeewerServer(client).connect(new StdioServerTransport());
}

main().catch((error) => {
  process.stderr.write(`veewer-mcp failed to start: ${error}\n`);
  process.exit(1);
});
