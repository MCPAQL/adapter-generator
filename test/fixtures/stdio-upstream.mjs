// Minimal stdio MCP upstream for generated-adapter tests. It keeps per-process
// state so tests can tell a reused child from a fresh one.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

let calls = 0;
const server = new McpServer({ name: "stdio-fixture", version: "1.0.0" });

server.registerTool("echo", { inputSchema: { message: z.string() } }, async ({ message }) => ({
  content: [{ type: "text", text: message }],
  structuredContent: { message },
}));

server.registerTool("count", {}, async () => {
  calls += 1;
  return { content: [{ type: "text", text: String(calls) }], structuredContent: { calls, pid: process.pid } };
});

server.registerTool("env_keys", {}, async () => ({
  content: [{ type: "text", text: "env" }],
  structuredContent: {
    keys: Object.keys(process.env).sort(),
    secret: process.env.FIXTURE_SECRET ?? null,
  },
}));

server.registerTool("crash", {}, async () => {
  setImmediate(() => process.exit(3));
  return new Promise(() => {});
});

await server.connect(new StdioServerTransport());
