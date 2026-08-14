import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolPriceSpec } from "../config.js";
import type { ToolModule } from "./types.js";
import { structuredJsonRepairTool } from "./structuredJsonRepair.js";
import { tabularToJsonTool } from "./tabularToJson.js";
import { treasuryYieldCurveTool } from "./treasuryYieldCurve.js";
import { blsCpiTool } from "./blsCpi.js";
import { onchainBalancesTool } from "./onchainBalances.js";
import { onchainPortfolioTool } from "./onchainPortfolio.js";
import { edgarInsiderTransactionsTool } from "./edgarInsiderTransactions.js";
import { macroReleaseCalendarTool } from "./macroReleaseCalendar.js";
import { macroJobsTool } from "./macroJobs.js";

export type { ToolModule } from "./types.js";

/**
 * The full tool registry. This is the ONLY file that changes when adding a tool:
 * implement a new ToolModule and append it here.
 *
 * Two families live here now:
 *  - pure compute (JSON repair, tabular parsing): no network, cannot fail upstream.
 *  - network-backed data (Treasury, BLS, on-chain RPC): fetches a public source and MUST throw
 *    on upstream failure so the payment gate skips settlement. See upstream/http.ts.
 */
export const tools: ToolModule[] = [
  // pure compute
  structuredJsonRepairTool,
  tabularToJsonTool,
  // macro / government data
  treasuryYieldCurveTool,
  blsCpiTool,
  macroJobsTool,
  macroReleaseCalendarTool,
  // SEC filings
  edgarInsiderTransactionsTool,
  // on-chain
  onchainBalancesTool,
  onchainPortfolioTool,
];

export function registerTools(server: McpServer): void {
  for (const tool of tools) tool.register(server);
}

export interface PaidToolSpec extends ToolPriceSpec {
  title: string;
  description: string;
  discovery?: ToolModule["discovery"];
}

/** Specs for tools that require x402 payment (price !== null). */
export function paidToolSpecs(): PaidToolSpec[] {
  return tools
    .filter((t): t is ToolModule & { price: string } => t.price !== null)
    .map((t) => ({
      name: t.name,
      defaultPrice: t.price,
      title: t.title,
      description: t.description,
      discovery: t.discovery,
    }));
}
