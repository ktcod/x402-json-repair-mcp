import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolModule } from "./types.js";
import { fetchJson, fetchText, UpstreamError } from "../upstream/http.js";

export const TOOL_NAME = "edgar_insider_transactions";
export const TOOL_PRICE = "$0.02";

const SOURCE = "SEC EDGAR";
const SOURCE_URL = "https://www.sec.gov/edgar";
const TICKER_MAP_URL = "https://www.sec.gov/files/company_tickers.json";
/** SEC fair access allows 10 req/s; capping filings per call keeps us far below that. */
export const MAX_FILINGS = 20;

/** Form 4 transaction codes, per the SEC's Form 345 instructions. */
const CODE_MEANING: Record<string, string> = {
  P: "Open-market or private purchase",
  S: "Open-market or private sale",
  A: "Grant, award or other acquisition from the issuer",
  D: "Disposition to the issuer",
  F: "Shares withheld to cover tax withholding",
  M: "Exercise or conversion of a derivative security",
  X: "Exercise of an in-the-money or at-the-money derivative",
  C: "Conversion of a derivative security",
  G: "Bona fide gift",
  V: "Transaction voluntarily reported earlier than required",
  J: "Other acquisition or disposition",
  U: "Disposition pursuant to a tender of shares",
};

export interface InsiderTransaction {
  /** ISO date (YYYY-MM-DD). */
  date: string | null;
  code: string | null;
  codeMeaning: string | null;
  /** "A" = acquired, "D" = disposed. */
  acquiredDisposed: string | null;
  shares: number | null;
  pricePerShare: number | null;
  /** shares * pricePerShare when both are present. */
  value: number | null;
  sharesOwnedAfter: number | null;
}

export interface InsiderFiling {
  filedAt: string;
  accession: string;
  owner: string | null;
  ownerTitle: string | null;
  isDirector: boolean;
  isOfficer: boolean;
  transactions: InsiderTransaction[];
  documentUrl: string;
}

export interface InsiderResult {
  cik: string;
  issuer: string | null;
  ticker: string | null;
  count: number;
  filings: InsiderFiling[];
  source: string;
}

/* ---------------------------------------------------------------------------------------- */
/* XML extraction. SEC ownership XML is machine-generated and highly regular, so targeted    */
/* tag extraction is reliable here; values are frequently wrapped in a <value> element.      */
/* ---------------------------------------------------------------------------------------- */

/** Read a tag's text, tolerating an inner <value> wrapper. Returns null when absent. */
export function tagValue(xml: string, tag: string): string | null {
  const block = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i").exec(xml);
  if (!block) return null;
  const inner = block[1];
  const wrapped = /<value\b[^>]*>([\s\S]*?)<\/value>/i.exec(inner);
  const text = (wrapped ? wrapped[1] : inner).replace(/<[^>]*>/g, "").trim();
  return text || null;
}

