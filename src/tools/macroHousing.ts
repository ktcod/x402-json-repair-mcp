import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolModule } from "./types.js";
import { fetchJson, UpstreamError } from "../upstream/http.js";

export const TOOL_NAME = "macro_housing";
export const TOOL_PRICE = "$0.005";

const SOURCE = "Census";
const SOURCE_URL = "https://www.census.gov/construction/nrc/index.html";
const ENDPOINT = "https://api.census.gov/data/timeseries/eits/resconst";

type CensusResponse = string[][];

export interface HousingResult {
  /** Latest month covered, e.g. "2026-06". */
  asOf: string;
  /** Seasonally-adjusted annualized rate, thousands of units. */
  startsThousands: number | null;
  permitsThousands: number | null;
  startsMomPercent: number | null;
  permitsMomPercent: number | null;
  source: string;
}

interface Monthly {
  ym: string;
  value: number;
}

function rowsToMonthly(body: CensusResponse): Monthly[] {
  if (!Array.isArray(body) || body.length < 2) return [];
  const header = body[0];
  const valueIdx = header.indexOf("cell_value");
  const timeIdx = header.indexOf("time");
  const out: Monthly[] = [];
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

/** Turn parsed starts/permits series into the housing read. Pure; no network. */
export function computeHousing(starts: Monthly[], permits: Monthly[]): HousingResult {
  if (starts.length === 0 && permits.length === 0) {
    throw new UpstreamError(SOURCE, "response contained no monthly housing observations");
  }
  const latest = starts[0] ?? permits[0];
  const startsPrev = starts[0]
    ? starts.find((p) => p.ym === shiftMonths(starts[0].ym, -1))
    : undefined;
  const permitsPrev = permits[0]
    ? permits.find((p) => p.ym === shiftMonths(permits[0].ym, -1))
    : undefined;

  return {
    asOf: latest.ym,
    startsThousands: starts[0]?.value ?? null,
    permitsThousands: permits[0]?.value ?? null,
    startsMomPercent: starts[0] && startsPrev ? pct(starts[0].value, startsPrev.value) : null,
    permitsMomPercent: permits[0] && permitsPrev ? pct(permits[0].value, permitsPrev.value) : null,
    source: SOURCE_URL,
  };
}

async function fetchSeries(
  category: "ASTARTS" | "APERMITS",
  year: number,
  apiKey: string,
): Promise<Monthly[]> {
  const params = new URLSearchParams({
    // NOTE: "time" is deliberately NOT in `get` — Census's timeseries API errors with
    // "unknown variable 'time'" when it appears in both `get` and as a predicate. It comes
    // back in the response automatically regardless.
    get: "cell_value",
    for: "us:1",
    time: String(year),
    time_slot_id: "0",
    seasonally_adj: "yes",
    category_code: category,
    data_type_code: "TOTAL",
    key: apiKey,
  });
  return rowsToMonthly(
    await fetchJson<CensusResponse>(`${ENDPOINT}?${params.toString()}`, { source: SOURCE }),
  );
}

export async function getHousing(now = new Date(), apiKey?: string): Promise<HousingResult> {
  if (!apiKey) {
    throw new UpstreamError(SOURCE, "CENSUS_API_KEY is not configured");
  }
  const year = now.getUTCFullYear();
  const [startsThis, permitsThis] = await Promise.all([
    fetchSeries("ASTARTS", year, apiKey),
    fetchSeries("APERMITS", year, apiKey),
  ]);
  // Fetch the prior year too so month-over-month still works in January.
  const [startsPrev, permitsPrev] = await Promise.all([
    fetchSeries("ASTARTS", year - 1, apiKey),
    fetchSeries("APERMITS", year - 1, apiKey),
  ]);
  return computeHousing([...startsThis, ...startsPrev], [...permitsThis, ...permitsPrev]);
}

const DESCRIPTION = `Latest U.S. new residential construction: housing starts and building permits, seasonally-adjusted annualized rate.

Housing starts (ground broken) and permits (approved but not necessarily started, a leading indicator) are the two headline figures from the Census Bureau's New Residential Construction survey, reported at a seasonally-adjusted annualized rate in thousands of units.

When to use: gauging housing-market momentum, a leading indicator for construction activity (permits lead starts), macro context for rate-sensitive sectors.

When NOT to use: you need single-family vs multi-family breakdown, regional detail, or completions data.

Args: none.

Returns structuredContent:
  {
    "asOf": "2026-06", "startsThousands": 1427, "permitsThousands": 1380,
    "startsMomPercent": 19.0, "permitsMomPercent": 2.1,
    "source": "https://www.census.gov/construction/nrc/index.html"
  }

Figures are in thousands of units at a seasonally-adjusted annual rate (SAAR), the standard convention for this release.`;

export const macroHousingTool: ToolModule = {
  name: TOOL_NAME,
  title: "US Housing Starts & Permits",
  description: DESCRIPTION,
  price: TOOL_PRICE,
  discovery: {
    inputSchema: { type: "object", properties: {} },
    output: {
      example: {
        asOf: "2026-06",
        startsThousands: 1427,
        permitsThousands: 1380,
        startsMomPercent: 19.0,
      },
    },
  },
  register(server: McpServer) {
    server.registerTool(
      TOOL_NAME,
      {
        title: "US Housing Starts & Permits",
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
        const result = await getHousing(new Date(), globalThis.process?.env?.CENSUS_API_KEY);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          structuredContent: result as unknown as Record<string, unknown>,
          isError: false,
        };
      },
    );
  },
};
