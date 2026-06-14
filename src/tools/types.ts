import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * A self-contained tool module. The MCP/payment/deploy skeleton is tool-agnostic:
 * to add tool #2, create another module and add it to the registry in `tools/index.ts`.
 */
export interface ToolModule {
  /** MCP tool name (snake_case). */
  name: string;
  /** Human-friendly title. */
  title: string;
  /** Capability description shown to agents — the primary discovery/marketing surface. */
  description: string;
  /** USD price per call (e.g. "$0.01"). `null` = free, no x402 gate. */
  price: string | null;
  /** Register the tool on an MCP server instance. */
  register: (server: McpServer) => void;
}
