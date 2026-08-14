import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolModule } from "./types.js";
import { fetchJson, UpstreamError } from "../upstream/http.js";
import { SEC_SOURCE, SEC_SOURCE_URL, padCik, resolveCik } from "../upstream/sec.js";

export const TOOL_NAME = "edgar_financials";
export const TOOL_PRICE = "$0.015";

/**
 * Ordered XBRL tag candidates per concept. Order matters: filers migrated from `Revenues` to
 * `RevenueFromContractWithCustomerExcludingAssessedTax` under ASC 606, so querying only the
 * obvious tag returns stale or empty data for most modern filers.
 */
const CONCEPTS: Array<{ key: string; label: string; tags: string[] }> = [
  {
    key: "revenue",
    label: "Revenue",
    tags: [
      "RevenueFromContractWithCustomerExcludingAssessedTax",
      "RevenueFromContractWithCustomerIncludingAssessedTax",
      "Revenues",
      "SalesRevenueNet",
    ],
  },
  { key: "netIncome", label: "Net income", tags: ["NetIncomeLoss", "ProfitLoss"] },
  {
    key: "epsDiluted",
    label: "Diluted EPS",
    tags: ["EarningsPerShareDiluted", "EarningsPerShareBasicAndDiluted"],
  },
  { key: "assets", label: "Total assets", tags: ["Assets"] },
  { key: "liabilities", label: "Total liabilities", tags: ["Liabilities"] },
  {
    key: "equity",
    label: "Shareholders' equity",
    tags: [
      "StockholdersEquity",
      "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest",
    ],
  },
  {
    key: "cash",
    label: "Cash and equivalents",
    tags: [
      "CashAndCashEquivalentsAtCarryingValue",
      "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents",
    ],
  },
];

interface XbrlObservation {
  start?: string;
  end?: string;
  val?: number;
  fy?: number;
  fp?: string;
  form?: string;
  frame?: string;
}
interface XbrlConcept {
  entityName?: string;
  tag?: string;
  label?: string;
  units?: Record<string, XbrlObservation[]>;
}

export interface Period {
  /** Period end date, ISO YYYY-MM-DD. */
  end: string;
  start: string | null;
  value: number;
  unit: string;
  fiscalYear: number | null;
  fiscalPeriod: string | null;
  form: string | null;
}

export interface ConceptResult {
  label: string;
  /** The XBRL tag that actually produced data. */
  tag: string | null;
  annual: Period | null;
  quarterly: Period | null;
}

export interface FinancialsResult {
  cik: string;
  entity: string | null;
  ticker: string;
  concepts: Record<string, ConceptResult>;
  source: string;
}

