import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolModule } from "./types.js";
import { fetchJson, fetchText, UpstreamError } from "../upstream/http.js";
import {
  SEC_SOURCE,
  SEC_SOURCE_URL,
  fetchSubmissions,
  padCik,
  recentFilings,
  resolveCik,
} from "../upstream/sec.js";

export const TOOL_NAME = "edgar_13f_holdings";
export const TOOL_PRICE = "$0.02";

interface FilingIndex {
  directory?: { item?: Array<{ name: string; size?: string }> };
}

/**
 * 13F holdings live in a separate XML document (the "information table"), not in
 * `primaryDocument` — that only ever points at the cover-page XML. Discover the info-table
 * file from the filing's own index rather than guessing a filename pattern.
 */
export async function findInfoTableDoc(cik: number, accession: string): Promise<string> {
  const acc = accession.replace(/-/g, "");
  const index = await fetchJson<FilingIndex>(
    `https://www.sec.gov/Archives/edgar/data/${cik}/${acc}/index.json`,
    { source: SEC_SOURCE, timeoutMs: 20_000 },
  );
  const items = index.directory?.item ?? [];
  const candidate = items.find(
    (it) =>
      it.name.toLowerCase().endsWith(".xml") && !it.name.toLowerCase().includes("primary_doc"),
  );
  if (!candidate) {
    throw new UpstreamError(SEC_SOURCE, `no information table found in filing ${accession}`);
  }
  return `https://www.sec.gov/Archives/edgar/data/${cik}/${acc}/${candidate.name}`;
}

export interface HoldingLot {
  issuer: string;
  cusip: string;
  /**
   * Value in whole USD, as reported in the filing's <value> tag.
   *
   * The SEC's own technical spec describes this field as "rounded to the nearest thousand
   * dollars", which many third-party summaries interpret as "multiply by 1000 to get dollars".
   * Verified against live filings (Berkshire's 2026-06-30 13F) that reading is wrong: dividing
   * the raw value by shares gives implausible per-share prices (AAPL ~$289,000/share). Taking
   * the raw value as already-whole-dollars gives plausible prices (~$289/share) instead, so
   * that is what we use.
   */
  valueUsd: number;
  shares: number;
}

export interface AggregatedHolding {
  issuer: string;
  cusip: string;
  /** Sum of every reported lot for this issuer+CUSIP; 13F reports in thousands of dollars. */
  valueUsd: number;
  shares: number;
  /** Number of separate lots (share classes, put/call splits) rolled into this row. */
  lots: number;
}

export interface HoldingsResult {
  cik: string;
  filer: string | null;
  periodOfReport: string | null;
  filedAt: string;
  accession: string;
  totalPositions: number;
  totalValueUsd: number;
  holdings: AggregatedHolding[];
  source: string;
}

