import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolModule } from "./types.js";
import { fetchJson, UpstreamError } from "../upstream/http.js";

export const TOOL_NAME = "macro_gdp";
export const TOOL_PRICE = "$0.005";

const SOURCE = "BEA";
const SOURCE_URL = "https://www.bea.gov/data/gdp/gross-domestic-product";
const ENDPOINT = "https://apps.bea.gov/api/data";
/** NIPA Table 1.1.1: Percent Change From Preceding Period in Real GDP, quarterly. */
const TABLE = "T10101";
const GDP_LINE = "1";

interface BeaDatum {
  TimePeriod: string;
  LineNumber: string;
  DataValue: string;
}
interface BeaResponse {
  BEAAPI?: {
    Results?: { Data?: BeaDatum[] };
    Error?: unknown;
  };
}

export interface GdpResult {
  /** Quarter covered, e.g. "2026Q2". */
  asOf: string;
  /** Real GDP growth, annualized quarter-over-quarter percent change. */
  growthAnnualizedPercent: number;
  /** The two most recent prior quarters, newest first, for trend context. */
  priorQuarters: Array<{ quarter: string; growthAnnualizedPercent: number }>;
  source: string;
}

/** Turn a raw BEA NIPA response into the real GDP growth read. Pure; no network. */
export function computeGdp(body: BeaResponse): GdpResult {
  const err = body.BEAAPI?.Error;
  if (err) {
    throw new UpstreamError(SOURCE, `BEA API error: ${JSON.stringify(err).slice(0, 200)}`);
  }
  const points = (body.BEAAPI?.Results?.Data ?? [])
    .filter((d) => d.LineNumber === GDP_LINE && /^\d{4}Q[1-4]$/.test(d.TimePeriod))
    .map((d) => ({ quarter: d.TimePeriod, value: Number(d.DataValue) }))
    .filter((d) => Number.isFinite(d.value))
    .sort((a, b) => (a.quarter < b.quarter ? 1 : a.quarter > b.quarter ? -1 : 0));

  if (points.length === 0) {
    throw new UpstreamError(SOURCE, "response contained no quarterly GDP observations");
  }

  return {
    asOf: points[0].quarter,
    growthAnnualizedPercent: points[0].value,
    priorQuarters: points
      .slice(1, 3)
      .map((p) => ({ quarter: p.quarter, growthAnnualizedPercent: p.value })),
    source: SOURCE_URL,
  };
}

export async function getGdp(now = new Date(), apiKey?: string): Promise<GdpResult> {
  if (!apiKey) {
    throw new UpstreamError(SOURCE, "BEA_API_KEY is not configured");
  }
  const years = `${now.getUTCFullYear() - 1},${now.getUTCFullYear()}`;
  const params = new URLSearchParams({
    UserID: apiKey,
    method: "GetData",
    datasetname: "NIPA",
    TableName: TABLE,
    Frequency: "Q",
    Year: years,
    ResultFormat: "JSON",
  });
  return computeGdp(
    await fetchJson<BeaResponse>(`${ENDPOINT}?${params.toString()}`, { source: SOURCE }),
  );
}

const DESCRIPTION = `Latest U.S. real GDP growth rate, from BEA's National Income and Product Accounts.

Returns the annualized quarter-over-quarter growth rate for the most recent quarter (the headline "how is the economy growing" number), plus the prior two quarters for trend context. BEA publishes this table as a percent-change series already, so no growth-rate math is needed here.

When to use: reading the pace of economic growth, recession-risk context (two consecutive negative quarters), or macro backdrop for a market decision.

When NOT to use: you need GDP in dollar levels, expenditure-component detail (consumption, investment, government, net exports), or real-time/nowcast estimates (this is BEA's official, lagged release).

Args: none.

Returns structuredContent:
  {
    "asOf": "2026Q2",
    "growthAnnualizedPercent": 1.5,
    "priorQuarters": [
      { "quarter": "2026Q1", "growthAnnualizedPercent": 2.1 },
      { "quarter": "2025Q4", "growthAnnualizedPercent": 0.5 }
    ],
    "source": "https://www.bea.gov/data/gdp/gross-domestic-product"
  }`;

export const macroGdpTool: ToolModule = {
  name: TOOL_NAME,
  title: "US Real GDP Growth",
  description: DESCRIPTION,
  price: TOOL_PRICE,
  discovery: {
    inputSchema: { type: "object", properties: {} },
    output: {
      example: {
        asOf: "2026Q2",
        growthAnnualizedPercent: 1.5,
        priorQuarters: [{ quarter: "2026Q1", growthAnnualizedPercent: 2.1 }],
      },
    },
  },
  register(server: McpServer) {
    server.registerTool(
      TOOL_NAME,
      {
        title: "US Real GDP Growth",
        description: DESCRIPTION,
        inputSchema: {},
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async () => {
        // Let UpstreamError propagate: the gate must not settle payment for a failed fetch.
        const result = await getGdp(new Date(), globalThis.process?.env?.BEA_API_KEY);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          structuredContent: result as unknown as Record<string, unknown>,
          isError: false,
        };
      },
    );
  },
};
