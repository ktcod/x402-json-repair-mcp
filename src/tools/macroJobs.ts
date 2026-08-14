import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolModule } from "./types.js";
import { fetchJson, UpstreamError } from "../upstream/http.js";

export const TOOL_NAME = "macro_jobs";
export const TOOL_PRICE = "$0.005";

const SOURCE = "BLS";
const SOURCE_URL = "https://www.bls.gov/ces/";
const BLS_ENDPOINT = "https://api.bls.gov/publicAPI/v2/timeseries/data/";

/** Headline labour-market series, all seasonally adjusted. */
const SERIES = {
  /** Unemployment rate, percent. */
  unemploymentRate: "LNS14000000",
  /** Total nonfarm employment, thousands of jobs. */
  nonfarmPayrolls: "CES0000000001",
  /** Average hourly earnings, total private, dollars. */
  avgHourlyEarnings: "CES0500000003",
  /** Labor force participation rate, percent. */
  participationRate: "LNS11300000",
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
export interface BlsJobsResponse {
  status?: string;
  message?: string[];
  Results?: { series?: BlsSeries[] };
}

export interface JobsResult {
  /** Latest month covered, e.g. "2026-07". */
  asOf: string;
  periodName: string;
  unemploymentRate: number | null;
  participationRate: number | null;
  /** Total nonfarm payrolls, thousands of jobs. */
  nonfarmPayrolls: number | null;
  /** Month-over-month change in payrolls, thousands (the "jobs added" headline). */
  payrollsChange: number | null;
  avgHourlyEarnings: number | null;
  /** Year-over-year growth in average hourly earnings, percent. */
  earningsYoyPercent: number | null;
  source: string;
}

interface Monthly {
  ym: string;
  value: number;
  periodName: string;
}

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

function shiftMonths(ym: string, delta: number): string {
  const [y, m] = ym.split("-").map(Number);
  const total = y * 12 + (m - 1) + delta;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`;
}

/** Turn a raw BLS response into the headline labour-market figures. Pure; no network. */
export function computeJobs(body: BlsJobsResponse): JobsResult {
  if (body.status && body.status !== "REQUEST_SUCCEEDED") {
    throw new UpstreamError(
      SOURCE,
      `${body.status}: ${(body.message ?? []).join("; ") || "no detail provided"}`,
    );
  }
  const byId = new Map((body.Results?.series ?? []).map((s) => [s.seriesID, s]));
  const unemployment = monthlyPoints(byId.get(SERIES.unemploymentRate));
  const payrolls = monthlyPoints(byId.get(SERIES.nonfarmPayrolls));
  const earnings = monthlyPoints(byId.get(SERIES.avgHourlyEarnings));
  const participation = monthlyPoints(byId.get(SERIES.participationRate));

  const anchor = payrolls[0] ?? unemployment[0];
  if (!anchor) {
    throw new UpstreamError(SOURCE, "response contained no monthly observations");
  }

  const prevPayrolls = payrolls[0]
    ? payrolls.find((p) => p.ym === shiftMonths(payrolls[0].ym, -1))
    : undefined;
  const yearAgoEarnings = earnings[0]
    ? earnings.find((p) => p.ym === shiftMonths(earnings[0].ym, -12))
    : undefined;

  return {
    asOf: anchor.ym,
    periodName: `${anchor.periodName} ${anchor.ym.slice(0, 4)}`,
    unemploymentRate: unemployment[0]?.value ?? null,
    participationRate: participation[0]?.value ?? null,
    nonfarmPayrolls: payrolls[0]?.value ?? null,
    payrollsChange:
      payrolls[0] && prevPayrolls
        ? Math.round((payrolls[0].value - prevPayrolls.value) * 10) / 10
        : null,
    avgHourlyEarnings: earnings[0]?.value ?? null,
    earningsYoyPercent:
      earnings[0] && yearAgoEarnings && yearAgoEarnings.value !== 0
        ? Math.round(((earnings[0].value - yearAgoEarnings.value) / yearAgoEarnings.value) * 1000) /
          10
        : null,
    source: SOURCE_URL,
  };
}

export async function getJobs(now = new Date(), apiKey?: string): Promise<JobsResult> {
  const endyear = now.getUTCFullYear();
  const payload: Record<string, unknown> = {
    seriesid: Object.values(SERIES),
    startyear: String(endyear - 1),
    endyear: String(endyear),
  };
  if (apiKey) payload.registrationkey = apiKey;

  return computeJobs(
    await fetchJson<BlsJobsResponse>(BLS_ENDPOINT, {
      source: SOURCE,
      method: "POST",
      body: JSON.stringify(payload),
    }),
  );
}

const DESCRIPTION = `Latest U.S. labour-market data from the Bureau of Labor Statistics, with the headline changes computed.

Returns the unemployment rate, labour force participation rate, total nonfarm payrolls, the month-over-month change in payrolls (the "jobs added" number that leads the Employment Situation report), average hourly earnings, and year-over-year wage growth. All series are seasonally adjusted.

BLS publishes levels; the month-over-month and year-over-year changes are computed here.

When to use: reading the state of the labour market, wage-inflation context, or Fed-policy reasoning.

When NOT to use: you need state or metro level detail, industry breakdowns, or JOLTS openings and quits.

Args: none.

Returns structuredContent:
  {
    "asOf": "2026-07", "periodName": "July 2026",
    "unemploymentRate": 4.1, "participationRate": 62.4,
    "nonfarmPayrolls": 158858, "payrollsChange": 73,
    "avgHourlyEarnings": 37.62, "earningsYoyPercent": 3.8,
    "source": "https://www.bls.gov/ces/"
  }

Payrolls are in thousands of jobs, so payrollsChange 73 means +73,000 jobs on the month.`;

export const macroJobsTool: ToolModule = {
  name: TOOL_NAME,
  title: "US Jobs Report",
  description: DESCRIPTION,
  price: TOOL_PRICE,
  discovery: {
    inputSchema: { type: "object", properties: {} },
    output: {
      example: {
        asOf: "2026-07",
        periodName: "July 2026",
        unemploymentRate: 4.1,
        nonfarmPayrolls: 158858,
        payrollsChange: 73,
        avgHourlyEarnings: 37.62,
        earningsYoyPercent: 3.8,
      },
    },
  },
  register(server: McpServer) {
    server.registerTool(
      TOOL_NAME,
      {
        title: "US Jobs Report",
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
        const result = await getJobs(new Date(), globalThis.process?.env?.BLS_API_KEY);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          structuredContent: result as unknown as Record<string, unknown>,
          isError: false,
        };
      },
    );
  },
};
