import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolModule } from "./types.js";
import { UpstreamError } from "../upstream/http.js";
import {
  SEC_SOURCE_URL,
  fetchSubmissions,
  filingUrl,
  padCik,
  recentFilings,
  resolveCik,
} from "../upstream/sec.js";

export const TOOL_NAME = "edgar_filings_feed";
export const TOOL_PRICE = "$0.008";

/** SEC 8-K item numbers worth surfacing a plain-English label for. Not exhaustive. */
const ITEM_LABELS: Record<string, string> = {
  "1.01": "Entry into a material definitive agreement",
  "1.02": "Termination of a material definitive agreement",
  "2.01": "Completion of acquisition or disposition of assets",
  "2.02": "Results of operations and financial condition",
  "2.03": "Creation of a direct financial obligation",
  "2.05": "Costs associated with exit or disposal activities",
  "2.06": "Material impairments",
  "3.01": "Notice of delisting or failure to meet listing standards",
  "4.01": "Changes in registrant's certifying accountant",
  "4.02": "Non-reliance on previously issued financial statements",
  "5.01": "Changes in control of registrant",
  "5.02": "Departure/appointment of directors or officers",
  "5.03": "Amendments to articles of incorporation or bylaws",
  "7.01": "Regulation FD disclosure",
  "8.01": "Other events",
  "9.01": "Financial statements and exhibits",
};

export interface FeedFiling {
  form: string;
  filedAt: string;
  reportDate: string | null;
  accession: string;
  description: string | null;
  documentUrl: string;
  /** For 8-Ks: the item numbers with a plain-English label, when known. */
  items: Array<{ code: string; label: string | null }> | null;
}

export interface FilingsFeedResult {
  cik: string;
  entity: string | null;
  ticker: string | null;
  count: number;
  filings: FeedFiling[];
  source: string;
}

function parseItems(raw: string | null): Array<{ code: string; label: string | null }> | null {
  if (!raw) return null;
  const codes = raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (codes.length === 0) return null;
  return codes.map((code) => ({ code, label: ITEM_LABELS[code] ?? null }));
}

export async function getFilingsFeed(
  tickerOrCik: string,
  forms: string[] = [],
  limit = 20,
): Promise<FilingsFeedResult> {
  const { cik } = await resolveCik(tickerOrCik);
  const subs = await fetchSubmissions(cik);
  const recent = recentFilings(subs, forms.length ? forms : undefined, limit);
  if (recent.length === 0) {
    throw new UpstreamError(
      "SEC EDGAR",
      forms.length
        ? `no ${forms.join("/")} filings found for CIK ${padCik(cik)}`
        : `no filings found for CIK ${padCik(cik)}`,
    );
  }

  return {
    cik: padCik(cik),
    entity: subs.name ?? null,
    ticker: subs.tickers?.[0] ?? null,
    count: recent.length,
    filings: recent.map((f) => ({
      form: f.form,
      filedAt: f.filedAt,
      reportDate: f.reportDate,
      accession: f.accession,
      description: f.description,
      documentUrl: filingUrl(cik, f.accession, f.primaryDocument),
      items: f.form === "8-K" ? parseItems(f.items) : null,
    })),
    source: SEC_SOURCE_URL,
  };
}

const DESCRIPTION = `Recent SEC filings for a company, newest first, with 8-K item codes translated to plain English.

A general-purpose filings feed: any form type, or a specific set (8-K for material events, 10-K/10-Q for periodic reports, S-1 for new-issue prospectuses, SC 13D/13G for activist and passive stakes). 8-K filings include their item numbers (e.g. "5.02") decoded into a label ("Departure/appointment of directors or officers") rather than leaving you to look up the code.

When to use: monitoring a company's material-event stream, building a filings watchlist, or finding a specific filing type.

When NOT to use: you need the parsed FINANCIAL content of a filing (use edgar_financials) or insider trades (use edgar_insider_transactions).

Args:
  - ticker (string, required): a ticker such as "AAPL", or a bare CIK such as "320193".
  - forms (string[], optional): filter to specific form types, e.g. ["8-K"] or ["10-K","10-Q"]. Omit for all forms.
  - limit (integer, optional, default 20): maximum filings to return (1-100).

Returns structuredContent:
  {
    "cik": "0000320193", "entity": "Apple Inc.", "ticker": "AAPL", "count": 1,
    "filings": [{
      "form": "8-K", "filedAt": "2026-08-01", "reportDate": "2026-07-31",
      "items": [{ "code": "2.02", "label": "Results of operations and financial condition" }],
      "documentUrl": "https://www.sec.gov/Archives/..."
    }],
    "source": "https://www.sec.gov/edgar"
  }`;

const inputSchema = {
  ticker: z
    .string()
    .min(1)
    .describe('Ticker symbol (e.g. "AAPL") or a bare SEC CIK (e.g. "320193").'),
  forms: z
    .array(z.string())
    .optional()
    .describe('Filter to these form types, e.g. ["8-K"]. Omit for all forms.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .describe("Maximum filings to return, newest first. Default 20."),
};

export const edgarFilingsFeedTool: ToolModule = {
  name: TOOL_NAME,
  title: "SEC Filings Feed",
  description: DESCRIPTION,
  price: TOOL_PRICE,
  discovery: {
    inputSchema: {
      type: "object",
      properties: {
        ticker: { type: "string", description: 'Ticker (e.g. "AAPL") or CIK.' },
        forms: { type: "array", items: { type: "string" }, description: 'e.g. ["8-K"].' },
        limit: { type: "number", description: "Max filings (1-100, default 20)." },
      },
      required: ["ticker"],
    },
    inputExample: { ticker: "AAPL", forms: ["8-K"], limit: 10 },
    output: {
      example: {
        cik: "0000320193",
        entity: "Apple Inc.",
        count: 1,
        filings: [
          {
            form: "8-K",
            filedAt: "2026-08-01",
            items: [{ code: "2.02", label: "Results of operations and financial condition" }],
          },
        ],
      },
    },
  },
  register(server: McpServer) {
    server.registerTool(
      TOOL_NAME,
      {
        title: "SEC Filings Feed",
        description: DESCRIPTION,
        inputSchema,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async ({ ticker, forms, limit }) => {
        // Let UpstreamError propagate: the gate must not settle payment for a failed fetch.
        const result = await getFilingsFeed(ticker, forms ?? [], limit ?? 20);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          structuredContent: result as unknown as Record<string, unknown>,
          isError: false,
        };
      },
    );
  },
};
