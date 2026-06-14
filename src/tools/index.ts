import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolPriceSpec } from "../config.js";
import type { ToolModule } from "./types.js";
import { structuredJsonRepairTool } from "./structuredJsonRepair.js";

export type { ToolModule } from "./types.js";

/**
 * The full tool registry. This is the ONLY file that changes when adding a tool:
 * implement a new ToolModule and append it here.
 */
export const tools: ToolModule[] = [structuredJsonRepairTool];

export function registerTools(server: McpServer): void {
  for (const tool of tools) tool.register(server);
}

export interface PaidToolSpec extends ToolPriceSpec {
  title: string;
  description: string;
}

/** Specs for tools that require x402 payment (price !== null). */
export function paidToolSpecs(): PaidToolSpec[] {
  return tools
    .filter((t): t is ToolModule & { price: string } => t.price !== null)
    .map((t) => ({ name: t.name, defaultPrice: t.price, title: t.title, description: t.description }));
}
