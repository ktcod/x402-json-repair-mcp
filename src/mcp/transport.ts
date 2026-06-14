import { StreamableHTTPTransport } from "@hono/mcp";
import type { Context } from "hono";
import { createMcpServer } from "./server.js";

/**
 * Handle one stateless MCP JSON-RPC request over Streamable HTTP.
 * Works on Cloudflare Workers and Node (Hono Context is framework-portable).
 * `parsedBody` is the already-parsed request body (we read it once for payment gating).
 */
export async function handleMcpRequest(c: Context, parsedBody: unknown): Promise<Response> {
  const server = createMcpServer();
  const transport = new StreamableHTTPTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  const response = await transport.handleRequest(c, parsedBody);
  return response ?? new Response(null, { status: 202 });
}