function num(value: string | null): number | null {
  if (value === null) return null;
  const n = Number(value.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function isTrue(value: string | null): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

/** Parse every non-derivative transaction out of a Form 3/4/5 XML document. Pure; no network. */
export function parseOwnershipXml(xml: string): {
  owner: string | null;
  ownerTitle: string | null;
  isDirector: boolean;
  isOfficer: boolean;
  issuer: string | null;
  ticker: string | null;
  transactions: InsiderTransaction[];
} {
  const blocks =
    xml.match(/<nonDerivativeTransaction\b[\s\S]*?<\/nonDerivativeTransaction>/gi) ?? [];
  const transactions: InsiderTransaction[] = blocks.map((b) => {
    const shares = num(tagValue(b, "transactionShares"));
    const price = num(tagValue(b, "transactionPricePerShare"));
    const code = tagValue(b, "transactionCode");
    return {
      date: tagValue(b, "transactionDate"),
      code,
      codeMeaning: code ? (CODE_MEANING[code.toUpperCase()] ?? null) : null,
      acquiredDisposed: tagValue(b, "transactionAcquiredDisposedCode"),
      shares,
      pricePerShare: price,
      value: shares !== null && price !== null ? round2(shares * price) : null,
      sharesOwnedAfter: num(tagValue(b, "sharesOwnedFollowingTransaction")),
    };
  });

  return {
    owner: tagValue(xml, "rptOwnerName"),
    ownerTitle: tagValue(xml, "officerTitle"),
    isDirector: isTrue(tagValue(xml, "isDirector")),
    isOfficer: isTrue(tagValue(xml, "isOfficer")),
    issuer: tagValue(xml, "issuerName"),
    ticker: tagValue(xml, "issuerTradingSymbol"),
    transactions,
  };
}

/* ---------------------------------------------------------------------------------------- */

interface TickerEntry {
  cik_str: number;
  ticker: string;
  title: string;
}

/** The ticker map is ~800 KB and changes rarely, so memoize it per isolate. */
let tickerCache: { at: number; map: Map<string, number> } | undefined;
const TICKER_TTL_MS = 24 * 60 * 60 * 1000;

async function tickerToCik(ticker: string): Promise<number> {
  const key = ticker.trim().toUpperCase();
  if (!tickerCache || Date.now() - tickerCache.at > TICKER_TTL_MS) {
    const body = await fetchJson<Record<string, TickerEntry>>(TICKER_MAP_URL, {
      source: SOURCE,
      timeoutMs: 20_000,
    });
    const map = new Map<string, number>();
    for (const entry of Object.values(body)) {
      if (entry?.ticker) map.set(entry.ticker.toUpperCase(), entry.cik_str);
    }
    tickerCache = { at: Date.now(), map };
  }
  const cik = tickerCache.map.get(key);
  if (cik === undefined) {
    throw new UpstreamError(SOURCE, `no SEC filer found for ticker "${key}"`);
  }
  return cik;
}

interface Submissions {
  name?: string;
  tickers?: string[];
  filings?: {
    recent?: {
      form?: string[];
      filingDate?: string[];
      accessionNumber?: string[];
      primaryDocument?: string[];
    };
  };
}

/**
 * Build the RAW XML url for an ownership filing. `primaryDocument` usually points at the
 * XSL-rendered HTML (e.g. "xslF345X06/form4.xml"); the machine-readable XML sits one level up.
 */
export function rawOwnershipDocUrl(
  cik: number,
  accession: string,
  primaryDocument: string,
): string {
  const acc = accession.replace(/-/g, "");
  const doc = primaryDocument.replace(/^.*xslF345X\d+\//i, "");
  return `https://www.sec.gov/Archives/edgar/data/${cik}/${acc}/${doc}`;
}

export async function getInsiderTransactions(
  tickerOrCik: string,
  limit = 5,
  forms: string[] = ["4"],
): Promise<InsiderResult> {
  const raw = tickerOrCik.trim();
  const cik = /^\d+$/.test(raw) ? Number(raw) : await tickerToCik(raw);
  const padded = String(cik).padStart(10, "0");

  const subs = await fetchJson<Submissions>(`https://data.sec.gov/submissions/CIK${padded}.json`, {
    source: SOURCE,
    timeoutMs: 20_000,
  });
  const recent = subs.filings?.recent;
  if (!recent?.form) {
    throw new UpstreamError(SOURCE, `no filing history returned for CIK ${padded}`);
  }

  const wanted = new Set(forms.map((f) => f.trim().toUpperCase()));
  const picked: Array<{ filedAt: string; accession: string; doc: string }> = [];
  for (let i = 0; i < recent.form.length && picked.length < limit; i++) {
    if (!wanted.has((recent.form[i] ?? "").toUpperCase())) continue;
    picked.push({
      filedAt: recent.filingDate?.[i] ?? "",
      accession: recent.accessionNumber?.[i] ?? "",
      doc: recent.primaryDocument?.[i] ?? "",
    });
  }

  const filings: InsiderFiling[] = [];
  for (const f of picked) {
    const url = rawOwnershipDocUrl(cik, f.accession, f.doc);
    try {
      const parsed = parseOwnershipXml(await fetchText(url, { source: SOURCE, timeoutMs: 20_000 }));
      filings.push({
        filedAt: f.filedAt,
        accession: f.accession,
        owner: parsed.owner,
        ownerTitle: parsed.ownerTitle,
        isDirector: parsed.isDirector,
        isOfficer: parsed.isOfficer,
        transactions: parsed.transactions,
        documentUrl: url,
      });
    } catch {
      // One unreadable filing should not void the whole (paid) response; skip it.
      continue;
    }
  }

  // Nothing usable means we delivered nothing: throw so the gate skips settlement.
  if (filings.length === 0) {
    throw new UpstreamError(
      SOURCE,
      picked.length === 0
        ? `no ${[...wanted].join("/")} filings found for CIK ${padded}`
        : `found ${picked.length} filing(s) for CIK ${padded} but none could be parsed`,
    );
  }

  return {
    cik: padded,
    issuer: subs.name ?? null,
    ticker: subs.tickers?.[0] ?? null,
    count: filings.length,
    filings,
    source: SOURCE_URL,
  };
}

const DESCRIPTION = `Insider buying and selling for a U.S. public company, parsed from SEC Form 4 filings.

Form 4 is published as raw ownership XML, one document per filing, with the machine-readable file hidden behind an XSL-rendered URL. This resolves the ticker to a CIK, finds the most recent filings, fetches each XML document, and returns clean transactions: who traded, their role, the date, the SEC transaction code with its plain-English meaning, share count, price, computed dollar value, and shares held afterwards.

When to use: tracking insider sentiment, checking whether executives are buying or selling, auditing recent officer and director activity.

When NOT to use: you need institutional holdings (that is Form 13F), or derivative/option detail (only non-derivative transactions are returned), or non-U.S. issuers.

Args:
  - ticker (string, required): a ticker such as "AAPL", or a bare CIK such as "320193".
  - limit (integer, optional, default 5): how many recent filings to parse (1-20).
  - forms (string[], optional, default ["4"]): which ownership forms to include ("3", "4", "5").

Returns structuredContent:
  {
    "cik": "0000320193", "issuer": "Apple Inc.", "ticker": "AAPL", "count": 1,
    "filings": [{
      "filedAt": "2026-08-13", "owner": "Newstead Jennifer",
      "ownerTitle": "SVP, GC and Secretary", "isOfficer": true, "isDirector": false,
      "transactions": [{ "date": "2026-08-11", "code": "S",
        "codeMeaning": "Open-market or private sale", "acquiredDisposed": "D",
        "shares": 1439, "pricePerShare": 307.75, "value": 442852.25,
        "sharesOwnedAfter": 40107 }],
      "documentUrl": "https://www.sec.gov/Archives/..."
    }],
    "source": "https://www.sec.gov/edgar"
  }

An individual filing that cannot be parsed is skipped rather than failing the call. If nothing at
all is parseable the call errors and is not billed.`;

const inputSchema = {
  ticker: z
    .string()
    .min(1)
    .describe('Ticker symbol (e.g. "AAPL") or a bare SEC CIK (e.g. "320193").'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_FILINGS)
    .default(5)
    .describe(`How many recent ownership filings to parse (1-${MAX_FILINGS}). Default 5.`),
  forms: z
    .array(z.enum(["3", "4", "5"]))
    .optional()
    .describe('Which ownership forms to include. Defaults to ["4"].'),
};

export const edgarInsiderTransactionsTool: ToolModule = {
  name: TOOL_NAME,
  title: "SEC Insider Transactions (Form 4)",
  description: DESCRIPTION,
  price: TOOL_PRICE,
  discovery: {
    inputSchema: {
      type: "object",
      properties: {
        ticker: { type: "string", description: 'Ticker (e.g. "AAPL") or CIK.' },
        limit: { type: "number", description: "Recent filings to parse (1-20, default 5)." },
        forms: { type: "array", items: { type: "string" }, description: 'Forms: "3", "4", "5".' },
      },
      required: ["ticker"],
    },
    output: {
      example: {
        cik: "0000320193",
        issuer: "Apple Inc.",
        ticker: "AAPL",
        count: 1,
        filings: [
          {
            filedAt: "2026-08-13",
            owner: "Newstead Jennifer",
            ownerTitle: "SVP, GC and Secretary",
            transactions: [
              {
                date: "2026-08-11",
                code: "S",
                codeMeaning: "Open-market or private sale",
                shares: 1439,
                pricePerShare: 307.75,
                value: 442852.25,
              },
            ],
          },
        ],
      },
    },
  },
  register(server: McpServer) {
    server.registerTool(
      TOOL_NAME,
      {
        title: "SEC Insider Transactions (Form 4)",
        description: DESCRIPTION,
        inputSchema,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async ({ ticker, limit, forms }) => {
        // Let UpstreamError propagate: the gate must not settle payment for a failed fetch.
        const result = await getInsiderTransactions(ticker, limit ?? 5, forms ?? ["4"]);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          structuredContent: result as unknown as Record<string, unknown>,
          isError: false,
        };
      },
    );
  },
};
