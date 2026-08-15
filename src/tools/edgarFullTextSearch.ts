import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolModule } from "./types.js";
import { fetchJson, UpstreamError } from "../upstream/http.js";
import { SEC_SOURCE, SEC_SOURCE_URL } from "../upstream/sec.js";

export const TOOL_NAME = "edgar_full_text_search";
export const TOOL_PRICE = "$0.01";

const ENDPOINT = "https://efts.sec.gov/LATEST/search-index";

export interface SearchHit {
  id: string;
  entity: string | null;
  form: string | null;
  filedAt: string | null;
  cik: string | null;
}

export interface FullTextSearchResult {
  query: string;
  totalMatches: number;
  /** True once EDGAR reports "gte" rather than an exact total (its own display cap is 10,000). */
  totalIsApproximate: boolean;
  count: number;
  hits: SearchHit[];
  source: string;
}

interface SearchHitSource {
  file_date?: string;
  display_names?: string[];
  root_form?: string;
  forms?: string[];
  ciks?: string[];
}
interface SearchResponse {
  hits?: {
    total?: { value?: number; relation?: string };
    hits?: Array<{ _id?: string; _source?: SearchHitSource }>;
  };
}

function firstCik(names?: string[]): string | null {
  // display_names look like "Apple Inc. (0000320193)"; pull the CIK out if present.
  const m = names?.[0]?.match(/\((\d{4,10})\)\s*$/);
  return m ? m[1] : null;
}

export async function searchFilings(
  query: string,
  opts: { forms?: string[]; dateFrom?: string; dateTo?: string; limit?: number } = {},
): Promise<FullTextSearchResult> {
  const q = query.trim();
  if (!q) throw new UpstreamError(SEC_SOURCE, "`query` must not be empty");

  const params = new URLSearchParams({ q });
  if (opts.forms?.length) params.set("forms", opts.forms.join(","));
  if (opts.dateFrom) params.set("startdt", opts.dateFrom);
  if (opts.dateTo) params.set("enddt", opts.dateTo);

  const body = await fetchJson<SearchResponse>(`${ENDPOINT}?${params.toString()}`, {
    source: SEC_SOURCE,
    timeoutMs: 20_000,
  });

  const rawHits = body.hits?.hits ?? [];
  if (rawHits.length === 0) {
    throw new UpstreamError(SEC_SOURCE, `no filings matched "${q}"`);
  }

  const limit = Math.max(1, Math.min(opts.limit ?? 10, rawHits.length));
  return {
    query: q,
    totalMatches: body.hits?.total?.value ?? rawHits.length,
    totalIsApproximate: body.hits?.total?.relation === "gte",
    count: limit,
    hits: rawHits.slice(0, limit).map((h) => ({
      id: h._id ?? "",
      entity: h._source?.display_names?.[0]?.replace(/\s*\(\d{4,10}\)\s*$/, "") ?? null,
      form: h._source?.root_form ?? h._source?.forms?.[0] ?? null,
      filedAt: h._source?.file_date ?? null,
      cik: firstCik(h._source?.display_names) ?? h._source?.ciks?.[0] ?? null,
    })),
    source: SEC_SOURCE_URL,
  };
}

const DESCRIPTION = `Full-text search across all SEC EDGAR filings since 2001 for a keyword or phrase.

Wraps EDGAR's own full-text search index, so it covers every filer and form type, not just a single company. Useful for finding who is disclosing a particular risk, technology, litigation, or event across the entire market.

When to use: cross-company research ("who is disclosing AI-related risk factors"), finding filings that mention a specific term, litigation or regulatory tracking.

When NOT to use: you already know the company (use edgar_filings_feed, which is company-scoped and cheaper), or you need results from before 2001 (EDGAR full-text search does not cover that far back).

Args:
  - query (string, required): search text. Wrap an exact phrase in double quotes, e.g. "\\"material weakness\\"".
  - forms (string[], optional): restrict to form types, e.g. ["10-K"].
  - dateFrom (string, optional): ISO start date (YYYY-MM-DD).
  - dateTo (string, optional): ISO end date (YYYY-MM-DD).
  - limit (integer, optional, default 10): maximum hits to return (1-50).

Returns structuredContent:
  {
    "query": "material weakness", "totalMatches": 10000, "totalIsApproximate": true,
    "count": 2,
    "hits": [
      { "id": "0001193125-26-123456:doc.htm", "entity": "Example Corp.",
        "form": "10-K", "filedAt": "2026-03-01", "cik": "0000320193" }
    ],
    "source": "https://www.sec.gov/edgar"
  }

"totalMatches" is a lower bound and "totalIsApproximate" is true once EDGAR's own count exceeds
its display cap (10,000) — narrow with forms/dateFrom/dateTo for a precise count.`;

const inputSchema = {
  query: z
    .string()
    .min(1)
    .describe('Search text. Quote an exact phrase, e.g. "material weakness".'),
  forms: z.array(z.string()).optional().describe('Restrict to form types, e.g. ["10-K"].'),
  dateFrom: z.string().optional().describe("ISO start date (YYYY-MM-DD)."),
  dateTo: z.string().optional().describe("ISO end date (YYYY-MM-DD)."),
  limit: z.number().int().min(1).max(50).default(10).describe("Max hits to return. Default 10."),
};

export const edgarFullTextSearchTool: ToolModule = {
  name: TOOL_NAME,
  title: "SEC Full-Text Filing Search",
  description: DESCRIPTION,
  price: TOOL_PRICE,
  discovery: {
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search text." },
        forms: { type: "array", items: { type: "string" }, description: 'e.g. ["10-K"].' },
        dateFrom: { type: "string", description: "ISO start date." },
        dateTo: { type: "string", description: "ISO end date." },
        limit: { type: "number", description: "Max hits (1-50, default 10)." },
      },
      required: ["query"],
    },
    inputExample: { query: "material weakness", forms: ["10-K"], limit: 10 },
    output: {
      example: {
        query: "material weakness",
        totalMatches: 10000,
        count: 1,
        hits: [{ entity: "Example Corp.", form: "10-K", filedAt: "2026-03-01" }],
      },
    },
  },
  register(server: McpServer) {
    server.registerTool(
      TOOL_NAME,
      {
        title: "SEC Full-Text Filing Search",
        description: DESCRIPTION,
        inputSchema,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async ({ query, forms, dateFrom, dateTo, limit }) => {
        // Let UpstreamError propagate: the gate must not settle payment for a failed fetch.
        const result = await searchFilings(query, { forms, dateFrom, dateTo, limit: limit ?? 10 });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          structuredContent: result as unknown as Record<string, unknown>,
          isError: false,
        };
      },
    );
  },
};
