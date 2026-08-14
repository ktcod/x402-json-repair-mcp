import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolModule } from "./types.js";
import { fetchJson, UpstreamError } from "../upstream/http.js";

export const TOOL_NAME = "macro_pce";
export const TOOL_PRICE = "$0.005";

const SOURCE = "BEA";
const SOURCE_URL = "https://www.bea.gov/data/personal-consumption-expenditures-price-index";
const ENDPOINT = "https://apps.bea.gov/api/data";
/** NIPA Table 2.8.4: Price Indexes for Personal Consumption Expenditures by Major Type, Monthly. */
const TABLE = "T20804";
const HEADLINE_LINE = "1";
/** "PCE excluding food and energy" — the Fed's actual preferred core inflation measure. */
const CORE_LINE = "25";

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

export interface PceMeasure {
  index: number | null;
  yoyPercent: number | null;
  momPercent: number | null;
}

export interface PceResult {
  asOf: string;
  headline: PceMeasure;
  core: PceMeasure;
  source: string;
}

interface Monthly {
  ym: string;
  value: number;
}

function pointsForLine(data: BeaDatum[], line: string): Monthly[] {
  const out: Monthly[] = [];
  for (const d of data) {
    if (d.LineNumber !== line) continue;
    // BEA's monthly TimePeriod uses a literal "M" separator, e.g. "2026M01" (mirroring the
    // quarterly "2026Q1" convention) — NOT plain digits. Normalize to "YYYY-MM".
    const m = /^(\d{4})M(\d{2})$/.exec(d.TimePeriod);
    if (!m) continue;
    const value = Number(d.DataValue.replace(/,/g, ""));
    if (!Number.isFinite(value)) continue;
    out.push({ ym: `${m[1]}-${m[2]}`, value });
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

function measure(points: Monthly[]): PceMeasure {
  const latest = points[0];
  if (!latest) return { index: null, yoyPercent: null, momPercent: null };
  const yearAgo = points.find((p) => p.ym === shiftMonths(latest.ym, -12));
  const prevMonth = points.find((p) => p.ym === shiftMonths(latest.ym, -1));
  return {
    index: latest.value,
    yoyPercent: yearAgo ? pct(latest.value, yearAgo.value) : null,
    momPercent: prevMonth ? pct(latest.value, prevMonth.value) : null,
  };
}

/** Turn a raw BEA NIPA response into headline/core PCE inflation. Pure; no network. */
export function computePce(body: BeaResponse): PceResult {
  const err = body.BEAAPI?.Error;
  if (err) {
    throw new UpstreamError(SOURCE, `BEA API error: ${JSON.stringify(err).slice(0, 200)}`);
  }
  const data = body.BEAAPI?.Results?.Data ?? [];
  const headline = pointsForLine(data, HEADLINE_LINE);
  if (headline.length === 0) {
    throw new UpstreamError(SOURCE, "response contained no PCE observations");
  }
  return {
    asOf: headline[0].ym,
    headline: measure(headline),
    core: measure(pointsForLine(data, CORE_LINE)),
    source: SOURCE_URL,
  };
}

export async function getPce(now = new Date(), apiKey?: string): Promise<PceResult> {
  if (!apiKey) {
    throw new UpstreamError(SOURCE, "BEA_API_KEY is not configured");
  }
  // Two calendar years is enough to compute year-over-year for the latest month.
  const years = `${now.getUTCFullYear() - 1},${now.getUTCFullYear()}`;
  const params = new URLSearchParams({
    UserID: apiKey,
    method: "GetData",
    datasetname: "NIPA",
    TableName: TABLE,
    Frequency: "M",
    Year: years,
    ResultFormat: "JSON",
  });
  return computePce(
    await fetchJson<BeaResponse>(`${ENDPOINT}?${params.toString()}`, { source: SOURCE }),
  );
}

const DESCRIPTION = `The Fed's preferred inflation gauge: Personal Consumption Expenditures (PCE) price index, headline and core.

The Federal Reserve targets PCE inflation, not CPI, when setting policy. Returns the headline index and "PCE excluding food and energy" (the actual core measure the Fed watches), each with year-over-year and month-over-month percent change computed from BEA's published index levels.

When to use: Fed-policy reasoning, comparing the Fed's actual inflation target against CPI, macro research that specifically needs PCE rather than CPI.

When NOT to use: you want CPI (use bls_cpi, which is timelier and what headlines usually report) or category-level PCE detail.

Args: none.

Returns structuredContent:
  {
    "asOf": "2026-06",
    "headline": { "index": 129.5, "yoyPercent": 2.6, "momPercent": 0.3 },
    "core":     { "index": 131.2, "yoyPercent": 2.8, "momPercent": 0.2 },
    "source": "https://www.bea.gov/data/personal-consumption-expenditures-price-index"
  }`;

export const macroPceTool: ToolModule = {
  name: TOOL_NAME,
  title: "US PCE Inflation (Fed's Preferred Gauge)",
  description: DESCRIPTION,
  price: TOOL_PRICE,
  discovery: {
    inputSchema: { type: "object", properties: {} },
    output: {
      example: {
        asOf: "2026-06",
        headline: { index: 129.5, yoyPercent: 2.6, momPercent: 0.3 },
        core: { index: 131.2, yoyPercent: 2.8, momPercent: 0.2 },
      },
    },
  },
  register(server: McpServer) {
    server.registerTool(
      TOOL_NAME,
      {
        title: "US PCE Inflation (Fed's Preferred Gauge)",
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
        const result = await getPce(new Date(), globalThis.process?.env?.BEA_API_KEY);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          structuredContent: result as unknown as Record<string, unknown>,
          isError: false,
        };
      },
    );
  },
};
