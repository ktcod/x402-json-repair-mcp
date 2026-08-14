import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolModule } from "./types.js";
import { fetchJson, UpstreamError } from "../upstream/http.js";

export const TOOL_NAME = "macro_energy";
export const TOOL_PRICE = "$0.005";

const SOURCE = "EIA";
const SOURCE_URL = "https://www.eia.gov/petroleum/";
const WTI_ENDPOINT = "https://api.eia.gov/v2/petroleum/pri/spt/data/";
const STOCKS_ENDPOINT = "https://api.eia.gov/v2/petroleum/stoc/wstk/data/";
const NATGAS_ENDPOINT = "https://api.eia.gov/v2/natural-gas/stor/wkly/data/";
/** WTI Cushing OK spot price series id. */
const WTI_SERIES = "RWTC";
/** Weekly U.S. ending stocks of crude oil, thousand barrels. */
const CRUDE_STOCKS_SERIES = "WCESTUS1";
/** Weekly U.S. total natural gas in underground storage, Bcf. */
const NATGAS_SERIES = "NW2_EPG0_SWO_R48_BCF";

interface EiaRow {
  period: string;
  value: string | number;
}
interface EiaResponse {
  response?: { data?: EiaRow[] };
  error?: string;
}

export interface EnergyResult {
  asOf: string;
  wtiSpotUsdPerBbl: number | null;
  crudeStocksThousandBbl: number | null;
  crudeStocksWowPercent: number | null;
  naturalGasStorageBcf: number | null;
  naturalGasStorageWowPercent: number | null;
  source: string;
}

function latestTwo(rows: EiaRow[] | undefined): [number | null, number | null] {
  const sorted = (rows ?? [])
    .map((r) => ({ period: r.period, value: Number(r.value) }))
    .filter((r) => Number.isFinite(r.value))
    .sort((a, b) => (a.period < b.period ? 1 : a.period > b.period ? -1 : 0));
  return [sorted[0]?.value ?? null, sorted[1]?.value ?? null];
}

function latestPeriod(rows: EiaRow[] | undefined): string | null {
  const sorted = [...(rows ?? [])].sort((a, b) =>
    a.period < b.period ? 1 : a.period > b.period ? -1 : 0,
  );
  return sorted[0]?.period ?? null;
}

function pct(newer: number | null, older: number | null): number | null {
  if (newer === null || older === null || older === 0) return null;
  return Math.round(((newer - older) / older) * 1000) / 10;
}

async function fetchSeries(url: string, seriesId: string, apiKey: string): Promise<EiaRow[]> {
  const params = new URLSearchParams({
    api_key: apiKey,
    frequency: "weekly",
    "facets[series][]": seriesId,
    "sort[0][column]": "period",
    "sort[0][direction]": "desc",
    length: "4",
  });
  params.append("data[0]", "value");
  const body = await fetchJson<EiaResponse>(`${url}?${params.toString()}`, { source: SOURCE });
  if (body.error) {
    throw new UpstreamError(SOURCE, `EIA API error: ${body.error}`);
  }
  return body.response?.data ?? [];
}

export async function getEnergy(apiKey?: string): Promise<EnergyResult> {
  if (!apiKey) {
    throw new UpstreamError(SOURCE, "EIA_API_KEY is not configured");
  }
  const [wtiRows, crudeRows, gasRows] = await Promise.all([
    fetchSeries(WTI_ENDPOINT, WTI_SERIES, apiKey),
    fetchSeries(STOCKS_ENDPOINT, CRUDE_STOCKS_SERIES, apiKey),
    fetchSeries(NATGAS_ENDPOINT, NATGAS_SERIES, apiKey),
  ]);

  if (wtiRows.length === 0 && crudeRows.length === 0 && gasRows.length === 0) {
    throw new UpstreamError(SOURCE, "no energy observations returned for any requested series");
  }

  const [wti] = latestTwo(wtiRows);
  const [crudeLatest, crudePrev] = latestTwo(crudeRows);
  const [gasLatest, gasPrev] = latestTwo(gasRows);

  return {
    asOf: latestPeriod(crudeRows) ?? latestPeriod(gasRows) ?? latestPeriod(wtiRows) ?? "",
    wtiSpotUsdPerBbl: wti,
    crudeStocksThousandBbl: crudeLatest,
    crudeStocksWowPercent: pct(crudeLatest, crudePrev),
    naturalGasStorageBcf: gasLatest,
    naturalGasStorageWowPercent: pct(gasLatest, gasPrev),
    source: SOURCE_URL,
  };
}

const DESCRIPTION = `Latest U.S. energy market data from the Energy Information Administration: WTI crude price, crude oil inventories, and natural gas storage.

Combines three EIA series that usually require separate lookups: the WTI Cushing spot price, weekly U.S. crude oil ending stocks (with week-over-week percent change), and weekly natural gas underground storage (with week-over-week percent change).

When to use: energy-sector context, inflation pass-through analysis (energy prices feed CPI/PCE), trading around the weekly EIA inventory releases.

When NOT to use: you need regional/PADD-level breakdowns, refined product prices (gasoline, diesel), or non-U.S. energy data.

Args: none.

Returns structuredContent:
  {
    "asOf": "2026-08-07",
    "wtiSpotUsdPerBbl": 84.77,
    "crudeStocksThousandBbl": 420000, "crudeStocksWowPercent": -1.2,
    "naturalGasStorageBcf": 3100, "naturalGasStorageWowPercent": 0.8,
    "source": "https://www.eia.gov/petroleum/"
  }`;

export const macroEnergyTool: ToolModule = {
  name: TOOL_NAME,
  title: "US Energy Markets (Crude & Natural Gas)",
  description: DESCRIPTION,
  price: TOOL_PRICE,
  discovery: {
    inputSchema: { type: "object", properties: {} },
    output: {
      example: {
        asOf: "2026-08-07",
        wtiSpotUsdPerBbl: 84.77,
        crudeStocksWowPercent: -1.2,
        naturalGasStorageWowPercent: 0.8,
      },
    },
  },
  register(server: McpServer) {
    server.registerTool(
      TOOL_NAME,
      {
        title: "US Energy Markets (Crude & Natural Gas)",
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
        const result = await getEnergy(globalThis.process?.env?.EIA_API_KEY);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          structuredContent: result as unknown as Record<string, unknown>,
          isError: false,
        };
      },
    );
  },
};
