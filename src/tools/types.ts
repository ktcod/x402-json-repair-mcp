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
  /**
   * Optional x402 Bazaar discovery metadata. Keep it COMPACT — it rides inside the payment
   * payload (the Coinbase CDP facilitator catalogs it on the first settled payment).
   */
  discovery?: {
    inputSchema: Record<string, unknown>;
    output?: { example?: unknown; schema?: Record<string, unknown> };
  };
  /** Register the tool on an MCP server instance. */
  register: (server: McpServer) => void;
}
