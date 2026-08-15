import { z } from "zod";
import Papa from "papaparse";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolModule } from "./types.js";
import { fetchText, UpstreamError } from "../upstream/http.js";

export const TOOL_NAME = "treasury_yield_curve";
export const TOOL_PRICE = "$0.005";

const SOURCE = "Treasury";
const SOURCE_URL = "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/";

/** Treasury publishes one CSV per calendar year of daily par yield curve rates. */
export function yieldCurveCsvUrl(year: number): string {
  return (
    "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/" +
    `daily-treasury-rates.csv/${year}/all?type=daily_treasury_yield_curve` +
    `&field_tdr_date_value=${year}&_format=csv`
  );
}

/** Treasury CSV column header -> canonical tenor key. */
const TENOR_KEYS: Record<string, string> = {
  "1 Mo": "1M",
  "1.5 Month": "6W",
  "2 Mo": "2M",
  "3 Mo": "3M",
  "4 Mo": "4M",
  "6 Mo": "6M",
  "1 Yr": "1Y",
  "2 Yr": "2Y",
  "3 Yr": "3Y",
  "5 Yr": "5Y",
  "7 Yr": "7Y",
  "10 Yr": "10Y",
  "20 Yr": "20Y",
  "30 Yr": "30Y",
};

export interface CurveDay {
  /** ISO date (YYYY-MM-DD). */
  date: string;
  /** Canonical tenor key -> percent yield. */
  tenors: Record<string, number>;
  /** 10Y minus 2Y in percentage points; null when either leg is missing. */
  spread2s10s: number | null;
  /** 10Y minus 3M in percentage points. */
  spread3m10y: number | null;
  /** True when 10Y sits below 2Y (the classic inversion signal). */
  inverted: boolean | null;
}

export interface YieldCurveResult {
  asOf: string;
  latest: CurveDay;
  history: CurveDay[];
  source: string;
}

function toIsoDate(mmddyyyy: string): string {
  const m = mmddyyyy.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return mmddyyyy.trim();
  const [, mm, dd, yyyy] = m;
  return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Parse Treasury's daily par yield CSV into newest-first curve days. Pure; no network. */
export function parseYieldCurveCsv(csv: string, limit = 1): CurveDay[] {
  const parsed = Papa.parse<Record<string, string>>(csv.trim(), {
    header: true,
    skipEmptyLines: true,
  });
  const rows = (parsed.data ?? []).filter((r) => r && r.Date);
  if (rows.length === 0) {
    throw new UpstreamError(SOURCE, "yield curve CSV contained no data rows");
  }

  const days: CurveDay[] = [];
  for (const row of rows.slice(0, Math.max(1, limit))) {
    const tenors: Record<string, number> = {};
    for (const [header, key] of Object.entries(TENOR_KEYS)) {
      const raw = row[header];
      if (raw === undefined || raw === "") continue;
      const value = Number(raw);
      if (Number.isFinite(value)) tenors[key] = value;
    }
    const y10 = tenors["10Y"];
    const y2 = tenors["2Y"];
    const m3 = tenors["3M"];
    days.push({
      date: toIsoDate(row.Date),
      tenors,
      spread2s10s: y10 !== undefined && y2 !== undefined ? round2(y10 - y2) : null,
      spread3m10y: y10 !== undefined && m3 !== undefined ? round2(y10 - m3) : null,
      inverted: y10 !== undefined && y2 !== undefined ? y10 < y2 : null,
    });
  }
  return days;
}

export async function getYieldCurve(days: number, now = new Date()): Promise<YieldCurveResult> {
  const year = now.getUTCFullYear();
  let parsed: CurveDay[];
  try {
    parsed = parseYieldCurveCsv(await fetchText(yieldCurveCsvUrl(year), { source: SOURCE }), days);
  } catch (e) {
    // Very early in January the current-year file can exist but be empty; fall back a year.
    if (!(e instanceof UpstreamError)) throw e;
    parsed = parseYieldCurveCsv(
      await fetchText(yieldCurveCsvUrl(year - 1), { source: SOURCE }),
      days,
    );
  }
  return { asOf: parsed[0].date, latest: parsed[0], history: parsed, source: SOURCE_URL };
}

const DESCRIPTION = `Current and recent U.S. Treasury par yield curve rates, with the spreads traders actually watch already computed.

Returns every published tenor (1 month through 30 years) for the latest business day, plus the 2s10s spread, the 3m10y spread, and an inversion flag. Source is the U.S. Treasury's official daily par yield curve (public domain, no attribution required).

When to use: you need risk-free rates for discounting, a read on the curve's shape, or recession-signal context (curve inversion).

When NOT to use: you need intraday quotes (this publishes once per business day) or non-U.S. sovereign curves.

Args:
  - days (integer, optional, default 1): how many recent business days to return, newest first (1-30).

Returns structuredContent:
  {
    "asOf": "2026-08-14",
    "latest": {
      "date": "2026-08-14",
      "tenors": { "1M": 3.79, "3M": 3.86, "2Y": 4.17, "10Y": 4.68, "30Y": 5.25 },
      "spread2s10s": 0.51,
      "spread3m10y": 0.82,
      "inverted": false
    },
    "history": [ ...same shape, newest first... ],
    "source": "https://home.treasury.gov/..."
  }`;

const inputSchema = {
  days: z
    .number()
    .int()
    .min(1)
    .max(30)
    .default(1)
    .describe("How many recent business days of the curve to return, newest first. Default 1."),
};

export const treasuryYieldCurveTool: ToolModule = {
  name: TOOL_NAME,
  title: "US Treasury Yield Curve",
  description: DESCRIPTION,
  price: TOOL_PRICE,
  discovery: {
    inputSchema: {
      type: "object",
      properties: {
        days: { type: "number", description: "Recent business days to return (1-30, default 1)." },
      },
    },
    inputExample: { days: 5 },
    output: {
      example: {
        asOf: "2026-08-14",
        latest: {
          date: "2026-08-14",
          tenors: { "3M": 3.86, "2Y": 4.17, "10Y": 4.68, "30Y": 5.25 },
          spread2s10s: 0.51,
          spread3m10y: 0.82,
          inverted: false,
        },
      },
    },
  },
  register(server: McpServer) {
    server.registerTool(
      TOOL_NAME,
      {
        title: "US Treasury Yield Curve",
        description: DESCRIPTION,
        inputSchema,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          // Reads a live upstream feed, unlike the pure-compute tools.
          openWorldHint: true,
        },
      },
      async ({ days }) => {
        // Let UpstreamError propagate: the gate must not settle payment for a failed fetch.
        const result = await getYieldCurve(days ?? 1);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          structuredContent: result as unknown as Record<string, unknown>,
          isError: false,
        };
      },
    );
  },
};
