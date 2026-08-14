import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolModule } from "./types.js";
import { fetchJson, UpstreamError } from "../upstream/http.js";

export const TOOL_NAME = "bls_cpi";
export const TOOL_PRICE = "$0.005";

const SOURCE = "BLS";
const SOURCE_URL = "https://www.bls.gov/cpi/";
const BLS_ENDPOINT = "https://api.bls.gov/publicAPI/v2/timeseries/data/";

/**
 * CPI-U series. Year-over-year is computed from NSA (the convention for headline inflation
 * prints); month-over-month is computed from seasonally adjusted, because MoM on NSA is noise.
 */
const SERIES = {
  headlineNsa: "CUUR0000SA0",
  coreNsa: "CUUR0000SA0L1E",
  headlineSa: "CUSR0000SA0",
  coreSa: "CUSR0000SA0L1E",
} as const;

interface BlsPoint {
  year: string;
  period: string;
  periodName: string;
  value: string;
}
interface BlsSeries {
  seriesID: string;
  data?: BlsPoint[];
}
export interface BlsResponse {
  status?: string;
  message?: string[];
  Results?: { series?: BlsSeries[] };
}

export interface CpiMeasure {
  /** Index level for the latest month. */
  index: number | null;
  /** Year-over-year percent change (from NSA). */
  yoyPercent: number | null;
  /** Month-over-month percent change (from seasonally adjusted). */
  momPercent: number | null;
}

export interface CpiResult {
  /** Latest month covered, e.g. "2026-07". */
  asOf: string;
  periodName: string;
  headline: CpiMeasure;
  core: CpiMeasure;
  source: string;
}

interface Monthly {
  ym: string;
  value: number;
  periodName: string;
}

/** Monthly observations only, newest first. Drops M13 (annual average) and unparseable values. */
function monthlyPoints(series: BlsSeries | undefined): Monthly[] {
  const out: Monthly[] = [];
  for (const p of series?.data ?? []) {
    if (!/^M(0[1-9]|1[0-2])$/.test(p.period)) continue;
    const value = Number(p.value);
    if (!Number.isFinite(value)) continue;
    out.push({ ym: `${p.year}-${p.period.slice(1)}`, value, periodName: p.periodName });
  }
  return out.sort((a, b) => (a.ym < b.ym ? 1 : a.ym > b.ym ? -1 : 0));
}

/** Percent change, rounded to one decimal (how inflation prints are reported). */
function pct(newer: number, older: number): number | null {
  if (!Number.isFinite(newer) || !Number.isFinite(older) || older === 0) return null;
  return Math.round(((newer - older) / older) * 1000) / 10;
}

function shiftMonths(ym: string, delta: number): string {
  const [y, m] = ym.split("-").map(Number);
  const total = y * 12 + (m - 1) + delta;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`;
}

function measure(nsa: Monthly[], sa: Monthly[]): CpiMeasure {
  const latest = nsa[0];
  if (!latest) return { index: null, yoyPercent: null, momPercent: null };
  const yearAgo = nsa.find((p) => p.ym === shiftMonths(latest.ym, -12));
  const saLatest = sa[0];
  const saPrev = saLatest ? sa.find((p) => p.ym === shiftMonths(saLatest.ym, -1)) : undefined;
  return {
    index: latest.value,
    yoyPercent: yearAgo ? pct(latest.value, yearAgo.value) : null,
    momPercent: saLatest && saPrev ? pct(saLatest.value, saPrev.value) : null,
  };
}

/** Turn a raw BLS response into headline/core inflation rates. Pure; no network. */
export function computeCpi(body: BlsResponse): CpiResult {
  if (body.status && body.status !== "REQUEST_SUCCEEDED") {
    throw new UpstreamError(
      SOURCE,
      `${body.status}: ${(body.message ?? []).join("; ") || "no detail provided"}`,
    );
  }
  const byId = new Map((body.Results?.series ?? []).map((s) => [s.seriesID, s]));
  const headlineNsa = monthlyPoints(byId.get(SERIES.headlineNsa));
  if (headlineNsa.length === 0) {
    throw new UpstreamError(SOURCE, "response contained no monthly CPI observations");
  }
  return {
    asOf: headlineNsa[0].ym,
    periodName: `${headlineNsa[0].periodName} ${headlineNsa[0].ym.slice(0, 4)}`,
    headline: measure(headlineNsa, monthlyPoints(byId.get(SERIES.headlineSa))),
    core: measure(monthlyPoints(byId.get(SERIES.coreNsa)), monthlyPoints(byId.get(SERIES.coreSa))),
    source: SOURCE_URL,
  };
}

export async function getCpi(now = new Date(), apiKey?: string): Promise<CpiResult> {
  // Two calendar years is enough to compute year-over-year for the latest month.
  const endyear = now.getUTCFullYear();
  const payload: Record<string, unknown> = {
    seriesid: Object.values(SERIES),
    startyear: String(endyear - 1),
    endyear: String(endyear),
  };
  // The keyless v2 tier suffices; a registered key only raises daily request limits.
  if (apiKey) payload.registrationkey = apiKey;

  return computeCpi(
    await fetchJson<BlsResponse>(BLS_ENDPOINT, {
      source: SOURCE,
      method: "POST",
      body: JSON.stringify(payload),
    }),
  );
}

const DESCRIPTION = `Latest U.S. CPI inflation from the Bureau of Labor Statistics, with the rates already computed.

BLS publishes index levels, not inflation rates. This tool does the arithmetic: headline and core (all items less food and energy) CPI, each with year-over-year and month-over-month percent change. Year-over-year uses not-seasonally-adjusted data and month-over-month uses seasonally adjusted, matching how these figures are conventionally reported.

When to use: you need the current inflation rate, a real-versus-nominal adjustment, or CPI context for a macro decision.

When NOT to use: you need PCE (the Fed's preferred gauge), regional or category-level CPI detail, or a long historical series.

Args: none.

Returns structuredContent:
  {
    "asOf": "2026-07",
    "periodName": "July 2026",
    "headline": { "index": 333.918, "yoyPercent": 2.9, "momPercent": 0.2 },
    "core":     { "index": 337.133, "yoyPercent": 3.1, "momPercent": 0.3 },
    "source": "https://www.bls.gov/cpi/"
  }`;

export const blsCpiTool: ToolModule = {
  name: TOOL_NAME,
  title: "US CPI Inflation",
  description: DESCRIPTION,
  price: TOOL_PRICE,
  discovery: {
    inputSchema: { type: "object", properties: {} },
    output: {
      example: {
        asOf: "2026-07",
        periodName: "July 2026",
        headline: { index: 333.918, yoyPercent: 2.9, momPercent: 0.2 },
        core: { index: 337.133, yoyPercent: 3.1, momPercent: 0.3 },
      },
    },
  },
  register(server: McpServer) {
    server.registerTool(
      TOOL_NAME,
      {
        title: "US CPI Inflation",
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
        const result = await getCpi(new Date(), globalThis.process?.env?.BLS_API_KEY);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          structuredContent: result as unknown as Record<string, unknown>,
          isError: false,
        };
      },
    );
  },
};
