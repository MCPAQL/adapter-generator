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

// Optional slow start, for tests that stop the adapter while the child is still starting.
// The pid file lets them check the child is reaped; EPIPE is ignored so only the adapter's
// cleanup, not a failed write, can end the child.
if (process.env.FIXTURE_PID_FILE) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(process.env.FIXTURE_PID_FILE, String(process.pid));
}
if (process.env.FIXTURE_START_DELAY_MS) {
  process.stdout.on("error", () => {});
  await new Promise((resolve) => setTimeout(resolve, Number(process.env.FIXTURE_START_DELAY_MS)));
}

await server.connect(new StdioServerTransport());