function daysBetween(start?: string, end?: string): number | null {
  if (!start || !end) return null;
  const a = Date.parse(start);
  const b = Date.parse(end);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

/**
 * Classify an observation by its period length. Balance-sheet items are instants (no start),
 * so those fall back to the form type.
 */
function classify(o: XbrlObservation): "annual" | "quarterly" | null {
  const days = daysBetween(o.start, o.end);
  if (days === null) {
    const form = (o.form ?? "").toUpperCase();
    if (form.startsWith("10-K")) return "annual";
    if (form.startsWith("10-Q")) return "quarterly";
    return null;
  }
  if (days >= 300 && days <= 400) return "annual";
  if (days >= 60 && days <= 120) return "quarterly";
  return null;
}

/** Pick the newest annual and quarterly observation. Pure; no network. */
export function selectPeriods(concept: XbrlConcept): {
  tag: string | null;
  unit: string | null;
  annual: Period | null;
  quarterly: Period | null;
} {
  const units = concept.units ?? {};
  const unit = Object.keys(units)[0] ?? null;
  const rows = unit ? (units[unit] ?? []) : [];
  let annual: Period | null = null;
  let quarterly: Period | null = null;

  for (const o of rows) {
    if (typeof o.val !== "number" || !Number.isFinite(o.val) || !o.end) continue;
    const kind = classify(o);
    if (!kind) continue;
    const period: Period = {
      end: o.end,
      start: o.start ?? null,
      value: o.val,
      unit: unit ?? "",
      fiscalYear: o.fy ?? null,
      fiscalPeriod: o.fp ?? null,
      form: o.form ?? null,
    };
    // SEC repeats the same fact across filings; the newest period end wins.
    if (kind === "annual" && (!annual || period.end > annual.end)) annual = period;
    if (kind === "quarterly" && (!quarterly || period.end > quarterly.end)) quarterly = period;
  }
  return { tag: concept.tag ?? null, unit, annual, quarterly };
}

async function fetchConcept(cik: number, tag: string): Promise<XbrlConcept | null> {
  try {
    return await fetchJson<XbrlConcept>(
      `https://data.sec.gov/api/xbrl/companyconcept/CIK${padCik(cik)}/us-gaap/${tag}.json`,
      { source: SEC_SOURCE, timeoutMs: 20_000 },
    );
  } catch {
    // A filer simply may not report this tag; try the next candidate.
    return null;
  }
}

export async function getFinancials(tickerOrCik: string): Promise<FinancialsResult> {
  const { cik } = await resolveCik(tickerOrCik);
  const concepts: Record<string, ConceptResult> = {};
  let entity: string | null = null;
  let found = 0;

  for (const spec of CONCEPTS) {
    let result: ConceptResult = { label: spec.label, tag: null, annual: null, quarterly: null };
    for (const tag of spec.tags) {
      const concept = await fetchConcept(cik, tag);
      if (!concept) continue;
      entity = entity ?? concept.entityName ?? null;
      const picked = selectPeriods(concept);
      if (picked.annual || picked.quarterly) {
        result = { label: spec.label, tag, annual: picked.annual, quarterly: picked.quarterly };
        found++;
        break;
      }
    }
    concepts[spec.key] = result;
  }

  // Nothing resolved means we delivered nothing: throw so the gate skips settlement.
  if (found === 0) {
    throw new UpstreamError(
      SEC_SOURCE,
      `no XBRL financial data found for CIK ${padCik(cik)} (the filer may not report US-GAAP tags)`,
    );
  }

  return {
    cik: padCik(cik),
    entity,
    ticker: tickerOrCik.trim().toUpperCase(),
    concepts,
    source: SEC_SOURCE_URL,
  };
}

const DESCRIPTION = `Key financials for a U.S. public company, pulled from SEC XBRL company facts.

Returns revenue, net income, diluted EPS, total assets, total liabilities, shareholders' equity and cash, each with the most recent ANNUAL and QUARTERLY figure, the period covered, and the form it came from.

Handles two things that trip up naive XBRL queries: filers migrated from the "Revenues" tag to "RevenueFromContractWithCustomerExcludingAssessedTax" under ASC 606, so each concept tries several tags in order; and the SEC repeats facts across filings with differing period lengths, so observations are classified as annual or quarterly by their actual duration rather than by trusting the fiscal-period label.

When to use: fundamentals for valuation or screening, checking latest reported revenue or EPS, pulling balance-sheet lines.

When NOT to use: you need full statements line by line, segment detail, non-GAAP measures, or analyst estimates.

Args:
  - ticker (string, required): a ticker such as "AAPL", or a bare CIK such as "320193".

Returns structuredContent:
  {
    "cik": "0000320193", "entity": "Apple Inc.", "ticker": "AAPL",
    "concepts": {
      "revenue": {
        "label": "Revenue",
        "tag": "RevenueFromContractWithCustomerExcludingAssessedTax",
        "annual":    { "end": "2025-09-27", "start": "2024-09-29", "value": 416000000000,
                       "unit": "USD", "fiscalYear": 2025, "fiscalPeriod": "FY", "form": "10-K" },
        "quarterly": { "end": "2026-06-27", "value": 94000000000, "unit": "USD", "form": "10-Q" }
      },
      "netIncome": {}, "epsDiluted": {}, "assets": {}
    },
    "source": "https://www.sec.gov/edgar"
  }

A concept the filer does not report comes back with tag null and both periods null, rather than a
fabricated zero.`;

const inputSchema = {
  ticker: z
    .string()
    .min(1)
    .describe('Ticker symbol (e.g. "AAPL") or a bare SEC CIK (e.g. "320193").'),
};

export const edgarFinancialsTool: ToolModule = {
  name: TOOL_NAME,
  title: "SEC Company Financials (XBRL)",
  description: DESCRIPTION,
  price: TOOL_PRICE,
  discovery: {
    inputSchema: {
      type: "object",
      properties: { ticker: { type: "string", description: 'Ticker (e.g. "AAPL") or CIK.' } },
      required: ["ticker"],
    },
    output: {
      example: {
        cik: "0000320193",
        entity: "Apple Inc.",
        ticker: "AAPL",
        concepts: {
          revenue: {
            label: "Revenue",
            tag: "RevenueFromContractWithCustomerExcludingAssessedTax",
            annual: { end: "2025-09-27", value: 416000000000, unit: "USD", form: "10-K" },
          },
        },
      },
    },
  },
  register(server: McpServer) {
    server.registerTool(
      TOOL_NAME,
      {
        title: "SEC Company Financials (XBRL)",
        description: DESCRIPTION,
        inputSchema,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async ({ ticker }) => {
        // Let UpstreamError propagate: the gate must not settle payment for a failed fetch.
        const result = await getFinancials(ticker);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          structuredContent: result as unknown as Record<string, unknown>,
          isError: false,
        };
      },
    );
  },
};
