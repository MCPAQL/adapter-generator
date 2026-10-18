// Records every dispatched operation so batch guard tests can detect a bypass.
import { createServer } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const calls = [];
function fixtureServer() {
  const server = new Server({ name: "batch-guard-fixture", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    calls.push(request.params.name);
    const data = { calls: [...calls], params: request.params.arguments };
    return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data };
  });
  return server;
}

if (process.argv.includes("--http")) {
  const http = createServer(async (request, response) => {
    const server = fixtureServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    response.on("close", () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(request, response);
  });
  http.listen(0, "127.0.0.1", () => {
    process.stdout.write(`http://127.0.0.1:${http.address().port}/mcp\n`);
  });
} else {
  await fixtureServer().connect(new StdioServerTransport());
}
