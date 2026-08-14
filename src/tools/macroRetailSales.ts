import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolModule } from "./types.js";
import { fetchJson, UpstreamError } from "../upstream/http.js";

export const TOOL_NAME = "macro_retail_sales";
export const TOOL_PRICE = "$0.005";

const SOURCE = "Census";
const SOURCE_URL = "https://www.census.gov/retail/index.html";
const ENDPOINT = "https://api.census.gov/data/timeseries/eits/marts";
/** "Retail and food services, total" less motor vehicles/parts — the ex-autos figure widely cited. */
const CATEGORY_TOTAL = "44X72";
const DATA_TYPE = "SM";

type CensusResponse = string[][];

export interface RetailSalesResult {
  /** Latest month covered, e.g. "2026-06". */
  asOf: string;
  /** Seasonally-adjusted monthly retail sales, millions of USD. */
  salesMillions: number;
  momPercent: number | null;
  yoyPercent: number | null;
  source: string;
}

function rowsToMonthly(body: CensusResponse): Array<{ ym: string; value: number }> {
  if (!Array.isArray(body) || body.length < 2) return [];
  const header = body[0];
  const valueIdx = header.indexOf("cell_value");
  const timeIdx = header.indexOf("time");
  const out: Array<{ ym: string; value: number }> = [];
  for (const row of body.slice(1)) {
    const value = Number(row[valueIdx]);
    const time = row[timeIdx];
    if (!Number.isFinite(value) || !/^\d{4}-\d{2}$/.test(time)) continue;
    out.push({ ym: time, value });
  }
  return out.sort((a, b) => (a.ym < b.ym ? 1 : a.ym > b.ym ? -1 : 0));
}

function shiftMonths(ym: string, delta: number): string {
  const [y, m] = ym.split("-").map(Number);
  const total = y * 12 + (m - 1) + delta;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`;
}

function pct(newer: number, older: number): number | null {
  if (!Number.isFinite(newer) || !Number.isFinite(older) || older === 0) return null;
  return Math.round(((newer - older) / older) * 1000) / 10;
}

/** Turn a raw Census MARTS response into the retail-sales read. Pure; no network. */
export function computeRetailSales(body: CensusResponse): RetailSalesResult {
  const points = rowsToMonthly(body);
  if (points.length === 0) {
    throw new UpstreamError(SOURCE, "response contained no monthly retail-sales observations");
  }
  const latest = points[0];
  const prevMonth = points.find((p) => p.ym === shiftMonths(latest.ym, -1));
  const yearAgo = points.find((p) => p.ym === shiftMonths(latest.ym, -12));
  return {
    asOf: latest.ym,
    salesMillions: latest.value,
    momPercent: prevMonth ? pct(latest.value, prevMonth.value) : null,
    yoyPercent: yearAgo ? pct(latest.value, yearAgo.value) : null,
    source: SOURCE_URL,
  };
}

export async function getRetailSales(
  now = new Date(),
  apiKey?: string,
): Promise<RetailSalesResult> {
  if (!apiKey) {
    throw new UpstreamError(SOURCE, "CENSUS_API_KEY is not configured");
  }
  const base = {
    // NOTE: "time" is deliberately NOT in `get` — Census's timeseries API errors with
    // "unknown variable 'time'" when it appears in both `get` and as a predicate. It comes
    // back in the response automatically regardless.
    get: "cell_value",
    time_slot_id: "0",
    category_code: CATEGORY_TOTAL,
    data_type_code: DATA_TYPE,
    seasonally_adj: "yes",
    key: apiKey,
  };
  // Always fetch this year AND last year: year-over-year needs 12 months of history, which a
  // single-year fetch only has once we are deep into the year. Fetching prior-year only on
  // failure (as an earlier version of this function did) silently leaves yoyPercent null for
  // most of the year, even though the fetch "succeeds".
  const year = now.getUTCFullYear();
  const [thisYear, lastYear] = await Promise.all(
    [year, year - 1].map((y) => {
      const params = new URLSearchParams({ ...base, time: String(y) });
      return fetchJson<CensusResponse>(`${ENDPOINT}?${params.toString()}`, { source: SOURCE });
    }),
  );
  const header = thisYear[0] ?? lastYear[0];
  return computeRetailSales([header, ...thisYear.slice(1), ...lastYear.slice(1)]);
}

const DESCRIPTION = `Latest U.S. retail sales, seasonally adjusted, excluding motor vehicles and parts — the "ex-autos" figure most commonly cited as a consumer-spending signal.

Returns the seasonally-adjusted monthly sales total in millions of dollars, with month-over-month and year-over-year percent change computed from the Census Bureau's Advance Monthly Retail Trade Survey.

When to use: gauging consumer spending strength, a component of GDP nowcasting, retail-sector demand signal.

When NOT to use: you need category-level detail (e.g. just electronics, or just restaurants), the auto-inclusive headline total, or real-time/weekly data (this is a monthly government release).

Args: none.

Returns structuredContent:
  {
    "asOf": "2026-06", "salesMillions": 766192,
    "momPercent": 0.9, "yoyPercent": 3.4,
    "source": "https://www.census.gov/retail/index.html"
  }`;

export const macroRetailSalesTool: ToolModule = {
  name: TOOL_NAME,
  title: "US Retail Sales",
  description: DESCRIPTION,
  price: TOOL_PRICE,
  discovery: {
    inputSchema: { type: "object", properties: {} },
    output: {
      example: { asOf: "2026-06", salesMillions: 766192, momPercent: 0.9, yoyPercent: 3.4 },
    },
  },
  register(server: McpServer) {
    server.registerTool(
      TOOL_NAME,
      {
        title: "US Retail Sales",
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
        const result = await getRetailSales(new Date(), globalThis.process?.env?.CENSUS_API_KEY);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          structuredContent: result as unknown as Record<string, unknown>,
          isError: false,
        };
      },
    );
  },
};
