import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "../tools/index.js";

// Renamed from "json-repair-mcp-server": the catalog grew from JSON repair to 21 tools spanning
// US government economic data, SEC EDGAR filings, and on-chain EVM reads. The name is also the
// only field the Official MCP Registry searches (substring match on name — title and description
// are NOT indexed), so it has to carry the keywords agents actually search for.
export const SERVER_NAME = "us-econ-sec-onchain-data-mcp";
export const SERVER_VERSION = "0.2.0";

/**
 * Human-facing service name shared by every x402 resource this server exposes.
 *
 * The Bazaar groups catalog entries by `serviceName`, so all 21 per-tool routes must report the
 * SAME value to appear as one coherent service rather than 21 unrelated listings.
 * Keep it short and ASCII: the CDP facilitator rejects payloads with oversized resource metadata.
 */
export const SERVICE_TITLE = "AgentFund US Economic, SEC & On-Chain Data";

/** Build a fresh MCP server with all tools registered (stateless: one per request). */
export function createMcpServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );
  registerTools(server);
  return server;
}