function num(value: string | null | undefined): number | null {
  if (!value) return null;
  const n = Number(value.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function textAfter(xml: string, tag: string): string | null {
  const m = new RegExp(`<(?:\\w+:)?${tag}\\b[^>]*>([^<]*)`, "i").exec(xml);
  return m ? m[1].trim() : null;
}

/** Parse every infoTable entry out of a 13F information-table XML document. Pure; no network. */
export function parseInfoTable(xml: string): HoldingLot[] {
  const blocks = xml.match(/<(?:\w+:)?infoTable\b[\s\S]*?<\/(?:\w+:)?infoTable>/gi) ?? [];
  const lots: HoldingLot[] = [];
  for (const b of blocks) {
    const value = num(textAfter(b, "value"));
    const shares = num(textAfter(b, "sshPrnamt"));
    const issuer = textAfter(b, "nameOfIssuer");
    const cusip = textAfter(b, "cusip");
    if (value === null || shares === null || !issuer || !cusip) continue;
    lots.push({ issuer, cusip, valueUsd: value, shares });
  }
  return lots;
}

/** Roll multiple lots of the same issuer+CUSIP (share classes, put/call splits) into one row. */
export function aggregateHoldings(lots: HoldingLot[]): AggregatedHolding[] {
  const byKey = new Map<string, AggregatedHolding>();
  for (const lot of lots) {
    const key = `${lot.cusip}:${lot.issuer}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.valueUsd += lot.valueUsd;
      existing.shares += lot.shares;
      existing.lots += 1;
    } else {
      byKey.set(key, {
        issuer: lot.issuer,
        cusip: lot.cusip,
        valueUsd: lot.valueUsd,
        shares: lot.shares,
        lots: 1,
      });
    }
  }
  return [...byKey.values()].sort((a, b) => b.valueUsd - a.valueUsd);
}

export async function getHoldings(tickerOrCik: string, limit = 25): Promise<HoldingsResult> {
  const { cik } = await resolveCik(tickerOrCik);
  const subs = await fetchSubmissions(cik);
  const [filing] = recentFilings(subs, ["13F-HR"], 1);
  if (!filing) {
    throw new UpstreamError(SEC_SOURCE, `no 13F-HR filing found for CIK ${padCik(cik)}`);
  }

  const docUrl = await findInfoTableDoc(cik, filing.accession);
  const xml = await fetchText(docUrl, { source: SEC_SOURCE, timeoutMs: 25_000 });
  const lots = parseInfoTable(xml);
  if (lots.length === 0) {
    throw new UpstreamError(
      SEC_SOURCE,
      `information table for ${filing.accession} had no parseable holdings`,
    );
  }

  const aggregated = aggregateHoldings(lots);
  return {
    cik: padCik(cik),
    filer: subs.name ?? null,
    periodOfReport: filing.reportDate,
    filedAt: filing.filedAt,
    accession: filing.accession,
    totalPositions: aggregated.length,
    totalValueUsd: Math.round(aggregated.reduce((s, h) => s + h.valueUsd, 0)),
    holdings: aggregated.slice(0, limit),
    source: SEC_SOURCE_URL,
  };
}

const DESCRIPTION = `Institutional stock holdings for a fund manager, from its latest SEC Form 13F.

13F filings split the actual holdings into a separate "information table" XML document that the filing index does not point at directly; this locates it, parses every position, and rolls up lots reported separately (different share classes, put/call splits) into one row per issuer.

When to use: seeing what a fund or institution holds and how much, tracking "smart money" positioning, portfolio research.

When NOT to use: real-time positions (13F is filed up to 45 days after quarter end, so this is always historical), short positions (13F does not require disclosing shorts), or non-U.S. filers.

Args:
  - ticker (string, required): the FILER's ticker (if it has one) or its SEC CIK, e.g. "1067983" for Berkshire Hathaway.
  - limit (integer, optional, default 25): maximum holdings to return, largest by value first (1-200).

Returns structuredContent:
  {
    "cik": "0001067983", "filer": "BERKSHIRE HATHAWAY INC",
    "periodOfReport": "2026-06-30", "filedAt": "2026-08-14",
    "totalPositions": 45, "totalValueUsd": 293000000000,
    "holdings": [
      { "issuer": "ALLY FINL INC", "cusip": "02005N100",
        "valueUsd": 900335661000, "shares": 19593812, "lots": 3 }
    ],
    "source": "https://www.sec.gov/edgar"
  }

Reports the most recently FILED 13F-HR. Values are whole USD, taken directly from the filing.`;

const inputSchema = {
  ticker: z
    .string()
    .min(1)
    .describe('The FILER\'s ticker or SEC CIK, e.g. "1067983" for Berkshire Hathaway.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .default(25)
    .describe("Maximum holdings to return, largest first. Default 25."),
};

export const edgar13fHoldingsTool: ToolModule = {
  name: TOOL_NAME,
  title: "SEC 13F Institutional Holdings",
  description: DESCRIPTION,
  price: TOOL_PRICE,
  discovery: {
    inputSchema: {
      type: "object",
      properties: {
        ticker: { type: "string", description: "Filer ticker or CIK." },
        limit: { type: "number", description: "Max holdings to return (1-200, default 25)." },
      },
      required: ["ticker"],
    },
    inputExample: { ticker: "1067983", limit: 10 },
    output: {
      example: {
        cik: "0001067983",
        filer: "BERKSHIRE HATHAWAY INC",
        totalPositions: 45,
        holdings: [
          { issuer: "ALLY FINL INC", cusip: "02005N100", valueUsd: 900335661000, shares: 19593812 },
        ],
      },
    },
  },
  register(server: McpServer) {
    server.registerTool(
      TOOL_NAME,
      {
        title: "SEC 13F Institutional Holdings",
        description: DESCRIPTION,
        inputSchema,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async ({ ticker, limit }) => {
        // Let UpstreamError propagate: the gate must not settle payment for a failed fetch.
        const result = await getHoldings(ticker, limit ?? 25);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          structuredContent: result as unknown as Record<string, unknown>,
          isError: false,
        };
      },
    );
  },
};
