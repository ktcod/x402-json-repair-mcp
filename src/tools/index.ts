import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolPriceSpec } from "../config.js";
import type { ToolModule } from "./types.js";
import { structuredJsonRepairTool } from "./structuredJsonRepair.js";
import { tabularToJsonTool } from "./tabularToJson.js";
import { treasuryYieldCurveTool } from "./treasuryYieldCurve.js";
import { blsCpiTool } from "./blsCpi.js";
import { onchainBalancesTool } from "./onchainBalances.js";
import { onchainPortfolioTool } from "./onchainPortfolio.js";
import { onchainCrossChainBalanceTool } from "./onchainCrossChainBalance.js";
import { onchainOraclePriceTool } from "./onchainOraclePrice.js";
import { onchainGasTool } from "./onchainGas.js";
import { edgarInsiderTransactionsTool } from "./edgarInsiderTransactions.js";
import { edgarFinancialsTool } from "./edgarFinancials.js";
import { edgar13fHoldingsTool } from "./edgar13fHoldings.js";
import { edgarFilingsFeedTool } from "./edgarFilingsFeed.js";
import { edgarFullTextSearchTool } from "./edgarFullTextSearch.js";
import { macroReleaseCalendarTool } from "./macroReleaseCalendar.js";
import { macroJobsTool } from "./macroJobs.js";
import { macroPceTool } from "./macroPce.js";
import { macroGdpTool } from "./macroGdp.js";
import { macroRetailSalesTool } from "./macroRetailSales.js";
import { macroHousingTool } from "./macroHousing.js";
import { macroEnergyTool } from "./macroEnergy.js";

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
  macroPceTool,
  macroGdpTool,
  macroRetailSalesTool,
  macroHousingTool,
  macroEnergyTool,
  macroReleaseCalendarTool,
  // SEC filings
  edgarInsiderTransactionsTool,
  edgarFinancialsTool,
  edgar13fHoldingsTool,
  edgarFilingsFeedTool,
  edgarFullTextSearchTool,
  // on-chain
  onchainBalancesTool,
  onchainPortfolioTool,
  onchainCrossChainBalanceTool,
  onchainOraclePriceTool,
  onchainGasTool,
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
