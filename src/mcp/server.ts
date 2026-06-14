import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "../tools/index.js";

export const SERVER_NAME = "json-repair-mcp-server";
export const SERVER_VERSION = "0.1.0";

/** Build a fresh MCP server with all tools registered (stateless: one per request). */
export function createMcpServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );
  registerTools(server);
  return server;
}
